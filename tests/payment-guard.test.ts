import { describe, expect, it } from 'bun:test';
import { Keypair } from '@stellar/stellar-sdk';
import { encodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { checkPaymentRequired, createPaymentGuard, isPaymentRefusal, paymentRefusal, type PaymentPolicy } from '../src/payment-guard.js';

const SAC_TESTNET = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const SAC_PUBNET = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75';
const OTHER_SAC = 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA';
const USDC_TESTNET = 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const seller = Keypair.random().publicKey();
const me = Keypair.random().publicKey();

type Offer = Record<string, unknown>;
const offer = (o: Offer = {}): Offer =>
  ({ scheme: 'exact', network: 'stellar:testnet', asset: SAC_TESTNET, amount: '10000', payTo: seller, maxTimeoutSeconds: 300, extra: {}, ...o });
const header = (accepts: Offer[], x402Version = 2) =>
  encodePaymentRequiredHeader({ x402Version, resource: { url: 'https://s.example/a', description: '', mimeType: 'application/json' }, accepts } as never);
const res402 = (accepts: Offer[]) => new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': header(accepts), 'content-type': 'application/json' } });
const sig = (accepted: Offer, x402Version = 2) => encodePaymentSignatureHeader({ x402Version, accepted, payload: {} } as never);
const policy: PaymentPolicy = { network: 'stellar:testnet', maxAmount: '0.05', self: me };
type F = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const reasonOf = async (p: Promise<unknown>) => ((await p.catch((e) => e)) as { code?: string; reason?: string });

describe('policy', () => {
  it.each([
    ['unknown network', { ...policy, network: 'stellar:nowhere' as never }],
    ['an unpinned EVM asset', { ...policy, network: 'eip155:84532' as const, self: `0x${'1'.repeat(40)}`, asset: `0x${'b'.repeat(40)}` }],
    ['an unpinned asset', { ...policy, asset: 'USDC:GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }],
    ['a pubnet asset on testnet', { ...policy, asset: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' }],
  ])('throws on construction for %s, before any request', (_n, p) => {
    let calls = 0;
    expect(() => createPaymentGuard(async () => (calls++, new Response('x')), p)).toThrow();
    expect(calls).toBe(0);
  });
  it.each([['missing', undefined, 'no_max_amount'], ['zero', '0', 'bad_max_amount'], ['negative', '-1', 'bad_max_amount'], ['words', 'five', 'bad_max_amount'], ['too precise', '0.00000001', 'bad_max_amount'], ['exponent', '1e3', 'bad_max_amount']] as const)(
    'refuses a %s maxAmount on construction',
    (_n, maxAmount, reason) => {
      expect(() => createPaymentGuard(async () => new Response('x'), { ...policy, maxAmount: maxAmount as never })).toThrow(expect.objectContaining({ code: 'payment_refused', reason }));
    },
  );
  it('refusals are typed', () => {
    expect(isPaymentRefusal(paymentRefusal('day_cap'))).toBe(true);
    expect(isPaymentRefusal(new Error('x'))).toBe(false);
  });
});

describe('checkPaymentRequired on an EVM network', () => {
  const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
  const evmMe = `0x${'1'.repeat(40)}`;
  const evmSeller = `0x${'A'.repeat(40)}`;
  const evm: PaymentPolicy = { network: 'eip155:84532', maxAmount: '0.05', self: evmMe };
  const evmOffer = (o: Offer = {}) => offer({ network: 'eip155:84532', asset: USDC_BASE_SEPOLIA, payTo: evmSeller, extra: { name: 'USDC', version: '2' }, ...o });
  it('approves the pinned USDC in 6 decimals and lowercases the addresses', async () => {
    expect(await checkPaymentRequired(header([evmOffer()]), evm)).toEqual({
      scheme: 'exact', network: 'eip155:84532', asset: USDC_BASE_SEPOLIA.toLowerCase(), assetId: USDC_BASE_SEPOLIA.toLowerCase(),
      amount: '10000', decimal: '0.010000', payTo: evmSeller.toLowerCase(), maxTimeoutSeconds: 300,
    });
  });
  it.each([
    ['over the cap', { amount: '50001' }, 'over_cap'],
    ['a Stellar payTo', { payTo: seller }, 'bad_pay_to'],
    ['self in another case', { payTo: evmMe.toUpperCase().replace('0X', '0x') }, 'pays_self'],
    ['the Stellar SAC as asset', { asset: SAC_TESTNET }, 'bad_asset'],
  ] as const)('refuses %s', async (_n, o, reason) => {
    expect((await reasonOf(checkPaymentRequired(header([evmOffer(o)]), evm))).reason).toBe(reason);
  });
});

describe('checkPaymentRequired', () => {
  it('approves exactly one compliant testnet USDC offer and describes it', async () => {
    const o = await checkPaymentRequired(header([offer(), offer({ network: 'eip155:42220' })]), policy);
    expect(o).toEqual({
      scheme: 'exact', network: 'stellar:testnet', asset: SAC_TESTNET, assetId: USDC_TESTNET,
      amount: '10000', decimal: '0.0010000', payTo: seller, maxTimeoutSeconds: 300,
    });
  });
  it('is network-aware: pubnet policy takes the pubnet USDC and rejects the testnet one', async () => {
    const pub = { ...policy, network: 'stellar:pubnet' as const };
    expect((await checkPaymentRequired(header([offer({ network: 'stellar:pubnet', asset: SAC_PUBNET })]), pub)).assetId).toMatch(/^USDC:GA5ZSEJY/);
    expect((await reasonOf(checkPaymentRequired(header([offer({ network: 'stellar:pubnet' })]), pub))).reason).toBe('bad_asset');
    expect((await reasonOf(checkPaymentRequired(header([offer({ network: 'stellar:pubnet', asset: SAC_PUBNET })]), policy))).reason).toBe('no_offer');
  });
  it('the cap is inclusive and read in whole units', async () => {
    expect((await checkPaymentRequired(header([offer({ amount: '500000' })]), policy)).decimal).toBe('0.0500000');
    expect((await reasonOf(checkPaymentRequired(header([offer({ amount: '500001' })]), policy))).reason).toBe('over_cap');
  });
  it('accepts a 300 s timeout and an explicitly pinned default asset', async () => {
    expect((await checkPaymentRequired(header([offer()]), { ...policy, asset: USDC_TESTNET })).maxTimeoutSeconds).toBe(300);
  });
  it.each([
    ['no header', null, 'not_x402_v2'],
    ['garbage', 'not-base64-json', 'not_x402_v2'],
    ['v1 header', header([offer()], 1), 'not_x402_v2'],
    ['pubnet offer only', header([offer({ network: 'stellar:pubnet' })]), 'no_offer'],
    ['two testnet offers', header([offer(), offer({ amount: '20000' })]), 'ambiguous_offer'],
    ['scheme', header([offer({ scheme: 'upto' })]), 'bad_scheme'],
    ['asset', header([offer({ asset: OTHER_SAC })]), 'bad_asset'],
    ['payTo', header([offer({ payTo: 'CABC' })]), 'bad_pay_to'],
    ['missing payTo', header([offer({ payTo: undefined })]), 'bad_pay_to'],
    ['self', header([offer({ payTo: me })]), 'pays_self'],
    ['amount format', header([offer({ amount: '0.01' })]), 'bad_amount'],
    ['zero amount', header([offer({ amount: '0' })]), 'bad_amount'],
    ['numeric amount', header([offer({ amount: 10000 })]), 'bad_amount'],
    ['over cap', header([offer({ amount: '500001' })]), 'over_cap'],
    ['a year of validity', header([offer({ maxTimeoutSeconds: 31536000 })]), 'bad_timeout'],
    ['negative timeout', header([offer({ maxTimeoutSeconds: -5 })]), 'bad_timeout'],
    ['zero timeout', header([offer({ maxTimeoutSeconds: 0 })]), 'bad_timeout'],
    ['fractional timeout', header([offer({ maxTimeoutSeconds: 1.5 })]), 'bad_timeout'],
    ['missing timeout', header([offer({ maxTimeoutSeconds: undefined })]), 'bad_timeout'],
    ['301 s timeout', header([offer({ maxTimeoutSeconds: 301 })]), 'bad_timeout'],
  ] as const)('refuses: %s', async (_n, h, reason) => {
    expect(await reasonOf(checkPaymentRequired(h, policy))).toMatchObject({ code: 'payment_refused', reason });
  });
  it('enforces a pinned payTo', async () => {
    expect((await reasonOf(checkPaymentRequired(header([offer()]), { ...policy, payTo: Keypair.random().publicKey() }))).reason).toBe('pay_to_mismatch');
    expect((await checkPaymentRequired(header([offer()]), { ...policy, payTo: seller })).payTo).toBe(seller);
  });
});

describe('guard: the 402', () => {
  it('refuses a bad offer on the first 402 and never lets a signed request out', async () => {
    const seen: Request[] = [];
    const g = createPaymentGuard(async (i, init) => (seen.push(new Request(i, init)), res402([offer({ amount: '999999999' })])), policy, async () => {
      throw new Error('onPay must not run');
    });
    expect((await reasonOf(g.fetch('https://s.example/a'))).reason).toBe('over_cap');
    expect(seen.length).toBe(1);
    expect([g.approved(), g.paid()]).toEqual([null, false]);
  });
  it('passes non-402 responses through untouched and approves nothing', async () => {
    const g = createPaymentGuard(async () => new Response('free', { status: 200 }), policy);
    expect(await (await g.fetch('https://s.example/a')).text()).toBe('free');
    expect([g.approved(), g.paid()]).toEqual([null, false]);
  });
  it('approves a compliant 402 and returns it to the caller', async () => {
    const g = createPaymentGuard(async () => res402([offer()]), policy);
    expect((await g.fetch('https://s.example/a')).status).toBe(402);
    expect(g.approved()?.decimal).toBe('0.0010000');
  });
});

describe('guard: the paid request', () => {
  const run = () => {
    const sent: Request[] = [];
    const base: F = async (i, init) => {
      const r = new Request(i, init);
      sent.push(r);
      return r.headers.has('PAYMENT-SIGNATURE') ? new Response('ok') : res402([offer()]);
    };
    return { sent, base };
  };
  const paidCount = (sent: Request[]) => sent.filter((r) => r.headers.has('PAYMENT-SIGNATURE')).length;

  it('lets exactly one payment matching the approved offer through, after onPay, and never a second', async () => {
    const { sent, base } = run();
    const order: string[] = [];
    const g = createPaymentGuard(base, policy, async (o) => void order.push(`onPay:${o.amount}:${sent.length}`));
    await g.fetch('https://s.example/a');
    const h = { 'PAYMENT-SIGNATURE': sig(offer()) };
    expect((await g.fetch('https://s.example/a', { method: 'POST', headers: h })).status).toBe(200);
    expect(order).toEqual(['onPay:10000:1']); // reserved after the 402, before the paid request left
    expect([g.paid(), paidCount(sent)]).toEqual([true, 1]);
    expect((await reasonOf(g.fetch('https://s.example/a', { method: 'POST', headers: h }))).reason).toBe('second_payment');
    expect((await reasonOf(g.fetch('https://s.example/a', { method: 'POST', headers: { 'PAYMENT-SIGNATURE': sig(offer({ amount: '1' })) } }))).reason).toBe('second_payment');
    expect(paidCount(sent)).toBe(1);
  });

  it('a second 402 after the payment is returned to the caller, not paid and not re-approved', async () => {
    let n = 0;
    const g = createPaymentGuard(async () => (n++ === 1 ? new Response('ok') : res402([n === 1 ? offer() : offer({ amount: '20000' })])), policy);
    await g.fetch('https://s.example/a');
    await g.fetch('https://s.example/a', { headers: { 'PAYMENT-SIGNATURE': sig(offer()) } });
    expect((await g.fetch('https://s.example/a')).status).toBe(402);
    expect(g.approved()?.amount).toBe('10000');
    expect((await reasonOf(g.fetch('https://s.example/a', { headers: { 'PAYMENT-SIGNATURE': sig(offer({ amount: '20000' })) } }))).reason).toBe('second_payment');
  });

  it('refuses a signature whose accepted offer differs, one without a 402 first, and a v1 payment', async () => {
    const { sent, base } = run();
    const g = createPaymentGuard(base, policy, async () => undefined);
    expect((await reasonOf(g.fetch('https://s.example/a', { headers: { 'PAYMENT-SIGNATURE': sig(offer()) } }))).reason).toBe('unapproved_payment');
    await g.fetch('https://s.example/a');
    for (const bad of [offer({ amount: '20000' }), offer({ payTo: Keypair.random().publicKey() }), offer({ asset: OTHER_SAC }), offer({ maxTimeoutSeconds: 3600 }), offer({ extra: { areFeesSponsored: true } })]) {
      expect((await reasonOf(g.fetch('https://s.example/a', { headers: { 'PAYMENT-SIGNATURE': sig(bad) } }))).reason).toBe('unapproved_payment');
    }
    expect((await reasonOf(g.fetch('https://s.example/a', { headers: { 'X-PAYMENT': 'x' } }))).reason).toBe('not_x402_v2');
    expect(paidCount(sent)).toBe(0);
    expect(g.paid()).toBe(false);
  });

  it('refuses a signature with a non-v2 version, no accepted offer, or garbage', async () => {
    const g = createPaymentGuard(async () => res402([offer()]), policy);
    await g.fetch('https://s.example/a');
    const noAccepted = Buffer.from(JSON.stringify({ x402Version: 2, payload: {} })).toString('base64');
    expect((await reasonOf(g.fetch('https://s.example/a', { headers: { 'PAYMENT-SIGNATURE': sig(offer(), 1) } }))).reason).toBe('not_x402_v2');
    expect((await reasonOf(g.fetch('https://s.example/a', { headers: { 'PAYMENT-SIGNATURE': noAccepted } }))).reason).toBe('unapproved_payment');
    expect((await reasonOf(g.fetch('https://s.example/a', { headers: { 'PAYMENT-SIGNATURE': '%%%' } }))).reason).toBe('unapproved_payment');
  });

  it('accepts the same extra with its keys in another order', async () => {
    let n = 0;
    const g = createPaymentGuard(async () => (n++ === 0 ? res402([offer({ extra: { a: 1, b: { c: 2, d: 3 } } })]) : new Response('ok')), policy);
    await g.fetch('https://s.example/a');
    const r = await g.fetch('https://s.example/a', { headers: { 'PAYMENT-SIGNATURE': sig(offer({ extra: { b: { d: 3, c: 2 }, a: 1 } })) } });
    expect(r.status).toBe(200);
  });

  it('onPay refusing (a cap) stops the signed request from leaving and keeps its own error', async () => {
    const { sent, base } = run();
    const g = createPaymentGuard(base, policy, async () => {
      throw paymentRefusal('day_cap');
    });
    await g.fetch('https://s.example/a');
    expect(await reasonOf(g.fetch('https://s.example/a', { headers: { 'PAYMENT-SIGNATURE': sig(offer()) } }))).toMatchObject({ code: 'payment_refused', reason: 'day_cap' });
    expect([paidCount(sent), g.paid()]).toEqual([0, false]);
  });

  it('a non-refusal onPay failure (a database error) propagates unchanged and sends nothing', async () => {
    const { sent, base } = run();
    const boom = new Error('db down');
    const g = createPaymentGuard(base, policy, async () => {
      throw boom;
    });
    await g.fetch('https://s.example/a');
    expect(await g.fetch('https://s.example/a', { headers: { 'PAYMENT-SIGNATURE': sig(offer()) } }).catch((e) => e)).toBe(boom);
    expect([paidCount(sent), g.paid()]).toEqual([0, false]);
  });

  it('releases the claim when onPay throws, so a retry is allowed', async () => {
    const { sent, base } = run();
    let calls = 0;
    const g = createPaymentGuard(base, policy, async () => {
      if (calls++ === 0) throw paymentRefusal('day_cap');
    });
    await g.fetch('https://s.example/a');
    const h = { 'PAYMENT-SIGNATURE': sig(offer()) };
    expect((await reasonOf(g.fetch('https://s.example/a', { headers: h }))).reason).toBe('day_cap');
    expect((await g.fetch('https://s.example/a', { headers: h })).status).toBe(200);
    expect([g.paid(), paidCount(sent)]).toEqual([true, 1]);
  });

  it('lets only one of two concurrent signed requests out', async () => {
    const { sent, base } = run();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const g = createPaymentGuard(base, policy, async () => void (await gate));
    await g.fetch('https://s.example/a');
    const h = { 'PAYMENT-SIGNATURE': sig(offer()) };
    const a = g.fetch('https://s.example/a', { headers: h });
    const b = await reasonOf(g.fetch('https://s.example/a', { headers: h }));
    expect(b.reason).toBe('second_payment');
    release();
    expect((await a).status).toBe(200);
    expect(paidCount(sent)).toBe(1);
  });

  it('keeps the abort signal of the request it forwards', async () => {
    let signal: AbortSignal | undefined;
    const g = createPaymentGuard(async (i, init) => ((signal = new Request(i, init).signal), new Response('ok')), policy);
    const ac = new AbortController();
    await g.fetch('https://s.example/a', { signal: ac.signal });
    ac.abort();
    expect(signal?.aborted).toBe(true);
  });
});
