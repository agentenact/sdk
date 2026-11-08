/**
 * One-time Stellar testnet setup for the opt-in e2e test (tests/e2e/stellar-testnet.test.ts).
 * Generates a SPONSOR (also the agent in the e2e) and a PAYER, friendbots both, adds USDC
 * trustlines, and writes .env.testnet (git-ignored, mode 0600).
 *
 * Two steps are web-only and remain manual:
 *   1. fund the PAYER with testnet USDC at https://faucet.circle.com (Stellar testnet)
 *   2. generate an OZ Channels testnet key at https://channels.openzeppelin.com/testnet/gen
 */
import { writeFile } from 'node:fs/promises';
import { Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const horizon = new Horizon.Server('https://horizon-testnet.stellar.org');

async function friendbot(addr: string) {
  const res = await fetch(`https://friendbot.stellar.org?addr=${addr}`);
  if (!res.ok) throw new Error(`friendbot ${addr}: ${res.status}`);
}

async function trust(kp: Keypair) {
  const acc = await horizon.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: new Asset('USDC', USDC_ISSUER) }))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  return horizon.submitTransaction(tx);
}

const sponsor = Keypair.random();
const payer = Keypair.random();
await Promise.all([friendbot(sponsor.publicKey()), friendbot(payer.publicKey())]);
await new Promise((r) => setTimeout(r, 3000));
await Promise.all([trust(sponsor), trust(payer)]);
await writeFile('.env.testnet', `SPONSOR_SECRET=${sponsor.secret()}\nPAYER_SECRET=${payer.secret()}\nOZ_API_KEY=\n`, { mode: 0o600 });

console.log(`sponsor/agent ${sponsor.publicKey()}`);
console.log(`payer         ${payer.publicKey()}  ← fund with testnet USDC: https://faucet.circle.com`);
console.log(`OZ key        https://channels.openzeppelin.com/testnet/gen → paste into OZ_API_KEY in .env.testnet`);
