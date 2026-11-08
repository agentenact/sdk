import { describe, expect, it } from 'bun:test';
import {
  Account,
  Address,
  Asset,
  Keypair,
  Networks,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  Operation,
  hash,
  nativeToScVal,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';
import { checkBindPreimage, checkBirthTransaction, createStellarAgent, type AgentKeySigner, type PartialOwnedAgent, type SorobanSeam, type StellarAuthSigner, type StellarSigner } from '../src/create.js';

const REGISTRY = 'CBGPDCJIHQ32G42BE7F2CIT3YW6XRN5ED6GQJHCRZSNAYH6TGMCL6X35';
const sponsor = Keypair.random();
const agent = Keypair.random();
const ownerC = StrKey.encodeContract(Buffer.alloc(32, 7));

type Failing = Error & { partial?: PartialOwnedAgent };

const sponsorSigner = (kp: Keypair): StellarSigner => ({
  publicKey: kp.publicKey(),
  async signTransaction(x, passphrase) {
    const tx = TransactionBuilder.fromXDR(x, passphrase);
    tx.sign(kp);
    return tx.toXDR();
  },
});

type OwnerCall = { fn: string; validUntil: number; passphrase: string; seen: string };

/** Stands in for a passkey wallet: fills the signature and expiry of the entry it was given. */
const ownerAuth = (log: OwnerCall[] = []): StellarAuthSigner => ({
  address: ownerC,
  async signAuthEntry(entryXdr, validUntil, passphrase) {
    const e = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, 'base64');
    log.push({ fn: e.rootInvocation().function().contractFn().functionName().toString(), validUntil, passphrase, seen: entryXdr });
    const creds = e.credentials().address();
    creds.signatureExpirationLedger(validUntil);
    creds.signature(xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('passkey')]));
    return e.toXDR('base64');
  },
});

function entry(
  signer: string,
  fn: string,
  source = false,
  args: xdr.ScVal[] = [],
  subInvocations: xdr.SorobanAuthorizedInvocation[] = [],
): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: source
      ? xdr.SorobanCredentials.sorobanCredentialsSourceAccount()
      : xdr.SorobanCredentials.sorobanCredentialsAddress(
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
      subInvocations,
    }),
  });
}

const fnOf = (tx: Transaction) =>
  (tx.operations[0] as unknown as { func: xdr.HostFunction }).func.invokeContract().functionName().toString();
const isAddr = (e: xdr.SorobanAuthorizationEntry) => e.credentials().switch() === xdr.SorobanCredentialsType.sorobanCredentialsAddress();
const argsOf = (tx: Transaction) =>
  (tx.operations[0] as unknown as { func: xdr.HostFunction }).func.invokeContract().args();
const authOf = (tx: Transaction) => (tx.operations[0] as unknown as { auth?: xdr.SorobanAuthorizationEntry[] }).auth ?? [];

interface Rig {
  calls: string[];
  submitted: Transaction[];
  prepareIn: Transaction[];
  sent: Transaction[];
  chainSeq: number;
  executedId?: number | null; // null = executed tx returns no value
  extraSigner?: string;
  fail?: 'account' | 'register-send' | 'bind-send';
  /** Tampers with what a recording simulation returns. */
  simAuth?: (fn: string, args: xdr.ScVal[], auth: xdr.SorobanAuthorizationEntry[]) => xdr.SorobanAuthorizationEntry[];
  seam: SorobanSeam;
  horizonSubmit: (x: string) => Promise<{ hash: string }>;
}

function rig(over: Partial<Rig> = {}): Rig {
  const r: Rig = { calls: [], submitted: [], prepareIn: [], sent: [], chainSeq: 9, seam: null as never, horizonSubmit: null as never, ...over };
  const assembled = (tx: Transaction) =>
    TransactionBuilder.cloneFrom(tx, { fee: tx.fee, sorobanData: new SorobanDataBuilder().setResourceFee(250_000).build() }).build();
  r.horizonSubmit = async (x) => {
    r.calls.push('horizon');
    if (r.fail === 'account') throw new Error('Horizon submit failed: 400 tx_failed');
    r.submitted.push(TransactionBuilder.fromXDR(x, Networks.TESTNET) as Transaction);
    r.chainSeq++;
    return { hash: 'a'.repeat(64) };
  };
  r.seam = {
    getAccount: async (id) => new Account(id, String(r.chainSeq)),
    register: async () => {
      throw new Error('register() is sponsor-mode only');
    },
    latestLedger: async () => 5000,
    prepare: async (tx) => {
      r.calls.push(`prepare:${fnOf(tx)}`);
      r.prepareIn.push(tx);
      const recording = authOf(tx).length === 0;
      const fn = fnOf(tx);
      // A real recording simulation records the call's own args in every entry.
      const args = argsOf(tx);
      const recorded = !recording
        ? []
        : fn === 'register_with_uri'
          ? [entry(sponsor.publicKey(), fn, true, args), entry(ownerC, fn, false, args)]
          : [
              entry(ownerC, fn, false, args),
              entry(agent.publicKey(), fn, false, args),
              ...(r.extraSigner ? [entry(r.extraSigner, fn, false, args)] : []),
            ];
      const auth = recording && r.simAuth ? r.simAuth(fn, args, recorded) : recorded;
      return { prepared: assembled(tx), auth };
    },
    send: async (tx) => {
      const fn = fnOf(tx as Transaction);
      r.calls.push(`send:${fn}`);
      if (r.fail === 'register-send' && fn === 'register_with_uri') throw new Error('sendTransaction error: register rejected');
      if (r.fail === 'bind-send' && fn === 'set_agent_wallet') throw new Error('sendTransaction error: bind rejected');
      r.sent.push(tx as Transaction);
      r.chainSeq++;
      return { hash: (fn === 'register_with_uri' ? 'b' : 'c').repeat(64) };
    },
    confirm: async (hash) => {
      r.calls.push('confirm');
      if (hash !== 'b'.repeat(64)) return undefined;
      return r.executedId === null ? undefined : nativeToScVal(r.executedId ?? 42, { type: 'u32' });
    },
  };
  return r;
}

const opts = (r: Rig, owner: StellarAuthSigner = ownerAuth(), sp: StellarSigner = sponsorSigner(sponsor)) => ({
  network: 'stellar:testnet' as const,
  owner,
  sponsor: sp,
  agentUri: 'https://agentenact.io/a/test/agent.json',
  identityRegistry: REGISTRY,
  keypair: agent,
  horizonSubmit: r.horizonSubmit,
  soroban: r.seam,
});

const run = (r: Rig, owner?: StellarAuthSigner, sp?: StellarSigner) =>
  createStellarAgent(opts(r, owner, sp)).catch((e) => e as Failing);

describe('createStellarAgent auth-entry owner mode', () => {
  it('sponsor sources and signs every tx; the owner only signs auth entries; the agent signs its own', async () => {
    const r = rig();
    const ownerLog: OwnerCall[] = [];
    const out = await createStellarAgent(opts(r, ownerAuth(ownerLog)));

    expect(out).toEqual({
      publicKey: agent.publicKey(),
      secret: agent.secret(),
      agentId: '42',
      owner: ownerC,
      txs: { account: 'a'.repeat(64), register: 'b'.repeat(64), bind: 'c'.repeat(64) },
    });
    expect(r.calls).toEqual([
      'horizon',
      'prepare:register_with_uri', 'prepare:register_with_uri', 'send:register_with_uri', 'confirm',
      'prepare:set_agent_wallet', 'prepare:set_agent_wallet', 'send:set_agent_wallet', 'confirm',
    ]);

    // tx 1: sponsor is source and reserve sponsor; signed by sponsor and agent, never by the owner
    const acct = r.submitted[0]!;
    expect(acct.source).toBe(sponsor.publicKey());
    expect(acct.operations.map((o) => o.type)).toEqual([
      'beginSponsoringFutureReserves', 'createAccount', 'changeTrust', 'endSponsoringFutureReserves',
    ]);
    const hints = acct.signatures.map((s) => s.hint().toString('hex'));
    expect(hints).toContain(sponsor.signatureHint().toString('hex'));
    expect(hints).toContain(agent.signatureHint().toString('hex'));

    // registry txs: sponsor is source, only the sponsor signs the envelope, consecutive sequences
    for (const tx of r.sent) {
      expect(tx.source).toBe(sponsor.publicKey());
      expect(tx.signatures).toHaveLength(1);
      expect(tx.signatures[0]!.hint().equals(sponsor.signatureHint())).toBe(true);
      expect(Number(tx.fee)).toBeGreaterThanOrEqual(250_000);
    }
    expect(r.sent.map((t) => t.sequence)).toEqual([String(r.chainSeq - 1), String(r.chainSeq)]);
    const registerArgs = (r.sent[0]!.operations[0] as unknown as { func: xdr.HostFunction }).func.invokeContract().args();
    expect(Address.fromScVal(registerArgs[0]!).toString()).toBe(ownerC);

    // the owner was asked twice, with the network and latestLedger + 100
    expect(ownerLog.map((l) => l.fn)).toEqual(['register_with_uri', 'set_agent_wallet']);
    for (const l of ownerLog) {
      expect(l.validUntil).toBe(5100);
      expect(l.passphrase).toBe(Networks.TESTNET);
    }

    // the enforcing re-simulation carries the signed entries
    const bindEnforcing = r.prepareIn[3]!;
    const signed = authOf(bindEnforcing);
    const ownerEntry = signed.find((e) => Address.fromScAddress(e.credentials().address().address()).toString() === ownerC)!;
    expect(ownerEntry.credentials().address().signature().switch()).toEqual(xdr.ScValType.scvVec());
    const agentEntry = signed.find((e) => Address.fromScAddress(e.credentials().address().address()).toString() === agent.publicKey())!;
    expect(agentEntry.credentials().address().signatureExpirationLedger()).toBe(5100);
    expect(agentEntry.credentials().address().signature().switch()).toEqual(xdr.ScValType.scvVec());
  });

  it('binds the agentId the executed register tx returned', async () => {
    const r = rig({ executedId: 77 });
    const out = await createStellarAgent(opts(r));
    expect(out.agentId).toBe('77');
    const bindArgs = (r.sent[1]!.operations[0] as unknown as { func: xdr.HostFunction }).func.invokeContract().args();
    expect(bindArgs[1]!.u32()).toBe(77);
    expect(Address.fromScVal(bindArgs[2]!).toString()).toBe(agent.publicKey());
  });

  it('an auth owner without a sponsor, or a sponsor with a tx-signing owner, throws before any network call', async () => {
    const r = rig();
    const noSponsor = { ...opts(r), sponsor: undefined };
    await expect(createStellarAgent(noSponsor as never)).rejects.toThrow(/sponsor/);
    const txOwner = { ...opts(r), owner: sponsorSigner(Keypair.random()) };
    await expect(createStellarAgent(txOwner as never)).rejects.toThrow(/sponsor/);
    const withSecret = { ...opts(r), sponsorSecret: sponsor.secret() };
    await expect(createStellarAgent(withSecret as never)).rejects.toThrow(/exactly one/);
    expect(r.calls).toEqual([]);
  });

  it('tx 1 failure: nothing registered or bound, no partial', async () => {
    const r = rig({ fail: 'account' });
    const err = await run(r);
    expect(err).toBeInstanceOf(Error);
    expect(err.partial).toBeUndefined();
    expect(r.calls).toEqual(['horizon']);
  });

  it('owner refuses the register entry: account exists, nothing sent, partial carries the account', async () => {
    const r = rig();
    const refusing: StellarAuthSigner = { address: ownerC, signAuthEntry: async () => { throw new Error('user cancelled'); } };
    const err = await run(r, refusing);
    expect(err.message).toMatch(/user cancelled/);
    expect(err.partial).toMatchObject({ publicKey: agent.publicKey(), owner: ownerC, txs: { account: 'a'.repeat(64) } });
    expect(err.partial!.txs.register).toBeUndefined();
    expect(r.sent).toHaveLength(0);
  });

  it('owner refuses the bind entry: registered, not bound, partial carries the agentId', async () => {
    const r = rig();
    let n = 0;
    const base = ownerAuth();
    const second: StellarAuthSigner = {
      address: ownerC,
      signAuthEntry: async (...a) => (++n === 2 ? Promise.reject(new Error('user cancelled')) : base.signAuthEntry(...a)),
    };
    const err = await run(r, second);
    expect(err.partial).toMatchObject({ agentId: '42', txs: { account: 'a'.repeat(64), register: 'b'.repeat(64) } });
    expect(err.partial!.txs.bind).toBeUndefined();
    expect(r.calls).not.toContain('send:set_agent_wallet');
  });

  it('an owner entry that comes back for a different invocation is refused before anything is sent', async () => {
    const r = rig();
    const swapping: StellarAuthSigner = {
      address: ownerC,
      async signAuthEntry() {
        const e = entry(ownerC, 'transfer');
        e.credentials().address().signature(xdr.ScVal.scvVec([]));
        return e.toXDR('base64');
      },
    };
    const err = await run(r, swapping);
    expect(err.message).toMatch(/different/);
    expect(r.sent).toHaveLength(0);
    expect(err.partial?.txs.account).toBe('a'.repeat(64));
  });

  it('a simulation that asks for an unexpected signer is refused before the owner is prompted, nothing bound', async () => {
    const stranger = Keypair.random().publicKey();
    const r = rig({ extraSigner: stranger });
    const ownerLog: OwnerCall[] = [];
    const err = await run(r, ownerAuth(ownerLog));
    expect(err.message).toMatch(/unexpected signer/);
    expect(ownerLog.map((l) => l.fn)).toEqual(['register_with_uri']); // never prompted for the bind
    expect(r.calls).not.toContain('send:set_agent_wallet');
    expect(err.partial?.agentId).toBe('42');
  });

  it('a register tx that returns no agentId stops before bind', async () => {
    const r = rig({ executedId: null });
    const err = await run(r);
    expect(err.message).toMatch(/agentId/);
    expect(r.calls).not.toContain('prepare:set_agent_wallet');
    expect(err.partial?.txs.register).toBe('b'.repeat(64));
  });

  it('register send fails: no confirm, no bind, partial has no register hash', async () => {
    const r = rig({ fail: 'register-send' });
    const err = await run(r);
    expect(r.calls).not.toContain('confirm');
    expect(err.partial!.txs.register).toBeUndefined();
  });

  it('bind send fails: partial carries the agentId but no bind hash', async () => {
    const r = rig({ fail: 'bind-send' });
    const err = await run(r);
    expect(err.partial).toMatchObject({ agentId: '42', txs: { register: 'b'.repeat(64) } });
    expect(err.partial!.txs.bind).toBeUndefined();
  });

  it('a sponsor that returns a different transaction is refused before submit', async () => {
    const r = rig();
    const other = Keypair.random();
    const lying: StellarSigner = {
      publicKey: sponsor.publicKey(),
      async signTransaction(_x, passphrase) {
        const tx = new TransactionBuilder(new Account(other.publicKey(), '1'), { fee: '100', networkPassphrase: passphrase })
          .setTimeout(30).build();
        tx.sign(sponsor);
        return tx.toXDR();
      },
    };
    const err = await run(r, ownerAuth(), lying);
    expect(err.message).toMatch(/different transaction/);
    expect(r.calls).toEqual([]);
  });

  it('a simulated owner entry for a different function or different args is refused before the owner is prompted', async () => {
    const tampers: Array<(fn: string, args: xdr.ScVal[]) => xdr.SorobanAuthorizationEntry> = [
      (_fn, args) => entry(ownerC, 'transfer', false, args),
      (fn, args) => entry(ownerC, fn, false, [args[0]!, nativeToScVal('https://evil.example/agent.json', { type: 'string' })]),
      (fn, args) => entry(ownerC, fn, false, args.slice(0, 1)),
    ];
    for (const tamper of tampers) {
      const r = rig({
        simAuth: (fn, args, auth) =>
          fn === 'register_with_uri' ? auth.map((e) => (isAddr(e) ? tamper(fn, args) : e)) : auth,
      });
      const ownerLog: OwnerCall[] = [];
      const err = await run(r, ownerAuth(ownerLog));
      expect(err.message).toMatch(/register_with_uri simulation returned an auth entry for a different invocation/);
      expect(ownerLog).toEqual([]);
      expect(r.sent).toHaveLength(0);
      expect(r.calls).toEqual(['horizon', 'prepare:register_with_uri']);
    }
  });

  it('a simulated entry with sub-invocations is refused before the owner is prompted', async () => {
    const sub = entry(ownerC, 'transfer').rootInvocation();
    const r = rig({
      simAuth: (fn, args, auth) =>
        fn === 'register_with_uri' ? auth.map((e) => (isAddr(e) ? entry(ownerC, fn, false, args, [sub]) : e)) : auth,
    });
    const ownerLog: OwnerCall[] = [];
    const err = await run(r, ownerAuth(ownerLog));
    expect(err.message).toMatch(/different invocation/);
    expect(ownerLog).toEqual([]);
    expect(r.sent).toHaveLength(0);
    expect(r.calls).toEqual(['horizon', 'prepare:register_with_uri']);
  });

  it('a simulated source-account entry for a different call is refused before the owner is prompted', async () => {
    const usdcSac = StrKey.encodeContract(Buffer.alloc(32, 3));
    const hidden = (): xdr.SorobanAuthorizationEntry => {
      const transfer = new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
        rootInvocation: new xdr.SorobanAuthorizedInvocation({
          function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
            new xdr.InvokeContractArgs({
              contractAddress: Address.fromString(usdcSac).toScAddress(),
              functionName: 'transfer',
              args: [
                Address.fromString(sponsor.publicKey()).toScVal(),
                Address.fromString(Keypair.random().publicKey()).toScVal(),
                nativeToScVal(1_000_000_000n, { type: 'i128' }),
              ],
            }),
          ),
          subInvocations: [entry(ownerC, 'transfer').rootInvocation()],
        }),
      });
      return transfer;
    };
    const r = rig({ simAuth: (fn, _args, auth) => (fn === 'register_with_uri' ? [hidden(), ...auth] : auth) });
    const ownerLog: OwnerCall[] = [];
    const err = await run(r, ownerAuth(ownerLog));
    expect(err.message).toMatch(/register_with_uri simulation returned an auth entry for a different invocation/);
    expect(ownerLog).toEqual([]);
    expect(r.sent).toHaveLength(0);
    expect(r.calls).toEqual(['horizon', 'prepare:register_with_uri']);
  });

  it('an owner entry the wallet returns with a different signer is refused as a different auth entry', async () => {
    const r = rig();
    const otherC = StrKey.encodeContract(Buffer.alloc(32, 9));
    const resigning: StellarAuthSigner = {
      address: ownerC,
      async signAuthEntry(entryXdr, validUntil) {
        const given = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, 'base64');
        const fn = given.rootInvocation().function().contractFn();
        const e = entry(otherC, fn.functionName().toString(), false, fn.args());
        e.credentials().address().signatureExpirationLedger(validUntil);
        e.credentials().address().signature(xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('passkey')]));
        return e.toXDR('base64');
      },
    };
    const err = await run(r, resigning);
    expect(err.message).toMatch(/owner signer returned a different auth entry/);
    expect(r.sent).toHaveLength(0);
  });

  it('an agent entry in the register_with_uri simulation is an unexpected signer; the agent never signs', async () => {
    const r = rig({
      simAuth: (fn, args, auth) => (fn === 'register_with_uri' ? [...auth, entry(agent.publicKey(), fn, false, args)] : auth),
    });
    const ownerLog: OwnerCall[] = [];
    const err = await run(r, ownerAuth(ownerLog));
    expect(err.message).toMatch(new RegExp(`unexpected signer ${agent.publicKey()}`));
    expect(ownerLog).toEqual([]);
    // no enforcing re-simulation: no entry was signed by anyone
    expect(r.calls).toEqual(['horizon', 'prepare:register_with_uri']);
    expect(r.sent).toHaveLength(0);
  });

  it('an auth owner whose address is the sponsor throws before any network call', async () => {
    const r = rig();
    const same: StellarAuthSigner = { ...ownerAuth(), address: sponsor.publicKey() };
    await expect(createStellarAgent(opts(r, same))).rejects.toThrow(
      'agentenact: the auth-entry owner and the sponsor must be different accounts',
    );
    expect(r.calls).toEqual([]);
  });

  it('the agent secret never reaches the owner, the sponsor or any submitted XDR', async () => {
    const r = rig();
    const seen: string[] = [];
    const ownerLog: OwnerCall[] = [];
    const sp = sponsorSigner(sponsor);
    const watched: StellarSigner = { publicKey: sp.publicKey, signTransaction: async (x, p) => (seen.push(x), sp.signTransaction(x, p)) };
    await createStellarAgent(opts(r, ownerAuth(ownerLog), watched));
    const everything = [...seen, ...ownerLog.map((l) => l.seen), ...r.sent.map((t) => t.toXDR()), ...r.submitted.map((t) => t.toXDR())].join('|');
    expect(everything).not.toContain(agent.secret());
  });
});

describe('createStellarAgent auth-entry owner mode with a remote agentSigner', () => {
  type Seen = { txs: string[]; preimages: string[] };
  /** A signer process stand-in: holds the agent key, sees the whole tx / preimage, returns only signatures. */
  const remote = (seen: Seen, tamper?: 'tx' | 'entry'): AgentKeySigner => ({
    publicKey: agent.publicKey(),
    // What a real signer process does: check the whole object, then sign the hash the checker returns.
    async signTransaction(x) {
      seen.txs.push(x);
      const h = checkBirthTransaction(x, { network: 'stellar:testnet', agent: agent.publicKey(), sponsor: sponsor.publicKey() });
      return agent.sign(tamper === 'tx' ? Buffer.alloc(32, 1) : h).toString('base64');
    },
    async signAuthEntry(preimage) {
      seen.preimages.push(preimage);
      const h = checkBindPreimage(preimage, { network: 'stellar:testnet', agent: agent.publicKey(), registry: REGISTRY });
      return agent.sign(tamper === 'entry' ? Buffer.alloc(32, 2) : h).toString('base64');
    },
  });
  const remoteOpts = (r: Rig, s: AgentKeySigner) => {
    const { keypair: _k, ...o } = opts(r);
    return { ...o, agentSigner: s };
  };

  it('signs through the signer only, verifies both signatures, and returns no secret', async () => {
    const r = rig();
    const seen: Seen = { txs: [], preimages: [] };
    const out = await createStellarAgent(remoteOpts(r, remote(seen)));
    expect(out).toEqual({ publicKey: agent.publicKey(), agentId: '42', owner: ownerC, txs: { account: 'a'.repeat(64), register: 'b'.repeat(64), bind: 'c'.repeat(64) } });
    expect('secret' in out).toBe(false);
    // the signer saw the whole account tx (sponsor-signed, 4 ops) and one set_agent_wallet preimage
    expect(seen.txs).toHaveLength(1);
    const tx = TransactionBuilder.fromXDR(seen.txs[0]!, Networks.TESTNET) as Transaction;
    expect(tx.operations.map((o) => o.type)).toEqual(['beginSponsoringFutureReserves', 'createAccount', 'changeTrust', 'endSponsoringFutureReserves']);
    expect(seen.preimages).toHaveLength(1);
    const pre = xdr.HashIdPreimage.fromXDR(seen.preimages[0]!, 'base64').sorobanAuthorization();
    expect(pre.invocation().function().contractFn().functionName().toString()).toBe('set_agent_wallet');
    const hints = r.submitted[0]!.signatures.map((x) => x.hint().toString('hex'));
    expect(hints).toContain(agent.signatureHint().toString('hex'));
  });
  it('a bad account-tx signature stops before anything is submitted', async () => {
    const r = rig();
    const e = await createStellarAgent(remoteOpts(r, remote({ txs: [], preimages: [] }, 'tx'))).catch((x) => x as Failing);
    expect((e as Error).message).toMatch(/invalid transaction signature/);
    expect(r.calls).toEqual([]);
  });
  it('a bad auth-entry signature stops before the bind is sent; the partial carries no secret', async () => {
    const r = rig();
    const e = (await createStellarAgent(remoteOpts(r, remote({ txs: [], preimages: [] }, 'entry'))).catch((x) => x)) as Failing;
    expect(e).toBeInstanceOf(Error);
    expect(r.calls).not.toContain('send:set_agent_wallet');
    expect(e.partial?.publicKey).toBe(agent.publicKey());
    expect(e.partial && 'secret' in e.partial).toBe(false);
  });
  it('agentSigner is refused with a keypair, and outside auth-entry owner mode', async () => {
    const r = rig();
    const s = remote({ txs: [], preimages: [] });
    await expect(createStellarAgent({ ...opts(r), agentSigner: s } as never)).rejects.toThrow(/either keypair or agentSigner/);
    await expect(createStellarAgent({ network: 'stellar:testnet', sponsorSecret: sponsor.secret(), agentUri: 'https://x', agentSigner: s } as never)).rejects.toThrow(/only supported with an auth-entry owner/);
    expect(r.calls).toEqual([]);
  });
});

describe('checkBirthTransaction / checkBindPreimage', () => {
  const usdc = new Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
  const birth = (extra?: (b: TransactionBuilder) => void, trust = usdc) => {
    const b = new TransactionBuilder(new Account(sponsor.publicKey(), '1'), { fee: '100', networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: agent.publicKey() }))
      .addOperation(Operation.createAccount({ destination: agent.publicKey(), startingBalance: '0' }))
      .addOperation(Operation.changeTrust({ asset: trust, source: agent.publicKey() }))
      .addOperation(Operation.endSponsoringFutureReserves({ source: agent.publicKey() }));
    extra?.(b);
    return b.setTimeout(300).build().toXDR();
  };
  const o = { network: 'stellar:testnet' as const, agent: agent.publicKey(), sponsor: sponsor.publicKey() };
  it('accepts exactly the birth shape and returns its hash', () => {
    const x = birth();
    expect(checkBirthTransaction(x, o).equals(TransactionBuilder.fromXDR(x, Networks.TESTNET).hash())).toBe(true);
  });
  it.each([
    ['a hidden payment from the agent', birth((b) => b.addOperation(Operation.payment({ destination: sponsor.publicKey(), asset: Asset.native(), amount: '1', source: agent.publicKey() })))],
    ['a trustline to another asset', birth(undefined, new Asset('USDC', sponsor.publicKey()))],
    ['the wrong network', birth()],
  ])('refuses %s', (name, x) => {
    if (name === 'the wrong network') expect(() => checkBirthTransaction(x, { ...o, network: 'stellar:pubnet' })).toThrow();
    else expect(() => checkBirthTransaction(x, o)).toThrow(/not a birth transaction/);
  });
  it('refuses another sponsor', () => {
    expect(() => checkBirthTransaction(birth(), { ...o, sponsor: agent.publicKey() })).toThrow(/another source/);
  });
  const bindPre = (fn = 'set_agent_wallet', wallet = agent.publicKey(), passphrase = Networks.TESTNET, sub: xdr.SorobanAuthorizedInvocation[] = []) =>
    xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId: hash(Buffer.from(passphrase)),
        nonce: new xdr.Int64(1),
        signatureExpirationLedger: 100,
        invocation: entry(agent.publicKey(), fn, false, [Address.fromString(ownerC).toScVal(), nativeToScVal(42, { type: 'u32' }), Address.fromString(wallet).toScVal()], sub).rootInvocation(),
      }),
    ).toXDR('base64');
  const b = { network: 'stellar:testnet' as const, agent: agent.publicKey(), registry: REGISTRY };
  it('accepts exactly set_agent_wallet(owner, id, agent)', () => {
    expect(checkBindPreimage(bindPre(), b)).toHaveLength(32);
  });
  it.each([
    ['another function', () => bindPre('transfer')],
    ['another wallet', () => bindPre('set_agent_wallet', sponsor.publicKey())],
    ['another network', () => bindPre('set_agent_wallet', agent.publicKey(), Networks.PUBLIC)],
    ['a sub-invocation', () => bindPre('set_agent_wallet', agent.publicKey(), Networks.TESTNET, [entry(agent.publicKey(), 'transfer').rootInvocation()])],
    ['garbage', () => 'AAAA'],
  ])('refuses %s', (_n, p) => {
    expect(() => checkBindPreimage(p(), b)).toThrow(/not a bind authorization/);
  });
});
