/**
 * Agent side of the policy signer: what runs INSIDE the agent's sandbox.
 *
 * The agent holds no key. It holds a transport to the policy signer (signer.ts), which runs outside the
 * sandbox with the keys and the owner's spend policy, and signs on its own whenever a request fits that
 * policy. A prompt-injected or compromised agent can ask for anything; it can only get what the policy
 * allows, because the signer reads the amount, asset and payee from the payload it signs, not from the
 * agent.
 *
 * One agent may own several wallets on different networks (Stellar, Celo, Arc, …). Each wallet is
 * `{ network, address }`; the adapters below turn one into the signer shape x402 clients expect, so it
 * drops into @x402/fetch (or `hire`) in place of a raw key.
 *
 * Zero dependencies. The transport is pluggable: `httpSignerTransport` talks to the signer's handler
 * (`createSignerHandler`) over HTTP; a unix socket or a direct function call works the same way.
 */
import type { Caip2 } from './networks.js';
import type { SpendRefusalReason } from './policy.js';

export interface WalletInfo {
  network: Caip2;
  address: string;
}

/** EIP-712 payload on the wire: bigints travel as decimal strings. */
export interface WireTypedData {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

export type SignRequest =
  | {
      kind: 'stellar_auth_entry';
      network: Caip2;
      address: string;
      /** base64 `HashIdPreimage` (ENVELOPE_TYPE_SOROBAN_AUTHORIZATION), exactly what SEP-43 `signAuthEntry` receives. */
      preimage: string;
    }
  | { kind: 'evm_typed_data'; network: Caip2; address: string; typedData: WireTypedData }
  | {
      kind: 'solana_message';
      network: Caip2;
      address: string;
      /** base64 of the transaction message bytes the payer signs (see solana-transfer.ts for what decodes). */
      message: string;
      /** The offer's payTo: the owner whose token account the transfer must credit. */
      payTo: string;
    }
  | { kind: 'wallets' };

export type SignResponse =
  | { ok: true; signature: string }
  | { ok: true; wallets: WalletInfo[] }
  | { ok: false; reason: SpendRefusalReason | 'bad_request' | 'unauthorized' };

/** Sends one request to the policy signer and returns its answer. JSON-safe both ways. */
export type SignerTransport = (req: SignRequest) => Promise<SignResponse>;

const REASONS = new Set<string>([
  'policy_expired', 'no_rule', 'pay_to_not_allowed', 'bad_amount', 'over_per_tx', 'over_window', 'unknown_wallet',
  'unknown_asset', 'wrong_network', 'unsupported_payload', 'bad_payload', 'bad_validity', 'bad_request', 'unauthorized',
]);

function parseResponse(body: unknown): SignResponse {
  const b = body as { ok?: unknown; signature?: unknown; wallets?: unknown; reason?: unknown } | null;
  if (b && b.ok === true && typeof b.signature === 'string') return { ok: true, signature: b.signature };
  if (b && b.ok === true && Array.isArray(b.wallets)) {
    const ok = b.wallets.every((w) => w && typeof w === 'object' && typeof w.network === 'string' && typeof w.address === 'string');
    if (ok) return { ok: true, wallets: (b.wallets as WalletInfo[]).map((w) => ({ network: w.network, address: w.address })) };
  }
  if (b && b.ok === false && typeof b.reason === 'string' && REASONS.has(b.reason)) return { ok: false, reason: b.reason as never };
  return { ok: false, reason: 'bad_request' };
}

export interface HttpSignerTransportOptions {
  /** The signer handler's URL, on an address only this sandbox can reach. Never a third party. */
  url: string;
  /** Bearer token the handler was built with. It authorizes signing requests; it is not a wallet key. */
  token: string;
  fetch?: typeof fetch;
  /** Abort a request after this long. Default 10_000. */
  timeoutMs?: number;
}

/**
 * HTTP transport to `createSignerHandler`. Sends only the request (payload to sign, network, address) and
 * the bearer token; no key exists on this side to send. A refusal comes back as `{ ok: false, reason }`;
 * a network failure or timeout throws.
 */
export function httpSignerTransport(opts: HttpSignerTransportOptions): SignerTransport {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return async (req) => {
    const res = await doFetch(opts.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, reason: 'bad_request' };
    }
    return parseResponse(body);
  };
}

export interface WalletRefusal extends Error {
  code: 'spend_refused';
  reason: string;
}

const refused = (reason: string): WalletRefusal =>
  Object.assign(new Error(`agentenact: spend refused: ${reason}`), { code: 'spend_refused' as const, reason });

async function signature(transport: SignerTransport, req: SignRequest): Promise<string> {
  const res = await transport(req);
  if (!res.ok) throw refused(res.reason);
  if (!('signature' in res)) throw refused('bad_request');
  return res.signature;
}

/** The wallets the signer holds for this agent. */
export async function listWallets(transport: SignerTransport): Promise<WalletInfo[]> {
  const res = await transport({ kind: 'wallets' });
  if (!res.ok) throw refused(res.reason);
  if (!('wallets' in res)) throw refused('bad_request');
  return res.wallets;
}

/** SEP-43 subset @x402/stellar's client takes (`ClientStellarSigner`). */
export interface StellarPaySigner {
  address: string;
  signAuthEntry(authEntry: string, opts?: { networkPassphrase?: string; address?: string }): Promise<{ signedAuthEntry: string; signerAddress?: string }>;
}

/** A Stellar wallet as an x402 client signer. Every auth entry goes to the policy signer. */
export function stellarPaySigner(transport: SignerTransport, wallet: WalletInfo): StellarPaySigner {
  if (!wallet.network.startsWith('stellar:')) throw new Error(`agentenact: ${wallet.network} is not a stellar network`);
  return {
    address: wallet.address,
    async signAuthEntry(preimage) {
      const signedAuthEntry = await signature(transport, { kind: 'stellar_auth_entry', network: wallet.network, address: wallet.address, preimage });
      return { signedAuthEntry, signerAddress: wallet.address };
    },
  };
}

/** The shape @x402/evm's client takes (`ClientEvmSigner`, required members only). */
export interface EvmPaySigner {
  readonly address: `0x${string}`;
  signTypedData(message: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }): Promise<`0x${string}`>;
}

/** What hire() takes to pay on Solana: signs one x402 transfer message for the offer's payTo; returns the base58 signature. */
export interface SolanaPaySigner {
  readonly address: string;
  signSolanaMessage(message: string, payTo: string): Promise<string>;
}

/** A Solana wallet as an x402 payer. Every message goes to the policy signer. */
export function solanaPaySigner(transport: SignerTransport, wallet: WalletInfo): SolanaPaySigner {
  if (!wallet.network.startsWith('solana:')) throw new Error(`agentenact: ${wallet.network} is not a Solana network`);
  return {
    address: wallet.address,
    signSolanaMessage: (message, payTo) => signature(transport, { kind: 'solana_message', network: wallet.network, address: wallet.address, message, payTo }),
  };
}

const toWire = (v: unknown): unknown =>
  typeof v === 'bigint'
    ? v.toString()
    : Array.isArray(v)
      ? v.map(toWire)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, toWire(x)]))
        : v;

/** An EVM wallet as an x402 client signer. Every typed-data signature goes to the policy signer. */
export function evmPaySigner(transport: SignerTransport, wallet: WalletInfo): EvmPaySigner {
  if (!wallet.network.startsWith('eip155:')) throw new Error(`agentenact: ${wallet.network} is not an EVM network`);
  return {
    address: wallet.address as `0x${string}`,
    async signTypedData(td) {
      const typedData = toWire(td) as WireTypedData;
      return (await signature(transport, { kind: 'evm_typed_data', network: wallet.network, address: wallet.address, typedData })) as `0x${string}`;
    },
  };
}
