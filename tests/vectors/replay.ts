import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { xdr, type Transaction } from '@stellar/stellar-sdk';
import { createStellarAdapter, type StellarAdapterOptions } from '../../src/adapters/stellar.js';
import { horizonFile } from '../../scripts/capture-vector-fixtures.js';

/** Offline testnet: the recorded Horizon and Soroban answers under fixtures/. */
export const VECTORS_DIR = import.meta.dir;

/** Horizon replay: a recorded file per path, 404 for anything not recorded. */
export async function replayFetch(url: string | URL | Request): Promise<Response> {
  const path = new URL(String(url)).pathname + new URL(String(url)).search;
  const body = await readFile(join(VECTORS_DIR, 'fixtures', 'horizon', horizonFile(path)), 'utf8').catch(() => null);
  return body === null ? new Response('{"status":404}', { status: 404 }) : new Response(body, { status: 200 });
}

/** Soroban replay: answers find_owner / get_agent_wallet from fixtures/rpc. */
export const replayRpc = {
  async simulateTransaction(tx: Transaction) {
    const op = tx.operations[0] as unknown as { func: xdr.HostFunction };
    const call = op.func.invokeContract();
    const file = `${call.functionName().toString()}-${call.args()[0]!.u32()}.json`;
    const body = JSON.parse(await readFile(join(VECTORS_DIR, 'fixtures', 'rpc', file), 'utf8')) as { retval?: string; error?: string };
    if (body.error) return { error: body.error };
    return { result: { retval: xdr.ScVal.fromXDR(body.retval!, 'base64') } };
  },
};

export const replayAdapter = (opts: StellarAdapterOptions = {}) =>
  createStellarAdapter({ network: 'testnet', fetch: replayFetch as typeof fetch, rpc: replayRpc, ...opts });
