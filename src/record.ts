/**
 * Enactment Record — the chain-agnostic core. v0.1, and v0.2 = v0.1 + `skills`.
 *
 * A record binds an agent identity to sha256(input), sha256(output) and the
 * settlement that paid for the work. Chains are FIELDS; signing is delegated
 * to a ChainAdapter (see adapter.ts). This file has zero dependencies and
 * knows nothing about any chain SDK.
 *
 * Signed bytes = sha256(canonicalBytes(record)) — 32 bytes. Canonical form is
 * JSON with a FIXED key order (below), no whitespace, `sig` excluded, absent
 * optional fields omitted.
 *
 * v0.2 adds `skills`: the approved skills (id + content hash, see skills.ts) the
 * agent says it used for this output, sorted by id. It is the agent's signed
 * statement, so it gives non-repudiation, not proof the skills ran. v0.2 always
 * carries the field (an empty list means "none used"); v0.1 bytes are unchanged.
 */

/** The version issued when a record carries no skills. */
export const RECORD_VERSION = '0.1' as const;
export const RECORD_VERSIONS = ['0.1', '0.2'] as const;
export type RecordVersion = (typeof RECORD_VERSIONS)[number];

/** At most this many skills per record, so the header stays well under common 8 KB limits. */
export const MAX_RECORD_SKILLS = 32;

export interface RecordSkill {
  /** Skill id as listed by skills.sh: `owner/repo/slug` or `domain/slug`. */
  id: string;
  /** The skill's content hash the owner approved. */
  sha256: string;
}

export type Chain = 'solana' | 'celo' | 'arc' | 'base' | 'arbitrum' | 'avalanche' | 'polygon' | 'stellar';
export const CHAINS: readonly Chain[] = ['solana', 'celo', 'arc', 'base', 'arbitrum', 'avalanche', 'polygon', 'stellar'];

export type SigAlg = 'ed25519' | 'secp256k1-eip191';
export const SIG_ALGS: readonly SigAlg[] = ['ed25519', 'secp256k1-eip191'];

export interface UnsignedEnactmentRecord {
  v: RecordVersion;
  agent: { chain: Chain; address: string; agentId?: string };
  input: { sha256: string; mediaType?: string };
  output: { sha256: string; mediaType?: string; bytes?: number };
  /** v0.2 only, and required there. */
  skills?: RecordSkill[];
  settlement: { chain: Chain; ref: string; payer: string; amount: string; asset: string };
  /** RFC 3339 UTC, `Z` suffix. */
  issuedAt: string;
  /** 16 random bytes, lowercase hex. */
  nonce: string;
}

export interface EnactmentRecord extends UnsignedEnactmentRecord {
  sig: { alg: SigAlg; value: string };
}

export type EnactmentErrorCode =
  | 'malformed'
  | 'unsupported_version'
  | 'bad_hash'
  | 'bad_nonce'
  | 'bad_timestamp'
  | 'bad_chain'
  | 'bad_sig_alg'
  | 'bad_skills';

export type EnactmentError = Error & { code: EnactmentErrorCode };

export function createEnactmentError(code: EnactmentErrorCode, message: string): EnactmentError {
  const err = new Error(message) as EnactmentError;
  err.name = 'EnactmentError';
  err.code = code;
  return err;
}

// ─── bytes / hex / hashing ───────────────────────────────────────────────────

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw createEnactmentError('malformed', 'invalid hex');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256(bytes: Uint8Array | string): Promise<Uint8Array> {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  // .slice() yields a Uint8Array<ArrayBuffer>, which BufferSource requires under TS 5.9.
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data.slice()));
}

export async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  return bytesToHex(await sha256(bytes));
}

export function randomNonce(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

// ─── validation ─────────────────────────────────────────────────────────────

const HASH_RE = /^[0-9a-f]{64}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const RFC3339_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function requireString(obj: Record<string, unknown>, key: string, path: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw createEnactmentError('malformed', `${path}.${key} must be a non-empty string`);
  }
  return v;
}

function optionalString(obj: Record<string, unknown>, key: string, path: string): string | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length === 0) {
    throw createEnactmentError('malformed', `${path}.${key} must be a non-empty string when present`);
  }
  return v;
}

function requireChain(v: unknown, path: string): Chain {
  if (typeof v !== 'string' || !(CHAINS as readonly string[]).includes(v)) {
    throw createEnactmentError('bad_chain', `${path} must be one of ${CHAINS.join(', ')}`);
  }
  return v as Chain;
}

function requireHash(v: unknown, path: string): string {
  if (typeof v !== 'string' || !HASH_RE.test(v)) {
    throw createEnactmentError('bad_hash', `${path} must be 64 lowercase hex chars`);
  }
  return v;
}

/**
 * Validates a skills list and returns it sorted by id. Throws `bad_skills` on a
 * non-array, a bad entry, a duplicate id or more than MAX_RECORD_SKILLS entries.
 */
export function parseRecordSkills(input: unknown): RecordSkill[] {
  if (!Array.isArray(input)) throw createEnactmentError('bad_skills', 'skills must be an array');
  if (input.length > MAX_RECORD_SKILLS) {
    throw createEnactmentError('bad_skills', `skills holds at most ${MAX_RECORD_SKILLS} entries`);
  }
  const out = input.map((x, i): RecordSkill => {
    if (!isRecord(x) || typeof x.id !== 'string' || x.id.length === 0 || x.id.length > 256 || /\s/.test(x.id)) {
      throw createEnactmentError('bad_skills', `skills[${i}].id must be a non-empty id without spaces`);
    }
    if (typeof x.sha256 !== 'string' || !HASH_RE.test(x.sha256)) {
      throw createEnactmentError('bad_skills', `skills[${i}].sha256 must be 64 lowercase hex chars`);
    }
    return { id: x.id, sha256: x.sha256 };
  });
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.id === out[i - 1]!.id) throw createEnactmentError('bad_skills', `skill ${out[i]!.id} listed twice`);
  }
  return out;
}

export function parseUnsignedRecord(input: unknown): UnsignedEnactmentRecord {
  if (!isRecord(input)) throw createEnactmentError('malformed', 'record must be an object');
  if (!(RECORD_VERSIONS as readonly unknown[]).includes(input.v)) {
    throw createEnactmentError('unsupported_version', `unsupported record version ${String(input.v)}`);
  }
  const v = input.v as RecordVersion;

  const agentIn = input.agent;
  if (!isRecord(agentIn)) throw createEnactmentError('malformed', 'agent must be an object');
  const agent: UnsignedEnactmentRecord['agent'] = {
    chain: requireChain(agentIn.chain, 'agent.chain'),
    address: requireString(agentIn, 'address', 'agent'),
  };
  const agentId = optionalString(agentIn, 'agentId', 'agent');
  if (agentId !== undefined) agent.agentId = agentId;

  const inputIn = input.input;
  if (!isRecord(inputIn)) throw createEnactmentError('malformed', 'input must be an object');
  const inp: UnsignedEnactmentRecord['input'] = { sha256: requireHash(inputIn.sha256, 'input.sha256') };
  const inMedia = optionalString(inputIn, 'mediaType', 'input');
  if (inMedia !== undefined) inp.mediaType = inMedia;

  const outputIn = input.output;
  if (!isRecord(outputIn)) throw createEnactmentError('malformed', 'output must be an object');
  const out: UnsignedEnactmentRecord['output'] = { sha256: requireHash(outputIn.sha256, 'output.sha256') };
  const outMedia = optionalString(outputIn, 'mediaType', 'output');
  if (outMedia !== undefined) out.mediaType = outMedia;
  if (outputIn.bytes !== undefined) {
    if (typeof outputIn.bytes !== 'number' || !Number.isInteger(outputIn.bytes) || outputIn.bytes < 0) {
      throw createEnactmentError('malformed', 'output.bytes must be a non-negative integer');
    }
    out.bytes = outputIn.bytes;
  }

  const setIn = input.settlement;
  if (!isRecord(setIn)) throw createEnactmentError('malformed', 'settlement must be an object');
  const settlement: UnsignedEnactmentRecord['settlement'] = {
    chain: requireChain(setIn.chain, 'settlement.chain'),
    ref: requireString(setIn, 'ref', 'settlement'),
    payer: requireString(setIn, 'payer', 'settlement'),
    amount: requireString(setIn, 'amount', 'settlement'),
    asset: requireString(setIn, 'asset', 'settlement'),
  };

  const issuedAt = input.issuedAt;
  if (typeof issuedAt !== 'string' || !RFC3339_UTC_RE.test(issuedAt) || Number.isNaN(Date.parse(issuedAt))) {
    throw createEnactmentError('bad_timestamp', 'issuedAt must be RFC 3339 UTC with Z suffix');
  }

  const nonce = input.nonce;
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) {
    throw createEnactmentError('bad_nonce', 'nonce must be 32 lowercase hex chars');
  }

  // v0.1 ignores a `skills` key like any other unknown key: it is not signed there.
  if (v === '0.2') {
    if (input.skills === undefined) throw createEnactmentError('bad_skills', 'a v0.2 record must carry skills');
    return { v, agent, input: inp, output: out, skills: parseRecordSkills(input.skills), settlement, issuedAt, nonce };
  }
  return { v, agent, input: inp, output: out, settlement, issuedAt, nonce };
}

export function parseRecord(input: unknown): EnactmentRecord {
  const unsigned = parseUnsignedRecord(input);
  const sigIn = isRecord(input) ? input.sig : undefined;
  if (!isRecord(sigIn)) throw createEnactmentError('malformed', 'sig must be an object');
  if (typeof sigIn.alg !== 'string' || !(SIG_ALGS as readonly string[]).includes(sigIn.alg)) {
    throw createEnactmentError('bad_sig_alg', `sig.alg must be one of ${SIG_ALGS.join(', ')}`);
  }
  const value = requireString(sigIn, 'value', 'sig');
  return { ...unsigned, sig: { alg: sigIn.alg as SigAlg, value } };
}

// ─── canonical form ─────────────────────────────────────────────────────────

/**
 * Fixed-order JSON of the unsigned record. Runs the input through
 * parseUnsignedRecord so an unvalidated object can never produce bytes, and
 * so `sig` and unknown keys are dropped. JSON.stringify omits undefined
 * optionals, so absent fields never appear (no `null`).
 */
export function canonicalBytes(record: UnsignedEnactmentRecord | EnactmentRecord): Uint8Array {
  const r = parseUnsignedRecord(record);
  const ordered = {
    v: r.v,
    agent: { chain: r.agent.chain, address: r.agent.address, agentId: r.agent.agentId },
    input: { sha256: r.input.sha256, mediaType: r.input.mediaType },
    output: { sha256: r.output.sha256, mediaType: r.output.mediaType, bytes: r.output.bytes },
    skills: r.skills?.map((x) => ({ id: x.id, sha256: x.sha256 })),
    settlement: {
      chain: r.settlement.chain,
      ref: r.settlement.ref,
      payer: r.settlement.payer,
      amount: r.settlement.amount,
      asset: r.settlement.asset,
    },
    issuedAt: r.issuedAt,
    nonce: r.nonce,
  };
  return new TextEncoder().encode(JSON.stringify(ordered));
}

/** The 32 bytes an adapter signs and verifies. */
export async function recordDigest(record: UnsignedEnactmentRecord | EnactmentRecord): Promise<Uint8Array> {
  return sha256(canonicalBytes(record));
}

// ─── transport ──────────────────────────────────────────────────────────────

/** HTTP header an agent attaches next to its paid response. */
export const ENACTMENT_HEADER = 'Enactment-Record' as const;

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw createEnactmentError('malformed', 'header is not base64url');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Signed record → header value. Canonical order, then `sig` appended. */
export function encodeRecordHeader(record: EnactmentRecord): string {
  const r = parseRecord(record);
  const canonical = JSON.parse(new TextDecoder().decode(canonicalBytes(r))) as Record<string, unknown>;
  const json = JSON.stringify({ ...canonical, sig: { alg: r.sig.alg, value: r.sig.value } });
  return toBase64Url(new TextEncoder().encode(json));
}

/** Header value → validated signed record. Throws EnactmentError. */
export function decodeRecordHeader(value: string): EnactmentRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(value)));
  } catch (err) {
    if ((err as { code?: string }).code) throw err;
    throw createEnactmentError('malformed', 'header is not valid JSON');
  }
  return parseRecord(parsed);
}
