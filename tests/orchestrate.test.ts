import { describe, expect, it } from 'bun:test';
import { bytesToHex, encodeRecordHeader, recordDigest, sha256Hex, signRecord, type ChainAdapter, type EnactmentRecord, type Settlement } from '../src/index.js';
import { decodeDelegation, DELEGATION_HEADER, type Delegation } from '../src/delegation.js';
import type { hire as realHire, HireResult } from '../src/hire.js';
import { paymentRefusal, type PaymentOffer } from '../src/payment-guard.js';
import {
  createDiscoveryDirectory, createOrchestratorTools, createRegistryDirectory, createTaskLedger, fetchAgentDocument, parseAgentDocument,
  type OrchestratorTool, type RegistryEntry, type RegistryReader,
} from '../src/orchestrate.js';
import type { StellarPaySigner } from '../src/wallet.js';

const SELF = 'GSELFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SELLER = 'GSELLERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'GOTHERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TX = 'a'.repeat(64);
const USDC_T = 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const SAC_T = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';

const hex = (d: Uint8Array) => bytesToHex(d);
const settled: Settlement = { chain: 'stellar', ref: TX, payer: SELF, payee: SELLER, amount: '0.0010000', asset: USDC_T, at: '2026-10-27T09:59:00Z' };
const adapter: ChainAdapter = {
  chain: 'stellar',
  sigAlg: 'ed25519',
  async sign(d) { return `${hex(d)}:${SELLER}`; },
  async verify(d, s, a) { return s === `${hex(d)}:${a}`; },
  async readSettlement(ref) { return ref === TX ? [settled] : []; },
  async resolveIdentity(id) { return id === '7' ? { owner: OTHER, wallet: SELLER } : null; },
};

async function sellerRecord(input: string, output: string): Promise<EnactmentRecord> {
  return signRecord(
    {
      v: '0.1',
      agent: { chain: 'stellar', address: SELLER, agentId: '7' },
      input: { sha256: await sha256Hex(input), mediaType: 'application/json' },
      output: { sha256: await sha256Hex(output), mediaType: 'application/json', bytes: output.length },
      settlement: { chain: 'stellar', ref: TX, payer: SELF, amount: '0.0010000', asset: USDC_T },
      issuedAt: '2026-10-27T10:00:00Z',
      nonce: '11'.repeat(16),
    },
    adapter,
    new Uint8Array(32),
  );
}

const hostedDoc = {
  name: 'Spanish translator',
  description: 'Translates English text to Spanish.',
  agentId: 7,
  agentWallet: SELLER,
  services: [{ slug: 'translate', description: 'en→es', price_usdc: '0.001', url: 'https://api.agentenact.io/a/x/s/translate', input_schema: { type: 'object' }, output_schema: null }],
};
const erc8004Doc = {
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
  name: 'Weather oracle',
  description: 'Hourly weather',
  services: [{ name: 'MCP', endpoint: 'https://weather.example/mcp' }, { name: 'web', endpoint: 'https://weather.example' }],
};
const dataUri = (o: unknown) => `data:application/json;base64,${btoa(JSON.stringify(o))}`;

/** Ids 0..5 as the testnet registry has them: some without a uri, one with a dead https uri. */
function fakeReader(): RegistryReader & { reads: string[] } {
  const entries: Record<string, RegistryEntry> = {
    '0': { agentId: '0', owner: OTHER, wallet: null, uri: '' },
    '1': { agentId: '1', owner: OTHER, wallet: null, uri: dataUri(erc8004Doc) },
    '3': { agentId: '3', owner: OTHER, wallet: null, uri: 'https://dead.example/agent.json' },
    '4': { agentId: '4', owner: OTHER, wallet: null, uri: 'ipfs://bafy' },
    '7': { agentId: '7', owner: OTHER, wallet: SELLER, uri: 'https://api.agentenact.io/a/x/agent.json' },
  };
  const r = {
    reads: [] as string[],
    async totalAgents() { return 8; },
    async read(id: string) { r.reads.push(id); return entries[id] ?? null; },
  };
  return r;
}
const docFetch = (async (i: string | URL | Request) => {
  const url = String(i);
  if (url === 'https://api.agentenact.io/a/x/agent.json') return new Response(JSON.stringify(hostedDoc), { status: 200, headers: { 'content-type': 'application/json' } });
  return new Response('nope', { status: 404 });
}) as typeof fetch;

describe('parseAgentDocument', () => {
  it('reads a hosted agent.json: services with url, price and schema', () => {
    const p = parseAgentDocument(hostedDoc);
    expect(p.name).toBe('Spanish translator');
    expect(p.services).toEqual([{ slug: 'translate', description: 'en→es', url: 'https://api.agentenact.io/a/x/s/translate', priceUsdc: '0.001', inputSchema: { type: 'object' }, outputSchema: null }]);
  });
  it('reads ERC-8004 endpoints and keeps them apart from paid services', () => {
    const p = parseAgentDocument(erc8004Doc);
    expect(p.services).toEqual([]);
    expect(p.endpoints).toEqual([{ name: 'MCP', endpoint: 'https://weather.example/mcp' }, { name: 'web', endpoint: 'https://weather.example' }]);
  });
  it('drops non-https service urls and credentials in urls', () => {
    const p = parseAgentDocument({ services: [{ url: 'http://x.example/s' }, { url: 'https://u:p@x.example/s' }, { url: 'javascript:alert(1)' }] });
    expect(p.services).toEqual([]);
  });
  it('refuses a non-object', () => {
    expect(() => parseAgentDocument([1])).toThrow();
  });
});

describe('fetchAgentDocument', () => {
  it('reads base64 and percent-encoded data uris', async () => {
    expect(await fetchAgentDocument(dataUri({ a: 1 }))).toEqual({ a: 1 });
    expect(await fetchAgentDocument(`data:application/json,${encodeURIComponent('{"b":2}')}`)).toEqual({ b: 2 });
  });
  it('refuses http, ipfs, non-200 and oversized documents', async () => {
    await expect(fetchAgentDocument('http://x.example/a.json', docFetch)).rejects.toThrow('unsupported uri scheme');
    await expect(fetchAgentDocument('ipfs://bafy', docFetch)).rejects.toThrow('unsupported uri scheme');
    await expect(fetchAgentDocument('https://dead.example/agent.json', docFetch)).rejects.toThrow('document answered 404');
    const big = (async () => new Response('x'.repeat(70_000), { status: 200 })) as unknown as typeof fetch;
    await expect(fetchAgentDocument('https://big.example/a.json', big)).rejects.toThrow('document too large');
  });
  it('does not follow redirects', async () => {
    let init: RequestInit | undefined;
    const f = (async (_i: string, i?: RequestInit) => ((init = i), new Response('', { status: 302, headers: { location: 'https://evil.example' } }))) as unknown as typeof fetch;
    await expect(fetchAgentDocument('https://a.example/a.json', f)).rejects.toThrow('document answered 302');
    expect(init?.redirect).toBe('manual');
  });
});

describe('registry directory', () => {
  it('walks newest id first, skips missing ids, matches every query word, and pages with a cursor', async () => {
    const reader = fakeReader();
    const dir = createRegistryDirectory({ network: 'stellar:testnet', reader, fetch: docFetch, scanPerCall: 4 });
    const p1 = await dir.find({ query: 'spanish translates' });
    expect(p1.agents).toEqual([{ agentId: '7', name: 'Spanish translator', description: 'Translates English text to Spanish.', services: 1, source: 'registry' }]);
    expect(p1.next).toBe('3');
    const p2 = await dir.find({ cursor: p1.next! });
    expect(p2.agents.map((a) => a.agentId)).toEqual(['3', '1', '0']);
    expect(p2.next).toBeNull();
  });
  it('get: chain facts plus the self-published document, or the reason it could not be read', async () => {
    const dir = createRegistryDirectory({ network: 'stellar:testnet', reader: fakeReader(), fetch: docFetch });
    expect(await dir.get('7')).toMatchObject({ agentId: '7', owner: OTHER, wallet: SELLER, selfPublished: { name: 'Spanish translator' } });
    expect(await dir.get('3')).toMatchObject({ selfPublished: null, documentError: 'document answered 404' });
    expect(await dir.get('0')).toMatchObject({ selfPublished: null, documentError: 'no uri' });
    expect(await dir.get('2')).toBeNull();
  });
  it('caches reads for five minutes', async () => {
    let t = 0;
    const reader = fakeReader();
    const dir = createRegistryDirectory({ network: 'stellar:testnet', reader, fetch: docFetch, now: () => t });
    await dir.get('7');
    await dir.get('7');
    t = 5 * 60_000 + 1;
    await dir.get('7');
    expect(reader.reads.filter((x) => x === '7').length).toBe(2);
  });
});

describe('discovery directory (opt-in)', () => {
  it('searches through the discovery API and describes agents from chain', async () => {
    let asked = '';
    const f = (async (i: string) => {
      asked = i;
      return new Response(JSON.stringify({
        items: [{ id: 13, builder: 'external', selfPublished: { name: 'Classifier', service: { slug: 'x', description: 'labels', priceUsdc: null } }, paymentsReceived: 21 }],
        next: 'MTc5', payments: { source: 'agentkarma', available: true },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const registry = createRegistryDirectory({ network: 'stellar:testnet', reader: fakeReader(), fetch: docFetch });
    const dir = createDiscoveryDirectory({ url: 'https://api.agentenact.io/', registry, fetch: f });
    const r = await dir.find({ query: 'classify', limit: 5 });
    expect(asked).toBe('https://api.agentenact.io/public/agents?q=classify&limit=5');
    expect(r).toEqual({ agents: [{ agentId: '13', name: 'Classifier', description: null, services: 1, source: 'discovery' }], next: 'MTc5' });
    expect((await dir.get('7'))?.wallet).toBe(SELLER);
  });
});

describe('task ledger', () => {
  it('carves tasks out of the session budget', () => {
    const l = createTaskLedger({ sessionBudgetUsdc: '0.10' });
    l.start({ purpose: 'a', budgetUsdc: '0.06' });
    expect(() => l.start({ purpose: 'b', budgetUsdc: '0.05' })).toThrow('over session budget: 0.04 USDC left');
    expect(l.unallocatedUsdc()).toBe('0.04');
  });
  it('a closed task gives back what it did not spend', () => {
    const l = createTaskLedger({ sessionBudgetUsdc: '0.10' });
    const t = l.start({ purpose: 'a', budgetUsdc: '0.10' });
    l.reserve(t.id, { agentId: null, url: 'https://x', payee: SELLER, amountUsdc: '0.0010000' });
    l.close(t.id);
    expect(l.unallocatedUsdc()).toBe('0.099');
  });
  it('refuses a reservation over the task budget and never un-counts a reservation', () => {
    const l = createTaskLedger({ sessionBudgetUsdc: '1' });
    const t = l.start({ purpose: 'a', budgetUsdc: '0.002' });
    const r = l.reserve(t.id, { agentId: null, url: 'https://x', payee: SELLER, amountUsdc: '0.0015000' });
    expect(r.ok).toBe(true);
    expect(l.reserve(t.id, { agentId: null, url: 'https://x', payee: SELLER, amountUsdc: '0.0010000' })).toEqual({ ok: false, reason: 'over_task_budget' });
    l.complete(t.id, (r as { id: string }).id, { state: 'free' });
    expect(l.get(t.id)!.delegations[0]!.state).toBe('unknown');
    expect(l.get(t.id)!.spentUsdc).toBe('0.0015');
  });
  it('takes the root from the delegation it was hired with', () => {
    const l = createTaskLedger({ sessionBudgetUsdc: '1', incoming: { v: 1, root: 'rootX', depth: 1, payees: [OTHER] } });
    expect(l.start({ purpose: 'a', budgetUsdc: '0.1' }).root).toBe('rootX');
  });
});

const signer: StellarPaySigner = { address: SELF, signAuthEntry: async () => ({ signedAuthEntry: '' }) } as unknown as StellarPaySigner;
const offer = (o: Partial<PaymentOffer> = {}): PaymentOffer => ({
  scheme: 'exact', network: 'stellar:testnet', asset: SAC_T, assetId: USDC_T, amount: '10000', decimal: '0.0010000', payTo: SELLER, maxTimeoutSeconds: 300, ...o,
});

type HireCall = { url: string; init: RequestInit; opts: Parameters<typeof realHire>[2] };
/** A hire that behaves like the real one around `onPay`: 'paid' settles, 'refused' throws before onPay, 'lost' throws after it. */
function fakeHire(mode: 'paid' | 'refused' | 'lost' | 'free', o: { payTo?: string } = {}) {
  const calls: HireCall[] = [];
  const fn = (async (url: string, init: RequestInit & { body?: string | Uint8Array }, opts: Parameters<typeof realHire>[2]): Promise<HireResult> => {
    calls.push({ url, init, opts });
    if (mode === 'refused') throw paymentRefusal('over_cap');
    const out = JSON.stringify({ text: 'hola' });
    if (mode === 'free') {
      return { response: new Response(out, { headers: { 'content-type': 'application/json' } }), output: new TextEncoder().encode(out), settlement: null, paid: null, record: null, verification: null, consistent: false, problems: ['no Enactment-Record header'] };
    }
    const o2 = offer(o.payTo ? { payTo: o.payTo } : {});
    await opts.onPay!(o2);
    if (mode === 'lost') throw new Error('socket hang up');
    const record = await sellerRecord(init.body as string, out);
    return {
      response: new Response(out, { headers: { 'content-type': 'application/json', 'Enactment-Record': encodeRecordHeader(record) } }),
      output: new TextEncoder().encode(out),
      settlement: { transaction: TX, network: 'stellar:testnet', payer: SELF },
      paid: o2,
      record,
      verification: { ok: true, checks: { signature: 'pass', settlement: 'pass', timing: 'pass', identity: 'pass' }, settlement: settled },
      consistent: true,
      problems: [],
    };
  }) as unknown as typeof realHire;
  return { fn, calls };
}

function tools(o: { hire?: typeof realHire; incoming?: Delegation; budget?: string; maxDepth?: number; pay?: boolean } = {}) {
  const directory = createRegistryDirectory({ network: 'stellar:testnet', reader: fakeReader(), fetch: docFetch });
  const r = createOrchestratorTools({
    network: 'stellar:testnet',
    directory,
    adapters: [adapter],
    ...(o.pay === false ? {} : {
      pay: { signer, sessionBudgetUsdc: o.budget ?? '0.10', maxPerCallUsdc: '0.05', maxDepth: o.maxDepth ?? 2, incoming: o.incoming ?? null },
    }),
    ...(o.hire ? { hire: o.hire } : {}),
  });
  const by = (n: string) => r.tools.find((t) => t.name === n) as OrchestratorTool;
  return { ...r, by };
}
const refusal = (p: Promise<unknown>) => p.then(() => 'no refusal', (e: { code?: string; reason?: string }) => (e.code === 'tool_refused' ? e.reason : `threw ${String(e)}`));

describe('orchestrator tools', () => {
  it('read-only without a payer: no start_task, no hire_agent', () => {
    expect(tools({ pay: false }).tools.map((t) => t.name)).toEqual(['find_agents', 'get_agent', 'verify_record']);
    expect(tools().tools.map((t) => t.name)).toEqual(['find_agents', 'get_agent', 'verify_record', 'start_task', 'hire_agent', 'get_task', 'list_tasks']);
  });
  it('get_agent validates the id and reports unknown agents', async () => {
    const t = tools();
    expect(await refusal(t.by('get_agent').run({ agent_id: '7; drop' }))).toBe('bad_agent_id');
    expect(await refusal(t.by('get_agent').run({ agent_id: '2' }))).toBe('agent_not_found');
    expect(await t.by('get_agent').run({ agent_id: '7' })).toMatchObject({ wallet: SELLER });
  });
  it('verify_record: the four checks, the digest, and optional exact input/output checks', async () => {
    const rec = await sellerRecord('{"text":"hi"}', '{"text":"hola"}');
    const t = tools({ pay: false });
    const r = (await t.by('verify_record').run({ record: encodeRecordHeader(rec), output: '{"text":"hola"}', input: '{"text":"HI"}' })) as Record<string, unknown>;
    expect(r.ok).toBe(true);
    expect(r.hashes).toEqual({ output: true, input: false });
    expect(r.recordDigest).toBe(hex(await recordDigest(rec)));
    expect(await t.by('verify_record').run({ record: { v: '0.1' } })).toMatchObject({ ok: false, failure: { check: 'record' } });
  });

  it('hire_agent: pays within the cap, records the delegation, sends the delegation header, and the manifest names the child record', async () => {
    const h = fakeHire('paid');
    const t = tools({ hire: h.fn });
    const { task_id } = (await t.by('start_task').run({ purpose: 'translate', budget_usdc: '0.03' })) as { task_id: string };
    const r = (await t.by('hire_agent').run({ task_id, url: 'https://api.agentenact.io/a/x/s/translate', agent_id: '7', input: { text: 'hi' }, max_usdc: '0.1' })) as Record<string, unknown>;
    expect(r).toMatchObject({ status: 200, output: { text: 'hola' }, payment: 'settled', paid_usdc: '0.001', transaction: TX, consistent: true, task_left_usdc: '0.029' });

    const call = h.calls[0]!;
    // The cap is the smallest of max_usdc (0.1), per call (0.05) and what the task has left (0.03).
    expect(call.opts.maxAmount).toBe('0.03');
    expect(call.opts.payTo).toBe(SELLER);
    expect(call.init.body).toBe('{"text":"hi"}');
    const sent = decodeDelegation((call.init.headers as Record<string, string>)[DELEGATION_HEADER]!);
    expect(sent).toEqual({ v: 1, root: task_id, depth: 1, payees: [SELF] });

    const task = (await t.by('get_task').run({ task_id })) as { delegations: { state: string; recordDigest: string }[]; manifest: { children: unknown[] } };
    expect(task.delegations[0]!.state).toBe('settled');
    expect(task.manifest.children).toEqual([{ agentId: '7', transaction: TX, recordDigest: r.record_digest, consistent: true }]);
  });
  it('a refusal before signing reserves nothing', async () => {
    const t = tools({ hire: fakeHire('refused').fn });
    const { task_id } = (await t.by('start_task').run({ purpose: 'p', budget_usdc: '0.01' })) as { task_id: string };
    expect(await refusal(t.by('hire_agent').run({ task_id, url: 'https://s.example/x', input: {}, max_usdc: '0.01' }))).toBe('over_cap');
    expect(t.ledger!.get(task_id)!.delegations).toEqual([]);
    expect(t.ledger!.get(task_id)!.spentUsdc).toBe('0');
  });
  it('a failure after the signed payment left keeps the reservation as unknown and says so', async () => {
    const t = tools({ hire: fakeHire('lost').fn });
    const { task_id } = (await t.by('start_task').run({ purpose: 'p', budget_usdc: '0.01' })) as { task_id: string };
    const r = await t.by('hire_agent').run({ task_id, url: 'https://s.example/x', input: {}, max_usdc: '0.01' });
    expect(r).toEqual({ error: 'hire_failed_after_payment', payment: 'unknown', transaction: null });
    expect(t.ledger!.get(task_id)!.delegations[0]).toMatchObject({ state: 'unknown', amountUsdc: '0.001' });
    expect(t.ledger!.get(task_id)!.spentUsdc).toBe('0.001');
  });
  it('a free endpoint pays nothing and counts nothing', async () => {
    const t = tools({ hire: fakeHire('free').fn });
    const { task_id } = (await t.by('start_task').run({ purpose: 'p', budget_usdc: '0.01' })) as { task_id: string };
    expect(await t.by('hire_agent').run({ task_id, url: 'https://s.example/x', input: {}, max_usdc: '0.01' })).toMatchObject({ payment: 'none', paid_usdc: null, consistent: false });
    expect(t.ledger!.get(task_id)!.spentUsdc).toBe('0');
  });
  it('refuses a payee already in the delegation chain before hiring (pinned by agent_id) and on the real offer (onPay)', async () => {
    const incoming: Delegation = { v: 1, root: 'r0', depth: 1, payees: [SELLER] };
    const h = fakeHire('paid');
    const t = tools({ hire: h.fn, incoming });
    const { task_id } = (await t.by('start_task').run({ purpose: 'p', budget_usdc: '0.01' })) as { task_id: string };
    expect(await refusal(t.by('hire_agent').run({ task_id, url: 'https://s.example/x', agent_id: '7', input: {}, max_usdc: '0.01' }))).toBe('delegation_loop');
    expect(h.calls.length).toBe(0);
    // Without agent_id the payee is only known from the 402: onPay refuses, nothing is reserved.
    expect(await refusal(t.by('hire_agent').run({ task_id, url: 'https://s.example/x', input: {}, max_usdc: '0.01' }))).toBe('delegation_loop');
    expect(t.ledger!.get(task_id)!.delegations).toEqual([]);
  });
  it('refuses past the max depth before hiring', async () => {
    const h = fakeHire('paid');
    const t = tools({ hire: h.fn, incoming: { v: 1, root: 'r0', depth: 2, payees: [OTHER] }, maxDepth: 2 });
    const { task_id } = (await t.by('start_task').run({ purpose: 'p', budget_usdc: '0.01' })) as { task_id: string };
    expect(await refusal(t.by('hire_agent').run({ task_id, url: 'https://s.example/x', input: {}, max_usdc: '0.01' }))).toBe('max_depth');
    expect(h.calls.length).toBe(0);
  });
  it('validates arguments: http urls, bad amounts, unknown tasks, oversized input', async () => {
    const t = tools({ hire: fakeHire('paid').fn });
    const { task_id } = (await t.by('start_task').run({ purpose: 'p', budget_usdc: '0.01' })) as { task_id: string };
    const hireArgs = { task_id, url: 'https://s.example/x', input: {}, max_usdc: '0.01' };
    expect(await refusal(t.by('hire_agent').run({ ...hireArgs, url: 'http://s.example/x' }))).toBe('bad_url');
    expect(await refusal(t.by('hire_agent').run({ ...hireArgs, max_usdc: '-1' }))).toBe('bad_max_usdc');
    expect(await refusal(t.by('hire_agent').run({ ...hireArgs, max_usdc: '0.000000001' }))).toBe('bad_max_usdc');
    expect(await refusal(t.by('hire_agent').run({ ...hireArgs, task_id: 'nope' }))).toBe('unknown_task');
    expect(await refusal(t.by('hire_agent').run({ ...hireArgs, input: 'x'.repeat(70_000) }))).toBe('input_too_large');
    expect(await refusal(t.by('start_task').run({ purpose: 'p', budget_usdc: '5' }))).toMatch(/^over session budget/);
  });
});

describe('registry paging', () => {
  it('a full page never skips ids that were read in the same batch', async () => {
    const reader: RegistryReader = {
      async totalAgents() { return 10; },
      async read(id) { return { agentId: id, owner: OTHER, wallet: null, uri: dataUri({ name: `agent ${id}` }) }; },
    };
    const dir = createRegistryDirectory({ network: 'stellar:testnet', reader, concurrency: 4 });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const p = await dir.find({ limit: 3, ...(cursor ? { cursor } : {}) });
      seen.push(...p.agents.map((a) => a.agentId));
      cursor = p.next ?? undefined;
    } while (cursor);
    expect(seen).toEqual(['9', '8', '7', '6', '5', '4', '3', '2', '1', '0']);
  });
});
