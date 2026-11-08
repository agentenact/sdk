/**
 * Records the testnet responses the conformance vectors replay offline:
 * Horizon JSON for each settlement tx, and the Soroban simulate results the
 * identity check reads. Run once, by hand; the test never calls it.
 *
 *   bun run scripts/capture-vector-fixtures.ts
 *
 * Writes tests/vectors/fixtures/. Read-only against testnet: nothing is signed or sent.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Account, Contract, Networks, TransactionBuilder, nativeToScVal, BASE_FEE } from '@stellar/stellar-sdk';
import { NETWORKS } from '../src/networks.js';

const HORIZON = 'https://horizon-testnet.stellar.org';
const RPC = 'https://soroban-testnet.stellar.org';
const OUT = join(import.meta.dir, '..', 'tests', 'vectors', 'fixtures');
// Any funded-or-not G address works as a view-call source; simulate never checks it.
const VIEW_SOURCE = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

const TXS = [
  'f951b337cdf8305e523a88fc2cf9db9c44a763c837718aa819a9041f00be73d0',
  'f2a1cf804df37d1e779d759ef87bbeca5b37fa9bcca75fc2d59ad92e0eb47f75',
];
const IDENTITY = [
  ['find_owner', 31],
  ['get_agent_wallet', 31],
  ['find_owner', 4000000],
] as const;

/** File name for a Horizon path, the same mapping the replay uses. */
export const horizonFile = (path: string) => `${path.replace(/^\//, '').replace(/[/?=&]/g, '_') || 'root'}.json`;

async function horizon(path: string): Promise<void> {
  const res = await fetch(`${HORIZON}${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  await writeFile(join(OUT, 'horizon', horizonFile(path)), JSON.stringify(await res.json(), null, 2) + '\n');
}

async function main(): Promise<void> {
  await mkdir(join(OUT, 'horizon'), { recursive: true });
  await mkdir(join(OUT, 'rpc'), { recursive: true });
  // historyStart: Horizon's oldest ledger and its close time (2025-12-17 after the last testnet reset)
  await horizon('/');
  const elder = JSON.parse(await Bun.file(join(OUT, 'horizon', horizonFile('/'))).text()).history_elder_ledger;
  await horizon(`/ledgers/${elder}`);
  for (const ref of TXS) {
    await horizon(`/transactions/${ref}`);
    await horizon(`/transactions/${ref}/payments?limit=200`);
  }
  const registry = NETWORKS['stellar:testnet'].identityRegistry;
  if (!registry) throw new Error('no testnet identity registry pinned');
  for (const [method, id] of IDENTITY) {
    const tx = new TransactionBuilder(new Account(VIEW_SOURCE, '0'), { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
      .addOperation(new Contract(registry).call(method, nativeToScVal(id, { type: 'u32' })))
      .setTimeout(30)
      .build();
    // Plain JSON-RPC over fetch: the SDK's axios client does not go through an HTTPS proxy.
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'simulateTransaction', params: { transaction: tx.toXDR() } }),
    });
    const { result } = (await res.json()) as { result: { error?: string; results?: { xdr: string }[] } };
    const body = result.error ? { error: result.error } : { retval: result.results?.[0]?.xdr ?? null };
    await writeFile(join(OUT, 'rpc', `${method}-${id}.json`), JSON.stringify(body, null, 2) + '\n');
  }
}

if (import.meta.main) await main();
