/**
 * `hire` — call a paid agent, pay via x402 if asked, then VERIFY what came back:
 *   1. the Enactment-Record signature/settlement/timing/identity (verifyRecord)
 *   2. consistency with what we observed: input hash == what we sent, output hash ==
 *      what we received, record.settlement.ref == PAYMENT-RESPONSE.transaction.
 * Never throws on a bad record; reports so the caller can refuse to pay feedback forward.
 * With a `payer`, every 402 passes the payment guard first (see payment-guard.ts): `maxAmount` is required.
 */
import type { ChainAdapter } from './adapter.js';
import { ENACTMENT_HEADER, decodeRecordHeader, sha256Hex, type EnactmentRecord } from './record.js';
import { verifyRecord, type VerifyResult } from './verify.js';
import { networkFor, type Caip2 } from './networks.js';
import { createPaymentGuard, paymentRefusal, type PaymentGuard, type PaymentOffer } from './payment-guard.js';
import type { EvmPaySigner, SolanaPaySigner, StellarPaySigner } from './wallet.js';

export {
  checkPaymentRequired, createPaymentGuard, isPaymentRefusal, paymentRefusal,
  type PaymentGuard, type PaymentOffer, type PaymentPolicy, type PaymentRefusal, type PaymentRefusalReason,
} from './payment-guard.js';

export interface HireOptions {
  adapter: ChainAdapter;
  /**
   * Payer: a raw secret (S… on Stellar, 0x… hex on EVM, base58 keypair or seed on Solana), or a `signer` from
   * `agentenact/wallet` (`stellarPaySigner`, `evmPaySigner`, `solanaPaySigner`) that forwards every signature to a
   * policy signer outside the sandbox, so the agent never holds the key. EVM networks pay USDC with an EIP-3009
   * authorization, Solana with an SPL transfer whose fee the seller's facilitator pays (x402 `exact`).
   * Omit when the endpoint is free or already paid.
   */
  payer?: { secret: string; network: Caip2 } | { signer: StellarPaySigner | EvmPaySigner | SolanaPaySigner; network: Caip2 };
  /**
   * REQUIRED whenever `payer` is set: the most this call may pay, a decimal in whole units of the asset
   * ('0.05'). hire() refuses, before anything is signed or sent, if it is missing or the seller asks for more.
   */
  maxAmount?: string;
  /** Pin the asset as `CODE:ISSUER` (Stellar) or the token contract (EVM). Default: the network's pinned USDC. Anything else is refused. */
  asset?: string;
  /** Pin the seller: refuse any offer that pays another address. */
  payTo?: string;
  /**
   * Called once with the approved offer, right before the signed payment leaves (the reservation point for a
   * spend ledger). Throw to refuse: nothing is sent. Not called when the endpoint is free.
   */
  onPay?: (offer: PaymentOffer) => Promise<void>;
  fetch?: typeof fetch;
  windowSeconds?: number;
}

export interface HireResult {
  response: Response;
  output: Uint8Array;
  settlement: { transaction: string; network: string; payer: string } | null;
  /** The offer a signed payment was sent for (it may or may not have settled), or null when nothing was paid. */
  paid: PaymentOffer | null;
  record: EnactmentRecord | null;
  verification: VerifyResult | null;
  /** true only when a record is present, verifies, and matches what we sent/received/paid. */
  consistent: boolean;
  problems: string[];
}

type SchemeClient = { address: string; client: unknown };

/** The x402 client scheme for the payer's network, built from its key or remote signer. */
async function payerScheme(payer: NonNullable<HireOptions['payer']>): Promise<SchemeClient> {
  if (payer.network.startsWith('stellar:')) {
    if ('signer' in payer && !('signAuthEntry' in payer.signer)) throw new Error(`agentenact: ${payer.network} needs a stellar signer`);
    const [{ createEd25519Signer }, { ExactStellarScheme }] = await Promise.all([import('@x402/stellar'), import('@x402/stellar/exact/client')]);
    const signer = 'signer' in payer ? (payer.signer as StellarPaySigner) : createEd25519Signer(payer.secret, payer.network);
    return { address: signer.address, client: new ExactStellarScheme(signer) };
  }
  if (payer.network.startsWith('eip155:')) {
    if ('signer' in payer && !('signTypedData' in payer.signer)) throw new Error(`agentenact: ${payer.network} needs an EVM signer`);
    const { ExactEvmScheme } = await import('@x402/evm/exact/client');
    let signer: EvmPaySigner;
    if ('signer' in payer) signer = payer.signer as EvmPaySigner;
    else {
      const { privateKeyToAccount } = await import('viem/accounts');
      const hex = payer.secret.startsWith('0x') ? payer.secret : `0x${payer.secret}`;
      signer = privateKeyToAccount(hex as `0x${string}`);
    }
    return { address: signer.address, client: new ExactEvmScheme(signer) };
  }
  if (payer.network.startsWith('solana:')) {
    if ('signer' in payer && !('signSolanaMessage' in payer.signer)) throw new Error(`agentenact: ${payer.network} needs a Solana signer`);
    return solanaScheme(payer);
  }
  throw new Error(`agentenact: hire cannot pay on ${payer.network}`);
}

/**
 * @x402/svm's client over a SolanaPaySigner. kit's signer interface carries no offer, so the scheme is wrapped: the
 * offer's payTo is held while its one message is built and signed, and a message signed outside that is refused.
 */
async function solanaScheme(payer: NonNullable<HireOptions['payer']>): Promise<SchemeClient> {
  const [{ ExactSvmScheme }, { base58Decode, base58Encode }, solana] = await Promise.all([
    import('@x402/svm/exact/client'),
    import('./base58.js'),
    import('./adapters/solana.js'),
  ]);
  let base: SolanaPaySigner;
  if ('signer' in payer) base = payer.signer as SolanaPaySigner;
  else {
    const seed = base58Decode(payer.secret);
    const address = await solana.solanaAddressOf(seed);
    base = {
      address,
      signSolanaMessage: async (message) => base58Encode(await solana.ed25519Sign(Uint8Array.from(atob(message), (c) => c.charCodeAt(0)), seed)),
    };
  }
  let payTo: string | undefined;
  const signer = {
    address: base.address,
    async signTransactions(txs: readonly { messageBytes: Uint8Array }[]) {
      const to = payTo;
      if (!to) throw new Error('agentenact: a Solana message outside a payment');
      return Promise.all(
        txs.map(async (tx) => {
          const sig = await base.signSolanaMessage(btoa(String.fromCharCode(...new Uint8Array(tx.messageBytes))), to);
          return Object.freeze({ [base.address]: base58Decode(sig) });
        }),
      );
    },
  };
  const net = networkFor(payer.network);
  const inner = new ExactSvmScheme(signer as never, { rpcUrl: net.rpcUrl! });
  // The pinned USDC mints are classic SPL Token mints (read live 2026-11-01): seed the scheme's mint cache with them, so
  // no RPC answer decides the token program or the decimals. Other mints are refused by the guard before this runs.
  const cache = (inner as unknown as { mintCache?: unknown }).mintCache;
  if (cache instanceof Map) {
    for (const a of Object.values(net.assets)) {
      cache.set(`${payer.network}:${a.asset}`, Promise.resolve({ decimals: a.decimals, programAddress: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }));
    }
  }
  const client = Object.assign(Object.create(inner) as typeof inner, {
    async createPaymentPayload(version: number, req: { payTo: string }) {
      payTo = req.payTo;
      try {
        return await inner.createPaymentPayload(version, req as never);
      } finally {
        payTo = undefined;
      }
    },
  });
  return { address: base.address, client };
}

async function payingFetch(
  base: typeof fetch,
  opts: HireOptions & { payer: NonNullable<HireOptions['payer']> },
): Promise<{ fetch: typeof fetch; guard: PaymentGuard }> {
  const { payer } = opts;
  networkFor(payer.network); // unknown networks throw before anything else
  // Before anything is imported, signed or sent: a payer without a cap is refused.
  if (opts.maxAmount === undefined) throw paymentRefusal('no_max_amount');
  const [{ wrapFetchWithPaymentFromConfig }, scheme] = await Promise.all([import('@x402/fetch'), payerScheme(payer)]);
  const signer = { address: scheme.address };
  // The guard sits UNDER the x402 client: it sees the 402 first and throws before the client can sign.
  const guard = createPaymentGuard(
    base as never,
    {
      network: payer.network,
      maxAmount: opts.maxAmount,
      self: signer.address,
      ...(opts.asset !== undefined ? { asset: opts.asset } : {}),
      ...(opts.payTo !== undefined ? { payTo: opts.payTo } : {}),
    },
    opts.onPay,
  );
  const wrapped = wrapFetchWithPaymentFromConfig(guard.fetch as typeof fetch, {
    schemes: [{ network: payer.network, client: scheme.client as never }],
  }) as typeof fetch;
  return { fetch: wrapped, guard };
}

function decodePaymentResponse(h: string | null): HireResult['settlement'] {
  if (!h) return null;
  try {
    const j = JSON.parse(atob(h.replace(/-/g, '+').replace(/_/g, '/'))) as { transaction?: string; network?: string; payer?: string };
    return j.transaction ? { transaction: j.transaction, network: j.network ?? '', payer: j.payer ?? '' } : null;
  } catch {
    return null;
  }
}

export async function hire(
  url: string,
  init: RequestInit & { body?: string | Uint8Array },
  opts: HireOptions,
): Promise<HireResult> {
  const base = opts.fetch ?? globalThis.fetch;
  const paying = opts.payer ? await payingFetch(base, { ...opts, payer: opts.payer }) : null;
  const f = paying ? paying.fetch : base;
  const sent = typeof init.body === 'string' ? new TextEncoder().encode(init.body) : (init.body ?? new Uint8Array());

  const response = await f(url, { ...init, body: init.body === undefined ? undefined : sent.slice() });
  const output = new Uint8Array(await response.arrayBuffer());
  const settlement = decodePaymentResponse(response.headers.get('PAYMENT-RESPONSE'));
  const paid = paying?.guard.paid() ? paying.guard.approved() : null;

  const header = response.headers.get(ENACTMENT_HEADER);
  if (!header) {
    return { response, output, settlement, paid, record: null, verification: null, consistent: false, problems: ['no Enactment-Record header'] };
  }
  let record: EnactmentRecord;
  try {
    record = decodeRecordHeader(header);
  } catch (e) {
    return {
      response, output, settlement, paid, record: null, verification: null, consistent: false,
      problems: [`malformed record: ${(e as Error).message}`],
    };
  }

  const problems: string[] = [];
  if (record.input.sha256 !== (await sha256Hex(sent))) problems.push('input hash mismatch');
  if (record.output.sha256 !== (await sha256Hex(output))) problems.push('output hash mismatch');
  if (!settlement) problems.push('no PAYMENT-RESPONSE header');
  else if (record.settlement.ref !== settlement.transaction) problems.push('settlement ref mismatch');

  const verification = await verifyRecord(record, opts.adapter, opts.windowSeconds ? { windowSeconds: opts.windowSeconds } : {});
  if (!verification.ok && verification.failure) {
    problems.push(`record verification failed: ${verification.failure.check}/${verification.failure.reason}`);
  }

  return { response, output, settlement, paid, record, verification, consistent: problems.length === 0, problems };
}
