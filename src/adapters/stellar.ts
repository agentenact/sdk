/**
 * Stellar adapter for Enactment Records.
 *
 * - Signing: ed25519 over the raw 32-byte record digest, using the agent's
 *   operator-held seed. This is NOT SEP-53 — SEP-53 is the wallet-UI message
 *   scheme (Freighter); an agent holds its own key and signs the digest
 *   directly. Verify = Keypair.fromPublicKey(G…).verify(digest, sig).
 * - Settlement: Horizon REST (`/transactions/{hash}` + `/payments`). Classic
 *   `payment` / `path_payment_*` ops AND Soroban `invoke_host_function` ops
 *   (via Horizon's `asset_balance_changes`, which is how x402/MPP USDC SAC
 *   transfers appear). [] when the tx is absent (404) or failed; throws on any
 *   other error — never guess.
 * - Asset identity is `CODE:ISSUER` (`XLM` for native). Anyone can issue a
 *   token coded "USDC"; pinning the issuer is what makes a record's
 *   `settlement.asset` unspoofable. Use STELLAR_USDC for Circle USDC.
 * - Identity: stellar-8004 Identity Registry `find_owner` / `get_agent_wallet`
 *   via Soroban simulateTransaction, mirroring AgentKarma's read path.
 *
 * Only this file imports @stellar/stellar-sdk (optional peer dependency).
 */
import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  type Transaction,
  type xdr,
} from '@stellar/stellar-sdk';
import type { ChainAdapter, IdentityBinding, Settlement } from '../adapter.js';
import { bytesToHex, hexToBytes } from '../record.js';
import { NETWORKS } from '../networks.js';
import type { RegistryReader } from '../orchestrate.js';
import { anchorValueBytes, templateAnchorKey, type TemplateAnchorReader } from '../community.js';

/** trionlabs/stellar-8004 Identity Registry, mainnet (same pin AgentKarma uses). Pinned in NETWORKS. */
export const STELLAR_IDENTITY_REGISTRY: string = NETWORKS['stellar:pubnet'].identityRegistry!;
/** trionlabs/stellar-8004 Identity Registry, testnet. Pinned in NETWORKS. */
export const STELLAR_IDENTITY_REGISTRY_TESTNET: string = NETWORKS['stellar:testnet'].identityRegistry!;
export const DEFAULT_HORIZON_URL = 'https://horizon.stellar.org';
export const DEFAULT_SOROBAN_RPC_URL = 'https://mainnet.sorobanrpc.com';
/** Circle USDC on Stellar mainnet, in the adapter's canonical `CODE:ISSUER` form. */
export const STELLAR_USDC = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' as const;

/** Valid, fund-less, never-signing source for read-only simulations. */
const VIEW_SOURCE = 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H';

/** The one Soroban RPC call the adapter needs; `rpc.Server` satisfies it, so do test fakes. */
export interface SorobanSimulator {
  simulateTransaction(tx: Transaction): Promise<unknown>;
}

export interface StellarAdapterOptions {
  /** 'pubnet' (default) or 'testnet'. Sets the Horizon, RPC and identity-registry defaults. */
  network?: 'pubnet' | 'testnet';
  horizonUrl?: string;
  rpcUrl?: string;
  identityRegistry?: string;
  /** Injected for tests. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Injected for tests. Defaults to new rpc.Server(rpcUrl). */
  rpc?: SorobanSimulator;
}

/** Decode an S… secret to its raw 32-byte ed25519 seed. */
export function stellarSecretToBytes(secret: string): Uint8Array {
  return new Uint8Array(StrKey.decodeEd25519SecretSeed(secret));
}

interface HorizonTx {
  successful: boolean;
  created_at: string;
}
interface HorizonAssetRef {
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
}
interface HorizonBalanceChange extends HorizonAssetRef {
  type: string;
  from?: string;
  to?: string;
  amount?: string;
}
interface HorizonPayment extends HorizonBalanceChange {
  asset_balance_changes?: HorizonBalanceChange[];
}

/** `XLM` for native, `CODE:ISSUER` otherwise; null when the asset is unidentifiable. */
function canonicalAsset(a: HorizonAssetRef): string | null {
  if (a.asset_type === 'native') return 'XLM';
  return a.asset_code && a.asset_issuer ? `${a.asset_code}:${a.asset_issuer}` : null;
}

const CLASSIC_PAYMENT_TYPES = new Set(['payment', 'path_payment_strict_send', 'path_payment_strict_receive']);

/** Flatten one Horizon payments record into zero or more transfers. */
function transfersOf(p: HorizonPayment): HorizonBalanceChange[] {
  if (CLASSIC_PAYMENT_TYPES.has(p.type)) return [p];
  if (p.type === 'invoke_host_function') return (p.asset_balance_changes ?? []).filter((c) => c.type === 'transfer');
  return [];
}

export function createStellarAdapter(opts: StellarAdapterOptions = {}): ChainAdapter {
  const testnet = opts.network === 'testnet';
  const horizon = (opts.horizonUrl ?? (testnet ? 'https://horizon-testnet.stellar.org' : DEFAULT_HORIZON_URL)).replace(/\/$/, '');
  const registry = opts.identityRegistry ?? (testnet ? STELLAR_IDENTITY_REGISTRY_TESTNET : STELLAR_IDENTITY_REGISTRY);
  const doFetch = opts.fetch ?? globalThis.fetch;
  const server: SorobanSimulator =
    opts.rpc ?? new rpc.Server(opts.rpcUrl ?? (testnet ? 'https://soroban-testnet.stellar.org' : DEFAULT_SOROBAN_RPC_URL));

  async function getJson<T>(path: string): Promise<T | null> {
    const res = await doFetch(`${horizon}${path}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Horizon ${path} failed: ${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  }

  async function simulateView(method: string, args: xdr.ScVal[]): Promise<unknown> {
    const tx = new TransactionBuilder(new Account(VIEW_SOURCE, '0'), {
      fee: BASE_FEE,
      networkPassphrase: testnet ? Networks.TESTNET : Networks.PUBLIC,
    })
      .addOperation(new Contract(registry).call(method, ...args))
      .setTimeout(30)
      .build();
    const sim = (await server.simulateTransaction(tx)) as
      | { error: string }
      | { result?: { retval: xdr.ScVal } };
    if ('error' in sim && sim.error) throw new Error(`Stellar simulate ${method} failed: ${sim.error}`);
    if (!('result' in sim) || !sim.result) throw new Error(`Stellar simulate ${method} returned no result`);
    return scValToNative(sim.result.retval);
  }

  return {
    chain: 'stellar',
    sigAlg: 'ed25519',

    async sign(digest, secret) {
      return bytesToHex(Keypair.fromRawEd25519Seed(Buffer.from(secret)).sign(Buffer.from(digest)));
    },

    async verify(digest, signatureHex, address) {
      try {
        if (!StrKey.isValidEd25519PublicKey(address)) return false;
        const sig = hexToBytes(signatureHex);
        if (sig.length !== 64) return false;
        return Keypair.fromPublicKey(address).verify(Buffer.from(digest), Buffer.from(sig));
      } catch {
        return false;
      }
    },

    async readSettlement(ref): Promise<Settlement[]> {
      const tx = await getJson<HorizonTx>(`/transactions/${ref}`);
      if (!tx || tx.successful === false) return [];
      const page = await getJson<{ _embedded: { records: HorizonPayment[] } }>(
        `/transactions/${ref}/payments?limit=200`,
      );
      if (!page) return [];
      const out: Settlement[] = [];
      for (const p of page._embedded.records) {
        for (const t of transfersOf(p)) {
          const asset = canonicalAsset(t);
          if (!t.from || !t.to || !t.amount || !asset) continue;
          out.push({ chain: 'stellar', ref, payer: t.from, payee: t.to, amount: t.amount, asset, at: tx.created_at });
        }
      }
      return out;
    },

    async historyStart(): Promise<string | null> {
      const root = await getJson<{ history_elder_ledger?: number }>('/');
      if (!root?.history_elder_ledger) return null;
      const ledger = await getJson<{ closed_at?: string }>(`/ledgers/${root.history_elder_ledger}`);
      return ledger?.closed_at ?? null;
    },

    async resolveIdentity(agentId): Promise<IdentityBinding | null> {
      if (!/^\d+$/.test(agentId)) return null;
      const id = Number(agentId);
      if (!Number.isSafeInteger(id) || id > 0xffff_ffff) return null;
      const arg = nativeToScVal(id, { type: 'u32' });
      const owner = (await simulateView('find_owner', [arg])) as string | null | undefined;
      if (!owner) return null;
      const wallet = (await simulateView('get_agent_wallet', [arg])) as string | null | undefined;
      return { owner, wallet: wallet ?? null };
    },
  };
}

/**
 * Enumerate the registry from chain alone (no indexer, no discovery API): `total_agents`, `agent_exists`,
 * `find_owner`, `get_agent_wallet`, `agent_uri`, each a simulateTransaction from a fund-less view source.
 * An agent without a uri makes `agent_uri` revert in the contract; that reads as ''.
 */
export function createStellarRegistryReader(opts: Pick<StellarAdapterOptions, 'network' | 'rpcUrl' | 'identityRegistry' | 'rpc'> = {}): RegistryReader {
  const testnet = opts.network === 'testnet';
  const registry = opts.identityRegistry ?? (testnet ? STELLAR_IDENTITY_REGISTRY_TESTNET : STELLAR_IDENTITY_REGISTRY);
  const server: SorobanSimulator =
    opts.rpc ?? new rpc.Server(opts.rpcUrl ?? (testnet ? 'https://soroban-testnet.stellar.org' : DEFAULT_SOROBAN_RPC_URL));

  async function view(method: string, args: xdr.ScVal[]): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
    const tx = new TransactionBuilder(new Account(VIEW_SOURCE, '0'), {
      fee: BASE_FEE,
      networkPassphrase: testnet ? Networks.TESTNET : Networks.PUBLIC,
    })
      .addOperation(new Contract(registry).call(method, ...args))
      .setTimeout(30)
      .build();
    const sim = (await server.simulateTransaction(tx)) as { error?: string; result?: { retval: xdr.ScVal } };
    if (sim.error) return { ok: false, error: sim.error };
    if (!sim.result) throw new Error(`Stellar simulate ${method} returned no result`);
    return { ok: true, value: scValToNative(sim.result.retval) };
  }
  // A transport-level failure throws from simulateTransaction itself; `error` in the answer is the contract's.
  const must = async (method: string, args: xdr.ScVal[]) => {
    const r = await view(method, args);
    if (!r.ok) throw new Error(`Stellar simulate ${method} failed: ${r.error}`);
    return r.value;
  };
  const idArg = (agentId: string): xdr.ScVal | null => {
    if (!/^\d{1,10}$/.test(agentId)) return null;
    const id = Number(agentId);
    return id > 0xffff_ffff ? null : nativeToScVal(id, { type: 'u32' });
  };

  return {
    async totalAgents() {
      const v = await must('total_agents', []);
      const n = typeof v === 'bigint' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new Error('Stellar total_agents returned an unexpected value');
      return n;
    },
    async read(agentId) {
      const arg = idArg(agentId);
      if (!arg) return null;
      if ((await must('agent_exists', [arg])) !== true) return null;
      const owner = await must('find_owner', [arg]);
      if (typeof owner !== 'string') return null;
      const wallet = await must('get_agent_wallet', [arg]);
      const uri = await view('agent_uri', [arg]);
      return {
        agentId: String(Number(agentId)),
        owner,
        wallet: typeof wallet === 'string' ? wallet : null,
        uri: uri.ok && typeof uri.value === 'string' ? uri.value : '',
      };
    },
  };
}

// ─── community template anchors ───────────────────────────────────────────────

/**
 * The `manage_data` operation that anchors a community template on its author's own account: name
 * `ae.tpl:<slug>`, value the 32 raw bytes of the template's sha256. One entry per slug, so anchoring a new version
 * replaces the old one (Horizon's operation history keeps every earlier anchor). `null` removes the entry and frees
 * its 0.5 XLM reserve. The caller builds, signs and submits the transaction with the author's key; nothing here
 * sees a secret or the network.
 */
export function templateAnchorOperation(slug: string, sha256: string | null): xdr.Operation {
  return Operation.manageData({ name: templateAnchorKey(slug), value: sha256 === null ? null : Buffer.from(anchorValueBytes(sha256)) });
}

/** Reads `ae.tpl:<slug>` from an account through Horizon. null when the account or the entry does not exist. */
export function createStellarTemplateAnchors(opts: Pick<StellarAdapterOptions, 'network' | 'horizonUrl' | 'fetch'> = {}): TemplateAnchorReader {
  const testnet = opts.network === 'testnet';
  const horizon = (opts.horizonUrl ?? (testnet ? 'https://horizon-testnet.stellar.org' : DEFAULT_HORIZON_URL)).replace(/\/$/, '');
  const doFetch = opts.fetch ?? globalThis.fetch;
  return {
    network: testnet ? 'stellar:testnet' : 'stellar:pubnet',
    async readAnchor(address, slug) {
      if (!StrKey.isValidEd25519PublicKey(address)) return null;
      const key = templateAnchorKey(slug);
      const res = await doFetch(`${horizon}/accounts/${address}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Horizon /accounts failed: ${res.status} ${res.statusText}`);
      const value = ((await res.json()) as { data?: Record<string, string> }).data?.[key];
      if (value === undefined) return null;
      const bytes = Buffer.from(value, 'base64');
      return bytes.length === 32 ? bytesToHex(bytes) : null;
    },
  };
}
