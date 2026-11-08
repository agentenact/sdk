import { describe, expect, it } from 'bun:test';
import { encodeAbiParameters, keccak256, pad, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createEvmAdapter, type EvmReadClient } from '../../src/adapters/evm.js';
import { hexToBytes, sha256 } from '../../src/index.js';

const key = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const acct = privateKeyToAccount(key);
const OTHER = '0x000000000000000000000000000000000000dEaD' as Hex;
const USDC = '0xceba9300f2b948710d2653dd7b07f33a8b32118c';
const TX = ('0x' + 'c'.repeat(64)) as Hex;
const TRANSFER = keccak256(toHex('Transfer(address,address,uint256)'));

function client(over: Partial<EvmReadClient> = {}): EvmReadClient {
  return {
    async getTransactionReceipt() {
      return {
        status: 'success',
        blockNumber: 100n,
        logs: [
          { address: USDC, topics: [TRANSFER, pad(OTHER), pad(acct.address)], data: encodeAbiParameters([{ type: 'uint256' }], [10000n]) },
          { address: '0x1111111111111111111111111111111111111111', topics: [TRANSFER, pad(OTHER), pad(acct.address)], data: encodeAbiParameters([{ type: 'uint256' }], [5n]) },
        ],
      };
    },
    async getBlock() {
      return { timestamp: 1788343140n }; // 2026-09-02T09:59:00Z
    },
    async readContract({ functionName }) {
      return functionName === 'ownerOf' ? acct.address : OTHER;
    },
    ...over,
  };
}

describe('evm adapter', () => {
  it('signs EIP-191 over the digest and verifies checksum-insensitively', async () => {
    const a = createEvmAdapter({ network: 'eip155:42220', client: client() });
    const d = await sha256('hello');
    const sig = await a.sign(d, hexToBytes(key));
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
    expect(await a.verify(d, sig, acct.address.toLowerCase())).toBe(true);
    expect(await a.verify(await sha256('x'), sig, acct.address)).toBe(false);
    expect(await a.verify(d, '0xzz', acct.address)).toBe(false);
  });
  it('reads ERC-20 Transfer logs into settlements, skipping unknown tokens', async () => {
    const a = createEvmAdapter({ network: 'eip155:42220', client: client() });
    expect(await a.readSettlement(TX)).toEqual([
      { chain: 'celo', ref: TX, payer: OTHER.toLowerCase(), payee: acct.address.toLowerCase(), amount: '0.010000', asset: USDC, at: '2026-09-02T09:59:00Z' },
    ]);
  });
  it('returns [] for a reverted or missing tx', async () => {
    const reverted = createEvmAdapter({
      network: 'eip155:42220',
      client: client({ async getTransactionReceipt() { return { status: 'reverted', blockNumber: 1n, logs: [] }; } }),
    });
    expect(await reverted.readSettlement(TX)).toEqual([]);
    const missing = createEvmAdapter({
      network: 'eip155:42220',
      client: client({ async getTransactionReceipt() { throw new Error('TransactionReceiptNotFoundError'); } }),
    });
    expect(await missing.readSettlement(TX)).toEqual([]);
  });
  it('resolves identity via ownerOf + getAgentWallet, lowercase; null on revert', async () => {
    const a = createEvmAdapter({ network: 'eip155:5042002', client: client() });
    expect(await a.resolveIdentity('72077')).toEqual({ owner: acct.address.toLowerCase(), wallet: OTHER.toLowerCase() });
    const none = createEvmAdapter({
      network: 'eip155:5042002',
      client: client({ async readContract() { throw new Error('execution reverted'); } }),
    });
    expect(await none.resolveIdentity('1')).toBeNull();
    expect(await a.resolveIdentity('abc')).toBeNull();
  });
});
