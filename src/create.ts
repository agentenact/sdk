/**
 * `create` — bring a Stellar agent into existence with operator-held keys:
 *   tx 1  sponsor-signed classic tx: sponsored reserves (CAP-33) open the agent's
 *         account + USDC trustline → the AGENT holds zero XLM.
 *   tx 2  register_with_uri on the stellar-8004 Identity Registry, inner tx signed by
 *         the agent, fee-bumped (CAP-15) by the sponsor → agent still holds zero XLM.
 * With `owner` (a wallet signer; the package never sees its secret) the owner is the
 * sponsor and source of three txs instead: account, register_with_uri, and set_agent_wallet
 * (the registry requires the owner's and the agent's authorisation) → the identity is owned
 * by the owner and the agent's wallet is bound to it.
 * With `owner` as an auth-entry signer (`StellarAuthSigner`, e.g. a passkey smart wallet C…)
 * plus a separate `sponsor`, the sponsor is source, fee payer and reserve sponsor of all
 * three txs and the owner only signs Soroban auth entries; never an envelope.
 * The generated secret is returned once and never retained. Nothing here talks to
 * AgentKarma; the sponsor is the operator's own account (AK runs no sponsorship service).
 */
import {
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  StrKey,
  Networks,
  Operation,
  TransactionBuilder,
  authorizeEntry,
  hash,
  nativeToScVal,
  rpc,
  scValToNative,
  type Account,
  xdr,
  type FeeBumpTransaction,
  type Transaction,
} from '@stellar/stellar-sdk';
import { networkFor } from './networks.js';
import { createStellarAdapter } from './adapters/stellar.js';

/** A wallet that signs for the owner (Freighter, a temporary in-page key, ...). */
export interface StellarSigner {
  publicKey: string;
  /** Sign a transaction envelope (base64 XDR) for `networkPassphrase`; return the signed XDR. */
  signTransaction(xdr: string, networkPassphrase: string): Promise<string>;
}

/**
 * An owner that only authorises Soroban calls: a passkey smart wallet (C…) or any account.
 * It never signs or funds a transaction envelope; a separate `sponsor` does.
 */
export interface StellarAuthSigner {
  /** The owner address the registry records: C… for a smart wallet, G… for an account. */
  address: string;
  /** Sign one Soroban authorization entry (base64 XDR) valid until `validUntilLedger`; return it signed (base64 XDR). */
  signAuthEntry(entryXdr: string, validUntilLedger: number, networkPassphrase: string): Promise<string>;
}

/**
 * The agent's key held somewhere else (a signer process). Auth-entry owner mode only. The signer is asked
 * for exactly two things, each as the whole object so it can check what it signs (never a bare hash):
 * the birth account transaction (the 4-op sponsored create + USDC trustline, already signed by the sponsor)
 * and the agent's `set_agent_wallet` authorization entry. `create` adds and checks each signature itself.
 */
export interface AgentKeySigner {
  publicKey: string;
  /** Sign the account tx (base64 envelope XDR) for `networkPassphrase`; return the agent's ed25519 signature over its hash, base64. */
  signTransaction(xdr: string, networkPassphrase: string): Promise<string>;
  /** Sign a Soroban authorization preimage (base64 `HashIdPreimage`, as SEP-43 `signAuthEntry` receives it); return the signature, base64. */
  signAuthEntry(preimage: string): Promise<string>;
}

export interface CreateStellarAgentOptions {
  network: 'stellar:pubnet' | 'stellar:testnet';
  /** Sponsor mode: the operator's funded account that pays reserves + fees; the agent registers itself. Never stored. */
  sponsorSecret?: string;
  /**
   * Owner mode (instead of `sponsorSecret`). A `StellarSigner` owner pays, owns the identity and binds
   * the agent's wallet. A `StellarAuthSigner` owner only signs auth entries and needs `sponsor`.
   */
  owner?: StellarSigner | StellarAuthSigner;
  /** With a `StellarAuthSigner` owner: the account that sources, pays for and sponsors every tx. */
  sponsor?: StellarSigner;
  /** agentURI registered on stellar-8004 (register_with_uri). A URL the operator controls. */
  agentUri: string;
  /** Identity registry contract; defaults to the one pinned in NETWORKS. */
  identityRegistry?: string;
  /**
   * The agent's keypair. Default: a fresh `Keypair.random()`. A hosted runtime passes the key it
   * generated and stores itself, so exactly one agent key exists. The secret is still returned.
   */
  keypair?: Keypair;
  /**
   * Auth-entry owner mode only, instead of `keypair`: the agent's key lives in a signer process and never
   * enters this one. The result and any `err.partial` then carry no `secret`.
   */
  agentSigner?: AgentKeySigner;
  /**
   * Auth-entry owner mode only: continue a birth whose earlier attempt stopped part-way, with the SAME
   * `keypair`. The caller states what it believes is on chain; the library verifies each fact itself
   * and throws an Error with `code: 'resume_mismatch'` (before any tx) if it does not hold.
   * - `account: true`: the agent account exists with the USDC trustline → tx 1 is skipped.
   * - `agentId`: (needs `account`) that identity is owned by `owner` → tx 2 is skipped; if its wallet is
   *   already this agent's key, nothing is sent at all.
   * WARNING: `{ account: true }` WITHOUT `agentId` always sends register_with_uri. Pass it only when you
   * know no registration was sent for this key (e.g. the owner never signed it). If a register may have
   * landed (confirm failed, outcome unknown), pass the `agentId` if known, or do not resume: a second
   * registration costs another full fee and leaves a duplicate identity. The already-bound success path
   * checks owner and wallet only; it does not compare the registered URI.
   * Sponsor mode and wallet-owner mode throw if `resume` is passed.
   */
  resume?: ResumeState;
  /**
   * Serialises the sponsor account's sequence number across concurrent births (sponsor and auth-entry
   * owner modes). Each sponsor-sourced tx runs in ONE `sponsorLock` call that spans reading the sponsor
   * account, building, any enforcing re-simulation, signing and submitting it, until the submit
   * returned or failed. Never nested; never held across the owner's auth-entry signing (that happens
   * before the call), so a slow passkey prompt does not block other births. The recording simulation
   * (never submitted, so it consumes no sequence) reads the sponsor account outside the lock.
   * In sponsor mode only tx 1 is sponsor-sourced (the fee-bump consumes the agent's sequence, not the
   * sponsor's). Not accepted in wallet-owner mode, where a human-speed wallet signs. An error thrown
   * by `work` propagates and your lock must release. Default: run `work` directly.
   */
  sponsorLock?: SponsorLock;
  /** Test seams. */
  horizonSubmit?: (xdr: string) => Promise<{ hash: string }>;
  /** Resume only: the agent account's balances from Horizon, or null when the account does not exist. */
  horizonAccount?: (id: string) => Promise<HorizonAccountView | null>;
  /** Resume only: the registry's owner and agent wallet for an agentId, or null when it has no owner. */
  identity?: (agentId: string) => Promise<{ owner: string; wallet: string | null } | null>;
  soroban?: SorobanSeam;
}

/** Runs `work` while holding the sponsor's sequence lock; see `CreateStellarAgentOptions.sponsorLock`. */
export type SponsorLock = <T>(work: () => Promise<T>) => Promise<T>;

const noLock: SponsorLock = (work) => work();

/** What the caller believes is already on chain; see `CreateStellarAgentOptions.resume`. */
export interface ResumeState {
  account: true;
  /** Decimal string, like the ids `create` returns. */
  agentId?: string;
}

/** The slice of Horizon's `/accounts/{id}` that resume reads. */
export interface HorizonAccountView {
  balances: { asset_type: string; asset_code?: string; asset_issuer?: string }[];
}

/** The three Soroban interactions `create` needs; the default speaks to rpc.Server. */
export interface SorobanSeam {
  getAccount(id: string): Promise<Account>;
  /** Simulate + assemble the registration; returns the assigned agentId and the prepared inner tx. */
  register(inner: Transaction): Promise<{ agentId: string; prepared: Transaction }>;
  send(tx: Transaction | FeeBumpTransaction): Promise<{ hash: string }>;
  /** Owner mode only. */
  latestLedger?(): Promise<number>;
  /** Owner mode only: simulate + assemble; also returns the auth entries the simulation asked for. */
  prepare?(tx: Transaction): Promise<{ prepared: Transaction; auth: xdr.SorobanAuthorizationEntry[] }>;
  /** Owner mode only: resolve once `hash` succeeded on chain, throw otherwise. Returns the executed tx's return value. */
  confirm?(hash: string): Promise<xdr.ScVal | undefined>;
}

export interface CreatedStellarAgent {
  publicKey: string;
  /** Returned ONCE. agentenact keeps no copy. */
  secret: string;
  agentId: string;
  txs: { account: string; register: string };
}

export interface CreatedOwnedStellarAgent extends CreatedStellarAgent {
  owner: string;
  txs: { account: string; register: string; bind: string };
}

/**
 * What already exists on chain when owner mode fails after tx 1 landed. Attached to the
 * thrown error as `err.partial`; the secret is the caller's own, and without it the funded,
 * sponsored agent account would be unusable.
 */
/** Result of a resumed birth: `txs` carries only the transactions this call actually sent. */
export interface ResumedOwnedStellarAgent extends Omit<CreatedOwnedStellarAgent, 'txs'> {
  txs: { account?: string; register?: string; bind?: string };
}

export interface PartialOwnedAgent {
  publicKey: string;
  /** Absent when the key lives in an `agentSigner`. */
  secret?: string;
  owner: string;
  agentId?: string;
  txs: { account?: string; register?: string; bind?: string };
}

/** Wallet approval is human-speed; the timebound starts when the tx is built. */
const WALLET_TIMEOUT_SECONDS = 300;
/** Auth entry validity in ledgers (~5 s each): outlives WALLET_TIMEOUT_SECONDS with margin. */
const AUTH_VALID_LEDGERS = 100;

export type SponsorModeOptions = CreateStellarAgentOptions & { sponsorSecret: string; owner?: undefined; sponsor?: undefined };
export type OwnerModeOptions = CreateStellarAgentOptions & { owner: StellarSigner; sponsorSecret?: undefined; sponsor?: undefined };
export type AuthOwnerModeOptions = CreateStellarAgentOptions & { owner: StellarAuthSigner; sponsor: StellarSigner; sponsorSecret?: undefined };

export type AuthOwnerResumeOptions = AuthOwnerModeOptions & { resume: ResumeState };

/** Auth-entry owner mode with the agent key in a signer process. */
export type AuthOwnerRemoteOptions = AuthOwnerModeOptions & { agentSigner: AgentKeySigner; keypair?: undefined };
/** Its result: everything but the secret, which never entered this process. */
export type RemoteOwnedStellarAgent = Omit<ResumedOwnedStellarAgent, 'secret'>;

const isAuthSigner = (o: StellarSigner | StellarAuthSigner | undefined): o is StellarAuthSigner =>
  !!o && typeof (o as StellarAuthSigner).signAuthEntry === 'function';

function defaultSoroban(rpcUrl: string, registryMethod: string): SorobanSeam {
  const s = new rpc.Server(rpcUrl);
  return {
    getAccount: (id) => s.getAccount(id),
    async register(inner) {
      const sim = await s.simulateTransaction(inner);
      if (rpc.Api.isSimulationError(sim)) throw new Error(`${registryMethod} simulation failed: ${sim.error}`);
      if (!sim.result) throw new Error(`${registryMethod} simulation returned no result`);
      const agentId = String(scValToNative(sim.result.retval));
      return { agentId, prepared: rpc.assembleTransaction(inner, sim).build() };
    },
    async send(tx) {
      const r = await s.sendTransaction(tx);
      if (r.status === 'ERROR') throw new Error(`sendTransaction error: ${JSON.stringify(r.errorResult)}`);
      return { hash: r.hash };
    },
    async latestLedger() {
      return (await s.getLatestLedger()).sequence;
    },
    async prepare(tx) {
      const sim = await s.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) throw new Error(`simulation failed: ${sim.error}`);
      return { prepared: rpc.assembleTransaction(tx, sim).build(), auth: sim.result?.auth ?? [] };
    },
    async confirm(hash) {
      const done = await s.pollTransaction(hash, { attempts: 30 });
      if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`transaction ${hash} did not succeed: ${done.status}`);
      return done.returnValue;
    },
  };
}

function defaultHorizonAccount(horizonUrl: string) {
  return async (id: string): Promise<HorizonAccountView | null> => {
    const res = await fetch(`${horizonUrl}/accounts/${id}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Horizon account read failed: ${res.status}`);
    return (await res.json()) as HorizonAccountView;
  };
}

function resumeMismatch(msg: string): Error {
  return Object.assign(new Error(`agentenact: cannot resume, ${msg}`), { code: 'resume_mismatch' });
}

function defaultHorizonSubmit(horizonUrl: string) {
  return async (xdrStr: string): Promise<{ hash: string }> => {
    const res = await fetch(`${horizonUrl}/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `tx=${encodeURIComponent(xdrStr)}`,
    });
    const j = (await res.json()) as { hash?: string; extras?: unknown; title?: string };
    if (!res.ok || !j.hash) throw new Error(`Horizon submit failed: ${res.status} ${j.title ?? ''} ${JSON.stringify(j.extras ?? {})}`);
    return { hash: j.hash };
  };
}

/** Inner inclusion fee per operation: total fee minus the Soroban resource fee, never below BASE_FEE. */
function inclusionFeePerOp(tx: Transaction): string {
  const ext = tx.toEnvelope().v1().tx().ext();
  const resourceFee = ext.switch() === 1 ? BigInt(ext.sorobanData().resourceFee().toString()) : 0n;
  const perOp = (BigInt(tx.fee) - resourceFee) / BigInt(tx.operations.length);
  return (perOp > BigInt(BASE_FEE) ? perOp : BigInt(BASE_FEE)).toString();
}

/** The 4-op account tx: `source` sponsors the agent's account + USDC trustline; the agent holds zero XLM. Unsigned. */
function sponsoredAccountTx(source: Account, agent: Keypair, usdc: Asset, passphrase: string, timeoutSeconds: number): Transaction {
  return new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: agent.publicKey() }))
    .addOperation(Operation.createAccount({ destination: agent.publicKey(), startingBalance: '0' }))
    .addOperation(Operation.changeTrust({ asset: usdc, source: agent.publicKey() }))
    .addOperation(Operation.endSponsoringFutureReserves({ source: agent.publicKey() }))
    .setTimeout(timeoutSeconds)
    .build();
}

/** Never bind (or hand back) an id that is not a u32: Number() would turn junk into NaN. */
function usableAgentId(id: string): string {
  if (!/^\d+$/.test(id) || Number(id) > 0xffff_ffff) {
    throw new Error(`agentenact: registration returned no usable agentId (got ${JSON.stringify(id)})`);
  }
  return id;
}

/** Owner-mode failure after tx 1 landed: the error carries what exists on chain. */
function withPartial(err: unknown, partial: PartialOwnedAgent): Error {
  return Object.assign(err instanceof Error ? err : new Error(String(err)), { partial });
}

export function createStellarAgent(opts: SponsorModeOptions): Promise<CreatedStellarAgent>;
export function createStellarAgent(opts: OwnerModeOptions): Promise<CreatedOwnedStellarAgent>;
export function createStellarAgent(opts: AuthOwnerRemoteOptions): Promise<RemoteOwnedStellarAgent>;
export function createStellarAgent(opts: AuthOwnerResumeOptions): Promise<ResumedOwnedStellarAgent>;
export function createStellarAgent(opts: AuthOwnerModeOptions): Promise<CreatedOwnedStellarAgent>;
export async function createStellarAgent(
  opts: CreateStellarAgentOptions,
): Promise<CreatedStellarAgent | CreatedOwnedStellarAgent | ResumedOwnedStellarAgent | RemoteOwnedStellarAgent> {
  if (!opts.sponsorSecret === !opts.owner) {
    throw new Error('agentenact: pass exactly one of sponsorSecret (sponsor mode) or owner (owner mode)');
  }
  if (isAuthSigner(opts.owner) !== !!opts.sponsor) {
    throw new Error('agentenact: an auth-entry owner needs a sponsor, and a sponsor is only for an auth-entry owner');
  }
  if (isAuthSigner(opts.owner) && opts.owner.address === opts.sponsor!.publicKey) {
    throw new Error('agentenact: the auth-entry owner and the sponsor must be different accounts');
  }
  if (opts.sponsorLock && opts.owner && !isAuthSigner(opts.owner)) {
    throw new Error('agentenact: sponsorLock applies to sponsor mode and auth-entry owner mode, not wallet-owner mode');
  }
  if (opts.agentSigner) {
    if (!isAuthSigner(opts.owner)) throw new Error('agentenact: agentSigner is only supported with an auth-entry owner and a sponsor');
    if (opts.keypair) throw new Error('agentenact: pass either keypair or agentSigner, not both');
  }
  if (opts.resume) {
    if (!isAuthSigner(opts.owner)) throw new Error('agentenact: resume is only supported with an auth-entry owner and a sponsor');
    if (opts.resume.account !== true) throw new Error('agentenact: resume.account must be true');
    const id = opts.resume.agentId;
    if (id !== undefined && (!/^\d+$/.test(id) || Number(id) > 0xffff_ffff)) {
      throw new Error(`agentenact: resume.agentId must be a decimal u32 string (got ${JSON.stringify(id)})`);
    }
  }
  const net = networkFor(opts.network);
  const registry = opts.identityRegistry ?? net.identityRegistry;
  if (!registry) throw new Error(`agentenact: no identity registry for ${opts.network}; pass identityRegistry`);
  const passphrase = opts.network === 'stellar:pubnet' ? Networks.PUBLIC : Networks.TESTNET;
  const [code, issuer] = Object.values(net.assets)[0]!.asset.split(':');
  const usdc = new Asset(code!, issuer!);

  // A remote agentSigner has no local secret: a public-key-only Keypair keeps the shared context typed (it
  // can build txs naming the agent but cannot sign). The auth-owner path signs only through `key`.
  const agent = opts.agentSigner ? Keypair.fromPublicKey(opts.agentSigner.publicKey) : (opts.keypair ?? Keypair.random());
  const horizonSubmit = opts.horizonSubmit ?? defaultHorizonSubmit(net.horizonUrl!);
  const soroban = opts.soroban ?? defaultSoroban(net.sorobanRpcUrl!, 'register_with_uri');
  const base = { agent, agentUri: opts.agentUri, registry, passphrase, usdc, horizonSubmit, soroban };
  const lock = opts.sponsorLock ?? noLock;

  if (isAuthSigner(opts.owner)) {
    const horizonAccount = opts.horizonAccount ?? defaultHorizonAccount(net.horizonUrl!);
    const identity =
      opts.identity ??
      createStellarAdapter({
        network: opts.network === 'stellar:pubnet' ? 'pubnet' : 'testnet',
        horizonUrl: net.horizonUrl,
        rpcUrl: net.sorobanRpcUrl,
        identityRegistry: registry,
      }).resolveIdentity;
    const key = opts.agentSigner ? remoteKey(opts.agentSigner, passphrase) : localKey(agent, passphrase);
    return createAuthOwned({ ...base, key, owner: opts.owner, sponsor: opts.sponsor!, lock, resume: opts.resume, horizonAccount, identity });
  }
  if (opts.owner) return createOwned({ ...base, owner: opts.owner });

  const sponsor = Keypair.fromSecret(opts.sponsorSecret!);
  // ── tx 1: sponsored account + trustline (agent holds zero XLM) ───────────
  const account = await lock(async () => {
    const sponsorAccount = await soroban.getAccount(sponsor.publicKey());
    const accountTx = sponsoredAccountTx(sponsorAccount, agent, usdc, passphrase, 120);
    accountTx.sign(sponsor, agent);
    return horizonSubmit(accountTx.toXDR());
  });

  // ── tx 2: register_with_uri, agent-signed inner, sponsor fee-bump ────────
  const agentAccount = await soroban.getAccount(agent.publicKey());
  const inner = new TransactionBuilder(agentAccount, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(
      new Contract(registry).call(
        'register_with_uri',
        Address.fromString(agent.publicKey()).toScVal(),
        nativeToScVal(opts.agentUri, { type: 'string' }),
      ),
    )
    .setTimeout(120)
    .build();
  const { agentId, prepared } = await soroban.register(inner);
  prepared.sign(agent);
  // buildFeeBumpTransaction bids `baseFee × (ops + 1) + resourceFee`, adding the Soroban
  // resource fee itself. Pass only the inner inclusion rate: bidding more makes the sponsor
  // hold (and risk) extra XLM for nothing, since the fee source must cover the full bid.
  const bumped = TransactionBuilder.buildFeeBumpTransaction(sponsor, inclusionFeePerOp(prepared), prepared, passphrase);
  bumped.sign(sponsor);
  const register = await soroban.send(bumped);

  return { publicKey: agent.publicKey(), secret: agent.secret(), agentId, txs: { account: account.hash, register: register.hash } };
}

interface OwnedCtx {
  owner: StellarSigner;
  agent: Keypair;
  agentUri: string;
  registry: string;
  passphrase: string;
  usdc: Asset;
  horizonSubmit: (xdr: string) => Promise<{ hash: string }>;
  soroban: SorobanSeam;
}

/** Wallet-signed envelope. The wallet signs first; any further local signer is added after it. */
async function walletSign(signer: StellarSigner, tx: Transaction, passphrase: string, role: string, ...then: Keypair[]): Promise<Transaction> {
  const signed = TransactionBuilder.fromXDR(await signer.signTransaction(tx.toXDR(), passphrase), passphrase) as Transaction;
  if (signed.signatures.length === 0) throw new Error(`agentenact: ${role} signer returned an unsigned transaction`);
  // The wallet must hand back the very transaction it was given (the hash covers body + network),
  // carrying its own valid signature; anything else is never submitted or co-signed.
  if (!signed.hash().equals(tx.hash())) throw new Error(`agentenact: ${role} signer returned a different transaction`);
  const key = Keypair.fromPublicKey(signer.publicKey);
  if (!signed.signatures.some((s) => s.hint().equals(key.signatureHint()) && key.verify(signed.hash(), s.signature()))) {
    throw new Error(`agentenact: ${role} signer returned no valid signature from the ${role} (wrong network?)`);
  }
  if (then.length) signed.sign(...then);
  return signed;
}

const signerOf = (e: xdr.SorobanAuthorizationEntry) => Address.fromScAddress(e.credentials().address().address()).toString();
const isAddressEntry = (e: xdr.SorobanAuthorizationEntry) =>
  e.credentials().switch() === xdr.SorobanCredentialsType.sorobanCredentialsAddress();
/** The entry authorises exactly `registry.fn(...args)` and nothing beneath it. */
const isForCall = (e: xdr.SorobanAuthorizationEntry, registry: string, fn: string, args: xdr.ScVal[]) => {
  const inv = e.rootInvocation();
  const f = inv.function();
  if (f.switch() !== xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()) return false;
  const call = f.contractFn();
  const got = call.args();
  return (
    Address.fromScAddress(call.contractAddress()).toString() === registry &&
    call.functionName().toString() === fn &&
    got.length === args.length &&
    got.every((a, i) => a.toXDR().equals(args[i]!.toXDR())) &&
    inv.subInvocations().length === 0
  );
};

async function createOwned(c: OwnedCtx): Promise<CreatedOwnedStellarAgent> {
  const { soroban, agent, passphrase } = c;
  const { prepare, latestLedger, confirm } = soroban;
  if (!prepare || !latestLedger || !confirm) {
    throw new Error('agentenact: owner mode needs soroban.prepare, latestLedger and confirm');
  }
  const ownerId = c.owner.publicKey;
  // Every build advances its source Account's sequence, so each tx gets a freshly fetched one.
  const invoke = async (fn: string, args: xdr.ScVal[], auth?: xdr.SorobanAuthorizationEntry[]) =>
    new TransactionBuilder(await soroban.getAccount(ownerId), { fee: BASE_FEE, networkPassphrase: passphrase })
      .addOperation(Operation.invokeContractFunction({ contract: c.registry, function: fn, args, ...(auth ? { auth } : {}) }))
      .setTimeout(WALLET_TIMEOUT_SECONDS)
      .build();

  // ── tx 1: owner-sponsored account + trustline (agent holds zero XLM) ─────
  const accountTx = sponsoredAccountTx(await soroban.getAccount(ownerId), agent, c.usdc, passphrase, WALLET_TIMEOUT_SECONDS);
  const account = await c.horizonSubmit((await walletSign(c.owner, accountTx, passphrase, 'owner', agent)).toXDR());

  // From here on the agent account exists on chain: any failure carries what was created.
  const partial: PartialOwnedAgent = {
    publicKey: agent.publicKey(),
    secret: agent.secret(),
    owner: ownerId,
    txs: { account: account.hash },
  };
  try {
    // ── tx 2: register_with_uri, owner is source and caller ────────────────
    const registerTx = await invoke('register_with_uri', [
      Address.fromString(ownerId).toScVal(),
      nativeToScVal(c.agentUri, { type: 'string' }),
    ]);
    const { agentId: simulatedId, prepared: registerPrepared } = await soroban.register(registerTx);
    const register = await soroban.send(await walletSign(c.owner, registerPrepared, passphrase, 'owner'));
    partial.txs.register = register.hash;
    // The simulated id can shift if another registration lands first; the executed tx is the truth.
    const returned = await confirm(register.hash);
    const agentId = usableAgentId(returned ? String(scValToNative(returned)) : simulatedId);
    partial.agentId = agentId;

    // ── tx 3: set_agent_wallet; needs the owner's AND the agent's authorisation ─
    const bindArgs = [
      Address.fromString(ownerId).toScVal(),
      nativeToScVal(Number(agentId), { type: 'u32' }),
      Address.fromString(agent.publicKey()).toScVal(),
    ];
    const first = await prepare(await invoke('set_agent_wallet', bindArgs));
    // The agent key signs nothing but this very call. Source-account entries count too: the owner's
    // envelope signature authorises them, so they could hide an owner-funded call.
    if (!first.auth.every((e) => isForCall(e, c.registry, 'set_agent_wallet', bindArgs))) {
      throw new Error('agentenact: set_agent_wallet simulation returned an auth entry for a different invocation');
    }
    const validUntil = (await latestLedger()) + AUTH_VALID_LEDGERS;
    const agentHex = agent.xdrPublicKey().toXDR('hex');
    let agentEntries = 0;
    const auth = await Promise.all(
      first.auth.map((entry) => {
        const creds = entry.credentials();
        const isAgent =
          creds.switch() === xdr.SorobanCredentialsType.sorobanCredentialsAddress() &&
          creds.address().address().switch() === xdr.ScAddressType.scAddressTypeAccount() &&
          creds.address().address().accountId().toXDR('hex') === agentHex;
        if (isAgent) agentEntries++;
        return isAgent ? authorizeEntry(entry, agent, validUntil, passphrase) : entry;
      }),
    );
    // The registry needs the agent's authorisation; without its entry the bind cannot succeed.
    if (!agentEntries) throw new Error('agentenact: set_agent_wallet simulation returned no auth entry for the agent');
    // Re-simulate with the signed entry so the footprint and fee reflect the real call.
    const { prepared: bindPrepared } = await prepare(await invoke('set_agent_wallet', bindArgs, auth));
    const bind = await soroban.send(await walletSign(c.owner, bindPrepared, passphrase, 'owner'));
    partial.txs.bind = bind.hash;
    await confirm(bind.hash);

    return {
      publicKey: agent.publicKey(),
      secret: agent.secret(),
      agentId,
      owner: ownerId,
      txs: { account: account.hash, register: register.hash, bind: bind.hash },
    };
  } catch (err) {
    throw withPartial(err, partial);
  }
}

/** The agent's key as the auth-owner path uses it: local, or in a signer process. */
interface AgentKey {
  publicKey: string;
  /** Present only for a local key. */
  secret?: string;
  /** Add the agent's signature to `tx` (verified before it is added). */
  signTx(tx: Transaction): Promise<void>;
  authorize(entry: xdr.SorobanAuthorizationEntry, validUntil: number): Promise<xdr.SorobanAuthorizationEntry>;
}

function localKey(kp: Keypair, passphrase: string): AgentKey {
  return {
    publicKey: kp.publicKey(),
    secret: kp.secret(),
    async signTx(tx) {
      tx.sign(kp);
    },
    authorize: (e, validUntil) => authorizeEntry(e, kp, validUntil, passphrase),
  };
}

function remoteKey(s: AgentKeySigner, passphrase: string): AgentKey {
  if (!StrKey.isValidEd25519PublicKey(s.publicKey)) throw new Error('agentenact: agentSigner.publicKey is not a G… address');
  const kp = Keypair.fromPublicKey(s.publicKey);
  return {
    publicKey: s.publicKey,
    async signTx(tx) {
      const sig = Buffer.from(await s.signTransaction(tx.toXDR(), passphrase), 'base64');
      if (!kp.verify(tx.hash(), sig)) throw new Error('agentenact: agent signer returned an invalid transaction signature');
      tx.addSignature(s.publicKey, sig.toString('base64'));
    },
    // authorizeEntry verifies the returned signature against the entry's address before using it.
    authorize: (e, validUntil) =>
      authorizeEntry(e, async (preimage) => Buffer.from(await s.signAuthEntry(preimage.toXDR('base64')), 'base64'), validUntil, passphrase),
  };
}

interface AuthOwnedCtx extends Omit<OwnedCtx, 'owner'> {
  key: AgentKey;
  owner: StellarAuthSigner;
  sponsor: StellarSigner;
  lock: SponsorLock;
  resume?: ResumeState;
  horizonAccount: (id: string) => Promise<HorizonAccountView | null>;
  identity: (agentId: string) => Promise<{ owner: string; wallet: string | null } | null>;
}

async function createAuthOwned(c: AuthOwnedCtx): Promise<ResumedOwnedStellarAgent | RemoteOwnedStellarAgent> {
  const { soroban, key, passphrase } = c;
  const agentAddress = key.publicKey;
  const withSecret = <T extends object>(o: T) => (key.secret !== undefined ? { ...o, secret: key.secret } : o);
  const { prepare, latestLedger, confirm } = soroban;
  if (!prepare || !latestLedger || !confirm) {
    throw new Error('agentenact: owner mode needs soroban.prepare, latestLedger and confirm');
  }
  const ownerId = c.owner.address;
  const sponsorId = c.sponsor.publicKey;
  // Every build advances its source Account's sequence, so each build gets a freshly fetched one.
  const build = async (fn: string, args: xdr.ScVal[], auth?: xdr.SorobanAuthorizationEntry[]) =>
    new TransactionBuilder(await soroban.getAccount(sponsorId), { fee: BASE_FEE, networkPassphrase: passphrase })
      .addOperation(Operation.invokeContractFunction({ contract: c.registry, function: fn, args, ...(auth ? { auth } : {}) }))
      .setTimeout(WALLET_TIMEOUT_SECONDS)
      .build();

  /** The owner signs its entry; the result must be the same entry (same signer, same invocation). */
  const ownerSigned = async (e: xdr.SorobanAuthorizationEntry, validUntil: number) => {
    const out = xdr.SorobanAuthorizationEntry.fromXDR(await c.owner.signAuthEntry(e.toXDR('base64'), validUntil, passphrase), 'base64');
    if (!isAddressEntry(out) || signerOf(out) !== ownerId || !out.rootInvocation().toXDR().equals(e.rootInvocation().toXDR())) {
      throw new Error('agentenact: owner signer returned a different auth entry');
    }
    return out;
  };

  /**
   * Recording simulation → sign every address entry (owner via its wallet, agent locally),
   * sequentially so a wallet never sees two prompts at once → enforcing re-simulation, in which
   * __check_auth really runs → sponsor signs the envelope → send. Returns the hash; confirm is the caller's.
   */
  const invoke = async (fn: string, args: xdr.ScVal[], agentSigns: boolean) => {
    const first = await prepare(await build(fn, args));
    // Refuse a call that needs anyone else's authorisation before the owner is ever prompted.
    const stranger = first.auth.filter(isAddressEntry).map(signerOf).find((w) => w !== ownerId && !(agentSigns && w === agentAddress));
    if (stranger) throw new Error(`agentenact: ${fn} simulation asked for an unexpected signer ${stranger}`);
    // Nobody signs an entry that authorises anything other than the very call being built. Source-account
    // entries count too: the sponsor's envelope signature authorises them, so they could hide a sponsor-funded call.
    if (!first.auth.every((e) => isForCall(e, c.registry, fn, args))) {
      throw new Error(`agentenact: ${fn} simulation returned an auth entry for a different invocation`);
    }
    const validUntil = (await latestLedger()) + AUTH_VALID_LEDGERS;
    const auth: xdr.SorobanAuthorizationEntry[] = [];
    const seen = { owner: 0, agent: 0 };
    for (const e of first.auth) {
      if (!isAddressEntry(e)) {
        auth.push(e);
        continue;
      }
      const who = signerOf(e);
      if (who === ownerId) {
        seen.owner++;
        auth.push(await ownerSigned(e, validUntil));
      } else {
        seen.agent++;
        auth.push(await key.authorize(e, validUntil));
      }
    }
    if (!seen.owner) throw new Error(`agentenact: ${fn} simulation returned no auth entry for the owner`);
    if (agentSigns && !seen.agent) throw new Error(`agentenact: ${fn} simulation returned no auth entry for the agent`);
    // Locked section: fresh sponsor sequence → enforcing re-simulation → sponsor signature → send.
    return c.lock(async () => {
      const { prepared } = await prepare(await build(fn, args, auth));
      return soroban.send(await walletSign(c.sponsor, prepared, passphrase, 'sponsor'));
    });
  };

  // ── resume: verify every claimed fact on chain before any tx is built or signed ─────────
  let resumedId: string | undefined;
  if (c.resume) {
    const acct = await c.horizonAccount(agentAddress);
    if (!acct) throw resumeMismatch('the agent account does not exist');
    const [code, issuer] = [c.usdc.getCode(), c.usdc.getIssuer()];
    if (!acct.balances.some((b) => b.asset_type !== 'native' && b.asset_code === code && b.asset_issuer === issuer)) {
      throw resumeMismatch('the agent account has no trustline to the network USDC');
    }
    if (c.resume.agentId !== undefined) {
      const found = await c.identity(c.resume.agentId);
      if (!found) throw resumeMismatch(`agentId ${c.resume.agentId} has no owner in the registry`);
      if (found.owner !== ownerId) throw resumeMismatch(`agentId ${c.resume.agentId} is owned by someone else`);
      if (found.wallet === agentAddress) {
        return withSecret({ publicKey: agentAddress, agentId: c.resume.agentId, owner: ownerId, txs: {} });
      }
      // The registry defaults a fresh identity's wallet to its owner, so that counts as unbound.
      if (found.wallet && found.wallet !== ownerId) throw resumeMismatch(`agentId ${c.resume.agentId} is bound to a different wallet`);
      resumedId = c.resume.agentId;
    }
  }

  // ── tx 1: sponsor opens the agent account + trustline (agent holds zero XLM; owner not involved) ─
  const txs: { account?: string; register?: string; bind?: string } = {};
  if (!c.resume) {
    txs.account = await c.lock(async () => {
      const accountTx = sponsoredAccountTx(await soroban.getAccount(sponsorId), c.agent, c.usdc, passphrase, WALLET_TIMEOUT_SECONDS);
      const signed = await walletSign(c.sponsor, accountTx, passphrase, 'sponsor');
      await key.signTx(signed);
      return (await c.horizonSubmit(signed.toXDR())).hash;
    });
  }

  const partial: PartialOwnedAgent = withSecret({ publicKey: agentAddress, owner: ownerId, txs });
  try {
    let agentId: string;
    if (resumedId !== undefined) {
      agentId = resumedId;
      partial.agentId = agentId;
    } else {
      // ── tx 2: register_with_uri(owner, uri); the owner authorises, the sponsor pays ─────────
      const register = await invoke('register_with_uri', [Address.fromString(ownerId).toScVal(), nativeToScVal(c.agentUri, { type: 'string' })], false);
      txs.register = register.hash;
      const returned = await confirm(register.hash);
      // No simulated fallback here: only the executed tx's return value names the identity.
      agentId = usableAgentId(returned ? String(scValToNative(returned)) : '');
      partial.agentId = agentId;
    }

    // ── tx 3: set_agent_wallet(owner, id, agent); owner and agent both authorise ────────────
    const bind = await invoke(
      'set_agent_wallet',
      [Address.fromString(ownerId).toScVal(), nativeToScVal(Number(agentId), { type: 'u32' }), Address.fromString(agentAddress).toScVal()],
      true,
    );
    txs.bind = bind.hash;
    await confirm(bind.hash);

    return withSecret({ publicKey: agentAddress, agentId, owner: ownerId, txs: { ...txs } });
  } catch (err) {
    throw withPartial(err, partial);
  }
}

/**
 * For a signer process that holds agent keys (see `AgentKeySigner`): accept the birth account tx only if it is
 * exactly the 4-op sponsored create + USDC trustline for `agent` on `network`, and nothing else the agent's
 * signature could authorise. Returns the tx hash to sign; throws on any other shape.
 */
export function checkBirthTransaction(envelopeXdr: string, o: { network: 'stellar:pubnet' | 'stellar:testnet'; agent: string; sponsor?: string }): Buffer {
  const passphrase = o.network === 'stellar:pubnet' ? Networks.PUBLIC : Networks.TESTNET;
  const fail = (why: string): never => {
    throw new Error(`agentenact: not a birth transaction: ${why}`);
  };
  let tx: Transaction | FeeBumpTransaction;
  try {
    tx = TransactionBuilder.fromXDR(envelopeXdr, passphrase);
  } catch {
    return fail('unreadable');
  }
  if (!('operations' in tx) || 'innerTransaction' in tx) return fail('fee bump');
  if (o.sponsor !== undefined && tx.source !== o.sponsor) fail('another source');
  if (tx.source === o.agent) fail('the agent is the source');
  const [code, issuer] = Object.values(networkFor(o.network).assets)[0]!.asset.split(':');
  const ops = tx.operations as Array<Record<string, unknown> & { type: string; source?: string }>;
  if (ops.length !== 4) fail('op count');
  const [b, c, t, e] = ops as [typeof ops[0], typeof ops[0], typeof ops[0], typeof ops[0]];
  const asset = t.line as { code?: string; issuer?: string } | undefined;
  const ok =
    b.type === 'beginSponsoringFutureReserves' && b.sponsoredId === o.agent && (b.source === undefined || b.source === tx.source) &&
    c.type === 'createAccount' && c.destination === o.agent && c.startingBalance === '0.0000000' && (c.source === undefined || c.source === tx.source) &&
    t.type === 'changeTrust' && t.source === o.agent && asset?.code === code && asset?.issuer === issuer &&
    e.type === 'endSponsoringFutureReserves' && e.source === o.agent;
  if (!ok) fail('op shape');
  return tx.hash();
}

/**
 * For a signer process that holds agent keys: accept a Soroban auth preimage only if it authorises exactly
 * `registry.set_agent_wallet(owner, agentId, agent)` on `network`, with no sub-invocations. Returns the
 * preimage hash to sign; throws on anything else.
 */
export function checkBindPreimage(preimage: string, o: { network: 'stellar:pubnet' | 'stellar:testnet'; agent: string; registry?: string }): Buffer {
  const passphrase = o.network === 'stellar:pubnet' ? Networks.PUBLIC : Networks.TESTNET;
  const registry = o.registry ?? networkFor(o.network).identityRegistry;
  const fail = (why: string): never => {
    throw new Error(`agentenact: not a bind authorization: ${why}`);
  };
  let raw: Buffer;
  let pre: xdr.HashIdPreimage;
  try {
    raw = Buffer.from(preimage, 'base64');
    pre = xdr.HashIdPreimage.fromXDR(raw);
  } catch {
    return fail('unreadable');
  }
  if (pre.switch().value !== xdr.EnvelopeType.envelopeTypeSorobanAuthorization().value) fail('not a soroban authorization');
  const auth = pre.sorobanAuthorization();
  if (!Buffer.from(auth.networkId()).equals(hash(Buffer.from(passphrase)))) fail('another network');
  const inv = auth.invocation();
  if (inv.subInvocations().length > 0) fail('sub-invocations');
  const f = inv.function();
  if (f.switch().value !== xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn().value) fail('not a contract call');
  const call = f.contractFn();
  const args = call.args();
  if (Address.fromScAddress(call.contractAddress()).toString() !== registry) fail('another contract');
  if (call.functionName().toString() !== 'set_agent_wallet' || args.length !== 3) fail('another function');
  if (args[1]!.switch().value !== xdr.ScValType.scvU32().value) fail('agent id');
  let wallet: string;
  try {
    wallet = Address.fromScVal(args[2]!).toString();
    Address.fromScVal(args[0]!);
  } catch {
    return fail('arguments');
  }
  if (wallet !== o.agent) fail('another wallet');
  return hash(raw);
}
