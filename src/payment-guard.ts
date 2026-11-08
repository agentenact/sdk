/**
 * The payment guard behind `hire()`: a fetch interceptor placed UNDER the x402 client.
 *
 * On the first 402 it checks the offer against a policy (the network, the pinned asset, `exact`, a valid
 * `payTo` that is not the payer, amount <= the cap, a bounded authorization lifetime) and throws BEFORE the
 * x402 client signs anything. A paid request (one carrying PAYMENT-SIGNATURE) passes only if it carries
 * exactly the approved offer, only once, and only after `onPay` has run (it may refuse, e.g. on a spend cap).
 * x402 v1 (X-PAYMENT) is refused. `onPay` runs on the signed request, never at 402 time, so a signing failure
 * leaves no reservation behind.
 *
 * Stellar, EVM (USDC via EIP-3009) and Solana (an SPL transfer the facilitator pays the fee for) networks. EVM
 * addresses compare case-insensitively, Stellar and Solana ones exactly. On Solana the offer's `extra.feePayer` must
 * be a real address other than the payer: a payer that is also the fee payer would pay the network fee and sign as
 * the transaction's source. The chain SDKs are optional peers, so they are loaded lazily, on the first 402;
 * importing this module needs none of them, and an EVM or Solana guard never loads the Stellar SDK.
 */
import { isSolanaAddress } from './base58.js';
import { formatUnits, networkFor, parseUnits, type Caip2 } from './networks.js';

/** The buyer's signed authorization may stay valid at most this long (x402 default; @x402/stellar derives maxLedger from it). */
export const MAX_TIMEOUT_SECONDS = 300;

export type PaymentRefusalReason =
  | 'no_max_amount' | 'bad_max_amount'
  | 'not_x402_v2' | 'no_offer' | 'ambiguous_offer' | 'bad_scheme' | 'bad_asset' | 'bad_pay_to'
  | 'pays_self' | 'pay_to_mismatch' | 'bad_amount' | 'over_cap' | 'bad_timeout' | 'bad_fee_payer' | 'unapproved_payment' | 'second_payment';

export interface PaymentRefusal extends Error {
  code: 'payment_refused';
  /** A PaymentRefusalReason, or the caller's own reason when an `onPay` hook refuses (e.g. 'day_cap'). */
  reason: string;
}

/** A refusal: nothing was signed or sent. Callers may throw their own from `onPay`. */
export const paymentRefusal = (reason: PaymentRefusalReason | (string & {})): PaymentRefusal =>
  Object.assign(new Error(`agentenact: payment refused: ${reason}`), { code: 'payment_refused' as const, reason });

export const isPaymentRefusal = (e: unknown): e is PaymentRefusal =>
  !!e && typeof e === 'object' && (e as { code?: unknown }).code === 'payment_refused';

/** What the seller asked for, as handed to `onPay`. */
export interface PaymentOffer {
  scheme: string;
  network: string;
  /** The x402 asset id (the SAC `C…` on Stellar, the lowercase token contract on EVM, the mint on Solana). */
  asset: string;
  /** The chain's unspoofable asset identity (`CODE:ISSUER`, or the lowercase token contract), as in a record's `settlement.asset`. */
  assetId: string;
  /** Base units, as sent on the wire. */
  amount: string;
  /** The same amount in whole units of the asset, fixed fraction width ("0.0010000"). */
  decimal: string;
  payTo: string;
  maxTimeoutSeconds: number;
}

export interface PaymentPolicy {
  /** The payer's network. */
  network: Caip2;
  /** Pinned asset as `CODE:ISSUER` (Stellar) or the token contract (EVM); defaults to the network's pinned USDC. Unknown assets throw. */
  asset?: string;
  /** Highest amount to pay, a decimal in whole units of the asset ("0.05"). */
  maxAmount: string;
  /** The payer's own address; an offer paying it is refused. */
  self: string;
  /** When set, the only address the offer may pay. */
  payTo?: string;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface PaymentGuard {
  fetch: Fetch;
  /** The offer that passed the 402 check, or null. */
  approved(): PaymentOffer | null;
  /** true once a signed request was claimed (onPay accepted it and it was handed on): a payment may have left. */
  paid(): boolean;
}

interface Requirements {
  scheme?: unknown; network?: unknown; asset?: unknown; amount?: unknown; payTo?: unknown;
  maxTimeoutSeconds?: unknown; extra?: unknown;
}

interface Deps {
  decodeRequired(h: string): { x402Version?: unknown; accepts?: unknown };
  decodeSignature(h: string): { x402Version?: unknown; accepted?: unknown };
  isAddress(a: string): boolean;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVM_ZERO = `0x${'0'.repeat(40)}`;

let http: Promise<Pick<Deps, 'decodeRequired' | 'decodeSignature'>> | undefined;
let stellarAddress: Promise<Deps['isAddress']> | undefined;
type Family = 'stellar' | 'evm' | 'solana';
const loadDeps = async (family: Family): Promise<Deps> => {
  const [h, isAddress] = await Promise.all([
    (http ??= import('@x402/core/http').then((m) => ({
      decodeRequired: m.decodePaymentRequiredHeader as Deps['decodeRequired'],
      decodeSignature: m.decodePaymentSignatureHeader as Deps['decodeSignature'],
    }))),
    family === 'evm'
      ? (a: string) => EVM_ADDRESS.test(a) && a.toLowerCase() !== EVM_ZERO
      : family === 'solana'
        ? isSolanaAddress
        : (stellarAddress ??= import('@stellar/stellar-sdk').then((sdk) => (a: string) => sdk.StrKey.isValidEd25519PublicKey(a))),
  ]);
  return { ...h, isAddress };
};

interface Resolved {
  network: Caip2;
  family: Family;
  /** EVM: addresses and assets compare lowercase. */
  evm: boolean;
  x402Asset: string;
  assetId: string;
  decimals: number;
  maxUnits: bigint;
  self: string;
  payTo?: string;
}

/** Validate the policy against the network table. Throws on an unknown network or asset, or a bad cap. */
function resolve(p: PaymentPolicy): Resolved {
  const net = networkFor(p.network);
  const family: Family = net.chain === 'stellar' ? 'stellar' : net.chain === 'solana' ? 'solana' : 'evm';
  const evm = family === 'evm';
  const entries = Object.entries(net.assets);
  const want = evm ? p.asset?.toLowerCase() : p.asset;
  const hit = want === undefined ? entries[0] : entries.find(([, a]) => a.asset === want);
  if (!hit) throw new Error(`agentenact: unknown asset ${p.asset} on ${p.network}`);
  const [x402Asset, { asset: assetId, decimals }] = hit;
  if (typeof p.maxAmount !== 'string') throw paymentRefusal('no_max_amount');
  let maxUnits: bigint;
  try {
    maxUnits = parseUnits(p.maxAmount, decimals);
  } catch {
    throw paymentRefusal('bad_max_amount');
  }
  if (maxUnits <= 0n || p.maxAmount.length > 30) throw paymentRefusal('bad_max_amount');
  const norm = (a: string) => (evm ? a.toLowerCase() : a);
  return {
    network: p.network, family, evm, x402Asset, assetId, decimals, maxUnits, self: norm(p.self),
    ...(p.payTo !== undefined ? { payTo: norm(p.payTo) } : {}),
  };
}

function check(header: string | null, r: Resolved, d: Deps): { raw: Requirements; offer: PaymentOffer } {
  if (!header) throw paymentRefusal('not_x402_v2');
  let offers: Requirements[];
  try {
    const decoded = d.decodeRequired(header);
    if (decoded.x402Version !== 2 || !Array.isArray(decoded.accepts)) throw paymentRefusal('not_x402_v2');
    offers = (decoded.accepts as Requirements[]).filter((a) => a && a.network === r.network);
  } catch {
    throw paymentRefusal('not_x402_v2');
  }
  if (offers.length === 0) throw paymentRefusal('no_offer');
  if (offers.length > 1) throw paymentRefusal('ambiguous_offer');
  const o = offers[0]!;
  if (o.scheme !== 'exact') throw paymentRefusal('bad_scheme');
  if (typeof o.asset !== 'string' || (r.evm ? o.asset.toLowerCase() : o.asset) !== r.x402Asset) throw paymentRefusal('bad_asset');
  if (typeof o.payTo !== 'string' || !d.isAddress(o.payTo)) throw paymentRefusal('bad_pay_to');
  const payTo = r.evm ? o.payTo.toLowerCase() : o.payTo;
  if (payTo === r.self) throw paymentRefusal('pays_self');
  if (r.payTo !== undefined && payTo !== r.payTo) throw paymentRefusal('pay_to_mismatch');
  if (typeof o.amount !== 'string' || !/^[1-9]\d{0,18}$/.test(o.amount)) throw paymentRefusal('bad_amount');
  if (BigInt(o.amount) > r.maxUnits) throw paymentRefusal('over_cap');
  const t = o.maxTimeoutSeconds;
  if (typeof t !== 'number' || !Number.isInteger(t) || t < 1 || t > MAX_TIMEOUT_SECONDS) throw paymentRefusal('bad_timeout');
  if (r.family === 'solana') {
    const feePayer = (o.extra as { feePayer?: unknown } | undefined)?.feePayer;
    if (!isSolanaAddress(feePayer) || feePayer === r.self) throw paymentRefusal('bad_fee_payer');
  }
  return {
    raw: o,
    offer: {
      scheme: 'exact', network: r.network, asset: r.x402Asset, assetId: r.assetId,
      amount: o.amount, decimal: formatUnits(o.amount, r.decimals), payTo, maxTimeoutSeconds: t,
    },
  };
}

/**
 * Check one 402 `PAYMENT-REQUIRED` header against a policy. Returns the single compliant offer or throws a
 * `payment_refused` error. Async only because the chain SDKs load lazily.
 */
export async function checkPaymentRequired(header: string | null, policy: PaymentPolicy): Promise<PaymentOffer> {
  const r = resolve(policy);
  return check(header, r, await loadDeps(r.family)).offer;
}

/** JSON with object keys sorted at every level, so `extra` compares by content, not key order. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([p], [q]) => (p < q ? -1 : p > q ? 1 : 0)))
      : x,
  );
const same = (a: Requirements, b: Requirements) =>
  a.scheme === b.scheme && a.network === b.network && a.asset === b.asset && a.amount === b.amount && a.payTo === b.payTo &&
  a.maxTimeoutSeconds === b.maxTimeoutSeconds && canonical(a.extra ?? null) === canonical(b.extra ?? null);

/**
 * Wrap `base` with the guard. Policy errors (unknown asset, bad cap) throw here, before any request.
 * `onPay` is called once, with the approved offer, right before the signed request leaves; if it throws,
 * nothing leaves and the claim is released (a retry may call it again).
 */
export function createPaymentGuard(base: Fetch, policy: PaymentPolicy, onPay?: (offer: PaymentOffer) => Promise<void>): PaymentGuard {
  const r = resolve(policy);
  let approvedRaw: Requirements | null = null;
  let approvedOffer: PaymentOffer | null = null;
  // `claimed` is taken synchronously (no await between the check and the set), so two concurrent signed requests
  // cannot both go out. It is released only if onPay refuses (nothing reserved, nothing sent); once the request
  // leaves it stays.
  let claimed = false;
  const guarded: Fetch = async (input, init) => {
    const d = await loadDeps(r.family);
    const req = new Request(input, init);
    if (req.headers.has('X-PAYMENT')) throw paymentRefusal('not_x402_v2');
    const sig = req.headers.get('PAYMENT-SIGNATURE');
    if (sig) {
      if (claimed) throw paymentRefusal('second_payment');
      let accepted: Requirements | undefined;
      try {
        const s = d.decodeSignature(sig);
        if (s.x402Version !== 2) throw paymentRefusal('not_x402_v2');
        accepted = s.accepted as Requirements | undefined;
      } catch (e) {
        if (isPaymentRefusal(e) && e.reason === 'not_x402_v2') throw e;
        throw paymentRefusal('unapproved_payment');
      }
      if (!accepted || typeof accepted !== 'object' || !approvedRaw || !approvedOffer || !same(accepted, approvedRaw)) {
        throw paymentRefusal('unapproved_payment');
      }
      claimed = true;
      try {
        await onPay?.(approvedOffer);
      } catch (e) {
        claimed = false;
        throw e;
      }
      return base(req);
    }
    const res = await base(req);
    if (res.status === 402 && !claimed) {
      const a = check(res.headers.get('PAYMENT-REQUIRED'), r, d);
      approvedRaw = a.raw;
      approvedOffer = a.offer;
    }
    return res;
  };
  return { fetch: guarded, approved: () => approvedOffer, paid: () => claimed };
}
