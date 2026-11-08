import { describe, expect, it } from 'bun:test';
import {
  bytesToHex,
  recordDigest,
  signRecord,
  verifyRecord,
  type ChainAdapter,
  type Settlement,
} from '../src/index.js';
import { UNSIGNED } from './record.test.js';

const AGENT = UNSIGNED.agent.address;
const PAYER = UNSIGNED.settlement.payer;
const SETTLEMENT: Settlement = {
  chain: 'stellar',
  ref: UNSIGNED.settlement.ref,
  payer: PAYER,
  payee: AGENT,
  amount: '0.0100000',
  asset: 'USDC',
  at: '2026-09-02T09:59:00Z',
};
const SECRET = new Uint8Array(32);

/** Fake adapter: "signature" = hex(digest) + ':' + address; verify recomputes. */
function fakeAdapter(overrides: Partial<ChainAdapter> = {}): ChainAdapter {
  return {
    chain: 'stellar',
    sigAlg: 'ed25519',
    async sign(digest) {
      return `${bytesToHex(digest)}:${AGENT}`;
    },
    async verify(digest, sig, address) {
      return sig === `${bytesToHex(digest)}:${address}`;
    },
    async readSettlement(ref) {
      return ref === SETTLEMENT.ref ? [SETTLEMENT] : [];
    },
    async resolveIdentity(agentId) {
      return agentId === '66' ? { owner: AGENT, wallet: null } : null;
    },
    ...overrides,
  };
}

const withSettlement = (s: Settlement) => fakeAdapter({ async readSettlement() { return [s]; } });

describe('signRecord', () => {
  it('attaches the adapter alg and a signature over the digest', async () => {
    const signed = await signRecord(UNSIGNED, fakeAdapter(), SECRET);
    expect(signed.sig.alg).toBe('ed25519');
    expect(signed.sig.value).toBe(`${bytesToHex(await recordDigest(UNSIGNED))}:${AGENT}`);
  });
  it('refuses to sign for a different chain than the adapter', async () => {
    const other = { ...UNSIGNED, agent: { ...UNSIGNED.agent, chain: 'celo' as const } };
    await expect(signRecord(other, fakeAdapter(), SECRET)).rejects.toThrow(/chain/);
  });
});

describe('verifyRecord', () => {
  it('passes all four checks on a good record', async () => {
    const signed = await signRecord(UNSIGNED, fakeAdapter(), SECRET);
    const res = await verifyRecord(signed, fakeAdapter());
    expect(res.ok).toBe(true);
    expect(res.checks).toEqual({ signature: 'pass', settlement: 'pass', timing: 'pass', identity: 'pass' });
    expect(res.settlement).toEqual(SETTLEMENT);
  });
  it('skips identity when agentId is absent', async () => {
    const { agentId: _x, ...agent } = UNSIGNED.agent;
    const signed = await signRecord({ ...UNSIGNED, agent }, fakeAdapter(), SECRET);
    const res = await verifyRecord(signed, fakeAdapter());
    expect(res.ok).toBe(true);
    expect(res.checks.identity).toBe('skipped');
  });
  it('fails on a malformed record without throwing', async () => {
    const res = await verifyRecord({ v: '9' }, fakeAdapter());
    expect(res.ok).toBe(false);
    expect(res.failure).toMatchObject({ check: 'record', reason: 'unsupported_version' });
    expect(res.checks.signature).toBe('skipped');
  });
  it('fails signature when any bound field is tampered after signing', async () => {
    const signed = await signRecord(UNSIGNED, fakeAdapter(), SECRET);
    const tampered = { ...signed, output: { ...signed.output, sha256: 'e'.repeat(64) } };
    const res = await verifyRecord(tampered, fakeAdapter());
    expect(res.ok).toBe(false);
    expect(res.failure).toEqual({ check: 'signature', reason: 'invalid_signature' });
    expect(res.checks.settlement).toBe('skipped');
  });
  it('fails signature on alg mismatch and chain mismatch', async () => {
    const signed = await signRecord(UNSIGNED, fakeAdapter(), SECRET);
    const wrongAlg = { ...signed, sig: { ...signed.sig, alg: 'secp256k1-eip191' as const } };
    expect((await verifyRecord(wrongAlg, fakeAdapter())).failure).toEqual({ check: 'signature', reason: 'alg_mismatch' });
    expect((await verifyRecord(signed, fakeAdapter({ chain: 'celo' }))).failure).toEqual({
      check: 'signature',
      reason: 'chain_mismatch',
    });
  });
  it('fails settlement when the tx is absent or pays someone else', async () => {
    const signed = await signRecord(UNSIGNED, fakeAdapter(), SECRET);
    const absent = await verifyRecord(signed, fakeAdapter({ async readSettlement() { return []; } }));
    expect(absent.failure).toEqual({ check: 'settlement', reason: 'not_found' });
    const elsewhere = await verifyRecord(signed, withSettlement({ ...SETTLEMENT, payee: 'GOTHER' }));
    expect(elsewhere.failure).toEqual({ check: 'settlement', reason: 'no_matching_payment' });
    expect(elsewhere.settlement).toBeUndefined();
  });
  it('matches amount numerically (0.01 == 0.0100000) and asset exactly', async () => {
    const signed = await signRecord(UNSIGNED, fakeAdapter(), SECRET);
    expect((await verifyRecord(signed, withSettlement({ ...SETTLEMENT, amount: '0.01' }))).ok).toBe(true);
    expect((await verifyRecord(signed, withSettlement({ ...SETTLEMENT, amount: '0.011' }))).ok).toBe(false);
    expect((await verifyRecord(signed, withSettlement({ ...SETTLEMENT, asset: 'XLM' }))).failure).toEqual({
      check: 'settlement',
      reason: 'no_matching_payment',
    });
  });
  it('fails timing when issued before settlement or after the window', async () => {
    const signed = await signRecord(UNSIGNED, fakeAdapter(), SECRET);
    const late = await verifyRecord(signed, withSettlement({ ...SETTLEMENT, at: '2026-09-02T10:00:01Z' }));
    expect(late.failure).toEqual({ check: 'timing', reason: 'issued_before_settlement' });
    expect(late.settlement).toBeDefined();
    const old = withSettlement({ ...SETTLEMENT, at: '2026-08-01T00:00:00Z' });
    expect((await verifyRecord(signed, old)).failure).toEqual({ check: 'timing', reason: 'issued_after_window' });
    expect((await verifyRecord(signed, old, { windowSeconds: 60 * 60 * 24 * 60 })).ok).toBe(true);
  });
  it('fails identity when unregistered or bound to another address', async () => {
    const signed = await signRecord(UNSIGNED, fakeAdapter(), SECRET);
    const none = await verifyRecord(signed, fakeAdapter({ async resolveIdentity() { return null; } }));
    expect(none.failure).toEqual({ check: 'identity', reason: 'unregistered' });
    const other = await verifyRecord(
      signed,
      fakeAdapter({ async resolveIdentity() { return { owner: 'GOTHER', wallet: null }; } }),
    );
    expect(other.failure).toEqual({ check: 'identity', reason: 'address_not_bound' });
    const viaWallet = await verifyRecord(
      signed,
      fakeAdapter({ async resolveIdentity() { return { owner: 'GOTHER', wallet: AGENT }; } }),
    );
    expect(viaWallet.ok).toBe(true);
  });
});

describe('verifyRecord history start', () => {
  const missing = fakeAdapter({ async readSettlement() { return []; } });
  it('reports history_unavailable when the record predates the readable history', async () => {
    const signed = await signRecord(UNSIGNED, missing, SECRET);
    const res = await verifyRecord(signed, { ...missing, historyStart: async () => '2027-01-01T00:00:00Z' });
    expect(res.ok).toBe(false);
    expect(res.failure).toEqual({ check: 'settlement', reason: 'history_unavailable' });
  });
  it('stays not_found when the record is inside the history, or historyStart fails', async () => {
    const signed = await signRecord(UNSIGNED, missing, SECRET);
    const inside = await verifyRecord(signed, { ...missing, historyStart: async () => '2020-01-01T00:00:00Z' });
    expect(inside.failure).toEqual({ check: 'settlement', reason: 'not_found' });
    const broken = await verifyRecord(signed, { ...missing, historyStart: async () => { throw new Error('down'); } });
    expect(broken.failure).toEqual({ check: 'settlement', reason: 'not_found' });
  });
});
