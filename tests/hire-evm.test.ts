/**
 * hire() paying on an EVM network (Base Sepolia, USDC via EIP-3009), in process: a real x402 EVM client signs a
 * real TransferWithAuthorization, the seller checks the signature recovers the payer, and the record it returns is
 * signed and verified by the real EVM adapter over a fake chain client with a realistic receipt.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http';
import { encodeAbiParameters, keccak256, pad, toHex, verifyTypedData, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ENACTMENT_HEADER, encodeRecordHeader, hexToBytes, sha256Hex, signRecord } from '../src/index.js';
import { createEvmAdapter, type EvmReadClient } from '../src/adapters/evm.js';
import { hire } from '../src/hire.js';
import { createPolicySigner } from '../src/signer.js';
import { createMemoryLedger } from '../src/policy.js';
import { evmPaySigner, type SignerTransport } from '../src/wallet.js';

const NETWORK = 'eip155:84532' as const;
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const usdc = USDC.toLowerCase();
const TX = `0x${'ab'.repeat(32)}` as Hex;
const TRANSFER = keccak256(toHex('Transfer(address,address,uint256)'));

let sellerKey: Hex;
let seller: string;
let payerKey: Hex;
let payer: string;
let amount = '10000';
let offerOverride: Record<string, unknown> = {};
let seen: Request[] = [];
let accepted: unknown[] = [];
let srv: ReturnType<typeof Bun.serve>;

const offer = () => ({
  scheme: 'exact', network: NETWORK, asset: USDC, amount, payTo: seller, maxTimeoutSeconds: 300,
  extra: { name: 'USDC', version: '2' }, ...offerOverride,
});

// What Base Sepolia answers for the settlement: a successful receipt with the USDC Transfer log, a block, and identity.
const chain: EvmReadClient = {
  async getTransactionReceipt({ hash }) {
    if (hash !== TX) throw new Error('not found');
    return {
      status: 'success',
      blockNumber: 33_000_000n,
      logs: [
        // A gas-token-free facilitator settle also emits AuthorizationUsed; the adapter must skip it.
        { address: usdc, topics: [keccak256(toHex('AuthorizationUsed(address,bytes32)')), pad(payer as Hex)], data: `0x${'00'.repeat(32)}` },
        { address: USDC, topics: [TRANSFER, pad(payer as Hex), pad(seller as Hex)], data: encodeAbiParameters([{ type: 'uint256' }], [BigInt(amount)]) },
      ],
    };
  },
  async getBlock() {
    return { timestamp: BigInt(Math.floor(Date.now() / 1000) - 5) };
  },
  async readContract({ functionName }) {
    return functionName === 'ownerOf' ? '0x00000000000000000000000000000000000000Ee' : seller;
  },
};
const adapter = createEvmAdapter({ network: NETWORK, client: chain });

beforeAll(() => {
  sellerKey = generatePrivateKey();
  seller = privateKeyToAccount(sellerKey).address.toLowerCase();
  payerKey = generatePrivateKey();
  payer = privateKeyToAccount(payerKey).address.toLowerCase();
  srv = Bun.serve({
    port: 0,
    async fetch(req) {
      const sig = req.headers.get('PAYMENT-SIGNATURE');
      if (!sig) {
        const pr = { x402Version: 2, resource: { url: req.url, description: '', mimeType: 'text/plain' }, accepts: [offer()] };
        return new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(pr as never) } });
      }
      const p = decodePaymentSignatureHeader(sig) as unknown as {
        accepted: unknown;
        payload: { signature: Hex; authorization: { from: Hex; to: Hex; value: string; validAfter: string; validBefore: string; nonce: Hex } };
      };
      accepted.push(p.accepted);
      const a = p.payload.authorization;
      const ok = await verifyTypedData({
        address: a.from,
        domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: USDC },
        types: { TransferWithAuthorization: [
          { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
        ] },
        primaryType: 'TransferWithAuthorization',
        message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce },
        signature: p.payload.signature,
      });
      if (!ok || a.to.toLowerCase() !== seller || a.value !== amount) return new Response('{"error":"bad"}', { status: 402 });
      const input = new Uint8Array(await req.arrayBuffer());
      const body = new TextEncoder().encode(`echo:${new TextDecoder().decode(input)}`);
      const rec = await signRecord(
        {
          v: '0.1',
          agent: { chain: 'base', address: seller, agentId: '7' },
          input: { sha256: await sha256Hex(input) },
          output: { sha256: await sha256Hex(body), mediaType: 'text/plain', bytes: body.byteLength },
          settlement: { chain: 'base', ref: TX, payer: a.from.toLowerCase(), amount: '0.010000', asset: usdc },
          issuedAt: new Date().toISOString(),
          nonce: '00'.repeat(16),
        },
        adapter,
        hexToBytes(sellerKey.slice(2)),
      );
      const settled = btoa(JSON.stringify({ success: true, transaction: TX, network: NETWORK, payer: a.from }));
      return new Response(body, { headers: { 'content-type': 'text/plain', 'PAYMENT-RESPONSE': settled, [ENACTMENT_HEADER]: encodeRecordHeader(rec) } });
    },
  });
});
afterAll(() => srv.stop());

const watching: typeof fetch = (async (i: string | URL | Request, init?: RequestInit) => (seen.push(new Request(i, init)), globalThis.fetch(i, init))) as never;
const url = () => `http://localhost:${srv.port}/echo`;
const pay = (extra: Partial<Parameters<typeof hire>[2]> = {}) =>
  hire(url(), { method: 'POST', body: 'hi' }, { adapter, payer: { secret: payerKey, network: NETWORK }, maxAmount: '0.05', fetch: watching, ...extra })
    .catch((e) => e as { code?: string; reason?: string; message: string });
const signed = () => seen.filter((r) => r.headers.has('PAYMENT-SIGNATURE')).length;
const reset = () => {
  seen = [];
  accepted = [];
  amount = '10000';
  offerOverride = {};
};

describe('hire on Base Sepolia', () => {
  it('pays with an EIP-3009 authorization and verifies the record end to end', async () => {
    reset();
    let reserved: unknown = null;
    const r = await pay({ onPay: async (o) => void (reserved = o) });
    if (!('consistent' in r)) throw r;
    expect(new TextDecoder().decode(r.output)).toBe('echo:hi');
    expect(r.problems).toEqual([]);
    expect(r.consistent).toBe(true);
    expect(r.verification?.ok).toBe(true);
    expect(r.settlement).toEqual({ transaction: TX, network: NETWORK, payer: privateKeyToAccount(payerKey).address });
    expect(r.paid).toEqual({
      scheme: 'exact', network: NETWORK, asset: usdc, assetId: usdc, amount: '10000', decimal: '0.010000', payTo: seller, maxTimeoutSeconds: 300,
    });
    expect(reserved).toEqual(r.paid);
    expect(signed()).toBe(1);
  });

  it('pins the asset and the seller case-insensitively', async () => {
    reset();
    const r = await pay({ asset: USDC, payTo: seller.toUpperCase().replace('0X', '0x') });
    expect('consistent' in r && r.consistent).toBe(true);
  });

  it.each([
    ['costs more than maxAmount', { amount: '50001' }, 'over_cap'],
    ['is another token', { asset: '0x0000000000000000000000000000000000000bad' }, 'bad_asset'],
    ['is on another EVM network', { network: 'eip155:5042002' }, 'no_offer'],
    ['pays the payer itself', { payTo: 'SELF' }, 'pays_self'],
    ['pays a malformed address', { payTo: '0x1234' }, 'bad_pay_to'],
    ['pays the zero address', { payTo: `0x${'0'.repeat(40)}` }, 'bad_pay_to'],
    ['lives a year', { maxTimeoutSeconds: 31536000 }, 'bad_timeout'],
  ] as const)('refuses a 402 that %s, with nothing signed', async (_n, o, reason) => {
    reset();
    offerOverride = o.payTo === 'SELF' ? { payTo: privateKeyToAccount(payerKey).address } : o;
    if ('amount' in o) amount = o.amount;
    let reserved = 0;
    const e = await pay({ onPay: async () => void reserved++ });
    expect(e).toMatchObject({ code: 'payment_refused', reason });
    expect(signed()).toBe(0);
    expect(reserved).toBe(0);
  });

  it('refuses a seller other than the pinned payTo', async () => {
    reset();
    expect(await pay({ payTo: privateKeyToAccount(generatePrivateKey()).address })).toMatchObject({ reason: 'pay_to_mismatch' });
    expect(signed()).toBe(0);
  });

  it('refuses a Stellar signer for an EVM payer before any request', async () => {
    reset();
    const stellarish = { address: 'G', signAuthEntry: async () => ({ signedAuthEntry: '' }) };
    const e = await pay({ payer: { signer: stellarish, network: NETWORK } });
    expect((e as Error).message).toMatch(/needs an EVM signer/);
    expect(seen.length).toBe(0);
  });

  it('refuses a network outside the table before any request', async () => {
    reset();
    const e = await pay({ payer: { secret: payerKey, network: 'eip155:1' as never } });
    expect((e as Error).message).toMatch(/unsupported network/);
    expect(seen.length).toBe(0);
  });
});

describe('hire on Base Sepolia through a policy signer', () => {
  const policyFor = (perTx: string) => ({ rules: [{ network: NETWORK, asset: USDC, perTx, perWindow: '0.05' }] });
  const remote = async (perTx: string) => {
    const ledger = createMemoryLedger();
    const ps = await createPolicySigner({ keys: [{ network: NETWORK, secret: payerKey }], policy: policyFor(perTx), ledger });
    let calls = 0;
    const transport: SignerTransport = async (req) => (calls++, JSON.parse(JSON.stringify(await ps.handle(JSON.parse(JSON.stringify(req))))));
    return { ledger, calls: () => calls, signer: evmPaySigner(transport, { network: NETWORK, address: payer }) };
  };

  it('the agent holds no key: the signer reads the payload, records the spend, and the record verifies', async () => {
    reset();
    const s = await remote('0.05');
    const r = await pay({ payer: { signer: s.signer, network: NETWORK } });
    if (!('consistent' in r)) throw r;
    expect(r.consistent).toBe(true);
    expect(s.calls()).toBe(1);
    expect(s.ledger.entries()).toMatchObject([{ network: NETWORK, asset: usdc, amount: 10_000n, payTo: seller }]);
  });

  it('the signer refuses what its own policy does not allow, even when the guard approved it', async () => {
    reset();
    const s = await remote('0.005');
    const e = await pay({ payer: { signer: s.signer, network: NETWORK } });
    expect((e as Error).message).toMatch(/spend refused: over_per_tx/);
    expect(signed()).toBe(0);
    expect(s.ledger.entries()).toEqual([]);
  });
});
