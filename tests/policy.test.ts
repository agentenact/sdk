import { describe, expect, it } from 'bun:test';
import { checkSpend, compilePolicy, createMemoryLedger, isSpendRefusal, spendRefusal, type SpendIntent, type SpendPolicy } from '../src/policy.js';

const USDC_TESTNET = 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const CELO_USDC = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C';
const now = new Date('2026-10-17T12:00:00Z');
const policy: SpendPolicy = {
  rules: [
    { network: 'stellar:testnet', asset: USDC_TESTNET, perTx: '0.05', perWindow: '0.1' },
    { network: 'eip155:42220', asset: CELO_USDC, perTx: '1', perWindow: '2', windowSeconds: 3600, payTo: ['0x00000000000000000000000000000000000000AA'] },
  ],
};
const intent = (o: Partial<SpendIntent> = {}): SpendIntent =>
  ({ network: 'stellar:testnet', asset: USDC_TESTNET, amount: 500_000n, from: 'GME', payTo: 'GSELLER', ...o });
const none = async () => 0n;
const reason = async (p: Promise<unknown>) => ((await p.catch((e) => e)) as { reason?: string })?.reason;

describe('compilePolicy', () => {
  it.each([
    ['an unknown network', { network: 'stellar:nowhere', asset: USDC_TESTNET, perTx: '1', perWindow: '1' }],
    ['an unpinned asset', { network: 'stellar:testnet', asset: 'USDC:GAAAA', perTx: '1', perWindow: '1' }],
    ['a pubnet asset on testnet', { network: 'stellar:testnet', asset: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', perTx: '1', perWindow: '1' }],
    ['a zero cap', { network: 'stellar:testnet', asset: USDC_TESTNET, perTx: '0', perWindow: '1' }],
    ['an over-precise cap', { network: 'stellar:testnet', asset: USDC_TESTNET, perTx: '0.00000001', perWindow: '1' }],
    ['perTx above perWindow', { network: 'stellar:testnet', asset: USDC_TESTNET, perTx: '2', perWindow: '1' }],
    ['a zero window', { network: 'stellar:testnet', asset: USDC_TESTNET, perTx: '1', perWindow: '1', windowSeconds: 0 }],
  ])('throws on %s', (_n, rule) => {
    expect(() => compilePolicy({ rules: [rule as never] })).toThrow();
  });
  it('throws on duplicate rules (EVM assets compare case-insensitively) and a bad expiry', () => {
    const r = { network: 'eip155:42220' as const, perTx: '1', perWindow: '1' };
    expect(() => compilePolicy({ rules: [{ ...r, asset: CELO_USDC }, { ...r, asset: CELO_USDC.toLowerCase() }] })).toThrow(/duplicate/);
    expect(() => compilePolicy({ rules: [], expiresAt: 'soon' })).toThrow();
  });
});

describe('checkSpend', () => {
  const c = compilePolicy(policy);
  it('allows a spend inside every limit', async () => {
    expect(await checkSpend(c, intent(), none, now)).toBeUndefined();
  });
  it('refuses what no rule covers: another network, another asset', async () => {
    expect(await reason(checkSpend(c, intent({ network: 'stellar:pubnet' }), none, now))).toBe('no_rule');
    expect(await reason(checkSpend(c, intent({ network: 'eip155:5042002', asset: '0x3600000000000000000000000000000000000000' }), none, now))).toBe('no_rule');
  });
  it('caps one spend and the rolling window', async () => {
    expect(await reason(checkSpend(c, intent({ amount: 500_001n }), none, now))).toBe('over_per_tx');
    expect(await reason(checkSpend(c, intent(), async () => 500_001n, now))).toBe('over_window');
    expect(await checkSpend(c, intent(), async () => 500_000n, now)).toBeUndefined();
  });
  it('asks the ledger for exactly the rule window', async () => {
    let since: Date | undefined;
    await checkSpend(c, intent({ network: 'eip155:42220', asset: CELO_USDC.toLowerCase(), amount: 1n, payTo: '0x00000000000000000000000000000000000000aa' }), async (s) => ((since = s), 0n), now);
    expect(since?.toISOString()).toBe('2026-10-17T11:00:00.000Z');
  });
  it('enforces the payee allowlist, case-insensitively on EVM', async () => {
    const evm = (payTo: string) => intent({ network: 'eip155:42220', asset: CELO_USDC, amount: 1n, payTo });
    expect(await checkSpend(c, evm('0x00000000000000000000000000000000000000aa'), none, now)).toBeUndefined();
    expect(await reason(checkSpend(c, evm('0x00000000000000000000000000000000000000bb'), none, now))).toBe('pay_to_not_allowed');
  });
  it('refuses a non-positive amount and an expired policy', async () => {
    expect(await reason(checkSpend(c, intent({ amount: 0n }), none, now))).toBe('bad_amount');
    const expired = compilePolicy({ ...policy, expiresAt: '2026-10-17T12:00:00Z' });
    expect(await reason(checkSpend(expired, intent(), none, now))).toBe('policy_expired');
  });
  it('refusals are typed', () => {
    expect(isSpendRefusal(spendRefusal('no_rule'))).toBe(true);
    expect(isSpendRefusal(new Error('x'))).toBe(false);
  });
});

describe('createMemoryLedger', () => {
  it('sums per network and asset inside the window', async () => {
    const l = createMemoryLedger();
    await l.add({ ...intent({ amount: 3n }), at: new Date('2026-10-17T10:00:00Z') });
    await l.add({ ...intent({ amount: 4n }), at: new Date('2026-10-17T11:30:00Z') });
    await l.add({ ...intent({ amount: 100n, network: 'stellar:pubnet' }), at: now });
    expect(await l.total('stellar:testnet', USDC_TESTNET, new Date('2026-10-17T11:00:00Z'))).toBe(4n);
    expect(await l.total('stellar:testnet', USDC_TESTNET, new Date(0))).toBe(7n);
  });
});
