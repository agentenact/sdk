/**
 * The policy signer: holds an agent's wallet keys OUTSIDE the agent's sandbox and signs on its own,
 * without asking a human, whenever a request fits the owner's spend policy (policy.ts).
 *
 * It never trusts the agent's description of a payment. It decodes the exact payload it is asked to
 * sign and reads the asset, amount, payer and payee from it:
 *  - Stellar: the SEP-43 auth-entry preimage. Only a single SAC `transfer(from, to, amount)` with no
 *    sub-invocations, on this network's passphrase, from this wallet, is signable.
 *  - EVM: EIP-712 typed data. Only EIP-3009 `TransferWithAuthorization` with the canonical field list,
 *    this network's chainId, a pinned token as `verifyingContract`, from this wallet, and a validity
 *    window of at most `maxValiditySeconds`, is signable.
 * Anything else is refused. Check → count → sign runs under one lock, so concurrent requests cannot both
 * slip under a cap.
 *
 * Keys are the operator's (no custody): this module runs on the operator's infra, receives keys from
 * the operator, and never sends a secret anywhere. `createSignerHandler` exposes it to the sandbox as a
 * Web-standard (Request) => Response handler behind a bearer token; the agent reaches it through
 * `agentenact/wallet`.
 *
 * Chain SDKs load lazily: a Stellar-only signer needs no viem, an EVM-only one no stellar-sdk.
 */
import { networkFor, type Caip2 } from './networks.js';
import {
  checkSpend, compilePolicy, createMemoryLedger, isSpendRefusal, normalizeAddress, spendRefusal,
  type SpendIntent, type SpendLedger, type SpendPolicy,
} from './policy.js';
import { sha256 } from './record.js';
import type { SignRequest, SignResponse, WalletInfo, WireTypedData } from './wallet.js';

/** EVM authorizations may stay valid at most this long by default (the x402 default timeout). */
export const DEFAULT_MAX_VALIDITY_SECONDS = 300;

export interface WalletKey {
  network: Caip2;
  /** `S…` seed on Stellar, `0x…` 32-byte hex private key on EVM, base58 of the 64-byte keypair (or 32-byte seed) on Solana. */
  secret: string;
}

export interface PolicySignerOptions {
  keys: WalletKey[];
  policy: SpendPolicy;
  /** Where signed spends are counted. Default: in memory (forgets on restart). */
  ledger?: SpendLedger;
  /** Longest EVM authorization window accepted. Default 300 s. */
  maxValiditySeconds?: number;
  now?: () => Date;
}

export interface PolicySigner {
  wallets(): WalletInfo[];
  /** Answer one request. Never throws for a refused or malformed request. */
  handle(req: SignRequest): Promise<SignResponse>;
}

interface Signing {
  info: WalletInfo;
  /** Decode the payload, return the spend it authorizes and a function that signs it. Throws spend_refused. */
  prepare(req: SignRequest, now: Date): Promise<{ intent: SpendIntent; sign(): Promise<string> }>;
}

const STELLAR_PASSPHRASE: Partial<Record<Caip2, string>> = {
  'stellar:pubnet': 'Public Global Stellar Network ; September 2015',
  'stellar:testnet': 'Test SDF Network ; September 2015',
};

function pinnedAsset(network: Caip2, x402Asset: string): string {
  const net = networkFor(network);
  const key = net.chain === 'stellar' || net.chain === 'solana' ? x402Asset : x402Asset.toLowerCase();
  const hit = net.assets[key];
  if (!hit) throw spendRefusal('unknown_asset');
  return hit.asset;
}

/**
 * Decode a SEP-43 auth-entry preimage that a Stellar x402 payment asks to have signed, and return the spend it
 * authorizes. Only a single pinned-SAC `transfer(from, to, amount)` with no sub-invocations, on `network`'s
 * passphrase, decodes; anything else throws `spend_refused`. The caller checks `from` is the wallet it holds.
 * Exported for multi-tenant signers that keep their own keys and ledger.
 */
export async function decodeStellarTransfer(preimage: string, network: Caip2): Promise<SpendIntent> {
  const sdk = await import('@stellar/stellar-sdk');
  const passphrase = STELLAR_PASSPHRASE[network];
  if (!passphrase) throw spendRefusal('wrong_network');
  let pre: InstanceType<typeof sdk.xdr.HashIdPreimage>;
  try {
    pre = sdk.xdr.HashIdPreimage.fromXDR(Buffer.from(preimage, 'base64'));
  } catch {
    throw spendRefusal('bad_payload');
  }
  if (pre.switch().value !== sdk.xdr.EnvelopeType.envelopeTypeSorobanAuthorization().value) throw spendRefusal('unsupported_payload');
  const auth = pre.sorobanAuthorization();
  if (!Buffer.from(auth.networkId()).equals(sdk.hash(Buffer.from(passphrase)))) throw spendRefusal('wrong_network');
  const inv = auth.invocation();
  if (inv.subInvocations().length > 0) throw spendRefusal('unsupported_payload');
  const fn = inv.function();
  if (fn.switch().value !== sdk.xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn().value) {
    throw spendRefusal('unsupported_payload');
  }
  const call = fn.contractFn();
  if (call.functionName().toString() !== 'transfer' || call.args().length !== 3) throw spendRefusal('unsupported_payload');
  const asset = pinnedAsset(network, sdk.Address.fromScAddress(call.contractAddress()).toString());
  let from: unknown, to: unknown, amount: unknown;
  try {
    [from, to, amount] = call.args().map((a) => sdk.scValToNative(a));
  } catch {
    throw spendRefusal('bad_payload');
  }
  if (typeof from !== 'string' || typeof to !== 'string' || typeof amount !== 'bigint') throw spendRefusal('bad_payload');
  return { network, asset, amount, from, payTo: to };
}

async function stellarSigning(key: WalletKey): Promise<Signing> {
  const sdk = await import('@stellar/stellar-sdk');
  if (!STELLAR_PASSPHRASE[key.network]) throw new Error(`agentenact: no passphrase for ${key.network}`);
  const kp = sdk.Keypair.fromSecret(key.secret);
  const address = kp.publicKey();
  return {
    info: { network: key.network, address },
    async prepare(req) {
      if (req.kind !== 'stellar_auth_entry') throw spendRefusal('unsupported_payload');
      const intent = await decodeStellarTransfer(req.preimage, key.network);
      if (intent.from !== address) throw spendRefusal('unknown_wallet');
      const raw = Buffer.from(req.preimage, 'base64');
      return {
        intent,
        sign: async () => kp.sign(sdk.hash(raw)).toString('base64'),
      };
    },
  };
}

const TRANSFER_WITH_AUTHORIZATION = [
  { name: 'from', type: 'address' },
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
] as const;

const sameFields = (a: unknown) =>
  Array.isArray(a) && a.length === TRANSFER_WITH_AUTHORIZATION.length &&
  a.every((f, i) => f && typeof f === 'object' && (f as { name?: unknown }).name === TRANSFER_WITH_AUTHORIZATION[i]!.name &&
    (f as { type?: unknown }).type === TRANSFER_WITH_AUTHORIZATION[i]!.type && Object.keys(f).length === 2);

const uint = (v: unknown): bigint => {
  if (typeof v !== 'string' && typeof v !== 'number') throw spendRefusal('bad_payload');
  const s = String(v);
  if (!/^\d{1,78}$/.test(s)) throw spendRefusal('bad_payload');
  return BigInt(s);
};

/** A decoded EIP-3009 authorization: the spend it moves and the exact typed data to sign (bigints, checksummed addresses). */
export interface EvmTransfer {
  intent: SpendIntent;
  typedData: {
    domain: { name: string; version: string; chainId: bigint; verifyingContract: `0x${string}` };
    types: { TransferWithAuthorization: typeof TRANSFER_WITH_AUTHORIZATION };
    primaryType: 'TransferWithAuthorization';
    message: { from: `0x${string}`; to: `0x${string}`; value: bigint; validAfter: bigint; validBefore: bigint; nonce: `0x${string}` };
  };
}

/**
 * Decode EIP-712 typed data that an EVM x402 payment asks to have signed, and return the spend it authorizes plus
 * the typed data rebuilt from the checked fields only. Only EIP-3009 `TransferWithAuthorization` with the canonical
 * field list, `network`'s chainId, a pinned token as `verifyingContract`, a real `to`, and a validity window ending
 * within `maxValiditySeconds` of `now`, decodes; anything else throws `spend_refused`. The caller checks `from` is
 * the wallet it holds. Exported for multi-tenant signers that keep their own keys and ledger.
 */
export async function decodeEvmTransfer(
  typedData: WireTypedData,
  network: Caip2,
  o: { now: Date; maxValiditySeconds?: number },
): Promise<EvmTransfer> {
  if (networkFor(network).chain === 'stellar') throw spendRefusal('wrong_network');
  const { isAddress, getAddress } = await import('viem');
  const chainId = BigInt(network.slice('eip155:'.length));
  const maxValiditySeconds = o.maxValiditySeconds ?? DEFAULT_MAX_VALIDITY_SECONDS;
  const td = typedData as WireTypedData | undefined;
  if (!td || typeof td !== 'object' || !td.domain || !td.types || !td.message) throw spendRefusal('bad_payload');
  if (td.primaryType !== 'TransferWithAuthorization') throw spendRefusal('unsupported_payload');
  const extraTypes = Object.keys(td.types).filter((k) => k !== 'TransferWithAuthorization' && k !== 'EIP712Domain');
  if (extraTypes.length > 0 || !sameFields(td.types.TransferWithAuthorization)) throw spendRefusal('unsupported_payload');
  const d = td.domain as { name?: unknown; version?: unknown; chainId?: unknown; verifyingContract?: unknown; salt?: unknown };
  if (d.salt !== undefined) throw spendRefusal('unsupported_payload');
  if (uint(d.chainId) !== chainId) throw spendRefusal('wrong_network');
  if (typeof d.verifyingContract !== 'string' || !isAddress(d.verifyingContract, { strict: false })) throw spendRefusal('bad_payload');
  if (typeof d.name !== 'string' || typeof d.version !== 'string') throw spendRefusal('bad_payload');
  const asset = pinnedAsset(network, d.verifyingContract);
  const m = td.message;
  if (typeof m.from !== 'string' || !isAddress(m.from, { strict: false })) throw spendRefusal('bad_payload');
  if (typeof m.to !== 'string' || !isAddress(m.to, { strict: false }) || /^0x0{40}$/i.test(m.to)) throw spendRefusal('bad_payload');
  if (typeof m.nonce !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(m.nonce)) throw spendRefusal('bad_payload');
  const value = uint(m.value);
  const validAfter = uint(m.validAfter);
  const validBefore = uint(m.validBefore);
  const nowS = BigInt(Math.floor(o.now.getTime() / 1000));
  if (validBefore <= nowS || validBefore - nowS > BigInt(maxValiditySeconds) || validAfter >= validBefore) {
    throw spendRefusal('bad_validity');
  }
  const from = getAddress(m.from);
  const to = getAddress(m.to);
  return {
    intent: { network, asset, amount: value, from: from.toLowerCase(), payTo: to.toLowerCase() },
    typedData: {
      domain: { name: d.name, version: d.version, chainId, verifyingContract: getAddress(d.verifyingContract) },
      types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION },
      primaryType: 'TransferWithAuthorization',
      message: { from, to, value, validAfter, validBefore, nonce: m.nonce as `0x${string}` },
    },
  };
}

async function solanaSigning(key: WalletKey): Promise<Signing> {
  const [{ base58Decode, base58Encode }, { ed25519Sign, solanaAddressOf }, { decodeSolanaTransfer }] = await Promise.all([
    import('./base58.js'),
    import('./adapters/solana.js'),
    import('./solana-transfer.js'),
  ]);
  const secret = base58Decode(key.secret);
  const address = await solanaAddressOf(secret);
  if (secret.length === 64 && base58Encode(secret.slice(32)) !== address) throw new Error('agentenact: Solana keypair halves do not match');
  return {
    info: { network: key.network, address },
    async prepare(req) {
      if (req.kind !== 'solana_message' || typeof req.message !== 'string' || typeof req.payTo !== 'string') throw spendRefusal('unsupported_payload');
      const t = await decodeSolanaTransfer(req.message, key.network, { payer: address, payTo: req.payTo });
      return { intent: t.intent, sign: async () => base58Encode(await ed25519Sign(t.message, secret)) };
    },
  };
}

async function evmSigning(key: WalletKey, maxValiditySeconds: number): Promise<Signing> {
  const { privateKeyToAccount } = await import('viem/accounts');
  const account = privateKeyToAccount(key.secret as `0x${string}`);
  const address = account.address.toLowerCase();
  return {
    info: { network: key.network, address },
    async prepare(req, now) {
      if (req.kind !== 'evm_typed_data') throw spendRefusal('unsupported_payload');
      const t = await decodeEvmTransfer(req.typedData, key.network, { now, maxValiditySeconds });
      if (t.intent.from !== address) throw spendRefusal('unknown_wallet');
      return { intent: t.intent, sign: () => account.signTypedData(t.typedData) };
    },
  };
}

/**
 * Build a policy signer. Throws on a bad policy, an unknown network or a bad key, before it signs anything.
 * One key per (network, address); an agent may hold keys on as many networks as NETWORKS lists.
 */
export async function createPolicySigner(opts: PolicySignerOptions): Promise<PolicySigner> {
  const policy = compilePolicy(opts.policy);
  const ledger = opts.ledger ?? createMemoryLedger();
  const now = opts.now ?? (() => new Date());
  const maxValidity = opts.maxValiditySeconds ?? DEFAULT_MAX_VALIDITY_SECONDS;
  const signings = new Map<string, Signing>();
  for (const k of opts.keys) {
    const chain = networkFor(k.network).chain;
    const s = chain === 'stellar' ? await stellarSigning(k) : chain === 'solana' ? await solanaSigning(k) : await evmSigning(k, maxValidity);
    const id = `${k.network} ${s.info.address}`;
    if (signings.has(id)) throw new Error(`agentenact: duplicate key for ${id}`);
    signings.set(id, s);
  }

  // check → count → sign is one critical section: no await in it may interleave with another request.
  let lock: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = lock.then(fn, fn);
    lock = run.catch(() => undefined);
    return run;
  };

  return {
    wallets: () => [...signings.values()].map((s) => ({ ...s.info })),
    async handle(req) {
      if (!req || typeof req !== 'object') return { ok: false, reason: 'bad_request' };
      if (req.kind === 'wallets') return { ok: true, wallets: [...signings.values()].map((s) => ({ ...s.info })) };
      if (req.kind !== 'stellar_auth_entry' && req.kind !== 'evm_typed_data' && req.kind !== 'solana_message') return { ok: false, reason: 'bad_request' };
      if (typeof req.network !== 'string' || typeof req.address !== 'string') return { ok: false, reason: 'bad_request' };
      let address: string;
      try {
        address = normalizeAddress(req.network, req.address);
      } catch {
        return { ok: false, reason: 'bad_request' };
      }
      const s = signings.get(`${req.network} ${address}`);
      if (!s) return { ok: false, reason: 'unknown_wallet' };
      try {
        return await serial(async () => {
          const at = now();
          const { intent, sign } = await s.prepare(req, at);
          await checkSpend(policy, intent, (since) => ledger.total(intent.network, intent.asset, since), at);
          const signature = await sign();
          await ledger.add({ ...intent, at });
          return { ok: true as const, signature };
        });
      } catch (e) {
        if (isSpendRefusal(e)) return { ok: false, reason: e.reason };
        return { ok: false, reason: 'bad_request' };
      }
    },
  };
}

/**
 * Generate a fresh wallet key for `network`. Run it where the signer runs; store the secret there and give
 * the agent only the address. The secret is returned once and no copy is kept.
 */
export async function generateWalletKey(network: Caip2): Promise<WalletKey & { address: string }> {
  if (networkFor(network).chain === 'stellar') {
    const { Keypair } = await import('@stellar/stellar-sdk');
    const kp = Keypair.random();
    return { network, address: kp.publicKey(), secret: kp.secret() };
  }
  if (networkFor(network).chain === 'solana') {
    const [{ base58Decode, base58Encode }, { solanaAddressOf }] = await Promise.all([import('./base58.js'), import('./adapters/solana.js')]);
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const address = await solanaAddressOf(seed);
    return { network, address, secret: base58Encode(new Uint8Array([...seed, ...base58Decode(address)])) };
  }
  const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts');
  const secret = generatePrivateKey();
  return { network, address: privateKeyToAccount(secret).address.toLowerCase(), secret };
}

async function sameToken(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/**
 * Expose a signer to the sandbox as (Request) => Response: JSON `SignRequest` in, JSON `SignResponse` out,
 * `Authorization: Bearer <token>` required. Serve it on an address only the agent's sandbox can reach.
 */
export function createSignerHandler(signer: PolicySigner, opts: { token: string }): (req: Request) => Promise<Response> {
  if (opts.token.length < 32) throw new Error('agentenact: signer token must be at least 32 characters');
  const json = (body: SignResponse, status: number) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return async (req) => {
    const auth = req.headers.get('authorization') ?? '';
    if (!auth.startsWith('Bearer ') || !(await sameToken(auth.slice(7), opts.token))) return json({ ok: false, reason: 'unauthorized' }, 401);
    if (req.method !== 'POST') return json({ ok: false, reason: 'bad_request' }, 405);
    let body: SignRequest;
    try {
      body = (await req.json()) as SignRequest;
    } catch {
      return json({ ok: false, reason: 'bad_request' }, 400);
    }
    const res = await signer.handle(body);
    return json(res, res.ok ? 200 : 403);
  };
}
export { associatedTokenAddress, decodeSolanaTransfer, type SolanaTransfer } from './solana-transfer.js';
