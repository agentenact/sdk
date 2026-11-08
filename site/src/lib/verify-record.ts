/** Runs the package's own verifier on a fetched record (the same calls as the home page's live proof). */
export type CheckName = 'signature' | 'settlement' | 'timing' | 'identity';
export type CheckState = 'pass' | 'fail' | 'skipped';

export interface VerifierModule {
  verifyRecord: (input: unknown, adapter: unknown, opts?: { windowSeconds?: number }) => Promise<{
    ok: boolean;
    checks: Record<CheckName, CheckState>;
    failure?: { check: string; reason: string };
  }>;
  createStellarAdapter: (opts?: { network?: 'pubnet' | 'testnet' }) => { resolveIdentity(agentId: string): Promise<{ owner: string; wallet: string | null } | null> };
}

export interface CheckResult {
  ok: boolean;
  checks: Record<CheckName, CheckState>;
  failure?: { check: string; reason: string };
  /** The agent's owner read from the registry now; null when unknown (never invented). */
  owner: string | null;
}

/** Long enough for a slow Horizon and RPC, short enough that a dead network shows Try again instead of an endless check. */
export const CHECK_TIMEOUT_MS = 30_000;

export async function checkRecord(record: unknown, mod: VerifierModule, o: { timeoutMs?: number } = {}): Promise<CheckResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), o.timeoutMs ?? CHECK_TIMEOUT_MS)));
  try {
    return await Promise.race([check(record, mod), late]);
  } finally {
    clearTimeout(timer);
  }
}

async function check(record: unknown, mod: VerifierModule): Promise<CheckResult> {
  const adapter = mod.createStellarAdapter({ network: 'testnet' });
  const agentId = (record as { agent?: { agentId?: unknown } } | null)?.agent?.agentId;
  const [result, owner] = await Promise.all([
    mod.verifyRecord(record, adapter, { windowSeconds: 86_400 }),
    typeof agentId === 'string' ? adapter.resolveIdentity(agentId).then((b) => b?.owner ?? null, () => null) : Promise.resolve(null),
  ]);
  // Verified means every check that applies passed: a skipped signature, payment or timing never counts, and the owner
  // check may be skipped only when the record names no agent id (a library agent without an identity).
  const core = (['signature', 'settlement', 'timing'] as const).every((k) => result.checks[k] === 'pass');
  const identity = typeof agentId === 'string' ? result.checks.identity === 'pass' : result.checks.identity !== 'fail';
  const ok = result.ok && !result.failure && core && identity;
  return { ok, checks: result.checks, ...(result.failure ? { failure: result.failure } : {}), owner };
}
