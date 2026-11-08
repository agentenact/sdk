/**
 * `community` — an open format for publishing agent templates that anyone can push and anyone can check.
 *
 * A community template is one JSON document (`agentenact.template/1`): who wrote it, what it is, and a `body` whose
 * shape its `kind` names. Nothing in it needs us:
 *
 *   1. Identity: the template's id is `sha256(canonicalJson(document without sig))`, hex. Change one byte, new id.
 *   2. Authorship: the author signs that id with their chain key, through the same ChainAdapter that signs records.
 *      The signed digest is domain-separated (`sha256("agentenact.template/1:" + id)`), so a template signature can
 *      never be replayed as a record signature or the other way round.
 *   3. Anchoring (optional): the author writes the id to their own account on chain. On Stellar this is one
 *      `manage_data` entry (see adapters/stellar `templateAnchor*`): no contract, no registry, no fee to anyone.
 *      An index that disappears takes nothing with it; the anchor stays on the author's account.
 *
 * Any index (ours or anyone's) accepts a template by running `verifyCommunityTemplate`; what a body means and
 * whether it is safe to run is the index's own check (`checkBody`), the way a skill's audit is the reviewer's.
 * Proves who published which bytes and when they were anchored; never that a template is good.
 *
 * Zero dependencies.
 */
import type { ChainAdapter } from './adapter.js';
import { NETWORKS, type Caip2 } from './networks.js';
import { SIG_ALGS, hexToBytes, sha256, sha256Hex, type SigAlg } from './record.js';

export const TEMPLATE_FORMAT = 'agentenact.template/1' as const;
/** Kebab-case, short enough for a Stellar data entry name (`ae.tpl:` + id ≤ 64 bytes). */
export const TEMPLATE_ID = /^[a-z0-9][a-z0-9-]{1,55}[a-z0-9]$/;
/** `vendor.name/major`, e.g. `agentenact.draft/1` (the panel's draft) or `agentenact.library/1` (`agentenact/templates`). */
export const TEMPLATE_KIND = /^[a-z0-9]+(?:\.[a-z0-9-]+)+\/[1-9][0-9]{0,3}$/;
/** 3..24 characters: a-z, 0-9, `_` and `-`, starting and ending with a letter or digit. */
export const AUTHOR_NAME = /^[a-z0-9][a-z0-9_-]{1,22}[a-z0-9]$/;
export const TITLE_MAX = 60;
export const SUMMARY_MAX = 160;
/** Upper bound of the canonical document, in UTF-8 bytes. */
export const TEMPLATE_MAX_BYTES = 32 * 1024;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export interface TemplateAuthor {
  /** CAIP-2 network of the author's key, e.g. `stellar:testnet`: anchors and agent ids are per network. */
  network: Caip2;
  /** The key that signs, in the chain's own form (G… on Stellar, 0x… on EVM). */
  address: string;
  /** Optional ERC-8004 agentId whose owner or agent wallet is `address`: the template is published by that agent. */
  agentId?: string;
  /**
   * Optional handle the author goes by, signed with the rest. Lowercase ASCII only, so no look-alike letters; it names,
   * it does not prove: show it next to the address, never instead of it. An index may refuse a handle another key holds.
   */
  name?: string;
}

export interface CommunityTemplate {
  format: typeof TEMPLATE_FORMAT;
  /** Author-chosen slug; stable across versions, unique per author. */
  slug: string;
  version: number;
  title: string;
  summary: string;
  author: TemplateAuthor;
  /** RFC 3339 UTC. */
  createdAt: string;
  kind: string;
  body: JsonValue;
}

export interface SignedCommunityTemplate extends CommunityTemplate {
  sig: { alg: SigAlg; value: string };
}

export type TemplateErrorCode = 'malformed' | 'too_large';
export type TemplateError = Error & { code: TemplateErrorCode };

export function createTemplateError(code: TemplateErrorCode, message: string): TemplateError {
  return Object.assign(new Error(message), { code, name: 'TemplateError' });
}

export function isTemplateError(err: unknown): err is TemplateError {
  return err instanceof Error && err.name === 'TemplateError' && typeof (err as { code?: unknown }).code === 'string';
}

// ─── canonical JSON ──────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Deterministic JSON: object keys sorted by UTF-16 code units at every depth, no whitespace, JSON.stringify's
 * number and string forms (the RFC 8785 subset that matters here). Throws on anything JSON cannot carry exactly:
 * non-finite numbers, undefined, functions, non-plain objects.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw createTemplateError('malformed', 'non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObj(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  throw createTemplateError('malformed', `not JSON: ${typeof value}`);
}

// ─── validation ─────────────────────────────────────────────────────────────

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const AGENT_ID = /^\d{1,20}$/;
const SIG_HEX = /^[0-9a-f]{128,140}$/;

function str(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string' || v.trim() === '' || v.length > max) throw createTemplateError('malformed', `${field} must be 1..${max} characters`);
  return v;
}

/** Validates an unsigned template and returns it with exactly the known fields (unknown keys are dropped). */
export function parseCommunityTemplate(input: unknown): CommunityTemplate {
  if (!isObj(input)) throw createTemplateError('malformed', 'template must be an object');
  if (input.format !== TEMPLATE_FORMAT) throw createTemplateError('malformed', `format must be ${TEMPLATE_FORMAT}`);
  const slug = input.slug;
  if (typeof slug !== 'string' || !TEMPLATE_ID.test(slug)) throw createTemplateError('malformed', 'slug must be kebab-case, 3..57 characters');
  const version = input.version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) throw createTemplateError('malformed', 'version must be a positive integer');
  const a = input.author;
  if (!isObj(a)) throw createTemplateError('malformed', 'author must be an object');
  if (typeof a.network !== 'string' || !Object.hasOwn(NETWORKS, a.network)) throw createTemplateError('malformed', 'author.network is not a supported CAIP-2 network');
  const network = a.network as Caip2;
  const address = str(a.address, 'author.address', 128);
  if (a.agentId !== undefined && (typeof a.agentId !== 'string' || !AGENT_ID.test(a.agentId))) throw createTemplateError('malformed', 'author.agentId must be decimal');
  if (a.name !== undefined && (typeof a.name !== 'string' || !AUTHOR_NAME.test(a.name))) throw createTemplateError('malformed', 'author.name must be 3..24 of a-z, 0-9, _ and -');
  const createdAt = input.createdAt;
  if (typeof createdAt !== 'string' || !RFC3339.test(createdAt) || Number.isNaN(Date.parse(createdAt))) throw createTemplateError('malformed', 'createdAt must be RFC 3339 UTC');
  const kind = input.kind;
  if (typeof kind !== 'string' || !TEMPLATE_KIND.test(kind)) throw createTemplateError('malformed', 'kind must look like vendor.name/1');
  if (!('body' in input) || input.body === undefined) throw createTemplateError('malformed', 'body is required');
  const out: CommunityTemplate = {
    format: TEMPLATE_FORMAT,
    slug,
    version,
    title: str(input.title, 'title', TITLE_MAX),
    summary: str(input.summary, 'summary', SUMMARY_MAX),
    author: { network, address, ...(a.agentId === undefined ? {} : { agentId: a.agentId as string }), ...(a.name === undefined ? {} : { name: a.name as string }) },
    createdAt,
    kind,
    body: input.body as JsonValue,
  };
  const size = new TextEncoder().encode(canonicalJson(out)).length;
  if (size > TEMPLATE_MAX_BYTES) throw createTemplateError('too_large', `template is ${size} bytes; the limit is ${TEMPLATE_MAX_BYTES}`);
  return out;
}

export function parseSignedCommunityTemplate(input: unknown): SignedCommunityTemplate {
  const t = parseCommunityTemplate(input);
  const sig = isObj(input) ? input.sig : undefined;
  if (!isObj(sig) || !SIG_ALGS.includes(sig.alg as SigAlg) || typeof sig.value !== 'string' || !SIG_HEX.test(sig.value)) {
    throw createTemplateError('malformed', 'sig must be { alg, value: lowercase hex }');
  }
  return { ...t, sig: { alg: sig.alg as SigAlg, value: sig.value } };
}

// ─── identity and signing ───────────────────────────────────────────────────

/** The canonical bytes of the template without `sig`. */
export function templateBytes(t: CommunityTemplate | SignedCommunityTemplate): Uint8Array {
  return new TextEncoder().encode(canonicalJson(parseCommunityTemplate(t)));
}

/** The template's id: lowercase hex sha256 of its canonical bytes. */
export async function templateHash(t: CommunityTemplate | SignedCommunityTemplate): Promise<string> {
  return sha256Hex(templateBytes(t));
}

/** The 32 bytes an author signs: domain-separated from record digests. */
export async function templateSigningDigest(hash: string): Promise<Uint8Array> {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw createTemplateError('malformed', 'hash must be 64 lowercase hex');
  return sha256(`${TEMPLATE_FORMAT}:${hash}`);
}

/** Signs with the author's secret through the chain's adapter. Returns the signed template and its id. */
export async function signCommunityTemplate(
  template: CommunityTemplate,
  secret: Uint8Array,
  adapter: ChainAdapter,
): Promise<{ template: SignedCommunityTemplate; sha256: string }> {
  const t = parseCommunityTemplate(template);
  const chain = NETWORKS[t.author.network].chain;
  if (chain !== adapter.chain) throw createTemplateError('malformed', `author.network ${t.author.network} does not match adapter chain ${adapter.chain}`);
  const hash = await templateHash(t);
  const value = await adapter.sign(await templateSigningDigest(hash), secret);
  return { template: { ...t, sig: { alg: adapter.sigAlg, value } }, sha256: hash };
}

// ─── verification ───────────────────────────────────────────────────────────

/** What the author's account says about `slug`: the hash anchored there, or null when nothing is. */
export interface TemplateAnchorReader {
  network: Caip2;
  readAnchor(address: string, slug: string): Promise<string | null>;
}

/**
 * - anchored: the author's account holds exactly this hash for the slug.
 * - superseded: it holds another hash (the author anchored a different version since, or never this one).
 * - unanchored: it holds nothing for the slug.
 * - unchecked: no anchor reader for the author's network was given, or reading failed.
 */
export type AnchorStatus = 'anchored' | 'superseded' | 'unanchored' | 'unchecked';

export type TemplateFailure =
  | { check: 'format'; reason: string }
  | { check: 'signature'; reason: 'chain_mismatch' | 'alg_mismatch' | 'bad_signature' }
  | { check: 'identity'; reason: 'agent_not_found' | 'not_owner_or_wallet' | 'unreachable' }
  | { check: 'body'; reason: string };

export type TemplateVerdict =
  | { ok: true; sha256: string; template: SignedCommunityTemplate; anchor: AnchorStatus; identity: 'bound' | 'none' }
  | { ok: false; sha256: string | null; failure: TemplateFailure };

export interface VerifyTemplateOptions {
  /** The adapter for `author.network` (same chain and network): checks the signature and, with `author.agentId`, the identity binding. */
  adapter: ChainAdapter;
  anchors?: TemplateAnchorReader;
  /** The index's own check of `body` for `kind`: a reason to refuse, or null. Runs last, after the signature. */
  checkBody?: (kind: string, body: JsonValue) => string | null | Promise<string | null>;
}

/**
 * format → signature → identity (only with author.agentId) → body. The anchor is reported, never required: an
 * index decides whether it lists unanchored templates. Throws only if `checkBody` throws.
 */
export async function verifyCommunityTemplate(input: unknown, opts: VerifyTemplateOptions): Promise<TemplateVerdict> {
  let t: SignedCommunityTemplate;
  try {
    t = parseSignedCommunityTemplate(input);
  } catch (err) {
    return { ok: false, sha256: null, failure: { check: 'format', reason: isTemplateError(err) ? err.message : 'malformed' } };
  }
  const hash = await templateHash(t);
  const fail = (failure: TemplateFailure): TemplateVerdict => ({ ok: false, sha256: hash, failure });
  const { adapter } = opts;

  const chain = NETWORKS[t.author.network].chain;
  if (chain !== adapter.chain) return fail({ check: 'signature', reason: 'chain_mismatch' });
  if (t.sig.alg !== adapter.sigAlg) return fail({ check: 'signature', reason: 'alg_mismatch' });
  if (!(await adapter.verify(await templateSigningDigest(hash), t.sig.value, t.author.address))) return fail({ check: 'signature', reason: 'bad_signature' });

  let identity: 'bound' | 'none' = 'none';
  if (t.author.agentId !== undefined) {
    let binding;
    try {
      binding = await adapter.resolveIdentity(t.author.agentId);
    } catch {
      return fail({ check: 'identity', reason: 'unreachable' });
    }
    if (!binding) return fail({ check: 'identity', reason: 'agent_not_found' });
    const same = (x: string | null) => x !== null && (chain === 'stellar' ? x === t.author.address : x.toLowerCase() === t.author.address.toLowerCase());
    if (!same(binding.owner) && !same(binding.wallet)) return fail({ check: 'identity', reason: 'not_owner_or_wallet' });
    identity = 'bound';
  }

  if (opts.checkBody) {
    const reason = await opts.checkBody(t.kind, t.body);
    if (reason !== null) return fail({ check: 'body', reason });
  }

  let anchor: AnchorStatus = 'unchecked';
  if (opts.anchors && opts.anchors.network === t.author.network) {
    try {
      const held = await opts.anchors.readAnchor(t.author.address, t.slug);
      anchor = held === null ? 'unanchored' : held === hash ? 'anchored' : 'superseded';
    } catch {
      anchor = 'unchecked';
    }
  }
  return { ok: true, sha256: hash, template: t, anchor, identity };
}

/** `ae.tpl:<slug>`: the data entry name an author's anchor lives under. */
export function templateAnchorKey(slug: string): string {
  if (!TEMPLATE_ID.test(slug)) throw createTemplateError('malformed', 'slug must be kebab-case, 3..57 characters');
  return `ae.tpl:${slug}`;
}

/** 32 raw bytes of a hex hash, for a chain value slot. */
export function anchorValueBytes(hash: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw createTemplateError('malformed', 'hash must be 64 lowercase hex');
  return hexToBytes(hash);
}

// ─── handle changes ─────────────────────────────────────────────────────────

export const HANDLE_FORMAT = 'agentenact.handle/1' as const;

/**
 * A handle change on its own, without a template: the key says "call me `name`" (or, with `null`, "drop my handle")
 * at `issuedAt`. Signed like a template, under its own prefix, so neither can pass as the other. An index keeps the
 * newest `issuedAt` per key and refuses anything not newer, so an old change cannot be replayed to undo a later one.
 */
export interface HandleChange {
  format: typeof HANDLE_FORMAT;
  network: Caip2;
  address: string;
  name: string | null;
  /** RFC 3339 UTC. */
  issuedAt: string;
}

export interface SignedHandleChange extends HandleChange {
  sig: { alg: SigAlg; value: string };
}

/** Validates a handle change and returns exactly its known fields (and `sig` when present and well-formed). */
export function parseHandleChange(input: unknown): HandleChange {
  if (!isObj(input)) throw createTemplateError('malformed', 'handle change must be an object');
  if (input.format !== HANDLE_FORMAT) throw createTemplateError('malformed', `format must be ${HANDLE_FORMAT}`);
  if (typeof input.network !== 'string' || !Object.hasOwn(NETWORKS, input.network)) throw createTemplateError('malformed', 'network is not a supported CAIP-2 network');
  const address = str(input.address, 'address', 128);
  if (input.name !== null && (typeof input.name !== 'string' || !AUTHOR_NAME.test(input.name))) throw createTemplateError('malformed', 'name must be 3..24 of a-z, 0-9, _ and -, or null');
  const issuedAt = input.issuedAt;
  if (typeof issuedAt !== 'string' || !RFC3339.test(issuedAt) || Number.isNaN(Date.parse(issuedAt))) throw createTemplateError('malformed', 'issuedAt must be RFC 3339 UTC');
  return { format: HANDLE_FORMAT, network: input.network as Caip2, address, name: input.name as string | null, issuedAt };
}

export function parseSignedHandleChange(input: unknown): SignedHandleChange {
  const h = parseHandleChange(input);
  const sig = isObj(input) ? input.sig : undefined;
  if (!isObj(sig) || !SIG_ALGS.includes(sig.alg as SigAlg) || typeof sig.value !== 'string' || !SIG_HEX.test(sig.value)) {
    throw createTemplateError('malformed', 'sig must be { alg, value: lowercase hex }');
  }
  return { ...h, sig: { alg: sig.alg as SigAlg, value: sig.value } };
}

/** The 32 bytes the key signs: `sha256("agentenact.handle/1:" + sha256(canonicalJson(change)))`. */
export async function handleSigningDigest(change: HandleChange | SignedHandleChange): Promise<Uint8Array> {
  const h = parseHandleChange(change);
  return sha256(`${HANDLE_FORMAT}:${await sha256Hex(canonicalJson(h))}`);
}

export async function signHandleChange(change: HandleChange, secret: Uint8Array, adapter: ChainAdapter): Promise<SignedHandleChange> {
  const h = parseHandleChange(change);
  if (NETWORKS[h.network].chain !== adapter.chain) throw createTemplateError('malformed', `network ${h.network} does not match adapter chain ${adapter.chain}`);
  return { ...h, sig: { alg: adapter.sigAlg, value: await adapter.sign(await handleSigningDigest(h), secret) } };
}

/** Format and signature only; freshness (newer than the last change, close to now) is the index's to judge. Never throws. */
export async function verifyHandleChange(input: unknown, adapter: ChainAdapter): Promise<{ ok: true; change: SignedHandleChange } | { ok: false; reason: 'malformed' | 'chain_mismatch' | 'bad_signature' }> {
  let h: SignedHandleChange;
  try {
    h = parseSignedHandleChange(input);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (NETWORKS[h.network].chain !== adapter.chain || h.sig.alg !== adapter.sigAlg) return { ok: false, reason: 'chain_mismatch' };
  return (await adapter.verify(await handleSigningDigest(h), h.sig.value, h.address)) ? { ok: true, change: h } : { ok: false, reason: 'bad_signature' };
}
