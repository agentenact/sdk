import { describe, expect, it } from 'bun:test';
import { Address, Keypair, nativeToScVal, xdr, type Transaction } from '@stellar/stellar-sdk';
import {
  STELLAR_IDENTITY_REGISTRY,
  STELLAR_IDENTITY_REGISTRY_TESTNET,
  STELLAR_USDC,
  createStellarAdapter,
  stellarSecretToBytes,
  type SorobanSimulator,
} from '../../src/adapters/stellar.js';
import { bytesToHex, sha256 } from '../../src/index.js';
import { NETWORKS } from '../../src/networks.js';

const kp = Keypair.random();
const OWNER = Keypair.random().publicKey();
const TX = 'f'.repeat(64);
const USDC_ISSUER = STELLAR_USDC.split(':')[1]!;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function horizonFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    const hit = routes[path];
    return hit ? hit() : jsonResponse({ status: 404 }, 404);
  }) as typeof fetch;
}

type SimTx = { operations: Array<{ func: { value(): { functionName(): Buffer } } }> };

/** Fake Soroban RPC: answers by invoked method name; unknown method → simulate error. */
export function fakeRpc(answers: Record<string, string | null>): SorobanSimulator {
  return {
    async simulateTransaction(tx: Transaction) {
      const name = (tx as SimTx).operations[0]!.func.value().functionName().toString();
      if (!(name in answers)) return { error: `unknown method ${name}` };
      const v = answers[name];
      const retval = v === null ? xdr.ScVal.scvVoid() : nativeToScVal(v, { type: 'address' });
      return { result: { retval } };
    },
  };
}

describe('stellar adapter — signing', () => {
  it('signs a digest with a raw seed and verifies against the G address', async () => {
    const adapter = createStellarAdapter({ fetch: horizonFetch({}), rpc: fakeRpc({}) });
    const digest = await sha256('hello');
    const sig = await adapter.sign(digest, new Uint8Array(kp.rawSecretKey()));
    expect(sig).toMatch(/^[0-9a-f]{128}$/);
    expect(await adapter.verify(digest, sig, kp.publicKey())).toBe(true);
    expect(await adapter.verify(digest, sig, Keypair.random().publicKey())).toBe(false);
    expect(await adapter.verify(await sha256('bye'), sig, kp.publicKey())).toBe(false);
  });
  it('verify never throws on garbage', async () => {
    const adapter = createStellarAdapter({ fetch: horizonFetch({}), rpc: fakeRpc({}) });
    expect(await adapter.verify(new Uint8Array(32), 'zz', 'not-an-address')).toBe(false);
    expect(await adapter.verify(new Uint8Array(32), 'zz', kp.publicKey())).toBe(false);
    expect(await adapter.verify(new Uint8Array(32), 'ab', kp.publicKey())).toBe(false);
  });
  it('stellarSecretToBytes decodes an S… secret to the 32-byte seed', () => {
    expect(bytesToHex(stellarSecretToBytes(kp.secret()))).toBe(bytesToHex(new Uint8Array(kp.rawSecretKey())));
  });
});

describe('stellar adapter — readSettlement', () => {
  const LOOKALIKE = Keypair.random().publicKey();
  const paymentsBody = {
    _embedded: {
      records: [
        { type: 'payment', from: OWNER, to: kp.publicKey(), amount: '0.0100000', asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER },
        { type: 'payment', from: OWNER, to: kp.publicKey(), amount: '1.0000000', asset_type: 'native' },
        { type: 'path_payment_strict_send', from: OWNER, to: kp.publicKey(), amount: '2.0000000', asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER },
        {
          type: 'invoke_host_function',
          asset_balance_changes: [
            { type: 'transfer', from: OWNER, to: kp.publicKey(), amount: '19.9700000', asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER },
            { type: 'mint', to: kp.publicKey(), amount: '5.0000000', asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER },
          ],
        },
        { type: 'payment', from: OWNER, to: kp.publicKey(), amount: '9.0000000', asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: LOOKALIKE },
        { type: 'create_account', account: OWNER, starting_balance: '1' },
      ],
    },
  };
  it('maps classic, path and Soroban (asset_balance_changes) transfers, pinning the issuer', async () => {
    const adapter = createStellarAdapter({
      fetch: horizonFetch({
        [`/transactions/${TX}`]: () => jsonResponse({ successful: true, created_at: '2026-09-02T09:59:00Z' }),
        [`/transactions/${TX}/payments`]: () => jsonResponse(paymentsBody),
      }),
      rpc: fakeRpc({}),
    });
    const at = '2026-09-02T09:59:00Z';
    const base = { chain: 'stellar' as const, ref: TX, payer: OWNER, payee: kp.publicKey(), at };
    expect(await adapter.readSettlement(TX)).toEqual([
      { ...base, amount: '0.0100000', asset: STELLAR_USDC },
      { ...base, amount: '1.0000000', asset: 'XLM' },
      { ...base, amount: '2.0000000', asset: STELLAR_USDC },
      { ...base, amount: '19.9700000', asset: STELLAR_USDC },
      { ...base, amount: '9.0000000', asset: `USDC:${LOOKALIKE}` },
    ]);
  });
  it('returns [] for a missing or failed tx', async () => {
    const missing = createStellarAdapter({ fetch: horizonFetch({}), rpc: fakeRpc({}) });
    expect(await missing.readSettlement(TX)).toEqual([]);
    const failed = createStellarAdapter({
      fetch: horizonFetch({
        [`/transactions/${TX}`]: () => jsonResponse({ successful: false, created_at: '2026-09-02T09:59:00Z' }),
      }),
      rpc: fakeRpc({}),
    });
    expect(await failed.readSettlement(TX)).toEqual([]);
  });
  it('throws on a non-404 Horizon error instead of guessing', async () => {
    const adapter = createStellarAdapter({
      fetch: horizonFetch({ [`/transactions/${TX}`]: () => jsonResponse({ status: 503 }, 503) }),
      rpc: fakeRpc({}),
    });
    await expect(adapter.readSettlement(TX)).rejects.toThrow(/503/);
  });
});

describe('stellar adapter — resolveIdentity', () => {
  it('reads find_owner and get_agent_wallet from the identity registry', async () => {
    const adapter = createStellarAdapter({
      fetch: horizonFetch({}),
      rpc: fakeRpc({ find_owner: OWNER, get_agent_wallet: kp.publicKey() }),
    });
    expect(await adapter.resolveIdentity('66')).toEqual({ owner: OWNER, wallet: kp.publicKey() });
    expect(STELLAR_IDENTITY_REGISTRY).toMatch(/^C[A-Z2-7]{55}$/);
  });
  it('returns null for an unregistered id or a non-integer id', async () => {
    const adapter = createStellarAdapter({
      fetch: horizonFetch({}),
      rpc: fakeRpc({ find_owner: null, get_agent_wallet: null }),
    });
    expect(await adapter.resolveIdentity('999999')).toBeNull();
    expect(await adapter.resolveIdentity('abc')).toBeNull();
    expect(await adapter.resolveIdentity('-1')).toBeNull();
    expect(await adapter.resolveIdentity('4294967296')).toBeNull();
  });
  it('testnet resolves identity against the pinned testnet registry', async () => {
    const called: string[] = [];
    const inner = fakeRpc({ find_owner: OWNER, get_agent_wallet: kp.publicKey() });
    const rpc: SorobanSimulator = {
      async simulateTransaction(tx: Transaction) {
        const invoke = (tx.operations[0] as unknown as { func: xdr.HostFunction }).func.invokeContract();
        called.push(Address.fromScAddress(invoke.contractAddress()).toString());
        return inner.simulateTransaction(tx);
      },
    };
    const adapter = createStellarAdapter({ network: 'testnet', fetch: horizonFetch({}), rpc });
    expect(await adapter.resolveIdentity('1')).toEqual({ owner: OWNER, wallet: kp.publicKey() });
    expect(new Set(called)).toEqual(new Set([STELLAR_IDENTITY_REGISTRY_TESTNET]));
    expect(STELLAR_IDENTITY_REGISTRY_TESTNET).toBe(NETWORKS['stellar:testnet'].identityRegistry!);
  });
  it('propagates a simulate error', async () => {
    const adapter = createStellarAdapter({ fetch: horizonFetch({}), rpc: fakeRpc({}) });
    await expect(adapter.resolveIdentity('66')).rejects.toThrow(/find_owner/);
  });
});
