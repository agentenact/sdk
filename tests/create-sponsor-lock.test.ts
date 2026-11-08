import { describe, expect, it } from 'bun:test';
import {
  Account,
  Address,
  Keypair,
  Networks,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';
import {
  createStellarAgent,
  type PartialOwnedAgent,
  type SponsorLock,
  type SorobanSeam,
  type StellarAuthSigner,
  type StellarSigner,
} from '../src/create.js';

const REGISTRY = 'CBGPDCJIHQ32G42BE7F2CIT3YW6XRN5ED6GQJHCRZSNAYH6TGMCL6X35';
const ownerC = StrKey.encodeContract(Buffer.alloc(32, 7));
// register_with_uri on testnet measured ~2.65M stroops; the resource fee is most of it.
const RESOURCE_FEE = 2_400_000;

type Failing = Error & { partial?: PartialOwnedAgent };

const fnOf = (tx: Transaction) => (tx.operations[0] as unknown as { func: xdr.HostFunction }).func.invokeContract().functionName().toString();
const argsOf = (tx: Transaction) => (tx.operations[0] as unknown as { func: xdr.HostFunction }).func.invokeContract().args();
const authOf = (tx: Transaction) => (tx.operations[0] as unknown as { auth?: xdr.SorobanAuthorizationEntry[] }).auth ?? [];

function entry(signer: string, fn: string, args: xdr.ScVal[]): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(signer).toScAddress(),
        nonce: new xdr.Int64(777),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({ contractAddress: Address.fromString(REGISTRY).toScAddress(), functionName: fn, args }),
      ),
      subInvocations: [],
    }),
  });
}

/** Everything that happens, in order, tagged with whether a sponsorLock section was open. */
interface Rig {
  log: string[];
  held: number;
  maxHeld: number;
  lockCalls: number;
  chain: { seq: number };
  /** Sequences the submitted sponsor-sourced txs carried. */
  seqs: string[];
  failAt?: string;
  lock: SponsorLock;
  seam: SorobanSeam;
  horizonSubmit: (x: string) => Promise<{ hash: string }>;
  owner: StellarAuthSigner;
  sponsor: StellarSigner;
  sponsorKp: Keypair;
  agentKp: Keypair;
}

const tick = () => new Promise((r) => setTimeout(r, 1));

function rig(over: { sharedLock?: SponsorLock; sponsorKp?: Keypair; chain?: { seq: number } } = {}): Rig {
  const sponsorKp = over.sponsorKp ?? Keypair.random();
  const agentKp = Keypair.random();
  const r: Rig = {
    log: [], held: 0, maxHeld: 0, lockCalls: 0, chain: over.chain ?? { seq: 9 }, seqs: [],
    lock: null as never, seam: null as never, horizonSubmit: null as never, owner: null as never,
    sponsor: null as never, sponsorKp, agentKp,
  };
  const tag = (e: string) => r.log.push(`${r.held > 0 ? 'in' : 'out'}:${e}`);
  r.lock = async (work) => {
    r.lockCalls++;
    r.held++;
    r.maxHeld = Math.max(r.maxHeld, r.held);
    r.log.push('enter');
    try {
      return await work();
    } finally {
      r.log.push('exit');
      r.held--;
    }
  };
  if (over.sharedLock) {
    const shared = over.sharedLock;
    r.lock = (work) =>
      shared(async () => {
        r.lockCalls++;
        r.log.push('enter');
        try {
          return await work();
        } finally {
          r.log.push('exit');
        }
      });
  }
  const fail = (what: string) => {
    if (r.failAt === what) throw new Error(`${what} rejected`);
  };
  const assembled = (tx: Transaction) =>
    TransactionBuilder.cloneFrom(tx, { fee: tx.fee, sorobanData: new SorobanDataBuilder().setResourceFee(RESOURCE_FEE).build() }).build();
  r.horizonSubmit = async (x) => {
    tag('horizonSubmit');
    fail('horizonSubmit');
    const tx = TransactionBuilder.fromXDR(x, Networks.TESTNET) as Transaction;
    r.seqs.push(tx.sequence);
    await tick();
    r.chain.seq++;
    return { hash: 'a'.repeat(64) };
  };
  r.seam = {
    getAccount: async (id) => {
      const sponsorRead = id === sponsorKp.publicKey();
      tag(sponsorRead ? 'getAccount:sponsor' : 'getAccount:other');
      const seq = r.chain.seq;
      await tick(); // a slow RPC read: lets an unlocked peer interleave
      return new Account(id, String(seq));
    },
    register: async (inner) => {
      tag('register');
      return { agentId: '42', prepared: assembled(inner) };
    },
    latestLedger: async () => 5000,
    prepare: async (tx) => {
      const recording = authOf(tx).length === 0;
      tag(recording ? `prepare-recording:${fnOf(tx)}` : `prepare:${fnOf(tx)}`);
      const fn = fnOf(tx);
      const args = argsOf(tx);
      const auth = !recording
        ? []
        : fn === 'register_with_uri'
          ? [entry(ownerC, fn, args)]
          : [entry(ownerC, fn, args), entry(agentKp.publicKey(), fn, args)];
      return { prepared: assembled(tx), auth };
    },
    send: async (tx) => {
      const fn = fnOf(tx as Transaction);
      tag(`send:${fn}`);
      fail(`send:${fn}`);
      r.seqs.push((tx as Transaction).sequence);
      await tick();
      r.chain.seq++;
      return { hash: (fn === 'register_with_uri' ? 'b' : 'c').repeat(64) };
    },
    confirm: async (hash) => (hash === 'b'.repeat(64) ? nativeToScVal(42, { type: 'u32' }) : undefined),
  };
  r.owner = {
    address: ownerC,
    async signAuthEntry(entryXdr, validUntil) {
      tag('ownerSign');
      await tick();
      const e = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, 'base64');
      const creds = e.credentials().address();
      creds.signatureExpirationLedger(validUntil);
      creds.signature(xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('passkey')]));
      return e.toXDR('base64');
    },
  };
  r.sponsor = {
    publicKey: sponsorKp.publicKey(),
    async signTransaction(x, passphrase) {
      tag('sponsorSign');
      const tx = TransactionBuilder.fromXDR(x, passphrase);
      tx.sign(sponsorKp);
      return tx.toXDR();
    },
  };
  return r;
}

const authOpts = (r: Rig, lock: SponsorLock | null = r.lock) => ({
  network: 'stellar:testnet' as const,
  owner: r.owner,
  sponsor: r.sponsor,
  agentUri: 'https://agentenact.io/a/test/agent.json',
  identityRegistry: REGISTRY,
  keypair: r.agentKp,
  horizonSubmit: r.horizonSubmit,
  soroban: r.seam,
  ...(lock ? { sponsorLock: lock } : {}),
});

const sponsorOpts = (r: Rig) => ({
  network: 'stellar:testnet' as const,
  sponsorSecret: r.sponsorKp.secret(),
  agentUri: 'https://agentenact.io/a/test/agent.json',
  identityRegistry: REGISTRY,
  keypair: r.agentKp,
  horizonSubmit: r.horizonSubmit,
  soroban: r.seam,
  sponsorLock: r.lock,
});

/** A FIFO mutex, like a caller's own lease lock. */
function mutex(): SponsorLock {
  let tail: Promise<unknown> = Promise.resolve();
  return (work) => {
    const run = tail.then(work, work);
    tail = run.catch(() => undefined);
    return run;
  };
}

describe('sponsorLock: auth-entry owner mode', () => {
  it('wraps exactly the three sponsor sections; owner signing and recording simulation stay outside', async () => {
    const r = rig();
    await createStellarAgent(authOpts(r));

    expect(r.lockCalls).toBe(3);
    expect(r.maxHeld).toBe(1); // never nested
    expect(r.held).toBe(0);
    expect(r.log).toEqual([
      // tx 1
      'enter', 'in:getAccount:sponsor', 'in:sponsorSign', 'in:horizonSubmit', 'exit',
      // tx 2: recording read + simulation and the owner prompt are outside; the build/re-sim/sign/send is inside
      'out:getAccount:sponsor', 'out:prepare-recording:register_with_uri', 'out:ownerSign',
      'enter', 'in:getAccount:sponsor', 'in:prepare:register_with_uri', 'in:sponsorSign', 'in:send:register_with_uri', 'exit',
      // tx 3: owner then agent entries (agent signs locally)
      'out:getAccount:sponsor', 'out:prepare-recording:set_agent_wallet', 'out:ownerSign',
      'enter', 'in:getAccount:sponsor', 'in:prepare:set_agent_wallet', 'in:sponsorSign', 'in:send:set_agent_wallet', 'exit',
    ]);
  });

  it('a failing tx 1 releases the lock, sends nothing, and carries no partial', async () => {
    const r = rig();
    r.failAt = 'horizonSubmit';
    const err = (await createStellarAgent(authOpts(r)).catch((e) => e)) as Failing;

    expect(err.message).toContain('horizonSubmit rejected');
    expect(err.partial).toBeUndefined();
    expect(r.held).toBe(0);
    expect(r.log.at(-1)).toBe('exit');
    expect(r.log.some((e) => e.includes('send:'))).toBe(false);
  });

  it('a failing register send releases the lock and keeps err.partial exactly as without a lock', async () => {
    const withLock = rig();
    withLock.failAt = 'send:register_with_uri';
    const a = (await createStellarAgent(authOpts(withLock)).catch((e) => e)) as Failing;

    const plain = rig();
    plain.failAt = 'send:register_with_uri';
    const b = (await createStellarAgent(authOpts(plain, null)).catch((e) => e)) as Failing;

    expect(a.message).toBe(b.message);
    expect(a.partial).toBeDefined();
    expect(a.partial!.txs).toEqual({ account: 'a'.repeat(64) });
    expect(a.partial).toEqual({ ...b.partial!, publicKey: a.partial!.publicKey, secret: a.partial!.secret, owner: a.partial!.owner });
    expect(withLock.held).toBe(0);
    expect(withLock.lockCalls).toBe(2); // tx 1 and the failed register; bind never started
  });

  it('a failing bind send releases the lock and the partial carries the registration', async () => {
    const r = rig();
    r.failAt = 'send:set_agent_wallet';
    const err = (await createStellarAgent(authOpts(r)).catch((e) => e)) as Failing;

    expect(err.partial!.agentId).toBe('42');
    expect(err.partial!.txs.register).toBe('b'.repeat(64));
    expect(err.partial!.txs.bind).toBeUndefined();
    expect(r.held).toBe(0);
    expect(r.lockCalls).toBe(3);
  });

  it('a lock that refuses (busy) fails before anything is submitted', async () => {
    const r = rig();
    const busy: SponsorLock = async () => {
      throw Object.assign(new Error('chain_busy'), { code: 'chain_busy' });
    };
    const err = (await createStellarAgent(authOpts(r, busy)).catch((e) => e)) as Failing;

    expect(err.message).toBe('chain_busy');
    expect(err.partial).toBeUndefined();
    expect(r.log).toEqual([]);
  });

  it('two concurrent births through one mutex never share a sponsor sequence', async () => {
    const sponsorKp = Keypair.random();
    const shared = mutex();
    const chain = { seq: 100 }; // one chain: both births read and advance the same sponsor sequence
    const a = rig({ sharedLock: shared, sponsorKp, chain });
    const b = rig({ sharedLock: shared, sponsorKp, chain });

    await Promise.all([createStellarAgent(authOpts(a)), createStellarAgent(authOpts(b))]);

    const all = [...a.seqs, ...b.seqs];
    expect(all).toHaveLength(6);
    expect(new Set(all).size).toBe(6);
    expect(a.lockCalls + b.lockCalls).toBe(6);
  });

  it('the same two births without a lock collide on a sequence (the lock is what prevents it)', async () => {
    const sponsorKp = Keypair.random();
    const chain = { seq: 100 };
    const a = rig({ sponsorKp, chain });
    const b = rig({ sponsorKp, chain });

    await Promise.all([createStellarAgent(authOpts(a, null)), createStellarAgent(authOpts(b, null))]);

    const all = [...a.seqs, ...b.seqs];
    expect(new Set(all).size).toBeLessThan(all.length);
  });

  it('without the option the same seam calls happen and nothing is wrapped', async () => {
    const r = rig();
    const out = await createStellarAgent(authOpts(r, null));
    expect(out.agentId).toBe('42');
    expect(r.log.some((e) => e === 'enter' || e === 'exit')).toBe(false);
    expect(r.lockCalls).toBe(0);
  });
});

describe('sponsorLock: sponsor mode and wallet-owner mode', () => {
  it('sponsor mode locks tx 1 only; the fee-bumped registration uses the agent sequence, outside', async () => {
    const r = rig();
    await createStellarAgent(sponsorOpts(r));

    expect(r.lockCalls).toBe(1);
    expect(r.log).toEqual([
      'enter', 'in:getAccount:sponsor', 'in:horizonSubmit', 'exit',
      'out:getAccount:other', 'out:register', 'out:send:register_with_uri',
    ]);
  });

  it('sponsor mode: a tx 1 failure releases the lock', async () => {
    const r = rig();
    r.failAt = 'horizonSubmit';
    const err = await createStellarAgent(sponsorOpts(r)).catch((e) => e as Error);
    expect(err.message).toContain('horizonSubmit rejected');
    expect(r.held).toBe(0);
    expect(r.log).toEqual(['enter', 'in:getAccount:sponsor', 'in:horizonSubmit', 'exit']);
  });

  it('wallet-owner mode refuses the option before any network call', async () => {
    const r = rig();
    const walletOwner: StellarSigner = { publicKey: Keypair.random().publicKey(), signTransaction: async (x) => x };
    const err = await createStellarAgent({
      network: 'stellar:testnet',
      owner: walletOwner,
      agentUri: 'https://agentenact.io/a/test/agent.json',
      identityRegistry: REGISTRY,
      keypair: r.agentKp,
      horizonSubmit: r.horizonSubmit,
      soroban: r.seam,
      sponsorLock: r.lock,
    }).catch((e) => e as Error);
    expect(err.message).toContain('sponsorLock');
    expect(r.log).toEqual([]);
  });
});
