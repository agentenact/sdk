/**
 * Solana adapter for Enactment Records. No SDK: JSON-RPC over fetch and WebCrypto Ed25519.
 *  - Signing: ed25519 over the raw 32-byte record digest with the agent's seed (the first 32 bytes of a Solana
 *    64-byte keypair, or the bare seed). Verify against the base58 address, which is the raw public key.
 *  - Settlement: `getTransaction` (jsonParsed) — every SPL Token `transferChecked` / `transfer`, outer and inner, of
 *    a pinned mint. The payer is the transfer's authority (the token owner, as x402 builds it), the payee the owner
 *    of the destination token account from the transaction's token balances. Unknown mints are skipped, never
 *    guessed. [] when the transaction does not exist or failed; throws on any other RPC error.
 *  - Identity: Solana has no ERC-8004 registry, so resolveIdentity is always null.
 */
export { base58Decode, base58Encode, isSolanaAddress } from '../base58.js';
import type { ChainAdapter, IdentityBinding, Settlement } from '../adapter.js';
import { base58Decode, base58Encode, isSolanaAddress } from '../base58.js';
import { bytesToHex, hexToBytes } from '../record.js';
import { formatUnits, networkFor, recordAsset, type SolanaCaip2 } from '../networks.js';

export interface SolanaAdapterOptions {
  network: SolanaCaip2;
  rpcUrl?: string;
  /** Injected for tests. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
}

const TOKEN_PROGRAMS = new Set(['spl-token', 'spl-token-2022']);
/** PKCS#8 prefix for a raw 32-byte Ed25519 seed (RFC 8410). */
const PKCS8_ED25519 = hexToBytes('302e020100300506032b657004220420');

interface ParsedIx {
  program?: string;
  parsed?: { type?: string; info?: Record<string, unknown> };
}
interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
}
interface RpcTx {
  blockTime: number | null;
  meta: { err: unknown; postTokenBalances?: TokenBalance[]; preTokenBalances?: TokenBalance[]; innerInstructions?: { instructions: ParsedIx[] }[] } | null;
  transaction: { message: { accountKeys: ({ pubkey: string } | string)[]; instructions: ParsedIx[] } };
}

const seedOf = (secret: Uint8Array): Uint8Array => {
  if (secret.length !== 32 && secret.length !== 64) throw new Error('agentenact: a Solana secret is a 32-byte seed or a 64-byte keypair');
  return secret.slice(0, 32);
};

/** Sign `message` with an Ed25519 seed (WebCrypto). */
export async function ed25519Sign(message: Uint8Array, seed: Uint8Array): Promise<Uint8Array> {
  const pkcs8 = new Uint8Array([...PKCS8_ED25519, ...seedOf(seed)]);
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('Ed25519', key, message.slice()));
}

/** The base58 address (raw public key) of an Ed25519 seed. */
export async function solanaAddressOf(seed: Uint8Array): Promise<string> {
  const pkcs8 = new Uint8Array([...PKCS8_ED25519, ...seedOf(seed)]);
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', key);
  const pub = Uint8Array.from(atob(jwk.x!.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  return base58Encode(pub);
}

export function createSolanaAdapter(opts: SolanaAdapterOptions): ChainAdapter {
  const net = networkFor(opts.network);
  if (net.chain !== 'solana') throw new Error(`agentenact: ${opts.network} is not a Solana network`);
  const url = opts.rpcUrl ?? net.rpcUrl!;
  const f = opts.fetch ?? globalThis.fetch;

  async function call<T>(method: string, params: unknown[]): Promise<T> {
    const res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (!res.ok) throw new Error(`agentenact: solana rpc ${method} answered ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error) throw new Error(`agentenact: solana rpc ${method}: ${body.error.message ?? 'error'}`);
    return body.result as T;
  }

  return {
    chain: 'solana',
    sigAlg: 'ed25519',

    async sign(digest, secret) {
      return bytesToHex(await ed25519Sign(digest, secret));
    },

    async verify(digest, signatureHex, address) {
      try {
        if (!isSolanaAddress(address) || !/^[0-9a-f]{128}$/.test(signatureHex)) return false;
        const key = await crypto.subtle.importKey('raw', base58Decode(address).slice(), { name: 'Ed25519' }, false, ['verify']);
        return await crypto.subtle.verify('Ed25519', key, hexToBytes(signatureHex).slice(), digest.slice());
      } catch {
        return false;
      }
    },

    async readSettlement(ref): Promise<Settlement[]> {
      if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(ref)) return [];
      const tx = await call<RpcTx | null>('getTransaction', [ref, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }]);
      if (!tx || !tx.meta || tx.meta.err !== null || tx.blockTime === null) return [];
      const at = new Date(tx.blockTime * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
      const owners = new Map<string, { owner: string; mint: string }>();
      for (const b of [...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])]) {
        const account = keys[b.accountIndex];
        if (account && b.owner) owners.set(account, { owner: b.owner, mint: b.mint });
      }
      const all = [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions ?? []).flatMap((i) => i.instructions)];
      const out: Settlement[] = [];
      for (const ix of all) {
        if (!ix.program || !TOKEN_PROGRAMS.has(ix.program)) continue;
        const type = ix.parsed?.type;
        const info = ix.parsed?.info;
        if (!info || (type !== 'transferChecked' && type !== 'transfer')) continue;
        const destination = owners.get(String(info.destination));
        const mint = typeof info.mint === 'string' ? info.mint : destination?.mint;
        if (!mint || !destination || destination.mint !== mint) continue;
        let known: { asset: string; decimals: number };
        try {
          known = recordAsset(opts.network, mint);
        } catch {
          continue; // unknown mint: skip, never guess
        }
        const raw = type === 'transferChecked' ? (info.tokenAmount as { amount?: unknown } | undefined)?.amount : info.amount;
        const payer = typeof info.authority === 'string' ? info.authority : typeof info.multisigAuthority === 'string' ? info.multisigAuthority : null;
        if (typeof raw !== 'string' || !/^\d+$/.test(raw) || !payer) continue;
        out.push({ chain: 'solana', ref, payer, payee: destination.owner, amount: formatUnits(raw, known.decimals), asset: known.asset, at });
      }
      return out;
    },

    async resolveIdentity(): Promise<IdentityBinding | null> {
      return null;
    },
  };
}
