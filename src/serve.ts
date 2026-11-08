/**
 * `serve` — an x402-gated handler that emits an Enactment Record per paid response.
 *
 * Order is the invariant:  verify → run handler in memory → settle → sign → send.
 *  - handler throws   → 500, NOT settled (payer keeps their money)
 *  - settle fails     → 402, output discarded (no free output)
 *  - success          → 200 + PAYMENT-RESPONSE + Enactment-Record bound to the real tx hash
 *
 * Built on @x402/core primitives, not @x402/express: the express middleware settles
 * after the handler returns and never hands the tx hash to the handler.
 * Framework-agnostic: (Request) => Promise<Response>. Works with Bun.serve, Hono,
 * Next route handlers, or anything that speaks the Web standard.
 *
 * Nothing that can throw runs after settlement: asset identity is pinned at
 * construction, the payer is required at verify, and the post-settle block is
 * fenced so a failure there still returns PAYMENT-RESPONSE (money moved).
 * The buyer's Stellar auth entry is valid for the advertised maxTimeoutSeconds (x402
 * default 300 s; measured on testnet 2026-10-04: settle works at 280 s, fails at 300 s).
 * With `delegation`, a looping or too-deep delegation chain is refused before the 402 (nothing to pay).
 * The handler is bounded by `handlerTimeoutMs` (default 45s, a wide margin inside that
 * window) and a slow handler yields 504 BEFORE settle.
 *
 * API pinned against @x402/core 2.24.0 (x402ResourceServer: initialize,
 * buildPaymentRequirements, createPaymentRequiredResponse (async),
 * findMatchingRequirements, verifyPayment, settlePayment; @x402/core/http header codecs).
 */
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import type { ChainAdapter } from './adapter.js';
import {
  ENACTMENT_HEADER, encodeRecordHeader, parseRecordSkills, randomNonce, recordDigest, sha256Hex,
  type EnactmentRecord, type RecordSkill, type UnsignedEnactmentRecord,
} from './record.js';
import { signRecord } from './verify.js';
import { DELEGATION_HEADER, checkIncomingDelegation } from './delegation.js';
import { formatUnits, networkFor, recordAsset, type Caip2 } from './networks.js';

export interface X402Server {
  accepts(): Promise<PaymentRequirements[]>;
  paymentRequired(): Promise<{ status: 402; headers: Record<string, string>; body: string }>;
  verify(
    paymentSignatureHeader: string,
  ): Promise<
    | { ok: true; requirements: PaymentRequirements; payload: PaymentPayload; payer: string; asset: string; decimals: number }
    | { ok: false; reason: string }
  >;
  settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<{ ok: true; transaction: string; payer: string; amount: string; responseHeader: string } | { ok: false; reason: string }>;
}

/** Pin every advertised requirement's asset to a record asset identity. Throws at construction, never after settlement. */
export function pinRequirements(network: Caip2, list: PaymentRequirements[]): Map<PaymentRequirements, { asset: string; decimals: number }> {
  const pinned = new Map<PaymentRequirements, { asset: string; decimals: number }>();
  for (const r of list) pinned.set(r, recordAsset(network, r.asset));
  return pinned;
}

/**
 * Signs a record somewhere else (a signer process that holds the key). It receives the WHOLE unsigned record,
 * never a bare digest, so the signer can compute the digest itself: a key that signs arbitrary 32-byte digests
 * would also sign a transaction hash. Returns the signed record; serve checks it before sending.
 */
export type RecordSigner = (unsigned: UnsignedEnactmentRecord) => Promise<EnactmentRecord>;

export interface EnactServerOptions {
  network: Caip2;
  /** The agent's raw secret, or `signRecord` when the key lives outside this process. */
  agent: { address: string; agentId?: string } & ({ secret: Uint8Array } | { signRecord: RecordSigner });
  adapter: ChainAdapter;
  /** "$0.001" or "0.001" — USD, settled in the network's USDC. */
  price: string;
  facilitator: { url: string; apiKey: string };
  /** Absolute URL of this endpoint, advertised in PAYMENT-REQUIRED. */
  resource: string;
  description?: string;
  /**
   * Returns the output. With `skills` (the approved skills this output used, e.g. `recordSkills(kit.used())`
   * from `agentenact/skills`, possibly empty) the record is v0.2 and carries them; without it, v0.1.
   * An invalid list fails the request before settlement.
   */
  handler: (input: Uint8Array, req: Request) => Promise<{ body: Uint8Array; mediaType: string; skills?: RecordSkill[] }>;
  /** Test seam: replaces the x402 resource server. */
  x402?: X402Server;
  now?: () => Date;
  /** Max handler wall time before a 504 (returned BEFORE settlement). Default 45_000. */
  handlerTimeoutMs?: number;
  /** Max wall time of a remote `signRecord` (AFTER settlement: a slow signer yields 500 + PAYMENT-RESPONSE). Default 10_000. */
  recordSignTimeoutMs?: number;
  /**
   * Refuse a request whose `AgentEnact-Delegation` chain is deeper than `maxDepth` or already contains this agent
   * (508, before the 402, so nothing is ever paid). Off when absent. The header is advisory: a forged one only
   * hurts its sender; the payer's money caps are what bound spend.
   */
  delegation?: { maxDepth: number };
}

const DEFAULT_HANDLER_TIMEOUT_MS = 45_000;
const DEFAULT_RECORD_SIGN_TIMEOUT_MS = 10_000;

/** The remote signer must return exactly this record, signed with the adapter's scheme for the agent's address. */
async function checkRemoteRecord(unsigned: UnsignedEnactmentRecord, signed: EnactmentRecord, adapter: ChainAdapter): Promise<EnactmentRecord> {
  const { sig, ...rest } = signed ?? ({} as EnactmentRecord);
  if (!sig || sig.alg !== adapter.sigAlg || typeof sig.value !== 'string') throw new Error('agentenact: remote record signature malformed');
  const digest = await recordDigest(unsigned);
  if (bytesEq(await recordDigest(rest as UnsignedEnactmentRecord), digest) === false) throw new Error('agentenact: remote signer changed the record');
  if (!(await adapter.verify(digest, sig.value, unsigned.agent.address))) throw new Error('agentenact: remote record signature invalid');
  return { ...unsigned, sig: { alg: sig.alg, value: sig.value } };
}

const bytesEq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Real x402 resource server over a v2 facilitator (OZ Channels on Stellar). */
export async function createX402Server(
  opts: Pick<EnactServerOptions, 'network' | 'agent' | 'price' | 'facilitator' | 'resource' | 'description'>,
): Promise<X402Server> {
  const [{ x402ResourceServer, HTTPFacilitatorClient }, http] = await Promise.all([
    import('@x402/core/server'),
    import('@x402/core/http'),
  ]);
  const net = networkFor(opts.network);
  const auth = { Authorization: `Bearer ${opts.facilitator.apiKey}` };
  const facilitator = new HTTPFacilitatorClient({
    url: opts.facilitator.url,
    createAuthHeaders: async () => ({ verify: auth, settle: auth, supported: auth }),
  });
  const rs = new x402ResourceServer(facilitator);
  if (net.chain === 'stellar') {
    const { ExactStellarScheme } = await import('@x402/stellar/exact/server');
    rs.register(opts.network, new ExactStellarScheme());
  } else {
    const { ExactEvmScheme } = await import('@x402/evm/exact/server');
    rs.register(opts.network, new ExactEvmScheme());
  }
  await rs.initialize();
  const list = await rs.buildPaymentRequirements({
    scheme: 'exact',
    network: opts.network,
    payTo: opts.agent.address,
    price: opts.price.startsWith('$') ? opts.price : `$${opts.price}`,
  });
  const pinned = pinRequirements(opts.network, list);
  const resourceInfo = { url: opts.resource, description: opts.description ?? '', mimeType: 'application/json' };

  return {
    async accepts() {
      return list;
    },
    async paymentRequired() {
      const pr = await rs.createPaymentRequiredResponse(list, resourceInfo);
      return { status: 402, headers: { 'PAYMENT-REQUIRED': http.encodePaymentRequiredHeader(pr) }, body: JSON.stringify(pr) };
    },
    async verify(header) {
      let payload: PaymentPayload;
      try {
        payload = http.decodePaymentSignatureHeader(header);
      } catch {
        return { ok: false, reason: 'malformed_payment_signature' };
      }
      const requirements = rs.findMatchingRequirements(list, payload) ?? payload.accepted;
      if (!requirements) return { ok: false, reason: 'no_matching_requirements' };
      const pin = pinned.get(requirements);
      if (!pin) return { ok: false, reason: 'unpinned_asset' };
      const v = await rs.verifyPayment(payload, requirements);
      if (!v.isValid) return { ok: false, reason: v.invalidReason ?? 'invalid_payment' };
      if (!v.payer) return { ok: false, reason: 'missing_payer' };
      return { ok: true, requirements, payload, payer: v.payer, asset: pin.asset, decimals: pin.decimals };
    },
    async settle(payload, requirements) {
      const s = await rs.settlePayment(payload, requirements);
      if (!s.success || !s.transaction) return { ok: false, reason: s.errorReason ?? 'settlement_failed' };
      const decimals = pinned.get(requirements)?.decimals ?? 0;
      return {
        ok: true,
        transaction: s.transaction,
        payer: s.payer ?? '',
        amount: formatUnits(s.amount ?? requirements.amount, decimals),
        responseHeader: http.encodePaymentResponseHeader(s),
      };
    },
  };
}

export async function createEnactServer(opts: EnactServerOptions): Promise<(req: Request) => Promise<Response>> {
  const net = networkFor(opts.network);
  if (net.chain !== opts.adapter.chain) {
    throw new Error(`agentenact: adapter chain ${opts.adapter.chain} does not match network ${opts.network} (${net.chain})`);
  }
  const x402 = opts.x402 ?? (await createX402Server(opts));
  const now = opts.now ?? (() => new Date());
  const handlerTimeoutMs = opts.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
  const recordSignTimeoutMs = opts.recordSignTimeoutMs ?? DEFAULT_RECORD_SIGN_TIMEOUT_MS;
  const agent = opts.agent;
  // EVM addresses compare lowercase in records and adapters; a facilitator reports the payer checksummed (Base Sepolia, 2026-10-28).
  const evm = opts.network.startsWith('eip155:');
  const sign = async (unsigned: UnsignedEnactmentRecord): Promise<EnactmentRecord> =>
    'signRecord' in agent
      ? checkRemoteRecord(unsigned, await withTimeout(agent.signRecord(unsigned), recordSignTimeoutMs), opts.adapter)
      : signRecord(unsigned, opts.adapter, agent.secret);
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  return async (req) => {
    if (opts.delegation) {
      const d = checkIncomingDelegation(req.headers.get(DELEGATION_HEADER), { self: opts.agent.address, maxDepth: opts.delegation.maxDepth });
      if (!d.ok) return json(d.reason === 'bad_delegation' ? 400 : 508, { error: d.reason });
    }
    const sig = req.headers.get('PAYMENT-SIGNATURE');
    if (!sig) {
      const pr = await x402.paymentRequired();
      return new Response(pr.body, { status: pr.status, headers: { 'content-type': 'application/json', ...pr.headers } });
    }
    const v = await x402.verify(sig);
    if (!v.ok) return json(402, { error: v.reason });

    const input = new Uint8Array(await req.arrayBuffer());
    // Everything that can fail on our side runs BEFORE settlement.
    const inputMedia = req.headers.get('content-type');
    const inputHash = await sha256Hex(input);
    let out: { body: Uint8Array; mediaType: string; skills?: RecordSkill[] };
    let skills: RecordSkill[] | undefined;
    try {
      out = await withTimeout(opts.handler(input, req), handlerTimeoutMs);
      if (out.skills !== undefined) skills = parseRecordSkills(out.skills);
    } catch (e) {
      const status = (e as Error).message === 'handler_timeout' ? 504 : 500;
      return json(status, { error: status === 504 ? 'handler_timeout' : 'handler_failed' }); // nothing settled
    }
    const outputHash = await sha256Hex(out.body);

    const s = await x402.settle(v.payload, v.requirements);
    if (!s.ok) return json(402, { error: s.reason }); // output discarded

    // Money has moved. From here on, every response carries PAYMENT-RESPONSE.
    try {
      const unsigned: UnsignedEnactmentRecord = {
        v: skills ? '0.2' : '0.1',
        agent: { chain: net.chain, address: opts.agent.address, ...(opts.agent.agentId ? { agentId: opts.agent.agentId } : {}) },
        input: { sha256: inputHash, ...(inputMedia ? { mediaType: inputMedia } : {}) },
        output: { sha256: outputHash, mediaType: out.mediaType, bytes: out.body.byteLength },
        ...(skills ? { skills } : {}),
        settlement: { chain: net.chain, ref: s.transaction, payer: evm ? (v.payer || s.payer).toLowerCase() : v.payer || s.payer, amount: s.amount, asset: v.asset },
        issuedAt: now().toISOString(),
        nonce: randomNonce(),
      };
      const record = await sign(unsigned);
      // .slice() → Uint8Array<ArrayBuffer>, the BodyInit TS 5.9 accepts.
      return new Response(out.body.slice(), {
        status: 200,
        headers: {
          'content-type': out.mediaType,
          'PAYMENT-RESPONSE': s.responseHeader,
          [ENACTMENT_HEADER]: encodeRecordHeader(record),
          'access-control-expose-headers': `PAYMENT-RESPONSE, ${ENACTMENT_HEADER}`,
        },
      });
    } catch {
      return json(500, { error: 'record_failed', transaction: s.transaction }, { 'PAYMENT-RESPONSE': s.responseHeader });
    }
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error('handler_timeout')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}
