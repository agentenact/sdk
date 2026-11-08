/**
 * Give the testnet demo agent an owner, so its records can be checked against
 * two wallets: the agent's (it signs every record) and the owner's (it holds the
 * agent's stellar-8004 identity).
 *
 * 1. The owner wallet registers an agentId on the pinned testnet Identity Registry.
 * 2. The owner binds the agent's wallet to that agentId. `set_agent_wallet`
 *    requires both the owner's and the agent's authorisation, so an owner can
 *    never claim an agent that did not agree, and vice versa.
 *
 * Idempotent: the owner key and agentId are kept in .env.testnet.owner
 * (git-ignored, mode 0600); a second run skips finished steps. Only public
 * data is printed.
 *
 *   bun --env-file=.env.testnet run scripts/testnet-bind-owner.ts
 */
import { readFile, writeFile } from 'node:fs/promises';
import {
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  authorizeEntry,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { createStellarAdapter } from '../src/adapters/stellar.js';
import { NETWORKS } from '../src/networks.js';

const OWNER_FILE = '.env.testnet.owner';
const net = NETWORKS['stellar:testnet'];
const registry = net.identityRegistry!;
const server = new rpc.Server(net.sorobanRpcUrl!);

const { SPONSOR_SECRET } = process.env;
if (!SPONSOR_SECRET) throw new Error('testnet-bind-owner: SPONSOR_SECRET must be set (bun --env-file=.env.testnet)');
const agent = Keypair.fromSecret(SPONSOR_SECRET);

async function loadOwnerFile(): Promise<Record<string, string>> {
  try {
    const text = await readFile(OWNER_FILE, 'utf8');
    return Object.fromEntries(text.split('\n').filter(Boolean).map((l) => l.split('=', 2) as [string, string]));
  } catch {
    return {};
  }
}

async function saveOwnerFile(vars: Record<string, string>): Promise<void> {
  await writeFile(OWNER_FILE, Object.entries(vars).map(([k, v]) => `${k}=${v}\n`).join(''), { mode: 0o600 });
}

/** Simulate, let `cosigner` sign its own auth entry, re-simulate for the real footprint, sign as source, send, wait. */
async function invoke(source: Keypair, fn: string, args: xdr.ScVal[], cosigner?: Keypair): Promise<unknown> {
  const build = (auth?: xdr.SorobanAuthorizationEntry[]) =>
    server.getAccount(source.publicKey()).then((account) =>
      new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
        .addOperation(Operation.invokeContractFunction({ contract: registry, function: fn, args, ...(auth ? { auth } : {}) }))
        .setTimeout(120)
        .build(),
    );

  let tx = await build();
  let sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${fn} simulation failed: ${sim.error}`);

  if (cosigner) {
    const validUntil = (await server.getLatestLedger()).sequence + 100;
    const auth = await Promise.all(
      (sim.result?.auth ?? []).map((entry) => {
        const creds = entry.credentials();
        const isCosigner =
          creds.switch() === xdr.SorobanCredentialsType.sorobanCredentialsAddress() &&
          Keypair.fromPublicKey(cosigner.publicKey()).xdrPublicKey().toXDR('hex') ===
            creds.address().address().accountId().toXDR('hex');
        return isCosigner ? authorizeEntry(entry, cosigner, validUntil, Networks.TESTNET) : Promise.resolve(entry);
      }),
    );
    tx = await build(auth);
    sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error(`${fn} simulation with signed auth failed: ${sim.error}`);
  }

  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(source);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === 'ERROR') throw new Error(`${fn} rejected: ${JSON.stringify(sent.errorResult?.result().switch().name)}`);
  const done = await server.pollTransaction(sent.hash, { attempts: 30 });
  if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`${fn} did not succeed: ${done.status} (${sent.hash})`);
  console.log(`${fn}  tx ${sent.hash}`);
  return done.returnValue ? scValToNative(done.returnValue) : undefined;
}

const vars = await loadOwnerFile();
let owner: Keypair;
if (vars.OWNER_SECRET) {
  owner = Keypair.fromSecret(vars.OWNER_SECRET);
} else {
  owner = Keypair.random();
  vars.OWNER_SECRET = owner.secret();
  await saveOwnerFile(vars);
  await server.fundAddress(owner.publicKey());
  console.log('owner funded by friendbot');
}
console.log(`owner  ${owner.publicKey()}`);
console.log(`agent  ${agent.publicKey()}`);

if (!vars.AGENT_ID) {
  const registration = {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: 'AgentEnact demo agent',
    description: 'Testnet agent behind the live proof on https://agentenact.srvl.app',
  };
  const uri = `data:application/json;base64,${Buffer.from(JSON.stringify(registration)).toString('base64')}`;
  const agentId = await invoke(owner, 'register_with_uri', [
    nativeToScVal(owner.publicKey(), { type: 'address' }),
    nativeToScVal(uri, { type: 'string' }),
  ]);
  vars.AGENT_ID = String(agentId);
  await saveOwnerFile(vars);
}
const agentId = vars.AGENT_ID!;
console.log(`agentId ${agentId}`);

const adapter = createStellarAdapter({ network: 'testnet' });
let binding = await adapter.resolveIdentity(agentId);
if (binding?.wallet !== agent.publicKey()) {
  await invoke(
    owner,
    'set_agent_wallet',
    [
      nativeToScVal(owner.publicKey(), { type: 'address' }),
      nativeToScVal(Number(agentId), { type: 'u32' }),
      nativeToScVal(agent.publicKey(), { type: 'address' }),
    ],
    agent,
  );
  binding = await adapter.resolveIdentity(agentId);
}

if (binding?.owner !== owner.publicKey() || binding.wallet !== agent.publicKey()) {
  throw new Error(`binding not as expected: ${JSON.stringify(binding)}`);
}
console.log(`bound  agentId ${agentId}: owner ${binding.owner}, agent wallet ${binding.wallet}`);
