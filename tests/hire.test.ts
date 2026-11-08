import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Keypair } from '@stellar/stellar-sdk';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { ENACTMENT_HEADER, encodeRecordHeader, sha256Hex, signRecord, type ChainAdapter, type Settlement } from '../src/index.js';
import { hire } from '../src/hire.js';
import { stellarPaySigner } from '../src/wallet.js';

const AGENT = 'GAGENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PAYER = 'GPAYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TX = 'd'.repeat(64);
const USDC = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const settled: Settlement = { chain: 'stellar', ref: TX, payer: PAYER, payee: AGENT, amount: '0.0010000', asset: USDC, at: '2026-09-02T09:59:00Z' };
const hex = (d: Uint8Array) => Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
const adapter: ChainAdapter = {
  chain: 'stellar',
  sigAlg: 'ed25519',
  async sign(d) { return `${hex(d)}:${AGENT}`; },
  async verify(d, s, a) { return s === `${hex(d)}:${a}`; },
  async readSettlement(ref) { return ref === TX ? [settled] : []; },
  async resolveIdentity() { return { owner: AGENT, wallet: null }; },
};
const paymentResponse = btoa(JSON.stringify({ success: true, transaction: TX, network: 'stellar:pubnet', payer: PAYER }));

let mode: 'good' | 'tampered' | 'wrong_tx' | 'no_record' | 'garbage' = 'good';
let srv: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  srv = Bun.serve({
    port: 0,
    async fetch(req) {
      const input = new Uint8Array(await req.arrayBuffer());
      const body = new TextEncoder().encode(`echo:${new TextDecoder().decode(input)}`);
      const rec = await signRecord(
        {
          v: '0.1',
          agent: { chain: 'stellar', address: AGENT, agentId: '66' },
          input: { sha256: await sha256Hex(mode === 'tampered' ? 'other' : input) },
          output: { sha256: await sha256Hex(body), mediaType: 'text/plain', bytes: body.byteLength },
          settlement: { chain: 'stellar', ref: mode === 'wrong_tx' ? 'f'.repeat(64) : TX, payer: PAYER, amount: '0.001', asset: USDC },
          issuedAt: '2026-09-02T10:00:00Z',
          nonce: '00'.repeat(16),
        },
        adapter,
        new Uint8Array(32),
      );
      const headers: Record<string, string> = { 'content-type': 'text/plain', 'PAYMENT-RESPONSE': paymentResponse };
      if (mode === 'garbage') headers[ENACTMENT_HEADER] = 'not-a-record';
      else if (mode !== 'no_record') headers[ENACTMENT_HEADER] = encodeRecordHeader(rec);
      return new Response(body, { headers });
    },
  });
});
afterAll(() => srv.stop());
const url = () => `http://localhost:${srv.port}/echo`;

describe('hire', () => {
  it('returns output, settlement, a verified record, and consistent=true on the happy path', async () => {
    mode = 'good';
    const r = await hire(url(), { method: 'POST', body: 'hi' }, { adapter });
    expect(new TextDecoder().decode(r.output)).toBe('echo:hi');
    expect(r.settlement).toEqual({ transaction: TX, network: 'stellar:pubnet', payer: PAYER });
    expect(r.verification?.ok).toBe(true);
    expect(r.consistent).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.paid).toBeNull();
  });
  it('flags a record whose input hash is not what we sent', async () => {
    mode = 'tampered';
    const r = await hire(url(), { method: 'POST', body: 'hi' }, { adapter });
    expect(r.consistent).toBe(false);
    expect(r.problems).toContain('input hash mismatch');
  });
  it('flags a record bound to a different settlement than PAYMENT-RESPONSE', async () => {
    mode = 'wrong_tx';
    const r = await hire(url(), { method: 'POST', body: 'hi' }, { adapter });
    expect(r.consistent).toBe(false);
    expect(r.problems).toContain('settlement ref mismatch');
    expect(r.verification?.ok).toBe(false);
  });
  it('reports a missing record without throwing', async () => {
    mode = 'no_record';
    const r = await hire(url(), { method: 'POST', body: 'hi' }, { adapter });
    expect(r.record).toBeNull();
    expect(r.verification).toBeNull();
    expect(r.consistent).toBe(false);
    expect(r.problems).toEqual(['no Enactment-Record header']);
  });
  it('reports a malformed record without throwing', async () => {
    mode = 'garbage';
    const r = await hire(url(), { method: 'POST', body: 'hi' }, { adapter });
    expect(r.record).toBeNull();
    expect(r.problems[0]).toMatch(/^malformed record/);
  });
  it('accepts a Uint8Array body and hashes exactly those bytes', async () => {
    mode = 'good';
    const r = await hire(url(), { method: 'POST', body: new TextEncoder().encode('hi') }, { adapter });
    expect(r.consistent).toBe(true);
  });
});

describe('hire with a payer: the payment guard', () => {
  const SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
  const payer = Keypair.random();
  const seller = Keypair.random().publicKey();
  const offer = (o: Record<string, unknown> = {}) =>
    ({ scheme: 'exact', network: 'stellar:testnet', asset: SAC, amount: '10000', payTo: seller, maxTimeoutSeconds: 300, extra: {}, ...o });
  let accepts: Record<string, unknown>[] = [offer()];
  let seen: Request[] = [];
  let paywall: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    paywall = Bun.serve({
      port: 0,
      fetch: (req) =>
        new Response('{}', {
          status: 402,
          headers: {
            'PAYMENT-REQUIRED': encodePaymentRequiredHeader({ x402Version: 2, resource: { url: req.url, description: '', mimeType: 'application/json' }, accepts } as never),
          },
        }),
    });
  });
  afterAll(() => paywall.stop());
  // A real HTTP round trip to a real 402, observed on the way out; the x402 client signs only after the guard approves.
  const watching: typeof fetch = (async (i: string | URL | Request, init?: RequestInit) => (seen.push(new Request(i, init)), globalThis.fetch(i, init))) as never;
  const pay = (extra: Partial<Parameters<typeof hire>[2]> = {}) =>
    hire(`http://localhost:${paywall.port}/x`, { method: 'POST', body: 'hi' }, {
      adapter,
      payer: { secret: payer.secret(), network: 'stellar:testnet' },
      maxAmount: '0.05',
      fetch: watching,
      ...extra,
    }).catch((e) => e as { code?: string; reason?: string; message: string });
  const nothingSigned = () => seen.every((r) => !r.headers.has('PAYMENT-SIGNATURE') && !r.headers.has('X-PAYMENT'));

  it('refuses a payer without maxAmount before importing, signing or sending anything', async () => {
    seen = [];
    accepts = [offer()];
    const e = await pay({ maxAmount: undefined });
    expect(e).toMatchObject({ code: 'payment_refused', reason: 'no_max_amount' });
    expect(seen.length).toBe(0);
  });

  it.each([
    ['an unknown asset pin', { asset: 'USDC:GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }],
    ['a non-positive maxAmount', { maxAmount: '0' }],
    ['a malformed maxAmount', { maxAmount: 'a lot' }],
  ])('throws on %s before any request', async (_n, extra) => {
    seen = [];
    const e = await pay(extra);
    expect(e instanceof Error).toBe(true);
    expect(seen.length).toBe(0);
  });

  it.each([
    ['costs more than maxAmount', { amount: '500001' }, 'over_cap'],
    ['is another asset', { asset: 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA' }, 'bad_asset'],
    ['is on another network', { network: 'stellar:pubnet' }, 'no_offer'],
    ['is not exact', { scheme: 'upto' }, 'bad_scheme'],
    ['pays the payer itself', { payTo: payer.publicKey() }, 'pays_self'],
    ['pays a malformed address', { payTo: 'GNOTANADDRESS' }, 'bad_pay_to'],
    ['lives a year', { maxTimeoutSeconds: 31536000 }, 'bad_timeout'],
  ] as const)('refuses a 402 that %s, with nothing signed and nothing paid', async (_n, o, reason) => {
    seen = [];
    accepts = [offer(o)];
    let reserved = 0;
    const e = await pay({ onPay: async () => void reserved++ });
    expect(e).toMatchObject({ code: 'payment_refused', reason });
    expect(seen.length).toBe(1);
    expect(nothingSigned()).toBe(true);
    expect(reserved).toBe(0);
  });

  it('refuses a seller other than the pinned payTo', async () => {
    seen = [];
    accepts = [offer()];
    expect(await pay({ payTo: Keypair.random().publicKey() })).toMatchObject({ reason: 'pay_to_mismatch' });
    expect(nothingSigned()).toBe(true);
  });

  it('refuses an x402 v1 challenge', async () => {
    seen = [];
    const v1 = Bun.serve({ port: 0, fetch: () => new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader({ x402Version: 1, resource: { url: 'x', description: '', mimeType: '' }, accepts: [offer()] } as never) } }) });
    try {
      const e = await hire(`http://localhost:${v1.port}/x`, { method: 'POST', body: 'hi' }, { adapter, payer: { secret: payer.secret(), network: 'stellar:testnet' }, maxAmount: '0.05', fetch: watching }).catch((x) => x);
      expect(e).toMatchObject({ reason: 'not_x402_v2' });
      expect(nothingSigned()).toBe(true);
    } finally {
      v1.stop();
    }
  });

  it('a policy-signer payer goes through the same guard: a bad offer never reaches the signer', async () => {
    let signerCalls = 0;
    const remote = stellarPaySigner(async () => (signerCalls++, { ok: false, reason: 'no_rule' }), { network: 'stellar:testnet', address: payer.publicKey() });
    for (const [o, reason] of [[{ payTo: payer.publicKey() }, 'pays_self'], [{ amount: '500001' }, 'over_cap']] as const) {
      seen = [];
      accepts = [offer(o)];
      const e = await pay({ payer: { signer: remote, network: 'stellar:testnet' } });
      expect(e).toMatchObject({ code: 'payment_refused', reason });
      expect(nothingSigned()).toBe(true);
    }
    expect(signerCalls).toBe(0);
  });

  it('a free endpoint passes through the guard: nothing paid, onPay never called, record verifies', async () => {
    mode = 'good';
    let reserved = 0;
    const r = await hire(url(), { method: 'POST', body: 'hi' }, { adapter, payer: { secret: payer.secret(), network: 'stellar:testnet' }, maxAmount: '0.05', onPay: async () => void reserved++ });
    expect([r.paid, reserved, r.consistent]).toEqual([null, 0, true]);
  });

  it('a payer on a network outside the table is refused before any request', async () => {
    seen = [];
    const e = await pay({ payer: { secret: payer.secret(), network: 'solana:mainnet' as never } });
    expect((e as Error).message).toMatch(/unsupported network/);
    expect(seen.length).toBe(0);
  });

  it('a record that fails after a settlement still returns the settlement (nothing throws after money moved)', async () => {
    mode = 'no_record';
    const r = await hire(url(), { method: 'POST', body: 'hi' }, { adapter });
    expect(r.settlement?.transaction).toBe(TX);
    expect(r.consistent).toBe(false);
  });
});
