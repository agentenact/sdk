import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createEvmAdapter } from '../../src/adapters/evm.js';
import { hire } from '../../src/hire.js';
import { hexToBytes } from '../../src/record.js';
import { createEnactServer } from '../../src/serve.js';

// Opt-in, Base Sepolia only. The payer needs testnet USDC (faucet.circle.com) and no ETH: the facilitator pays gas.
//   BASE_SEPOLIA_PAYER_KEY=0x… AGENTENACT_TESTNET=1 bun test tests/e2e/base-sepolia.testnet.test.ts
// The seller is a fresh key every run; settlement goes through the public x402.org testnet facilitator.
const live = process.env.AGENTENACT_TESTNET === '1' && !!process.env.BASE_SEPOLIA_PAYER_KEY;
const NETWORK = 'eip155:84532' as const;
const FACILITATOR = 'https://x402.org/facilitator';

describe.skipIf(!live)('serve → hire → verify on Base Sepolia', () => {
  let srv: ReturnType<typeof Bun.serve>;
  let payerKey: Hex;
  let sellerKey: Hex;

  beforeAll(async () => {
    payerKey = process.env.BASE_SEPOLIA_PAYER_KEY as Hex;
    sellerKey = generatePrivateKey();
    const seller = privateKeyToAccount(sellerKey).address;
    srv = Bun.serve({ port: 0, fetch: () => new Response('starting', { status: 503 }) });
    const resource = `http://localhost:${srv.port}/echo`;
    const handle = await createEnactServer({
      network: NETWORK,
      agent: { address: seller.toLowerCase(), secret: hexToBytes(sellerKey.slice(2)) },
      adapter: createEvmAdapter({ network: NETWORK }),
      price: '$0.001',
      facilitator: { url: FACILITATOR, apiKey: '' },
      resource,
      handler: async (input) => ({ body: new TextEncoder().encode(`echo:${new TextDecoder().decode(input)}`), mediaType: 'text/plain' }),
    });
    srv.reload({ fetch: handle });
  }, 60_000);
  afterAll(() => srv?.stop());

  it('pays 0.001 USDC with an EIP-3009 authorization; the record verifies from Base Sepolia', async () => {
    const r = await hire(`http://localhost:${srv.port}/echo`, { method: 'POST', body: 'hello base' }, {
      adapter: createEvmAdapter({ network: NETWORK }),
      payer: { secret: payerKey, network: NETWORK },
      maxAmount: '0.01',
    });
    console.log('base sepolia settlement', r.settlement?.transaction, r.problems);
    expect(r.response.status).toBe(200);
    expect(new TextDecoder().decode(r.output)).toBe('echo:hello base');
    expect(r.paid?.decimal).toBe('0.001000');
    expect(r.record?.agent.chain).toBe('base');
    expect(r.consistent).toBe(true);
  }, 120_000);
});
