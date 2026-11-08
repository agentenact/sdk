import { describe, expect, it } from 'bun:test';
import { decodeEvmTransfer } from '../src/signer.js';

const NOW = new Date('2026-10-28T18:00:00Z');
const nowS = NOW.getTime() / 1000;
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const td = (m: Record<string, unknown> = {}, d: Record<string, unknown> = {}) => ({
  domain: { name: 'USDC', version: '2', chainId: '84532', verifyingContract: USDC, ...d },
  types: { TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ] },
  primaryType: 'TransferWithAuthorization',
  message: {
    from: `0x${'A1'.repeat(20)}`, to: `0x${'b2'.repeat(20)}`, value: '10000', validAfter: String(nowS - 600),
    validBefore: String(nowS + 300), nonce: `0x${'00'.repeat(32)}`, ...m,
  },
});
const reason = (p: Promise<unknown>) => p.then(() => 'ok', (e: { reason?: string }) => e.reason);

describe('decodeEvmTransfer', () => {
  it('returns the spend in lowercase and typed data rebuilt from the checked fields', async () => {
    const t = await decodeEvmTransfer(td(), 'eip155:84532', { now: NOW });
    expect(t.intent).toEqual({ network: 'eip155:84532', asset: USDC.toLowerCase(), amount: 10_000n, from: `0x${'a1'.repeat(20)}`, payTo: `0x${'b2'.repeat(20)}` });
    expect(t.typedData.domain.chainId).toBe(84532n);
    expect(t.typedData.message.value).toBe(10_000n);
  });
  it.each([
    ['another chain id', td({}, { chainId: '8453' }), 'wrong_network'],
    ['an unpinned token', td({}, { verifyingContract: `0x${'c3'.repeat(20)}` }), 'unknown_asset'],
    ['the zero address as payee', td({ to: `0x${'0'.repeat(40)}` }), 'bad_payload'],
    ['a window past maxValidity', td({ validBefore: String(nowS + 301) }), 'bad_validity'],
    ['an expired window', td({ validBefore: String(nowS) }), 'bad_validity'],
    ['a salted domain', td({}, { salt: `0x${'00'.repeat(32)}` }), 'unsupported_payload'],
  ])('refuses %s', async (_n, typed, r) => {
    expect(await reason(decodeEvmTransfer(typed as never, 'eip155:84532', { now: NOW }))).toBe(r);
  });
  it('refuses a Stellar network', async () => {
    expect(await reason(decodeEvmTransfer(td() as never, 'stellar:testnet', { now: NOW }))).toBe('wrong_network');
  });
});
