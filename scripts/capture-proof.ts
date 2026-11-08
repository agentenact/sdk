/**
 * Make one real paid call on Stellar testnet and save the PUBLIC evidence the
 * website verifies live: the Enactment Record, the exact input/output bytes (so
 * anyone can re-hash them), the settlement, and the local verification result.
 *
 * The record carries the agent's stellar-8004 agentId (see testnet-bind-owner.ts),
 * so it verifies against both the agent's wallet and its owner's.
 * Secrets come from .env.testnet and never reach the output file or the console.
 *
 *   bun --env-file=.env.testnet --env-file=.env.testnet.owner run scripts/capture-proof.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { Keypair } from '@stellar/stellar-sdk';
import { createStellarAdapter, stellarSecretToBytes } from '../src/adapters/stellar.js';
import { createEnactServer } from '../src/serve.js';
import { hire } from '../src/hire.js';

const { SPONSOR_SECRET, PAYER_SECRET, OZ_API_KEY, AGENT_ID } = process.env;
if (!SPONSOR_SECRET || !PAYER_SECRET || !OZ_API_KEY || !AGENT_ID) {
  throw new Error('capture-proof: SPONSOR_SECRET, PAYER_SECRET, OZ_API_KEY and AGENT_ID must be set (see usage above)');
}

const agent = Keypair.fromSecret(SPONSOR_SECRET);
const adapter = createStellarAdapter({ network: 'testnet' });
const input = 'Summarise: AgentEnact binds every paid output to the payment that bought it.';

const handler = await createEnactServer({
  network: 'stellar:testnet',
  agent: { address: agent.publicKey(), agentId: AGENT_ID, secret: stellarSecretToBytes(agent.secret()) },
  adapter,
  price: '$0.001',
  facilitator: { url: 'https://channels.openzeppelin.com/x402/testnet', apiKey: OZ_API_KEY },
  resource: 'https://agentenact.srvl.app/demo/summarise',
  description: 'AgentEnact demo summariser',
  handler: async (bytes) => ({
    body: new TextEncoder().encode(
      JSON.stringify({ summary: 'Paid outputs carry a signed record tying input, output and settlement together.', inputBytes: bytes.byteLength }),
    ),
    mediaType: 'application/json',
  }),
});

const srv = Bun.serve({ port: 0, fetch: handler });
try {
  const r = await hire(
    `http://localhost:${srv.port}/demo/summarise`,
    { method: 'POST', body: input, headers: { 'content-type': 'text/plain' } },
    { adapter, payer: { secret: PAYER_SECRET, network: 'stellar:testnet' }, maxAmount: '0.01' },
  );
  if (!r.consistent || !r.record || !r.settlement) {
    throw new Error(`capture-proof: run not consistent: ${r.problems.join('; ')}`);
  }
  const proof = {
    network: 'stellar:testnet',
    capturedAt: new Date().toISOString(),
    input,
    output: new TextDecoder().decode(r.output),
    record: r.record,
    settlement: r.settlement,
    verification: r.verification,
    explorer: `https://stellar.expert/explorer/testnet/tx/${r.settlement.transaction}`,
  };
  await mkdir('site/public/proofs', { recursive: true });
  const path = `site/public/proofs/${r.settlement.transaction}.json`;
  await writeFile(path, `${JSON.stringify(proof, null, 2)}\n`);
  await writeFile('site/public/proofs/latest.json', `${JSON.stringify(proof, null, 2)}\n`);
  console.log(`saved ${path}`);
  console.log(`tx ${r.settlement.transaction}`);
  console.log(`checks ${JSON.stringify(r.verification?.checks)}`);
} finally {
  srv.stop();
}
