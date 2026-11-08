/**
 * Spend policy: the limits an owner sets ONCE for an agent's wallets, enforced by the policy signer
 * (signer.ts) on every signature, with no human in the loop.
 *
 * A policy is a list of rules, one per (network, asset): a per-transaction cap, a cap over a rolling
 * window, and an optional payee allowlist. Anything no rule covers is refused (fail closed). Amounts are
 * decimals in whole units of the asset; assets are the chain's unspoofable identity (`CODE:ISSUER` on
 * Stellar, the lowercase token contract on EVM), exactly as in a record's `settlement.asset`.
 *
 * Zero dependencies: this file knows the network table and nothing else.
 */
import { networkFor, parseUnits, type Caip2 } from './networks.js';

export const DEFAULT_WINDOW_SECONDS = 86_400;

export interface SpendRule {
  network: Caip2;
  /** `CODE:ISSUER` on Stellar, the token contract on EVM. Must be pinned in NETWORKS. */
  asset: string;
  /** Most one signature may move, whole units ("0.05"). */
  perTx: string;
  /** Most all signatures together may move within `windowSeconds`, whole units ("5"). */
  perWindow: string;
  /** Rolling window length. Default 86 400 (one day). */
  windowSeconds?: number;
  /** When set, the only addresses this rule may pay. */
  payTo?: string[];
}

export interface SpendPolicy {
  rules: SpendRule[];
  /** RFC 3339; after it every spend is refused until the owner sets a new policy. */
  expiresAt?: string;
}

/** What a signature would move, as read from the payload itself (never from the agent's word). */
export interface SpendIntent {
  network: Caip2;
  asset: string;
  /** Base units. */
  amount: bigint;
  from: string;
  payTo: string;
}

export interface SpendEntry extends SpendIntent {
  at: Date;
}

/**
 * Where signed spends are counted. The default is in memory, so a restart forgets the window: give the
 * signer a persistent ledger in production. A spend is counted when it is SIGNED, whether or not it ever
 * settles, so the window can only over-count.
 */
export interface SpendLedger {
  /** Base units signed for (network, asset) at or after `since`. */
  total(network: Caip2, asset: string, since: Date): Promise<bigint>;
  add(entry: SpendEntry): Promise<void>;
}

export type SpendRefusalReason =
  | 'policy_expired' | 'no_rule' | 'pay_to_not_allowed' | 'bad_amount' | 'over_per_tx' | 'over_window'
  | 'unknown_wallet' | 'unknown_asset' | 'wrong_network' | 'unsupported_payload' | 'bad_payload' | 'bad_validity';

export interface SpendRefusal extends Error {
  code: 'spend_refused';
  reason: SpendRefusalReason;
}

export const spendRefusal = (reason: SpendRefusalReason): SpendRefusal =>
  Object.assign(new Error(`agentenact: spend refused: ${reason}`), { code: 'spend_refused' as const, reason });

export const isSpendRefusal = (e: unknown): e is SpendRefusal =>
  !!e && typeof e === 'object' && (e as { code?: unknown }).code === 'spend_refused';

interface CompiledRule {
  network: Caip2;
  asset: string;
  decimals: number;
  perTx: bigint;
  perWindow: bigint;
  windowMs: number;
  payTo: Set<string> | null;
}

export interface CompiledPolicy {
  rules: CompiledRule[];
  expiresAt: number | null;
}

const isEvm = (network: Caip2) => network.startsWith('eip155:');
/** EVM addresses compare case-insensitively; Stellar strkeys are exact. */
export const normalizeAddress = (network: Caip2, a: string): string => (isEvm(network) ? a.toLowerCase() : a);

function cap(value: string, decimals: number, what: string): bigint {
  let v: bigint;
  try {
    v = parseUnits(value, decimals);
  } catch {
    throw new Error(`agentenact: bad ${what} ${value}`);
  }
  if (v <= 0n) throw new Error(`agentenact: ${what} must be positive`);
  return v;
}

/** Validate a policy against the network table. Throws on an unknown network or asset, a bad cap, or a duplicate rule. */
export function compilePolicy(p: SpendPolicy): CompiledPolicy {
  const seen = new Set<string>();
  const rules = p.rules.map((r): CompiledRule => {
    const net = networkFor(r.network);
    const asset = normalizeAddress(r.network, r.asset);
    const pinned = Object.values(net.assets).find((a) => a.asset === asset);
    if (!pinned) throw new Error(`agentenact: unknown asset ${r.asset} on ${r.network}`);
    const key = `${r.network} ${asset}`;
    if (seen.has(key)) throw new Error(`agentenact: duplicate rule for ${key}`);
    seen.add(key);
    const perTx = cap(r.perTx, pinned.decimals, 'perTx');
    const perWindow = cap(r.perWindow, pinned.decimals, 'perWindow');
    if (perTx > perWindow) throw new Error(`agentenact: perTx exceeds perWindow for ${key}`);
    const windowSeconds = r.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
    if (!Number.isInteger(windowSeconds) || windowSeconds < 1) throw new Error(`agentenact: bad windowSeconds for ${key}`);
    return {
      network: r.network, asset, decimals: pinned.decimals, perTx, perWindow, windowMs: windowSeconds * 1000,
      payTo: r.payTo ? new Set(r.payTo.map((a) => normalizeAddress(r.network, a))) : null,
    };
  });
  let expiresAt: number | null = null;
  if (p.expiresAt !== undefined) {
    expiresAt = Date.parse(p.expiresAt);
    if (Number.isNaN(expiresAt)) throw new Error(`agentenact: bad expiresAt ${p.expiresAt}`);
  }
  return { rules, expiresAt };
}

/**
 * Check one intent. `spent` returns what the ledger already counts inside the rule's window.
 * Throws a `spend_refused` error; returns nothing on success.
 */
export async function checkSpend(
  policy: CompiledPolicy,
  intent: SpendIntent,
  spent: (since: Date) => Promise<bigint>,
  now: Date,
): Promise<void> {
  if (policy.expiresAt !== null && now.getTime() >= policy.expiresAt) throw spendRefusal('policy_expired');
  const asset = normalizeAddress(intent.network, intent.asset);
  const rule = policy.rules.find((r) => r.network === intent.network && r.asset === asset);
  if (!rule) throw spendRefusal('no_rule');
  if (intent.amount <= 0n) throw spendRefusal('bad_amount');
  if (rule.payTo && !rule.payTo.has(normalizeAddress(intent.network, intent.payTo))) throw spendRefusal('pay_to_not_allowed');
  if (intent.amount > rule.perTx) throw spendRefusal('over_per_tx');
  const already = await spent(new Date(now.getTime() - rule.windowMs));
  if (already + intent.amount > rule.perWindow) throw spendRefusal('over_window');
}

/** In-memory ledger. Forgets everything on restart; fine for tests and a single short-lived process. */
export function createMemoryLedger(): SpendLedger & { entries(): readonly SpendEntry[] } {
  const entries: SpendEntry[] = [];
  return {
    async total(network, asset, since) {
      const a = normalizeAddress(network, asset);
      let sum = 0n;
      for (const e of entries) {
        if (e.network === network && normalizeAddress(network, e.asset) === a && e.at.getTime() >= since.getTime()) sum += e.amount;
      }
      return sum;
    },
    async add(entry) {
      entries.push(entry);
    },
    entries: () => entries,
  };
}
