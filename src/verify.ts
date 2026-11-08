import type { ChainAdapter, Settlement } from './adapter.js';
import {
  createEnactmentError,
  parseRecord,
  recordDigest,
  type EnactmentErrorCode,
  type EnactmentRecord,
  type UnsignedEnactmentRecord,
} from './record.js';

export type VerifyCheck = 'signature' | 'settlement' | 'timing' | 'identity';

export type VerifyFailure =
  | { check: 'signature'; reason: 'invalid_signature' | 'alg_mismatch' | 'chain_mismatch' }
  | { check: 'settlement'; reason: 'not_found' | 'history_unavailable' | 'no_matching_payment' }
  | { check: 'timing'; reason: 'issued_before_settlement' | 'issued_after_window' }
  | { check: 'identity'; reason: 'unregistered' | 'address_not_bound' }
  | { check: 'record'; reason: EnactmentErrorCode; message: string };

export interface VerifyResult {
  ok: boolean;
  checks: Record<VerifyCheck, 'pass' | 'fail' | 'skipped'>;
  failure?: VerifyFailure;
  settlement?: Settlement;
}

export interface VerifyOptions {
  /** Max seconds between settlement close and issuedAt. Default 86400 (24h). */
  windowSeconds?: number;
}

const DEFAULT_WINDOW_SECONDS = 86_400;

/** Sign an unsigned record with the adapter's scheme. The secret never leaves this call. */
export async function signRecord(
  unsigned: UnsignedEnactmentRecord,
  adapter: ChainAdapter,
  secret: Uint8Array,
): Promise<EnactmentRecord> {
  if (unsigned.agent.chain !== adapter.chain) {
    throw createEnactmentError(
      'bad_chain',
      `record agent.chain ${unsigned.agent.chain} does not match adapter chain ${adapter.chain}`,
    );
  }
  const digest = await recordDigest(unsigned);
  const value = await adapter.sign(digest, secret);
  return { ...unsigned, sig: { alg: adapter.sigAlg, value } };
}

/** Decimal-string equality ignoring leading/trailing zeros: "0.01" == "0.0100000". */
function amountsEqual(a: string, b: string): boolean {
  const norm = (s: string) => {
    const [int = '0', frac = ''] = s.split('.');
    return `${int.replace(/^0+(?=\d)/, '')}.${frac.replace(/0+$/, '')}`;
  };
  return norm(a) === norm(b);
}

/**
 * Four checks in dependency order; the first failure short-circuits and the
 * remaining checks are reported as `skipped`. Never throws for a bad record —
 * malformed input is reported as `{ check: 'record' }`.
 */
export async function verifyRecord(
  input: unknown,
  adapter: ChainAdapter,
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  const checks: VerifyResult['checks'] = {
    signature: 'skipped',
    settlement: 'skipped',
    timing: 'skipped',
    identity: 'skipped',
  };
  const fail = (failure: VerifyFailure, settlement?: Settlement): VerifyResult => {
    if (failure.check !== 'record') checks[failure.check] = 'fail';
    return settlement ? { ok: false, checks, failure, settlement } : { ok: false, checks, failure };
  };

  let record: EnactmentRecord;
  try {
    record = parseRecord(input);
  } catch (err) {
    const e = err as { code?: EnactmentErrorCode; message?: string };
    return fail({ check: 'record', reason: e.code ?? 'malformed', message: e.message ?? 'invalid record' });
  }

  // 1. signature
  if (record.agent.chain !== adapter.chain) return fail({ check: 'signature', reason: 'chain_mismatch' });
  if (record.sig.alg !== adapter.sigAlg) return fail({ check: 'signature', reason: 'alg_mismatch' });
  const digest = await recordDigest(record);
  if (!(await adapter.verify(digest, record.sig.value, record.agent.address))) {
    return fail({ check: 'signature', reason: 'invalid_signature' });
  }
  checks.signature = 'pass';

  // 2. settlement
  const payments = await adapter.readSettlement(record.settlement.ref);
  if (payments.length === 0) {
    const reason = (await issuedBeforeHistory(record, adapter)) ? 'history_unavailable' : 'not_found';
    return fail({ check: 'settlement', reason });
  }
  const settlement = payments.find(
    (p) =>
      p.payee === record.agent.address &&
      p.payer === record.settlement.payer &&
      p.asset === record.settlement.asset &&
      amountsEqual(p.amount, record.settlement.amount),
  );
  if (!settlement) return fail({ check: 'settlement', reason: 'no_matching_payment' });
  checks.settlement = 'pass';

  // 3. timing
  const settledAt = Date.parse(settlement.at);
  const issuedAt = Date.parse(record.issuedAt);
  if (issuedAt < settledAt) return fail({ check: 'timing', reason: 'issued_before_settlement' }, settlement);
  const window = (opts.windowSeconds ?? DEFAULT_WINDOW_SECONDS) * 1000;
  if (issuedAt - settledAt > window) return fail({ check: 'timing', reason: 'issued_after_window' }, settlement);
  checks.timing = 'pass';

  // 4. identity (only when declared)
  if (record.agent.agentId !== undefined) {
    const binding = await adapter.resolveIdentity(record.agent.agentId);
    if (!binding) return fail({ check: 'identity', reason: 'unregistered' }, settlement);
    const bound = binding.owner === record.agent.address || binding.wallet === record.agent.address;
    if (!bound) return fail({ check: 'identity', reason: 'address_not_bound' }, settlement);
    checks.identity = 'pass';
  }

  return { ok: true, checks, settlement };
}

/**
 * True when the record claims a time before the oldest ledger the adapter can
 * read: its settlement may have existed and been reset or pruned away. Still a
 * failure, never a pass; it only stops calling such a record "not found".
 */
async function issuedBeforeHistory(record: EnactmentRecord, adapter: ChainAdapter): Promise<boolean> {
  if (!adapter.historyStart) return false;
  try {
    const start = await adapter.historyStart();
    return start !== null && Date.parse(record.issuedAt) < Date.parse(start);
  } catch {
    return false;
  }
}
