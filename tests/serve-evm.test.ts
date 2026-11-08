/** serve() selling on Base Sepolia: the record is chain `base`, signed EIP-191 by the agent key, and verifies from the receipt. */
import { describe, expect, it } from 'bun:test';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { encodeAbiParameters, getAddress, keccak256, pad, toHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ENACTMENT_HEADER, decodeRecordHeader, hexToBytes, verifyRecord } from '../src/index.js';
import { createEvmAdapter, type EvmReadClient } from '../src/adapters/evm.js';
import { createEnactServer, pinRequirements, type X402Server } from '../src/serve.js';

const NETWORK = 'eip155:84532' as const;
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const TX = `0x${'cd'.repeat(32)}` as Hex;
const key = generatePrivateKey();
const agent = privateKeyToAccount(key).address.toLowerCase();
const payer = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();

const REQ = { scheme: 'exact', network: NETWORK, amount: '10000', asset: USDC, payTo: agent, maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2' } } as unknown as PaymentRequirements;
const PAYLOAD = { x402Version: 2, accepted: REQ, payload: {} } as unknown as PaymentPayload;

const chain: EvmReadClient = {
  async getTransactionReceipt() {
    return {
      status: 'success',
      blockNumber: 33_000_001n,
      logs: [{ address: USDC, topics: [keccak256(toHex('Transfer(address,address,uint256)')), pad(payer as Hex), pad(agent as Hex)], data: encodeAbiParameters([{ type: 'uint256' }], [10_000n]) }],
    };
  },
  async getBlock() {
    return { timestamp: BigInt(Math.floor(Date.now() / 1000) - 3) };
  },
  async readContract({ functionName }) {
    return functionName === 'ownerOf' ? '0x00000000000000000000000000000000000000ee' : agent;
  },
};

describe('serve on Base Sepolia', () => {
  it('pins Base Sepolia USDC at construction and refuses an unknown token', () => {
    expect([...pinRequirements(NETWORK, [REQ]).values()]).toEqual([{ asset: USDC.toLowerCase(), decimals: 6 }]);
    expect(() => pinRequirements(NETWORK, [{ ...REQ, asset: `0x${'b'.repeat(40)}` }])).toThrow(/unknown asset/);
  });

  it('a paid call returns a base record that verifies from the receipt, identity included', async () => {
    const adapter = createEvmAdapter({ network: NETWORK, client: chain });
    const x402: X402Server = {
      async accepts() { return [REQ]; },
      async paymentRequired() { return { status: 402, headers: { 'PAYMENT-REQUIRED': 'req' }, body: '{}' }; },
      // Checksummed, as the x402.org facilitator reports it.
      async verify() { return { ok: true, requirements: REQ, payload: PAYLOAD, payer: getAddress(payer), asset: USDC.toLowerCase(), decimals: 6 }; },
      async settle() { return { ok: true, transaction: TX, payer: getAddress(payer), amount: '0.010000', responseHeader: 'resp' }; },
    };
    const handle = await createEnactServer({
      network: NETWORK,
      agent: { address: agent, agentId: '7', secret: hexToBytes(key.slice(2)) },
      adapter,
      price: '$0.01',
      facilitator: { url: 'https://example.invalid', apiKey: '' },
      resource: 'https://agent.example/echo',
      handler: async (input) => ({ body: input, mediaType: 'text/plain' }),
      x402,
    });
    const res = await handle(new Request('https://agent.example/echo', { method: 'POST', body: 'hi', headers: { 'PAYMENT-SIGNATURE': 'good' } }));
    expect(res.status).toBe(200);
    const record = decodeRecordHeader(res.headers.get(ENACTMENT_HEADER)!);
    expect(record.agent).toEqual({ chain: 'base', address: agent, agentId: '7' });
    expect(record.settlement).toMatchObject({ chain: 'base', ref: TX, payer, amount: '0.010000', asset: USDC.toLowerCase() });
    expect(record.sig.alg).toBe('secp256k1-eip191');
    expect((await verifyRecord(record, adapter)).ok).toBe(true);
  });

  it('refuses a Stellar adapter for a Base Sepolia network at construction', async () => {
    const stellar = { ...createEvmAdapter({ network: NETWORK, client: chain }), chain: 'stellar' as const };
    expect(
      createEnactServer({
        network: NETWORK, agent: { address: agent, secret: new Uint8Array(32) }, adapter: stellar, price: '0.01',
        facilitator: { url: 'x', apiKey: '' }, resource: 'x', handler: async (i) => ({ body: i, mediaType: 'text/plain' }), x402: {} as X402Server,
      }),
    ).rejects.toThrow(/does not match/);
  });
});
