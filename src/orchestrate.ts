/**
 * `orchestrate` — the tools an agent uses to coordinate other agents, with every hop provable.
 *
 *   find_agents     search agents (the on-chain registry by default; a discovery API only when the caller opts in)
 *   get_agent       one agent: chain identity + its self-published services
 *   verify_record   the four checks on any Enactment Record, plus optional input/output hash checks
 *   start_task      open a task with a budget carved from the session budget
 *   hire_agent      pay a service via x402 under the payment guard, inside the task budget, carrying the delegation
 *   get_task        the task's delegations: who was paid, tx hashes, record digests, whether each record held
 *   list_tasks      every task this orchestrator opened
 *
 * Tools are plain data (name, description, JSON Schema, run) so the same set drives an MCP server (`agentenact/mcp`)
 * or any model loop. Money:
 *   - No key lives here. hire_agent pays through a `StellarPaySigner` (agentenact/wallet → the policy signer), whose
 *     own policy is the hard floor nothing here can raise.
 *   - In-process caps on top: per call, per task, and a session budget the tasks are carved from. A reservation is
 *     taken in `onPay` (the signed request is about to leave) and is never released once a signature has left:
 *     a missing receipt counts as spent ('unknown'), failing safe.
 *   - Delegation (delegation.ts): depth and loop checks before anything is signed; the header is advisory.
 * Record chaining needs no format change: get_task returns a `manifest` (the child records' digests and tx hashes);
 * an orchestrator that puts it in its own output commits to it through its own record's output hash.
 *
 * Everything an agent publishes about itself (name, description, services) is a claim, returned under
 * `selfPublished`. Only the registry fields (owner, wallet, uri) and verified records are chain facts.
 */
import type { ChainAdapter } from './adapter.js';
import { DELEGATION_HEADER, childDelegation, encodeDelegation, type Delegation } from './delegation.js';
import { hire, isPaymentRefusal, paymentRefusal, type PaymentOffer } from './hire.js';
import { networkFor, parseUnits, formatUnits, type Caip2 } from './networks.js';
import { bytesToHex, decodeRecordHeader, parseRecord, recordDigest, sha256Hex, type EnactmentRecord } from './record.js';
import { verifyRecord } from './verify.js';
import type { StellarPaySigner } from './wallet.js';

// ---------------------------------------------------------------------------------------------------------------
// Directory

/** One registry entry, read from chain. `uri` is '' when the agent never set one. */
export interface RegistryEntry {
  agentId: string;
  owner: string;
  wallet: string | null;
  uri: string;
}

/** What `adapters/stellar` `createStellarRegistryReader` returns; any chain's registry reader fits. Agents are 0 … total-1. */
export interface RegistryReader {
  totalAgents(): Promise<number>;
  read(agentId: string): Promise<RegistryEntry | null>;
}

export interface AgentService {
  slug: string | null;
  description: string | null;
  url: string;
  priceUsdc: string | null;
  inputSchema: unknown;
  outputSchema: unknown;
}

export interface AgentEndpoint {
  name: string;
  endpoint: string;
}

export interface SelfPublished {
  name: string | null;
  description: string | null;
  services: AgentService[];
  endpoints: AgentEndpoint[];
}

export interface AgentInfo {
  agentId: string;
  network: Caip2;
  /** Chain facts from the registry. */
  owner: string;
  wallet: string | null;
  uri: string;
  /** The document at `uri`, as the agent published it. null when it could not be read. */
  selfPublished: SelfPublished | null;
  documentError?: string;
}

export interface AgentSummary {
  agentId: string;
  name: string | null;
  description: string | null;
  services: number;
  source: 'registry' | 'discovery';
}

export interface AgentDirectory {
  find(q: { query?: string; limit?: number; cursor?: string }): Promise<{ agents: AgentSummary[]; next: string | null }>;
  get(agentId: string): Promise<AgentInfo | null>;
}

const DOC_MAX_BYTES = 64 * 1024;
const DOC_TIMEOUT_MS = 5_000;
const TEXT_MAX = 500;
const NAME_MAX = 80;
const MAX_SERVICES = 20;
const CACHE_MS = 5 * 60_000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const https = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
};
const usdcText = (v: unknown): string | null =>
  typeof v === 'string' && /^\d{1,12}(\.\d{1,7})?$/.test(v) ? v : typeof v === 'number' && Number.isFinite(v) && v >= 0 ? String(v) : null;

/**
 * Parse a registration document. Two shapes are read: an agentenact hosted `agent.json`
 * (`services: [{ slug, description, price_usdc, url, input_schema, output_schema }]`) and an ERC-8004
 * registration-v1 document (`services` / `endpoints`: `[{ name, endpoint }]`). Unknown fields are ignored.
 */
export function parseAgentDocument(doc: unknown): SelfPublished {
  if (!isObj(doc)) throw new Error('document is not a JSON object');
  const services: AgentService[] = [];
  const endpoints: AgentEndpoint[] = [];
  const lists = [doc.services, doc.endpoints].filter(Array.isArray) as unknown[][];
  for (const list of lists) {
    for (const s of list.slice(0, MAX_SERVICES)) {
      if (!isObj(s)) continue;
      const url = https(s.url);
      if (url) {
        services.push({
          slug: str(s.slug, 64),
          description: str(s.description, TEXT_MAX),
          url,
          priceUsdc: usdcText(s.price_usdc ?? s.priceUsdc),
          inputSchema: s.input_schema ?? s.inputSchema ?? null,
          outputSchema: s.output_schema ?? s.outputSchema ?? null,
        });
        continue;
      }
      const name = str(s.name, 32);
      const endpoint = typeof s.endpoint === 'string' ? s.endpoint.slice(0, 512) : null;
      if (name && endpoint) endpoints.push({ name, endpoint });
    }
  }
  return { name: str(doc.name, NAME_MAX), description: str(doc.description, TEXT_MAX), services, endpoints };
}

/** Read the document behind an agent uri: `data:` (inline) or `https:` (bounded fetch, no redirects). */
export async function fetchAgentDocument(uri: string, f: typeof fetch = globalThis.fetch): Promise<unknown> {
  if (uri.startsWith('data:')) {
    const comma = uri.indexOf(',');
    if (comma < 0) throw new Error('bad data uri');
    const meta = uri.slice(5, comma);
    const body = uri.slice(comma + 1);
    const text = meta.endsWith(';base64')
      ? new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0)))
      : decodeURIComponent(body);
    if (text.length > DOC_MAX_BYTES) throw new Error('document too large');
    return JSON.parse(text);
  }
  if (!https(uri)) throw new Error('unsupported uri scheme');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), DOC_TIMEOUT_MS);
  try {
    const res = await f(uri, { redirect: 'manual', signal: ctl.signal, headers: { accept: 'application/json' } });
    if (res.status !== 200) throw new Error(`document answered ${res.status}`);
    const len = Number(res.headers.get('content-length') ?? '0');
    if (len > DOC_MAX_BYTES) throw new Error('document too large');
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > DOC_MAX_BYTES) throw new Error('document too large');
    return JSON.parse(new TextDecoder().decode(buf));
  } finally {
    clearTimeout(t);
  }
}

function summary(a: AgentInfo, source: AgentSummary['source']): AgentSummary {
  return {
    agentId: a.agentId,
    name: a.selfPublished?.name ?? null,
    description: a.selfPublished?.description ?? null,
    services: a.selfPublished?.services.length ?? 0,
    source,
  };
}

function matches(a: AgentInfo, query: string): boolean {
  const q = query.toLowerCase();
  const p = a.selfPublished;
  if (!p) return false;
  const hay = [p.name, p.description, ...p.services.flatMap((s) => [s.slug, s.description])].filter(Boolean).join('\n').toLowerCase();
  return q.split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

export interface RegistryDirectoryOptions {
  network: Caip2;
  reader: RegistryReader;
  fetch?: typeof fetch;
  /** Registry ids read per find() call. Each read is ~4 simulations plus a document fetch. Default 20. */
  scanPerCall?: number;
  concurrency?: number;
  now?: () => number;
}

/**
 * Discovery from chain alone: walks the registry newest id first. Slow (a few seconds per page) but it needs no
 * indexer and nobody's API. Reads are cached for 5 minutes.
 */
export function createRegistryDirectory(o: RegistryDirectoryOptions): AgentDirectory {
  const now = o.now ?? Date.now;
  const scan = Math.max(1, Math.min(o.scanPerCall ?? 20, 100));
  const concurrency = Math.max(1, Math.min(o.concurrency ?? 4, 8));
  const cache = new Map<string, { at: number; value: Promise<AgentInfo | null> }>();

  async function load(agentId: string): Promise<AgentInfo | null> {
    const e = await o.reader.read(agentId);
    if (!e) return null;
    const info: AgentInfo = { agentId: e.agentId, network: o.network, owner: e.owner, wallet: e.wallet, uri: e.uri, selfPublished: null };
    if (!e.uri) return { ...info, documentError: 'no uri' };
    try {
      return { ...info, selfPublished: parseAgentDocument(await fetchAgentDocument(e.uri, o.fetch)) };
    } catch (err) {
      return { ...info, documentError: (err as Error).message.slice(0, 200) };
    }
  }

  function get(agentId: string): Promise<AgentInfo | null> {
    const hit = cache.get(agentId);
    if (hit && now() - hit.at < CACHE_MS) return hit.value;
    const value = load(agentId);
    cache.set(agentId, { at: now(), value });
    value.catch(() => cache.delete(agentId));
    return value;
  }

  return {
    get,
    async find({ query, limit, cursor }) {
      const want = Math.max(1, Math.min(limit ?? 10, 50));
      let id = cursor !== undefined ? Number(cursor) : (await o.reader.totalAgents()) - 1;
      if (!Number.isSafeInteger(id)) throw new Error('bad cursor');
      const agents: AgentSummary[] = [];
      let budget = scan;
      while (id >= 0 && budget > 0 && agents.length < want) {
        const ids: number[] = [];
        for (let i = 0; i < concurrency && id - i >= 0 && i < budget; i++) ids.push(id - i);
        const read = await Promise.all(ids.map((x) => get(String(x)).catch(() => null)));
        // Advance one id at a time so a full page never skips ids that were read but not returned.
        for (const a of read) {
          if (agents.length >= want) break;
          id--;
          budget--;
          if (!a || (query && !matches(a, query))) continue;
          agents.push(summary(a, 'registry'));
        }
      }
      return { agents, next: id >= 0 ? String(id) : null };
    },
  };
}

/**
 * Opt-in: search through an agentenact discovery API (`GET {url}/public/agents?q=`), then describe each agent from
 * chain through `registry`. Only the search goes to that API; get() never does.
 */
export function createDiscoveryDirectory(o: { url: string; registry: AgentDirectory; fetch?: typeof fetch }): AgentDirectory {
  const base = o.url.replace(/\/+$/, '');
  const f = o.fetch ?? globalThis.fetch;
  return {
    get: (id) => o.registry.get(id),
    async find({ query, limit, cursor }) {
      const u = new URL(`${base}/public/agents`);
      if (query) u.searchParams.set('q', query.slice(0, 64));
      u.searchParams.set('limit', String(Math.max(1, Math.min(limit ?? 10, 50))));
      if (cursor) u.searchParams.set('cursor', cursor);
      const res = await f(u.toString(), { headers: { accept: 'application/json' } });
      if (res.status !== 200) throw new Error(`discovery answered ${res.status}`);
      const j = (await res.json()) as { items?: unknown[]; next?: unknown };
      const agents: AgentSummary[] = [];
      for (const it of Array.isArray(j.items) ? j.items : []) {
        if (!isObj(it) || typeof it.id !== 'number') continue;
        const sp = isObj(it.selfPublished) ? it.selfPublished : {};
        agents.push({
          agentId: String(it.id),
          name: str(sp.name, NAME_MAX),
          description: str(sp.description, TEXT_MAX),
          services: isObj(sp.service) ? 1 : 0,
          source: 'discovery',
        });
      }
      return { agents, next: typeof j.next === 'string' ? j.next : null };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Tasks and budget

export type DelegationState = 'reserved' | 'settled' | 'unknown' | 'free' | 'failed';

export interface DelegationEntry {
  id: string;
  agentId: string | null;
  url: string;
  payee: string | null;
  /** Reserved or paid amount in whole USDC; '0' when nothing was signed. */
  amountUsdc: string;
  state: DelegationState;
  transaction: string | null;
  /** hex sha256 of the child's signed record (its canonical bytes), the link a parent commits to. */
  recordDigest: string | null;
  consistent: boolean | null;
  problems: string[];
  at: string;
}

export interface Task {
  id: string;
  /** Root task id: this task's own id at the root, the incoming one when this orchestrator was itself hired. */
  root: string;
  purpose: string;
  budgetUsdc: string;
  spentUsdc: string;
  open: boolean;
  delegations: DelegationEntry[];
  createdAt: string;
}

const USDC_DECIMALS = 7;
const u = (d: string) => parseUnits(d, USDC_DECIMALS);
const fmt = (v: bigint) => formatUnits(v, USDC_DECIMALS).replace(/\.?0+$/, '') || '0';

const randomId = (): string => {
  const b = new Uint8Array(9);
  crypto.getRandomValues(b);
  return bytesToHex(b);
};

/** Counts toward a budget: everything except a hire that provably signed nothing. */
const counts = (s: DelegationState) => s === 'reserved' || s === 'settled' || s === 'unknown';

export interface TaskLedger {
  start(t: { purpose: string; budgetUsdc: string }): Task;
  get(id: string): Task | null;
  list(): Task[];
  close(id: string): Task | null;
  /** Synchronous check-and-take, so two concurrent hires can never both fit into the last cent. */
  reserve(taskId: string, e: { agentId: string | null; url: string; payee: string; amountUsdc: string }): { ok: true; id: string } | { ok: false; reason: 'unknown_task' | 'task_closed' | 'over_task_budget' };
  /** Record the outcome of a reserved hire. A reservation never goes back to not counting. */
  complete(taskId: string, entryId: string, r: Partial<Pick<DelegationEntry, 'state' | 'transaction' | 'recordDigest' | 'consistent' | 'problems' | 'payee' | 'amountUsdc'>>): void;
  /** Session budget left to carve new tasks from. */
  unallocatedUsdc(): string;
}

export function createTaskLedger(o: { sessionBudgetUsdc: string; incoming?: Delegation | null; now?: () => Date }): TaskLedger {
  const now = o.now ?? (() => new Date());
  const session = u(o.sessionBudgetUsdc);
  const tasks = new Map<string, Task>();
  const allocated = () => [...tasks.values()].reduce((a, t) => a + (t.open ? u(t.budgetUsdc) : u(t.spentUsdc)), 0n);
  const spent = (t: Task) => t.delegations.filter((d) => counts(d.state)).reduce((a, d) => a + u(d.amountUsdc), 0n);

  return {
    start({ purpose, budgetUsdc }) {
      const want = u(budgetUsdc);
      if (want <= 0n) throw new Error('budget must be positive');
      if (allocated() + want > session) throw new Error(`over session budget: ${fmt(session - allocated())} USDC left`);
      const id = randomId();
      const t: Task = {
        id,
        root: o.incoming?.root ?? id,
        purpose: purpose.slice(0, 200),
        budgetUsdc: fmt(want),
        spentUsdc: '0',
        open: true,
        delegations: [],
        createdAt: now().toISOString(),
      };
      tasks.set(id, t);
      return t;
    },
    get: (id) => tasks.get(id) ?? null,
    list: () => [...tasks.values()],
    close(id) {
      const t = tasks.get(id);
      if (!t) return null;
      t.open = false;
      return t;
    },
    reserve(taskId, e) {
      const t = tasks.get(taskId);
      if (!t) return { ok: false, reason: 'unknown_task' };
      if (!t.open) return { ok: false, reason: 'task_closed' };
      const amount = u(e.amountUsdc);
      if (spent(t) + amount > u(t.budgetUsdc)) return { ok: false, reason: 'over_task_budget' };
      const id = randomId();
      t.delegations.push({
        id, agentId: e.agentId, url: e.url, payee: e.payee, amountUsdc: fmt(amount), state: 'reserved',
        transaction: null, recordDigest: null, consistent: null, problems: [], at: now().toISOString(),
      });
      t.spentUsdc = fmt(spent(t));
      return { ok: true, id };
    },
    complete(taskId, entryId, r) {
      const t = tasks.get(taskId);
      const d = t?.delegations.find((x) => x.id === entryId);
      if (!t || !d) return;
      // A reservation whose signature left can only become settled or unknown, never free again.
      if (d.state === 'reserved' && r.state && !counts(r.state)) r = { ...r, state: 'unknown' };
      Object.assign(d, r);
      t.spentUsdc = fmt(spent(t));
    },
    unallocatedUsdc: () => fmt(session - allocated()),
  };
}

/**
 * What a parent commits to: the child records it used, in a stable order. Put it (or its sha256) in the
 * orchestrator's own output and its own Enactment Record binds it through `output.sha256`.
 */
export function taskManifest(t: Task): { task: string; root: string; children: { agentId: string | null; transaction: string; recordDigest: string | null; consistent: boolean | null }[] } {
  return {
    task: t.id,
    root: t.root,
    children: t.delegations
      .filter((d) => d.transaction)
      .map((d) => ({ agentId: d.agentId, transaction: d.transaction!, recordDigest: d.recordDigest, consistent: d.consistent })),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Tools

/** JSON Schema for a tool's arguments: an object. */
export type JsonSchemaObject = { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };

export interface OrchestratorTool {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
  annotations: { readOnlyHint: boolean; openWorldHint: true; destructiveHint?: false; idempotentHint?: boolean };
  run(args: unknown, signal?: AbortSignal): Promise<unknown>;
}

/** A refusal the model should see as a tool error: a short code, never a stack. */
export interface ToolRefusal extends Error {
  code: 'tool_refused';
  reason: string;
}
export const toolRefusal = (reason: string): ToolRefusal => Object.assign(new Error(reason), { code: 'tool_refused' as const, reason });
export const isToolRefusal = (e: unknown): e is ToolRefusal => !!e && typeof e === 'object' && (e as { code?: unknown }).code === 'tool_refused';

export interface OrchestratorOptions {
  network: Caip2;
  directory: AgentDirectory;
  /** One adapter per chain the orchestrator verifies records on; the network's chain is required. */
  adapters: ChainAdapter[];
  /**
   * Enables start_task / hire_agent. The signer pays from `signer.address`; it never holds a key here.
   * Omit for a read-only orchestrator.
   */
  pay?: {
    signer: StellarPaySigner;
    /** The whole session may commit at most this much, across all tasks. */
    sessionBudgetUsdc: string;
    /** Per hire. Default '0.05'. */
    maxPerCallUsdc?: string;
    /** Deepest hired agent allowed in a chain (root = 0). Default 2. */
    maxDepth?: number;
    /** The delegation this orchestrator received when it was itself hired; null/absent at the root. */
    incoming?: Delegation | null;
  };
  fetch?: typeof fetch;
  now?: () => Date;
  /** Test seam: replaces `hire` (agentenact/hire). */
  hire?: typeof hire;
}

const OUTPUT_MAX_CHARS = 20_000;
const INPUT_MAX_BYTES = 64 * 1024;
const AGENT_ID = /^\d{1,10}$/;

function args(a: unknown): Record<string, unknown> {
  if (a === undefined || a === null) return {};
  if (!isObj(a)) throw toolRefusal('bad_arguments');
  return a;
}
function optString(a: Record<string, unknown>, k: string, max: number): string | undefined {
  const v = a[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v.length > max) throw toolRefusal(`bad_${k}`);
  return v;
}
function reqString(a: Record<string, unknown>, k: string, max: number): string {
  const v = optString(a, k, max);
  if (v === undefined || v === '') throw toolRefusal(`missing_${k}`);
  return v;
}
function usdcArg(a: Record<string, unknown>, k: string, required: boolean): string | undefined {
  const v = a[k];
  if (v === undefined || v === null) {
    if (required) throw toolRefusal(`missing_${k}`);
    return undefined;
  }
  const s = typeof v === 'number' ? String(v) : v;
  if (typeof s !== 'string' || !/^\d{1,6}(\.\d{1,7})?$/.test(s) || u(s) <= 0n) throw toolRefusal(`bad_${k}`);
  return s;
}

/** Decode output bytes for a model: JSON when it parses, else text; bounded. */
function readable(output: Uint8Array, mediaType: string | null): { output: unknown; truncated: boolean } {
  const text = new TextDecoder().decode(output);
  const truncated = text.length > OUTPUT_MAX_CHARS;
  if (!truncated && (mediaType ?? '').includes('json')) {
    try {
      return { output: JSON.parse(text), truncated };
    } catch {
      /* fall through to text */
    }
  }
  return { output: truncated ? text.slice(0, OUTPUT_MAX_CHARS) : text, truncated };
}

async function digestHex(r: EnactmentRecord): Promise<string> {
  return bytesToHex(await recordDigest(r));
}

export function createOrchestratorTools(o: OrchestratorOptions): { tools: OrchestratorTool[]; ledger: TaskLedger | null } {
  const net = networkFor(o.network);
  const adapterFor = (chain: string) => o.adapters.find((a) => a.chain === chain) ?? null;
  if (!adapterFor(net.chain)) throw new Error(`agentenact: no adapter for ${net.chain}`);
  const pay = o.pay;
  if (pay && !o.network.startsWith('stellar:')) throw new Error('agentenact: hire_agent pays on stellar networks only');
  const ledger = pay ? createTaskLedger({ sessionBudgetUsdc: pay.sessionBudgetUsdc, incoming: pay.incoming ?? null, ...(o.now ? { now: o.now } : {}) }) : null;
  const perCall = pay?.maxPerCallUsdc ?? '0.05';
  const maxDepth = pay?.maxDepth ?? 2;
  const read = { readOnlyHint: true, openWorldHint: true, idempotentHint: true } as const;

  const tools: OrchestratorTool[] = [
    {
      name: 'find_agents',
      description:
        'Search agents registered on chain (ERC-8004 / stellar-8004). Matches words against what each agent publishes about itself ' +
        '(name, description, services); that text is the agent\'s own claim. Returns ids; call get_agent for services and prices. ' +
        'Pass `next` back as `cursor` for more.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 64, description: 'Words that must all appear, e.g. "translate spanish".' },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
          cursor: { type: 'string', maxLength: 128 },
        },
        additionalProperties: false,
      },
      annotations: read,
      async run(raw) {
        const a = args(raw);
        const query = optString(a, 'query', 64);
        const cursor = optString(a, 'cursor', 128);
        const limit = a.limit === undefined ? undefined : Number(a.limit);
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50)) throw toolRefusal('bad_limit');
        const r = await o.directory.find({ ...(query ? { query } : {}), ...(cursor ? { cursor } : {}), ...(limit ? { limit } : {}) });
        return { network: o.network, ...r };
      },
    },
    {
      name: 'get_agent',
      description:
        'One agent by its registry id: owner and wallet (chain facts) and its self-published services (url, price in USDC, input schema). ' +
        'Hire a service with hire_agent.',
      inputSchema: {
        type: 'object',
        properties: { agent_id: { type: 'string', pattern: '^\\d{1,10}$' } },
        required: ['agent_id'],
        additionalProperties: false,
      },
      annotations: read,
      async run(raw) {
        const id = reqString(args(raw), 'agent_id', 10);
        if (!AGENT_ID.test(id)) throw toolRefusal('bad_agent_id');
        const agent = await o.directory.get(id);
        if (!agent) throw toolRefusal('agent_not_found');
        return agent;
      },
    },
    {
      name: 'verify_record',
      description:
        'Verify an Enactment Record from public chain data: signature, settlement, timing, identity. Optionally check that a given ' +
        'input/output is exactly what the record hashed. Proves who produced it and that it was paid for; never that it is correct.',
      inputSchema: {
        type: 'object',
        properties: {
          record: { description: 'The record as JSON, or the Enactment-Record header value.', oneOf: [{ type: 'object' }, { type: 'string' }] },
          output: { type: 'string', description: 'Optional: the exact output text the record should cover.' },
          input: { type: 'string', description: 'Optional: the exact input text the record should cover.' },
        },
        required: ['record'],
        additionalProperties: false,
      },
      annotations: read,
      async run(raw) {
        const a = args(raw);
        let record: EnactmentRecord;
        try {
          record = typeof a.record === 'string' ? decodeRecordHeader(a.record) : parseRecord(a.record);
        } catch (e) {
          return { ok: false, failure: { check: 'record', reason: (e as Error).message.slice(0, 200) } };
        }
        const adapter = adapterFor(record.agent.chain);
        if (!adapter) throw toolRefusal(`no_adapter_for_${record.agent.chain}`);
        const v = await verifyRecord(record, adapter);
        const hashes: Record<string, boolean> = {};
        const out = optString(a, 'output', 1_000_000);
        const inp = optString(a, 'input', 1_000_000);
        if (out !== undefined) hashes.output = (await sha256Hex(out)) === record.output.sha256;
        if (inp !== undefined) hashes.input = (await sha256Hex(inp)) === record.input.sha256;
        return { ...v, recordDigest: await digestHex(record), ...(Object.keys(hashes).length ? { hashes } : {}) };
      },
    },
  ];

  if (pay && ledger) {
    const self = pay.signer.address;
    tools.push(
      {
        name: 'start_task',
        description:
          'Open a task with a USDC budget before hiring agents for it. Every hire_agent call names a task and is paid from its budget. ' +
          'The session has a fixed total; a task cannot exceed what is left.',
        inputSchema: {
          type: 'object',
          properties: {
            purpose: { type: 'string', maxLength: 200 },
            budget_usdc: { type: 'string', pattern: '^\\d{1,6}(\\.\\d{1,7})?$', description: 'e.g. "0.05"' },
          },
          required: ['purpose', 'budget_usdc'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
        async run(raw) {
          const a = args(raw);
          const purpose = reqString(a, 'purpose', 200);
          const budget = usdcArg(a, 'budget_usdc', true)!;
          try {
            const t = ledger.start({ purpose, budgetUsdc: budget });
            return { task_id: t.id, budget_usdc: t.budgetUsdc, session_left_usdc: ledger.unallocatedUsdc() };
          } catch (e) {
            throw toolRefusal((e as Error).message);
          }
        },
      },
      {
        name: 'hire_agent',
        description:
          'Pay an agent\'s service in testnet/mainnet USDC via x402 and get its output plus its Enactment Record, verified. ' +
          'Refused before anything is signed when the price is above max_usdc, the task budget or the per-call cap, when the payee is ' +
          'already in this delegation chain, or when the chain is too deep. `input` is sent as JSON.',
        inputSchema: {
          type: 'object',
          properties: {
            task_id: { type: 'string', maxLength: 64 },
            url: { type: 'string', maxLength: 512, description: 'The service url from get_agent.' },
            agent_id: { type: 'string', pattern: '^\\d{1,10}$', description: 'Optional: pins the payee to this agent\'s wallet.' },
            input: { description: 'JSON input for the service.' },
            max_usdc: { type: 'string', pattern: '^\\d{1,6}(\\.\\d{1,7})?$' },
          },
          required: ['task_id', 'url', 'input', 'max_usdc'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
        async run(raw, signal) {
          const a = args(raw);
          const taskId = reqString(a, 'task_id', 64);
          const url = https(reqString(a, 'url', 512));
          if (!url) throw toolRefusal('bad_url');
          const agentId = optString(a, 'agent_id', 10) ?? null;
          if (agentId !== null && !AGENT_ID.test(agentId)) throw toolRefusal('bad_agent_id');
          const maxUsdc = usdcArg(a, 'max_usdc', true)!;
          if (!('input' in a)) throw toolRefusal('missing_input');
          const body = JSON.stringify(a.input ?? null);
          if (new TextEncoder().encode(body).byteLength > INPUT_MAX_BYTES) throw toolRefusal('input_too_large');

          const task = ledger.get(taskId);
          if (!task) throw toolRefusal('unknown_task');
          if (!task.open) throw toolRefusal('task_closed');

          let payTo: string | undefined;
          if (agentId !== null) {
            const agent = await o.directory.get(agentId);
            if (!agent) throw toolRefusal('agent_not_found');
            payTo = agent.wallet ?? agent.owner;
          }
          // Depth and loop checks before anything is signed (the payee is checked again on the real offer in onPay).
          const pre = childDelegation({ parent: pay.incoming ?? null, root: task.root, self, ...(payTo ? { payee: payTo } : {}), maxDepth });
          if ('refused' in pre) throw toolRefusal(pre.refused);

          const left = u(task.budgetUsdc) - u(task.spentUsdc);
          const cap = [u(maxUsdc), u(perCall), left].reduce((m, v) => (v < m ? v : m));
          if (cap <= 0n) throw toolRefusal('over_task_budget');

          let entry: string | null = null;
          const onPay = async (offer: PaymentOffer) => {
            const chain = childDelegation({ parent: pay.incoming ?? null, root: task.root, self, payee: offer.payTo, maxDepth });
            if ('refused' in chain) throw paymentRefusal(chain.refused);
            const r = ledger.reserve(taskId, { agentId, url, payee: offer.payTo, amountUsdc: offer.decimal });
            if (!r.ok) throw paymentRefusal(r.reason);
            entry = r.id;
          };
          try {
            const res = await (o.hire ?? hire)(
              url,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json', [DELEGATION_HEADER]: encodeDelegation(pre) },
                body,
                ...(signal ? { signal } : {}),
              },
              {
                adapter: adapterFor(net.chain)!,
                payer: { signer: pay.signer, network: o.network },
                maxAmount: fmt(cap),
                ...(payTo ? { payTo } : {}),
                onPay,
                ...(o.fetch ? { fetch: o.fetch } : {}),
              },
            );
            const digest = res.record ? await digestHex(res.record) : null;
            const state: DelegationState = res.paid ? (res.settlement ? 'settled' : 'unknown') : 'free';
            if (entry) {
              ledger.complete(taskId, entry, {
                state,
                transaction: res.settlement?.transaction ?? null,
                recordDigest: digest,
                consistent: res.consistent,
                problems: res.problems,
              });
            }
            const { output, truncated } = readable(res.output, res.response.headers.get('content-type'));
            return {
              status: res.response.status,
              output,
              ...(truncated ? { truncated: true } : {}),
              payment: state === 'free' ? 'none' : state,
              paid_usdc: res.paid ? fmt(u(res.paid.decimal)) : null,
              transaction: res.settlement?.transaction ?? null,
              record: res.record,
              record_digest: digest,
              consistent: res.consistent,
              problems: res.problems,
              task_left_usdc: fmt(u(ledger.get(taskId)!.budgetUsdc) - u(ledger.get(taskId)!.spentUsdc)),
            };
          } catch (e) {
            // A signature may have left: the reservation stays, as 'unknown'. Nothing was signed if `entry` is null.
            if (entry) ledger.complete(taskId, entry, { state: 'unknown', problems: [(e as Error).message.slice(0, 200)] });
            if (isPaymentRefusal(e)) throw toolRefusal(e.reason);
            if (entry) return { error: 'hire_failed_after_payment', payment: 'unknown', transaction: null };
            throw toolRefusal('hire_failed');
          }
        },
      },
      {
        name: 'get_task',
        description:
          'A task\'s delegations (who was paid, how much, tx hash, child record digest, whether it verified) and a `manifest`. ' +
          'Include the manifest in your own output so your Enactment Record commits to the child records you used.',
        inputSchema: { type: 'object', properties: { task_id: { type: 'string', maxLength: 64 } }, required: ['task_id'], additionalProperties: false },
        annotations: read,
        async run(raw) {
          const t = ledger.get(reqString(args(raw), 'task_id', 64));
          if (!t) throw toolRefusal('unknown_task');
          return { ...t, manifest: taskManifest(t) };
        },
      },
      {
        name: 'list_tasks',
        description: 'Every task opened in this session, with budget and spend, and the session budget left.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: read,
        async run() {
          return {
            session_left_usdc: ledger.unallocatedUsdc(),
            tasks: ledger.list().map((t) => ({ id: t.id, purpose: t.purpose, budget_usdc: t.budgetUsdc, spent_usdc: t.spentUsdc, open: t.open, hires: t.delegations.length })),
          };
        },
      },
    );
  }
  return { tools, ledger };
}

export {
  DELEGATION_HEADER, checkIncomingDelegation, childDelegation, decodeDelegation, encodeDelegation, parseDelegation,
  type Delegation, type DelegationRefusalReason,
} from './delegation.js';
