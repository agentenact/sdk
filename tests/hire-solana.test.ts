/**
 * hire() paying on Solana devnet, in process: the real @x402/svm client builds and the payer signs a real transfer
 * message (directly from a secret, and through the policy signer), the seller checks that signature and decodes the
 * transfer, and the record it returns is signed and verified by the Solana adapter over a fake RPC whose answer has
 * the shape of a recorded devnet transaction.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http';
import { createSolanaAdapter, solanaAddressOf } from '../src/adapters/solana.js';
import { base58Decode, base58Encode } from '../src/base58.js';
import { ENACTMENT_HEADER, encodeRecordHeader, sha256Hex, signRecord } from '../src/index.js';
import { hire } from '../src/hire.js';
import { createMemoryLedger } from '../src/policy.js';
import { createPolicySigner } from '../src/signer.js';
import { associatedTokenAddress, decodeSolanaTransfer } from '../src/solana-transfer.js';
import { solanaPaySigner, type SignerTransport } from '../src/wallet.js';

const NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as const;
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const FEE_PAYER = '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4';
const BLOCKHASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const TX = 'eHnxcGEbrQKB26qMVSzDEb64N5J7yQxwHnww6cHhvSw9uDNexebwscwGBtsiTeU5w76my8udmvU2yFiE2oQAjpU';

let sellerSeed: Uint8Array;
let seller: string;
let payerSeed: Uint8Array;
let payer: string;
let payerSecret: string;
let offerOverride: Record<string, unknown> = {};
let srv: ReturnType<typeof Bun.serve>;
let decoded: unknown[] = [];

const offer = () => ({
  scheme: 'exact', network: NETWORK, asset: USDC, amount: '10000', payTo: seller, maxTimeoutSeconds: 300,
  extra: { feePayer: FEE_PAYER, recentBlockhash: BLOCKHASH, lastValidBlockHeight: 1 }, ...offerOverride,
});

/** A getTransaction answer shaped like the recorded devnet one: one transferChecked from payer to seller. */
const rpc = (async (_u: string | URL | Request, init?: RequestInit) => {
  const { params } = JSON.parse(String(init?.body)) as { params: [string] };
  if (params[0] !== TX) return Response.json({ jsonrpc: '2.0', id: 1, result: null });
  const [source, destination] = await Promise.all([associatedTokenAddress(payer, USDC, TOKEN), associatedTokenAddress(seller, USDC, TOKEN)]);
  return Response.json({
    jsonrpc: '2.0', id: 1,
    result: {
      blockTime: Math.floor(Date.now() / 1000) - 5,
      slot: 517_454_415,
      version: 0,
      meta: {
        err: null, fee: 10_000, innerInstructions: [], logMessages: [],
        preTokenBalances: [
          { accountIndex: 2, mint: USDC, owner: payer, programId: TOKEN, uiTokenAmount: { amount: '50000', decimals: 6 } },
          { accountIndex: 3, mint: USDC, owner: seller, programId: TOKEN, uiTokenAmount: { amount: '0', decimals: 6 } },
        ],
        postTokenBalances: [
          { accountIndex: 2, mint: USDC, owner: payer, programId: TOKEN, uiTokenAmount: { amount: '40000', decimals: 6 } },
          { accountIndex: 3, mint: USDC, owner: seller, programId: TOKEN, uiTokenAmount: { amount: '10000', decimals: 6 } },
        ],
      },
      transaction: {
        signatures: [TX],
        message: {
          accountKeys: [FEE_PAYER, payer, source, destination, USDC, TOKEN].map((pubkey, i) => ({ pubkey, signer: i < 2, writable: i === 0 || i === 2 || i === 3, source: 'transaction' })),
          instructions: [
            { programId: 'ComputeBudget111111111111111111111111111111', accounts: [], data: 'K1FDJ7', stackHeight: 1 },
            { program: 'spl-token', programId: TOKEN, parsed: { type: 'transferChecked', info: { source, mint: USDC, destination, authority: payer, tokenAmount: { amount: '10000', decimals: 6, uiAmount: 0.01, uiAmountString: '0.01' } } }, stackHeight: 1 },
          ],
        },
      },
    },
  });
}) as typeof fetch;
const adapter = createSolanaAdapter({ network: NETWORK, fetch: rpc });

beforeAll(async () => {
  sellerSeed = crypto.getRandomValues(new Uint8Array(32));
  seller = await solanaAddressOf(sellerSeed);
  payerSeed = crypto.getRandomValues(new Uint8Array(32));
  payer = await solanaAddressOf(payerSeed);
  payerSecret = base58Encode(new Uint8Array([...payerSeed, ...base58Decode(payer)]));
  srv = Bun.serve({
    port: 0,
    async fetch(req) {
      const sig = req.headers.get('PAYMENT-SIGNATURE');
      if (!sig) {
        const pr = { x402Version: 2, resource: { url: req.url, description: '', mimeType: 'text/plain' }, accepts: [offer()] };
        return new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(pr as never) } });
      }
      const p = decodePaymentSignatureHeader(sig) as unknown as { payload: { transaction: string } };
      // Wire transaction: shortvec signature count (2 here), the signatures, then the message the payer signed.
      const wire = Uint8Array.from(atob(p.payload.transaction), (c) => c.charCodeAt(0));
      const message = wire.slice(1 + 64 * wire[0]!);
      const payerSig = wire.slice(1 + 64, 1 + 128);
      const key = await crypto.subtle.importKey('raw', base58Decode(payer).slice(), { name: 'Ed25519' }, false, ['verify']);
      if (wire[0] !== 2 || !(await crypto.subtle.verify('Ed25519', key, payerSig, message))) return new Response('{"error":"bad"}', { status: 402 });
      decoded.push((await decodeSolanaTransfer(btoa(String.fromCharCode(...message)), NETWORK, { payer, payTo: seller })).intent);
      const input = new Uint8Array(await req.arrayBuffer());
      const body = new TextEncoder().encode(`echo:${new TextDecoder().decode(input)}`);
      const rec = await signRecord(
        {
          v: '0.1',
          agent: { chain: 'solana', address: seller },
          input: { sha256: await sha256Hex(input) },
          output: { sha256: await sha256Hex(body), mediaType: 'text/plain', bytes: body.byteLength },
          settlement: { chain: 'solana', ref: TX, payer, amount: '0.010000', asset: USDC },
          issuedAt: new Date().toISOString(),
          nonce: '00'.repeat(16),
        },
        adapter,
        sellerSeed,
      );
      const settled = btoa(JSON.stringify({ success: true, transaction: TX, network: NETWORK, payer }));
      return new Response(body, { headers: { 'content-type': 'text/plain', 'PAYMENT-RESPONSE': settled, [ENACTMENT_HEADER]: encodeRecordHeader(rec) } });
    },
  });
});
afterAll(() => srv.stop());

const url = () => `http://localhost:${srv.port}/echo`;
const reset = () => {
  decoded = [];
  offerOverride = {};
};

describe('hire on Solana devnet', () => {
  it('pays with a transfer the facilitator pays the fee for, and verifies the record end to end', async () => {
    reset();
    let reserved: unknown = null;
    const r = await hire(url(), { method: 'POST', body: 'hi' }, { adapter, payer: { secret: payerSecret, network: NETWORK }, maxAmount: '0.05', onPay: async (o) => void (reserved = o) });
    expect(new TextDecoder().decode(r.output)).toBe('echo:hi');
    expect(r.problems).toEqual([]);
    expect(r.consistent).toBe(true);
    expect(r.verification?.ok).toBe(true);
    expect(decoded).toEqual([{ network: NETWORK, asset: USDC, amount: 10_000n, from: payer, payTo: seller }]);
    expect(reserved).toEqual({ scheme: 'exact', network: NETWORK, asset: USDC, assetId: USDC, amount: '10000', decimal: '0.010000', payTo: seller, maxTimeoutSeconds: 300 });
  });

  it('pays through the policy signer: the agent holds no key, the signer decodes the message and counts the spend', async () => {
    reset();
    const ledger = createMemoryLedger();
    const signer = await createPolicySigner({
      keys: [{ network: NETWORK, secret: payerSecret }],
      policy: { rules: [{ network: NETWORK, asset: USDC, perTx: '0.02', perWindow: '0.10' }] },
      ledger,
    });
    const transport: SignerTransport = (req) => signer.handle(req);
    const r = await hire(url(), { method: 'POST', body: 'hi' }, { adapter, payer: { signer: solanaPaySigner(transport, { network: NETWORK, address: payer }), network: NETWORK }, maxAmount: '0.05' });
    expect(r.consistent).toBe(true);
    expect(await ledger.total(NETWORK, USDC, new Date(0))).toBe(10_000n);
    // Over the per-transaction cap: the signer refuses, nothing reaches the seller signed.
    offerOverride = { amount: '30000' };
    const refused = await hire(url(), { method: 'POST', body: 'hi' }, { adapter, payer: { signer: solanaPaySigner(transport, { network: NETWORK, address: payer }), network: NETWORK }, maxAmount: '0.05' }).catch((e) => e as Error);
    expect(String((refused as Error).message)).toContain('spend refused: over_per_tx');
    expect(decoded.length).toBe(1);
  });

  it('refuses an offer without a fee payer, or one that makes the payer pay the fee, before signing', async () => {
    for (const extra of [{ recentBlockhash: BLOCKHASH }, { feePayer: 'not-an-address', recentBlockhash: BLOCKHASH }]) {
      reset();
      offerOverride = { extra };
      const e = await hire(url(), {}, { adapter, payer: { secret: payerSecret, network: NETWORK }, maxAmount: '0.05' }).catch((x) => x as { reason?: string });
      expect((e as { reason?: string }).reason).toBe('bad_fee_payer');
    }
    reset();
    offerOverride = { extra: { feePayer: payer, recentBlockhash: BLOCKHASH } };
    const self = await hire(url(), {}, { adapter, payer: { secret: payerSecret, network: NETWORK }, maxAmount: '0.05' }).catch((x) => x as { reason?: string });
    expect((self as { reason?: string }).reason).toBe('bad_fee_payer');
    expect(decoded).toEqual([]);
  });
});
