import { describe, expect, it } from 'bun:test';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { ENACTMENT_HEADER, decodeRecordHeader, recordDigest, sha256Hex, verifyRecord, type ChainAdapter, type Settlement } from '../src/index.js';
import { createEnactServer, pinRequirements, type RecordSigner, type X402Server } from '../src/serve.js';

const AGENT = 'GAGENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PAYER = 'GPAYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TX = 'e'.repeat(64);
const USDC = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

const settled: Settlement = { chain: 'stellar', ref: TX, payer: PAYER, payee: AGENT, amount: '0.0010000', asset: USDC, at: '2026-09-02T09:59:00Z' };

function fakeAdapter(): ChainAdapter {
  return {
    chain: 'stellar',
    sigAlg: 'ed25519',
    async sign(d) { return `${Buffer.from(d).toString('hex')}:${AGENT}`; },
    async verify(d, s, a) { return s === `${Buffer.from(d).toString('hex')}:${a}`; },
    async readSettlement(ref) { return ref === TX ? [settled] : []; },
    async resolveIdentity() { return { owner: AGENT, wallet: null }; },
  };
}

const REQ = { scheme: 'exact', network: 'stellar:pubnet', amount: '10000', asset: 'CCW67…', payTo: AGENT, maxTimeoutSeconds: 60, extra: {} } as unknown as PaymentRequirements;
const PAYLOAD = { x402Version: 2, accepted: REQ, payload: {} } as unknown as PaymentPayload;

function fakeX402(overrides: Partial<X402Server> = {}): X402Server & { settled: number } {
  const s = {
    settled: 0,
    async accepts() { return [REQ]; },
    async paymentRequired() { return { status: 402 as const, headers: { 'PAYMENT-REQUIRED': 'req' }, body: '{}' }; },
    async verify(h: string) {
      return h === 'good'
        ? { ok: true as const, requirements: REQ, payload: PAYLOAD, payer: PAYER, asset: USDC, decimals: 7 }
        : { ok: false as const, reason: h === 'nopayer' ? 'missing_payer' : 'invalid_signature' };
    },
    async settle() {
      s.settled++;
      return { ok: true as const, transaction: TX, payer: PAYER, amount: '0.0010000', responseHeader: 'resp' };
    },
    ...overrides,
  };
  return s as X402Server & { settled: number };
}

const echo = async (input: Uint8Array) => ({ body: new TextEncoder().encode(`echo:${new TextDecoder().decode(input)}`), mediaType: 'text/plain' });

async function server(x402: X402Server, handler: Parameters<typeof createEnactServer>[0]['handler'] = echo, extra: { now?: () => Date; handlerTimeoutMs?: number } = {}) {
  return createEnactServer({
    network: 'stellar:pubnet',
    agent: { address: AGENT, agentId: '66', secret: new Uint8Array(32) },
    adapter: fakeAdapter(),
    price: '$0.001',
    facilitator: { url: 'https://example.invalid', apiKey: 'k' },
    resource: 'https://agent.example/echo',
    handler,
    x402,
    now: () => new Date('2026-09-02T10:00:00Z'),
    ...extra,
  });
}

const post = (body: string, headers: Record<string, string> = {}) =>
  new Request('https://agent.example/echo', { method: 'POST', body, headers: { 'content-type': 'text/plain', ...headers } });

describe('createEnactServer', () => {
  it('replies 402 with PAYMENT-REQUIRED when unpaid, settles nothing', async () => {
    const x = fakeX402();
    const res = await (await server(x))(post('hi'));
    expect(res.status).toBe(402);
    expect(res.headers.get('PAYMENT-REQUIRED')).toBe('req');
    expect(x.settled).toBe(0);
  });
  it('rejects a bad payment signature with 402 and settles nothing', async () => {
    const x = fakeX402();
    const res = await (await server(x))(post('hi', { 'PAYMENT-SIGNATURE': 'bad' }));
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'invalid_signature' });
    expect(x.settled).toBe(0);
  });
  it('serves after settlement, with PAYMENT-RESPONSE and a verifiable Enactment-Record', async () => {
    const x = fakeX402();
    const res = await (await server(x))(post('hi', { 'PAYMENT-SIGNATURE': 'good' }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('echo:hi');
    expect(res.headers.get('PAYMENT-RESPONSE')).toBe('resp');
    expect(x.settled).toBe(1);
    const record = decodeRecordHeader(res.headers.get(ENACTMENT_HEADER)!);
    expect(record.input).toEqual({ sha256: await sha256Hex('hi'), mediaType: 'text/plain' });
    expect(record.output.sha256).toBe(await sha256Hex('echo:hi'));
    expect(record.output.bytes).toBe(7);
    expect(record.settlement).toEqual({ chain: 'stellar', ref: TX, payer: PAYER, amount: '0.0010000', asset: USDC });
    expect(record.agent).toEqual({ chain: 'stellar', address: AGENT, agentId: '66' });
    expect(record.issuedAt).toBe('2026-09-02T10:00:00.000Z');
    expect((await verifyRecord(record, fakeAdapter())).ok).toBe(true);
  });
  it('a handler that reports skills gets a v0.2 record carrying them; the record still verifies', async () => {
    const used = [{ id: 'acme/skills/stellar-payments', sha256: 'd'.repeat(64) }];
    const res = await (await server(fakeX402(), async (i) => ({ ...(await echo(i)), skills: used })))(post('hi', { 'PAYMENT-SIGNATURE': 'good' }));
    expect(res.status).toBe(200);
    const record = decodeRecordHeader(res.headers.get(ENACTMENT_HEADER)!);
    expect(record.v).toBe('0.2');
    expect(record.skills).toEqual(used);
    expect((await verifyRecord(record, fakeAdapter())).ok).toBe(true);
  });
  it('without skills the record stays v0.1', async () => {
    const res = await (await server(fakeX402()))(post('hi', { 'PAYMENT-SIGNATURE': 'good' }));
    const record = decodeRecordHeader(res.headers.get(ENACTMENT_HEADER)!);
    expect(record.v).toBe('0.1');
    expect(record.skills).toBeUndefined();
  });
  it('an invalid skills list fails before settlement (500, nothing settled)', async () => {
    const x = fakeX402();
    const bad = async (i: Uint8Array) => ({ ...(await echo(i)), skills: [{ id: 'a/b/c', sha256: 'not-a-hash' }] });
    const res = await (await server(x, bad))(post('hi', { 'PAYMENT-SIGNATURE': 'good' }));
    expect(res.status).toBe(500);
    expect(x.settled).toBe(0);
  });
  it('does not settle when the handler throws (500, payer keeps their money)', async () => {
    const x = fakeX402();
    const res = await (await server(x, async () => { throw new Error('boom'); }))(post('hi', { 'PAYMENT-SIGNATURE': 'good' }));
    expect(res.status).toBe(500);
    expect(x.settled).toBe(0);
  });
  it('does not serve when settlement fails (402, output discarded)', async () => {
    const x = fakeX402({ async settle() { return { ok: false, reason: 'settle_failed' }; } });
    const res = await (await server(x))(post('hi', { 'PAYMENT-SIGNATURE': 'good' }));
    expect(res.status).toBe(402);
    expect(res.headers.get(ENACTMENT_HEADER)).toBeNull();
    expect(await res.text()).not.toContain('echo:hi');
  });
  it('a verified payment without a payer is refused before settlement', async () => {
    const x = fakeX402();
    const res = await (await server(x))(post('hi', { 'PAYMENT-SIGNATURE': 'nopayer' }));
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'missing_payer' });
    expect(x.settled).toBe(0);
  });
  it('a slow handler yields 504 before settlement (auth entries expire in ~1 minute)', async () => {
    const x = fakeX402();
    const slow = async () => { await new Promise((r) => setTimeout(r, 200)); return echo(new Uint8Array()); };
    const res = await (await server(x, slow, { handlerTimeoutMs: 20 }))(post('hi', { 'PAYMENT-SIGNATURE': 'good' }));
    expect(res.status).toBe(504);
    expect(x.settled).toBe(0);
  });
  it('a failure after settlement still returns PAYMENT-RESPONSE (money moved) and the tx', async () => {
    const x = fakeX402();
    const res = await (await server(x, echo, { now: () => new Date('nope') }))(post('hi', { 'PAYMENT-SIGNATURE': 'good' }));
    expect(res.status).toBe(500);
    expect(res.headers.get('PAYMENT-RESPONSE')).toBe('resp');
    expect(await res.json()).toEqual({ error: 'record_failed', transaction: TX });
    expect(x.settled).toBe(1);
  });
  it('pinRequirements fails at construction on an asset the network table does not know', () => {
    const unknown = { ...REQ, asset: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } as PaymentRequirements;
    expect(() => pinRequirements('stellar:pubnet', [unknown])).toThrow(/unknown asset/);
    const ok = { ...REQ, asset: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75' } as PaymentRequirements;
    expect(pinRequirements('stellar:pubnet', [ok]).get(ok)).toEqual({ asset: USDC, decimals: 7 });
  });
  it('refuses to start when adapter chain and network disagree', async () => {
    await expect(
      createEnactServer({
        network: 'eip155:42220',
        agent: { address: AGENT, secret: new Uint8Array(32) },
        adapter: fakeAdapter(),
        price: '$0.001',
        facilitator: { url: 'u', apiKey: 'k' },
        resource: 'https://x',
        handler: echo,
        x402: fakeX402(),
      }),
    ).rejects.toThrow(/chain/);
  });
});

describe('createEnactServer with a remote record signer', () => {
  const adapter = fakeAdapter();
  const remote = (impl: RecordSigner) =>
    createEnactServer({
      network: 'stellar:pubnet',
      agent: { address: AGENT, agentId: '66', signRecord: impl },
      adapter,
      price: '$0.001',
      facilitator: { url: 'https://example.invalid', apiKey: 'k' },
      resource: 'https://agent.example/echo',
      handler: echo,
      x402: fakeX402(),
      now: () => new Date('2026-09-02T10:00:00Z'),
      recordSignTimeoutMs: 50,
    });
  const honest: RecordSigner = async (u) => ({ ...u, sig: { alg: 'ed25519', value: await adapter.sign(await recordDigest(u), new Uint8Array(32)) } });

  it('gets the whole unsigned record (never a bare digest) and serves a record that verifies', async () => {
    let got: unknown;
    const res = await (await remote(async (u) => ((got = u), honest(u))))(post('hi', { 'PAYMENT-SIGNATURE': 'good' }));
    expect(res.status).toBe(200);
    expect(got).toMatchObject({ v: '0.1', agent: { address: AGENT }, settlement: { ref: TX } });
    expect((await verifyRecord(decodeRecordHeader(res.headers.get(ENACTMENT_HEADER)!), adapter)).ok).toBe(true);
  });
  it.each([
    ['throws', async () => { throw new Error('signer down'); }],
    ['hangs past the timeout', () => new Promise<never>(() => {})],
    ['changes the record', async (u: Parameters<RecordSigner>[0]) => honest({ ...u, settlement: { ...u.settlement, amount: '9' } })],
    ['returns a bad signature', async (u: Parameters<RecordSigner>[0]) => ({ ...u, sig: { alg: 'ed25519' as const, value: 'nope' } })],
    ['returns another algorithm', async (u: Parameters<RecordSigner>[0]) => ({ ...(await honest(u)), sig: { alg: 'secp256k1-eip191' as const, value: 'x' } })],
  ] as const)('a signer that %s still yields PAYMENT-RESPONSE and the tx (money moved), never a record', async (_n, impl) => {
    const res = await (await remote(impl as RecordSigner))(post('hi', { 'PAYMENT-SIGNATURE': 'good' }));
    expect(res.status).toBe(500);
    expect(res.headers.get('PAYMENT-RESPONSE')).toBe('resp');
    expect(res.headers.get(ENACTMENT_HEADER)).toBeNull();
    expect(await res.json()).toEqual({ error: 'record_failed', transaction: TX });
  });
});
