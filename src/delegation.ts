/**
 * Delegation context: what an orchestrator tells the agent it hires about the chain of hires above it.
 *
 * Carried as one HTTP header on the paid request (`AgentEnact-Delegation`), base64url JSON:
 *   { v: 1, root, depth, payees }
 *   - root   : the root task id, opaque, so every hop of one job can be grouped
 *   - depth  : the hired agent's depth (the root orchestrator is 0, the agent it hires is 1, …)
 *   - payees : every address that has paid on the way down, the sender included
 *
 * The header is ADVISORY. A foreign agent can drop or forge it. It lets honest agents refuse loops (A→B→A) and
 * runaway depth before any payment, but the guarantee against runaway spend is the money caps (the policy
 * signer, the payment guard, the task budget), never this header.
 *
 * Zero dependencies.
 */

export const DELEGATION_HEADER = 'AgentEnact-Delegation' as const;
export const DELEGATION_VERSION = 1 as const;
/** A chain longer than this is refused as malformed: no honest job needs it. */
export const MAX_DELEGATION_PAYEES = 16;
const MAX_HEADER_CHARS = 2048;
const ROOT = /^[A-Za-z0-9_-]{1,64}$/;
const ADDRESS = /^[A-Za-z0-9]{1,128}$/;

export interface Delegation {
  v: typeof DELEGATION_VERSION;
  root: string;
  depth: number;
  payees: string[];
}

export type DelegationRefusalReason = 'bad_delegation' | 'max_depth' | 'delegation_loop';

function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): string {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** Validate a delegation from any source. Throws `Error('bad_delegation')` on anything off. */
export function parseDelegation(input: unknown): Delegation {
  const d = input as Partial<Delegation> | null;
  const ok =
    !!d && typeof d === 'object' && !Array.isArray(d) &&
    d.v === DELEGATION_VERSION &&
    typeof d.root === 'string' && ROOT.test(d.root) &&
    typeof d.depth === 'number' && Number.isInteger(d.depth) && d.depth >= 1 && d.depth <= MAX_DELEGATION_PAYEES &&
    Array.isArray(d.payees) && d.payees.length >= 1 && d.payees.length <= MAX_DELEGATION_PAYEES &&
    d.payees.every((p) => typeof p === 'string' && ADDRESS.test(p)) &&
    Object.keys(d).every((k) => k === 'v' || k === 'root' || k === 'depth' || k === 'payees');
  if (!ok) throw new Error('bad_delegation');
  return { v: DELEGATION_VERSION, root: d.root!, depth: d.depth!, payees: [...d.payees!] };
}

export function encodeDelegation(d: Delegation): string {
  const v = b64urlEncode(JSON.stringify(parseDelegation(d)));
  if (v.length > MAX_HEADER_CHARS) throw new Error('bad_delegation');
  return v;
}

/** Decode a header value. Throws `Error('bad_delegation')` on anything that is not a valid delegation. */
export function decodeDelegation(value: string): Delegation {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_HEADER_CHARS) throw new Error('bad_delegation');
  let json: unknown;
  try {
    json = JSON.parse(b64urlDecode(value));
  } catch {
    throw new Error('bad_delegation');
  }
  return parseDelegation(json);
}

/**
 * The delegation an agent sends when it hires the next one. `parent` is what it received (absent at the root),
 * `self` the hirer's paying address. Returns the refusal reason instead when the hire would exceed `maxDepth`
 * or the payee already appears in the chain.
 */
export function childDelegation(o: {
  parent: Delegation | null;
  root: string;
  self: string;
  payee?: string;
  maxDepth: number;
}): Delegation | { refused: DelegationRefusalReason } {
  const depth = (o.parent?.depth ?? 0) + 1;
  if (depth > o.maxDepth) return { refused: 'max_depth' };
  const payees = [...(o.parent?.payees ?? [])];
  if (!payees.includes(o.self)) payees.push(o.self);
  if (payees.length > MAX_DELEGATION_PAYEES) return { refused: 'max_depth' };
  if (o.payee !== undefined && (o.payee === o.self || payees.includes(o.payee))) return { refused: 'delegation_loop' };
  return { v: DELEGATION_VERSION, root: o.parent?.root ?? o.root, depth, payees };
}

/**
 * The receiving side: may an agent at `self` accept this request? Absent header = a root call, accepted.
 * Used by `serve` (option `delegation`) before anything is paid.
 */
export function checkIncomingDelegation(
  header: string | null,
  o: { self: string; maxDepth: number },
): { ok: true; delegation: Delegation | null } | { ok: false; reason: DelegationRefusalReason } {
  if (header === null) return { ok: true, delegation: null };
  let d: Delegation;
  try {
    d = decodeDelegation(header);
  } catch {
    return { ok: false, reason: 'bad_delegation' };
  }
  if (d.depth > o.maxDepth) return { ok: false, reason: 'max_depth' };
  if (d.payees.includes(o.self)) return { ok: false, reason: 'delegation_loop' };
  return { ok: true, delegation: d };
}
