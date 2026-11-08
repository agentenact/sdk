import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Keypair } from '@stellar/stellar-sdk';
import { createStellarAdapter, stellarSecretToBytes } from '../../src/adapters/stellar.js';
import { createEnactServer } from '../../src/serve.js';
import { hire } from '../../src/hire.js';

// Opt-in, real money on testnet:
//   bun run scripts/testnet-setup.ts   (once; then do the two manual web steps it prints)
//   set -a; source .env.testnet; set +a; AGENTENACT_TESTNET=1 bun test tests/e2e/stellar-testnet.test.ts
const env = process.env;
const live = env.AGENTENACT_TESTNET === '1' && !!env.SPONSOR_SECRET && !!env.PAYER_SECRET && !!env.OZ_API_KEY;

describe.skipIf(!live)('x402 on Stellar testnet — serve → hire → verify', () => {
  // The SPONSOR doubles as the agent for this test (funded, has a trustline).
  // Built inside beforeAll: describe.skipIf still evaluates the describe body.
  let agent: Keypair;
  let adapter: ReturnType<typeof createStellarAdapter>;
  let srv: ReturnType<typeof Bun.serve>;

  beforeAll(async () => {
    agent = Keypair.fromSecret(env.SPONSOR_SECRET!);
    adapter = createStellarAdapter({ network: 'testnet' });
    const handler = await createEnactServer({
      network: 'stellar:testnet',
      agent: { address: agent.publicKey(), secret: stellarSecretToBytes(agent.secret()) }, // no agentId on testnet
      adapter,
      price: '$0.001',
      facilitator: { url: 'https://channels.openzeppelin.com/x402/testnet', apiKey: env.OZ_API_KEY! },
      resource: 'http://localhost/summarise',
      handler: async (input) => ({
        body: new TextEncoder().encode(JSON.stringify({ summary: `${input.byteLength} bytes` })),
        mediaType: 'application/json',
      }),
    });
    srv = Bun.serve({ port: 0, fetch: handler });
  });
  afterAll(() => srv?.stop());

  it('pays 0.001 USDC, gets output + a record that verifies from public testnet data', async () => {
    const r = await hire(
      `http://localhost:${srv.port}/summarise`,
      { method: 'POST', body: 'hello stellar' },
      { adapter, payer: { secret: env.PAYER_SECRET!, network: 'stellar:testnet' }, maxAmount: '0.01' },
    );
    console.log('settlement', r.settlement, 'problems', r.problems);
    expect(r.response.status).toBe(200);
    expect(r.settlement?.transaction).toMatch(/^[0-9a-f]{64}$/);
    expect(r.verification?.checks).toMatchObject({ signature: 'pass', settlement: 'pass', timing: 'pass', identity: 'skipped' });
    expect(r.consistent).toBe(true);
  }, 120_000);
});
