import { describe, expect, it } from 'bun:test';
import {
  Account,
  Address,
  BASE_FEE,
  Asset,
  Keypair,
  Networks,
  Operation,
  hash,
  nativeToScVal,
  SorobanDataBuilder,
  TransactionBuilder,
  xdr,
  type FeeBumpTransaction,
  type Transaction,
} from '@stellar/stellar-sdk';
import { createStellarAgent, type PartialOwnedAgent, type SorobanSeam, type StellarSigner } from '../src/create.js';
import { NETWORKS } from '../src/networks.js';

const sponsor = Keypair.random();
const agent = Keypair.random();
const USDC_TESTNET_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const REGISTRY = 'CBGPDCJIHQ32G42BE7F2CIT3YW6XRN5ED6GQJHCRZSNAYH6TGMCL6X35';
// Resource fee of a register_with_uri call as simulated on pubnet 2026-09-22 (27.29 XLM).
const RESOURCE_FEE = 272_932_053;

describe('createStellarAgent', () => {
  it('builds the sponsored-account tx and a fee-bumped registration, returns the secret once', async () => {
    const submitted: Transaction[] = [];
    const sent: Array<Transaction | FeeBumpTransaction> = [];
    let registered: Transaction | null = null;

    const res = await createStellarAgent({
      network: 'stellar:testnet',
      sponsorSecret: sponsor.secret(),
      agentUri: 'https://example.test/agent.json',
      identityRegistry: REGISTRY,
      keypair: agent,
      horizonSubmit: async (x) => {
        submitted.push(TransactionBuilder.fromXDR(x, Networks.TESTNET) as Transaction);
        return { hash: 'a'.repeat(64) };
      },
      soroban: {
        getAccount: async (id) => new Account(id, '7'),
        register: async (inner) => {
          registered = inner;
          // Shaped like rpc.assembleTransaction output: sorobanData carries the resource fee and
          // build() adds it to the inclusion fee, so the total is inclusion + resource.
          const sorobanData = new SorobanDataBuilder().setResourceFee(RESOURCE_FEE).build();
          const prepared = TransactionBuilder.cloneFrom(inner, { fee: inner.fee, sorobanData }).build();
          return { agentId: '42', prepared };
        },
        send: async (tx) => {
          sent.push(tx);
          return { hash: 'b'.repeat(64) };
        },
      },
    });

    expect(res.publicKey).toBe(agent.publicKey());
    expect(res.secret).toBe(agent.secret());
    expect(res.agentId).toBe('42');
    expect(res.txs).toEqual({ account: 'a'.repeat(64), register: 'b'.repeat(64) });

    // tx 1 — sponsor-sourced, four ops, agent-sourced trustline + end-sponsoring, both signatures.
    const tx = submitted[0]!;
    expect(tx.source).toBe(sponsor.publicKey());
    expect(tx.operations.map((o) => o.type)).toEqual([
      'beginSponsoringFutureReserves',
      'createAccount',
      'changeTrust',
      'endSponsoringFutureReserves',
    ]);
    const create = tx.operations[1] as { destination: string; startingBalance: string };
    expect(create.destination).toBe(agent.publicKey());
    expect(Number(create.startingBalance)).toBe(0);
    const trust = tx.operations[2] as { source?: string; line: { code: string; issuer: string } };
    expect(trust.source).toBe(agent.publicKey());
    expect(trust.line).toMatchObject({ code: 'USDC', issuer: USDC_TESTNET_ISSUER });
    expect((tx.operations[3] as { source?: string }).source).toBe(agent.publicKey());
    expect(tx.signatures).toHaveLength(2);

    // tx 2 — agent-sourced inner invoking register_with_uri on the registry, sponsor fee-bump.
    expect(registered!.source).toBe(agent.publicKey());
    expect(registered!.operations[0]!.type).toBe('invokeHostFunction');
    const fb = sent[0] as FeeBumpTransaction;
    expect(fb.feeSource).toBe(sponsor.publicKey());
    expect(fb.innerTransaction.source).toBe(agent.publicKey());
    expect(fb.innerTransaction.signatures).toHaveLength(1);
    expect(fb.signatures).toHaveLength(1);
    // Fee bid = resource fee + base fee × (inner ops + 1). The network requires at least this,
    // and the sponsor must hold the full bid as balance, so bidding more locks up real XLM.
    expect(Number(fb.innerTransaction.fee)).toBe(Number(BASE_FEE) + RESOURCE_FEE);
    expect(Number(fb.fee)).toBe(RESOURCE_FEE + Number(BASE_FEE) * 2);
    expect(Number(fb.fee)).toBeGreaterThanOrEqual(Number(fb.innerTransaction.fee) + Number(BASE_FEE));
  });

  it('registers on the pinned testnet registry when none is passed', async () => {
    let registered: Transaction | null = null;
    await createStellarAgent({
      network: 'stellar:testnet',
      sponsorSecret: sponsor.secret(),
      agentUri: 'https://example.test/agent.json',
      keypair: Keypair.random(),
      horizonSubmit: async () => ({ hash: 'a'.repeat(64) }),
      soroban: {
        getAccount: async (id) => new Account(id, '7'),
        register: async (inner) => {
          registered = inner;
          const sorobanData = new SorobanDataBuilder().setResourceFee(RESOURCE_FEE).build();
          return { agentId: '7', prepared: TransactionBuilder.cloneFrom(inner, { fee: inner.fee, sorobanData }).build() };
        },
        send: async () => ({ hash: 'b'.repeat(64) }),
      },
    });
    const invoke = (registered!.operations[0] as unknown as { func: xdr.HostFunction }).func.invokeContract();
    expect(Address.fromScAddress(invoke.contractAddress()).toString()).toBe(NETWORKS['stellar:testnet'].identityRegistry!);
  });
});

// ── owner mode: a wallet the package never sees the secret of ───────────────
const owner = Keypair.random();
const ownerSigner = (kp: Keypair, log?: string[]): StellarSigner => ({
  publicKey: kp.publicKey(),
  async signTransaction(x, passphrase) {
    log?.push('owner-sign');
    const tx = TransactionBuilder.fromXDR(x, passphrase);
    tx.sign(kp);
    return tx.toXDR();
  },
});

/** The args of the contract call a built tx invokes; a real simulation returns entries carrying them. */
const callArgs = (tx: Transaction) => (tx.operations[0] as unknown as { func: xdr.HostFunction }).func.invokeContract().args();

/** An unsigned address-credential entry for `signer`, shaped like a simulation result. */
function simAuthEntry(
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
        nonce: new xdr.Int64(12345),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(REGISTRY).toScAddress(),
          functionName: fn,
          args,
        }),
      ),
      subInvocations,
    }),
  });
}

interface OwnerRig {
  submitted: Transaction[];
  sent: Transaction[];
  prepared: Transaction[];
  calls: string[];
  seam: SorobanSeam;
  horizonSubmit: (x: string) => Promise<{ hash: string }>;
  /** The owner's on-chain sequence; advances only when a tx is submitted. */
  chainSeq: number;
  /** Return value the executed register tx reports; defaults to the simulated id. */
  executedId?: number;
}

function ownerRig(fail?: 'account' | 'register' | 'bind'): OwnerRig {
  const rig: OwnerRig = { submitted: [], sent: [], prepared: [], calls: [], seam: null as never, horizonSubmit: null as never, chainSeq: 7 };
  const fee = (tx: Transaction) => {
    // assembled Soroban tx: resource fee ~1e5+ stroops on top of the inclusion fee
    const sorobanData = new SorobanDataBuilder().setResourceFee(250_000).build();
    return TransactionBuilder.cloneFrom(tx, { fee: tx.fee, sorobanData }).build();
  };
  rig.horizonSubmit = async (x) => {
    rig.calls.push('horizon');
    if (fail === 'account') throw new Error('Horizon submit failed: 400 tx_failed');
    rig.submitted.push(TransactionBuilder.fromXDR(x, Networks.TESTNET) as Transaction);
    rig.chainSeq++;
    return { hash: 'a'.repeat(64) };
  };
  rig.seam = {
    // A fresh Account per call at the current on-chain sequence, like rpc.Server.getAccount.
    getAccount: async (id) => new Account(id, String(rig.chainSeq)),
    latestLedger: async () => 1000,
    register: async (inner) => {
      rig.calls.push('register');
      if (fail === 'register') throw new Error('register_with_uri simulation failed: boom');
      rig.prepared.push(inner);
      return { agentId: '42', prepared: fee(inner) };
    },
    prepare: async (tx) => {
      rig.calls.push('prepare');
      const op = tx.operations[0] as unknown as { auth?: xdr.SorobanAuthorizationEntry[] };
      const first = !op.auth?.length;
      // Like a real simulation: the agent entry is for whichever agent is the call's third argument.
      const args = callArgs(tx);
      const boundAgent = Address.fromScVal(args[2]!).toString();
      return {
        prepared: fee(tx),
        auth: first
          ? [simAuthEntry(owner.publicKey(), 'set_agent_wallet', true, args), simAuthEntry(boundAgent, 'set_agent_wallet', false, args)]
          : [],
      };
    },
    send: async (tx) => {
      rig.calls.push('send');
      if (fail === 'bind' && (tx as Transaction).operations[0]!.type === 'invokeHostFunction' && rig.sent.length === 1) {
        throw new Error('sendTransaction error: bind rejected');
      }
      rig.sent.push(tx as Transaction);
      rig.chainSeq++;
      return { hash: (rig.sent.length === 1 ? 'b' : 'c').repeat(64) };
    },
    confirm: async () => {
      rig.calls.push('confirm');
      // Only the register tx returns a value (the agentId).
      return rig.calls.filter((k) => k === 'confirm').length === 1 && rig.executedId !== undefined
        ? nativeToScVal(rig.executedId, { type: 'u32' })
        : undefined;
    },
  };
  return rig;
}

const ownerOpts = (rig: OwnerRig, signer: StellarSigner = ownerSigner(owner)) => ({
  network: 'stellar:testnet' as const,
  owner: signer,
  agentUri: 'https://example.test/agent.json',
  identityRegistry: REGISTRY,
  keypair: agent,
  horizonSubmit: rig.horizonSubmit,
  soroban: rig.seam,
});

describe('createStellarAgent owner mode', () => {
  it('builds owner-sponsored account, owner-sourced register, and owner-sourced bind with the agent auth signed', async () => {
    const log: string[] = [];
    const rig = ownerRig();
    const res = await createStellarAgent(ownerOpts(rig, ownerSigner(owner, log)));

    expect(res.owner).toBe(owner.publicKey());
    expect(res.publicKey).toBe(agent.publicKey());
    expect(res.secret).toBe(agent.secret());
    expect(res.agentId).toBe('42');
    expect(res.txs).toEqual({ account: 'a'.repeat(64), register: 'b'.repeat(64), bind: 'c'.repeat(64) });
    expect(log).toEqual(['owner-sign', 'owner-sign', 'owner-sign']);

    // tx 1 — same four sponsored ops, owner as sponsor and source; owner signs first, agent second.
    const tx1 = rig.submitted[0]!;
    expect(tx1.source).toBe(owner.publicKey());
    expect(tx1.operations.map((o) => o.type)).toEqual([
      'beginSponsoringFutureReserves',
      'createAccount',
      'changeTrust',
      'endSponsoringFutureReserves',
    ]);
    expect((tx1.operations[0] as { sponsoredId: string }).sponsoredId).toBe(agent.publicKey());
    const trust = tx1.operations[2] as { source?: string; line: { code: string; issuer: string } };
    expect(trust.source).toBe(agent.publicKey());
    expect(trust.line).toMatchObject({ code: 'USDC', issuer: USDC_TESTNET_ISSUER });
    expect(tx1.signatures).toHaveLength(2);
    expect(tx1.signatures[0]!.hint().equals(owner.signatureHint())).toBe(true);
    expect(tx1.signatures[1]!.hint().equals(agent.signatureHint())).toBe(true);

    // tx 2 — register_with_uri, owner is source AND the `owner` argument. No fee bump.
    const tx2 = rig.sent[0]!;
    expect(tx2.source).toBe(owner.publicKey());
    expect(tx2.signatures).toHaveLength(1);
    const inv2 = (tx2.operations[0] as unknown as { func: xdr.HostFunction }).func.invokeContract();
    expect(inv2.functionName().toString()).toBe('register_with_uri');
    expect(Address.fromScVal(inv2.args()[0]!).toString()).toBe(owner.publicKey());

    // tx 3 — set_agent_wallet(owner, agentId, agent), owner source, agent auth entry signed.
    const tx3 = rig.sent[1]!;
    expect(tx3.source).toBe(owner.publicKey());
    expect(tx3.signatures).toHaveLength(1);
    const op3 = tx3.operations[0] as unknown as { func: xdr.HostFunction; auth: xdr.SorobanAuthorizationEntry[] };
    const inv3 = op3.func.invokeContract();
    expect(inv3.functionName().toString()).toBe('set_agent_wallet');
    expect(Address.fromScVal(inv3.args()[0]!).toString()).toBe(owner.publicKey());
    expect(inv3.args()[1]!.u32()).toBe(42);
    expect(Address.fromScVal(inv3.args()[2]!).toString()).toBe(agent.publicKey());
    // The owner's entry (source-account credentials) is left alone; the agent's is signed.
    expect(op3.auth).toHaveLength(2);
    expect(op3.auth[0]!.credentials().switch().name).toBe('sorobanCredentialsSourceAccount');
    const creds = op3.auth[1]!.credentials().address();
    expect(Address.fromScAddress(creds.address()).toString()).toBe(agent.publicKey());
    expect(creds.signatureExpirationLedger()).toBe(1100);
    expect(creds.signature().switch().name).not.toBe('scvVoid');
    // Fees are realistic assembled Soroban fees.
    expect(Number(tx2.fee)).toBeGreaterThan(100_000);
    expect(Number(tx3.fee)).toBeGreaterThan(100_000);
  });

  it('tx 1 failure: nothing registered, nothing bound', async () => {
    const rig = ownerRig('account');
    await expect(createStellarAgent(ownerOpts(rig))).rejects.toThrow(/Horizon submit failed/);
    expect(rig.calls).toEqual(['horizon']);
    expect(rig.sent).toHaveLength(0);
  });

  it('tx 2 failure: nothing bound', async () => {
    const rig = ownerRig('register');
    await expect(createStellarAgent(ownerOpts(rig))).rejects.toThrow(/register_with_uri simulation failed/);
    expect(rig.sent).toHaveLength(0);
    expect(rig.calls).not.toContain('prepare');
  });

  it('a bind failure surfaces after registration, carrying the partial result', async () => {
    const rig = ownerRig('bind');
    const err = (await createStellarAgent(ownerOpts(rig)).catch((e) => e)) as Error & { partial?: PartialOwnedAgent };
    expect(err.message).toMatch(/bind rejected/);
    expect(rig.sent).toHaveLength(1);
    expect(err.partial).toEqual({
      publicKey: agent.publicKey(),
      secret: agent.secret(),
      owner: owner.publicKey(),
      agentId: '42',
      txs: { account: 'a'.repeat(64), register: 'b'.repeat(64) },
    });
  });

  it('a register failure after tx 1 carries the created account', async () => {
    const rig = ownerRig('register');
    const err = (await createStellarAgent(ownerOpts(rig)).catch((e) => e)) as Error & { partial?: PartialOwnedAgent };
    expect(err.partial).toMatchObject({ secret: agent.secret(), txs: { account: 'a'.repeat(64) } });
    expect(err.partial!.agentId).toBeUndefined();
  });

  it('a tx 1 failure carries no partial (nothing exists yet)', async () => {
    const err = (await createStellarAgent(ownerOpts(ownerRig('account'))).catch((e) => e)) as Error & { partial?: unknown };
    expect(err.partial).toBeUndefined();
  });

  it('each tx gets the next sequence, including the final bind after the discarded simulation build', async () => {
    const rig = ownerRig();
    await createStellarAgent(ownerOpts(rig));
    const tx1 = rig.submitted[0]!;
    const tx2 = rig.sent[0]!;
    const tx3 = rig.sent[1]!;
    expect(BigInt(tx2.sequence)).toBe(BigInt(tx1.sequence) + 1n);
    expect(BigInt(tx3.sequence)).toBe(BigInt(tx2.sequence) + 1n);
  });

  it('binds the agentId the executed tx returned, not the simulated one', async () => {
    const rig = ownerRig();
    rig.executedId = 43;
    const res = await createStellarAgent(ownerOpts(rig));
    expect(res.agentId).toBe('43');
    const inv3 = (rig.sent[1]!.operations[0] as unknown as { func: xdr.HostFunction }).func.invokeContract();
    expect(inv3.args()[1]!.u32()).toBe(43);
  });

  it('wallet-signed txs get a timebound long enough for a human approval', async () => {
    const rig = ownerRig();
    await createStellarAgent(ownerOpts(rig));
    for (const tx of [rig.submitted[0]!, rig.sent[0]!, rig.sent[1]!]) {
      const tb = tx.timeBounds!;
      expect(Number(tb.maxTime) - Number(tb.minTime)).toBeGreaterThanOrEqual(300);
    }
  });

  it('rejects sponsorSecret + owner together, or neither, before any network call', async () => {
    const rig = ownerRig();
    const base = { network: 'stellar:testnet' as const, agentUri: 'x', identityRegistry: REGISTRY, keypair: agent, horizonSubmit: rig.horizonSubmit, soroban: rig.seam };
    await expect(
      createStellarAgent({ ...base, owner: ownerSigner(owner), sponsorSecret: sponsor.secret() } as never),
    ).rejects.toThrow(/exactly one/);
    await expect(createStellarAgent(base as never)).rejects.toThrow(/exactly one/);
    expect(rig.calls).toEqual([]);
  });
});

// ── owner mode: error paths and edge cases ──────────────────────────────────
type Failing = Error & { partial?: PartialOwnedAgent };
const run = (rig: OwnerRig, signer?: StellarSigner) => createStellarAgent(ownerOpts(rig, signer)).catch((e) => e as Failing);

/** A signer that delegates to the real one but replaces the nth signing call (1-based). */
const signerWith = (nth: number, replace: (x: string, passphrase: string) => Promise<string>, log?: string[]): StellarSigner => {
  const real = ownerSigner(owner, log);
  let n = 0;
  return {
    publicKey: real.publicKey,
    signTransaction: (x, passphrase) => (++n === nth ? replace(x, passphrase) : real.signTransaction(x, passphrase)),
  };
};
const rejectWith = (msg: unknown) => async () => {
  throw msg;
};

describe('createStellarAgent owner mode: signer failures', () => {
  it('signer rejects at step 1: nothing submitted, no partial, nothing after', async () => {
    const rig = ownerRig();
    const err = await run(rig, signerWith(1, rejectWith(new Error('User declined access'))));
    expect(err.message).toBe('User declined access');
    expect(err.partial).toBeUndefined();
    expect(rig.calls).toEqual([]);
  });

  it('signer rejects at step 2: account exists, nothing registered or bound', async () => {
    const rig = ownerRig();
    const err = await run(rig, signerWith(2, rejectWith(new Error('User declined'))));
    expect(err.message).toBe('User declined');
    expect(rig.submitted).toHaveLength(1);
    expect(rig.sent).toHaveLength(0);
    expect(err.partial).toEqual({
      publicKey: agent.publicKey(),
      secret: agent.secret(),
      owner: owner.publicKey(),
      txs: { account: 'a'.repeat(64) },
    });
  });

  it('signer rejects at step 3: registered but not bound, partial carries the agentId', async () => {
    const rig = ownerRig();
    const err = await run(rig, signerWith(3, rejectWith(new Error('User declined'))));
    expect(err.message).toBe('User declined');
    expect(rig.sent).toHaveLength(1);
    expect(err.partial).toEqual({
      publicKey: agent.publicKey(),
      secret: agent.secret(),
      owner: owner.publicKey(),
      agentId: '42',
      txs: { account: 'a'.repeat(64), register: 'b'.repeat(64) },
    });
  });

  it('a non-Error rejection is wrapped in an Error and still carries the partial', async () => {
    const rig = ownerRig();
    const err = await run(rig, signerWith(2, rejectWith('wallet closed')));
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('wallet closed');
    expect(err.partial!.txs).toEqual({ account: 'a'.repeat(64) });
  });

  it('hands the signer the network passphrase and the envelope of the tx being built', async () => {
    const rig = ownerRig();
    const seen: Array<{ passphrase: string; source: string; op: string }> = [];
    await run(rig, {
      publicKey: owner.publicKey(),
      async signTransaction(x, passphrase) {
        const tx = TransactionBuilder.fromXDR(x, passphrase) as Transaction;
        seen.push({ passphrase, source: tx.source, op: tx.operations[0]!.type });
        tx.sign(owner);
        return tx.toXDR();
      },
    });
    expect(seen.map((s) => s.passphrase)).toEqual([Networks.TESTNET, Networks.TESTNET, Networks.TESTNET]);
    expect(seen.every((s) => s.source === owner.publicKey())).toBe(true);
    expect(seen.map((s) => s.op)).toEqual(['beginSponsoringFutureReserves', 'invokeHostFunction', 'invokeHostFunction']);
  });

  const unsigned = async (x: string, passphrase: string) => (TransactionBuilder.fromXDR(x, passphrase) as Transaction).toXDR();

  it('an unsigned envelope is refused at each step before anything is submitted for it', async () => {
    for (const step of [1, 2, 3]) {
      const rig = ownerRig();
      const err = await run(rig, signerWith(step, unsigned));
      expect(err.message).toMatch(/unsigned transaction/);
      expect(rig.submitted.length + rig.sent.length).toBe(step - 1);
      expect(err.partial === undefined).toBe(step === 1);
    }
  });

  const wrongNetwork = async (x: string) => {
    // Signed for the public network: same body, signature over a different hash.
    const tx = TransactionBuilder.fromXDR(x, Networks.PUBLIC) as Transaction;
    tx.sign(owner);
    return tx.toXDR();
  };

  it('an envelope signed for the wrong network is refused at each step', async () => {
    for (const step of [1, 2, 3]) {
      const rig = ownerRig();
      const err = await run(rig, signerWith(step, wrongNetwork));
      expect(err.message).toMatch(/valid signature/);
      expect(rig.submitted.length + rig.sent.length).toBe(step - 1);
    }
  });

  it('a signature by someone other than the owner is refused', async () => {
    const rig = ownerRig();
    const stranger = Keypair.random();
    const err = await run(
      rig,
      signerWith(1, async (x, p) => {
        const tx = TransactionBuilder.fromXDR(x, p) as Transaction;
        tx.sign(stranger);
        return tx.toXDR();
      }),
    );
    expect(err.message).toMatch(/valid signature/);
    expect(rig.submitted).toHaveLength(0);
  });

  const differentTx = async (_x: string, passphrase: string) => {
    // A validly owner-signed transaction, but not the one that was asked for.
    const other = new TransactionBuilder(new Account(owner.publicKey(), '999'), { fee: BASE_FEE, networkPassphrase: passphrase })
      .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: '1' }))
      .setTimeout(300)
      .build();
    other.sign(owner);
    return other.toXDR();
  };

  it('a different, validly signed transaction is refused at each step', async () => {
    for (const step of [1, 2, 3]) {
      const rig = ownerRig();
      const err = await run(rig, signerWith(step, differentTx));
      expect(err.message).toMatch(/different transaction/);
      expect(rig.submitted.length + rig.sent.length).toBe(step - 1);
    }
  });

  it('a different transaction at step 3 never gets the agent signature or reaches send', async () => {
    const rig = ownerRig();
    const err = await run(rig, signerWith(3, differentTx));
    expect(err.message).toMatch(/different transaction/);
    expect(rig.sent).toHaveLength(1);
    expect(err.partial!.txs.bind).toBeUndefined();
  });

  it('garbage XDR from the signer fails with the partial attached', async () => {
    const rig = ownerRig();
    const err = await run(rig, signerWith(2, async () => 'not-xdr'));
    expect(err).toBeInstanceOf(Error);
    expect(err.partial!.txs).toEqual({ account: 'a'.repeat(64) });
  });
});

describe('createStellarAgent owner mode: simulation and chain failures', () => {
  it('missing seam methods throw before any network call', async () => {
    for (const drop of ['prepare', 'latestLedger', 'confirm'] as const) {
      const rig = ownerRig();
      const seam = { ...rig.seam, [drop]: undefined } as SorobanSeam;
      const err = await createStellarAgent({ ...ownerOpts(rig), soroban: seam }).catch((e) => e as Failing);
      expect(err.message).toMatch(/owner mode needs soroban\.prepare, latestLedger and confirm/);
      expect(rig.calls).toEqual([]);
    }
  });

  it('first set_agent_wallet simulation fails: nothing bound, partial carries the registration', async () => {
    const rig = ownerRig();
    rig.seam.prepare = async () => {
      throw new Error('simulation failed: HostError');
    };
    const err = await run(rig);
    expect(err.message).toMatch(/simulation failed/);
    expect(rig.sent).toHaveLength(1);
    expect(err.partial!.agentId).toBe('42');
    expect(err.partial!.txs.bind).toBeUndefined();
  });

  it('re-simulation with the signed entry fails: nothing bound', async () => {
    const rig = ownerRig();
    const real = rig.seam.prepare!;
    let n = 0;
    rig.seam.prepare = async (tx) => {
      if (++n === 2) throw new Error('simulation failed: bad auth');
      return real(tx);
    };
    const err = await run(rig);
    expect(err.message).toMatch(/bad auth/);
    expect(rig.sent).toHaveLength(1);
    expect(err.partial!.txs.bind).toBeUndefined();
  });

  it('latestLedger failure stops before signing any auth entry', async () => {
    const rig = ownerRig();
    rig.seam.latestLedger = async () => {
      throw new Error('rpc down');
    };
    const err = await run(rig);
    expect(err.message).toBe('rpc down');
    expect(rig.sent).toHaveLength(1);
    expect(err.partial!.agentId).toBe('42');
  });

  it('simulation returns no auth entries at all: refused, nothing bound', async () => {
    const rig = ownerRig();
    const real = rig.seam.prepare!;
    rig.seam.prepare = async (tx) => ({ prepared: (await real(tx)).prepared, auth: [] });
    const err = await run(rig);
    expect(err.message).toMatch(/no auth entry for the agent/);
    expect(rig.sent).toHaveLength(1);
    expect(err.partial!.txs.bind).toBeUndefined();
  });

  it('simulation returns only the owner entry: refused, nothing bound', async () => {
    const rig = ownerRig();
    const real = rig.seam.prepare!;
    rig.seam.prepare = async (tx) => ({
      prepared: (await real(tx)).prepared,
      auth: [simAuthEntry(owner.publicKey(), 'set_agent_wallet', true, callArgs(tx))],
    });
    const err = await run(rig);
    expect(err.message).toMatch(/no auth entry for the agent/);
    expect(rig.sent).toHaveLength(1);
  });

  it('an entry for some other address is neither signed nor mistaken for the agent', async () => {
    const rig = ownerRig();
    const other = Keypair.random();
    const real = rig.seam.prepare!;
    rig.seam.prepare = async (tx) => {
      const r = await real(tx);
      return { prepared: r.prepared, auth: r.auth.length ? [simAuthEntry(other.publicKey(), 'set_agent_wallet', false, callArgs(tx)), ...r.auth] : [] };
    };
    await run(rig);
    const op3 = rig.sent[1]!.operations[0] as unknown as { auth: xdr.SorobanAuthorizationEntry[] };
    expect(op3.auth).toHaveLength(3);
    expect(op3.auth[0]!.credentials().address().signature().switch().name).toBe('scvVoid');
    expect(op3.auth[1]!.credentials().switch().name).toBe('sorobanCredentialsSourceAccount');
    expect(op3.auth[2]!.credentials().address().signature().switch().name).not.toBe('scvVoid');
  });

  /** The first set_agent_wallet simulation returns `entries(args)` in place of the honest ones. */
  const hostileBind = async (entries: (args: xdr.ScVal[]) => xdr.SorobanAuthorizationEntry[]) => {
    const rig = ownerRig();
    const real = rig.seam.prepare!;
    let ledgerReads = 0;
    rig.seam.latestLedger = async () => {
      ledgerReads++;
      return 1000;
    };
    rig.seam.prepare = async (tx) => {
      const r = await real(tx);
      return { prepared: r.prepared, auth: r.auth.length ? entries(callArgs(tx)) : [] };
    };
    const err = await run(rig);
    expect(err.message).toBe('agentenact: set_agent_wallet simulation returned an auth entry for a different invocation');
    // Refused before the auth expiry is read, so before the agent key signs anything; no re-simulation, no bind send.
    expect(ledgerReads).toBe(0);
    expect(rig.calls.filter((k) => k === 'prepare')).toHaveLength(1);
    expect(rig.sent).toHaveLength(1);
    expect(err.partial!.agentId).toBe('42');
    expect(err.partial!.txs.bind).toBeUndefined();
  };
  const ownerEntry = (args: xdr.ScVal[]) => simAuthEntry(owner.publicKey(), 'set_agent_wallet', true, args);

  it('an agent entry for a different function is refused before the agent signs', async () => {
    await hostileBind((args) => [ownerEntry(args), simAuthEntry(agent.publicKey(), 'register_with_uri', false, args)]);
  });

  it('an agent entry with different args is refused before the agent signs', async () => {
    await hostileBind((args) => {
      const otherId = [args[0]!, nativeToScVal(7, { type: 'u32' }), args[2]!];
      return [ownerEntry(args), simAuthEntry(agent.publicKey(), 'set_agent_wallet', false, otherId)];
    });
  });

  it('an agent entry with sub-invocations is refused before the agent signs', async () => {
    const sub = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(REGISTRY).toScAddress(),
          functionName: 'transfer',
          args: [],
        }),
      ),
      subInvocations: [],
    });
    await hostileBind((args) => [ownerEntry(args), simAuthEntry(agent.publicKey(), 'set_agent_wallet', false, args, [sub])]);
  });

  it('a source-account entry for a different call is refused before anything is signed', async () => {
    await hostileBind((args) => [
      simAuthEntry(owner.publicKey(), 'register_with_uri', true, args),
      simAuthEntry(agent.publicKey(), 'set_agent_wallet', false, args),
    ]);
  });

  it('the agent auth entry signature verifies against the agent key and the network', async () => {
    const rig = ownerRig();
    await run(rig);
    const op3 = rig.sent[1]!.operations[0] as unknown as { auth: xdr.SorobanAuthorizationEntry[] };
    const creds = op3.auth[1]!.credentials().address();
    // Payload authorizeEntry signs: hash(HashIdPreimage.envelopeTypeSorobanAuthorization).
    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId: hash(Buffer.from(Networks.TESTNET)),
        nonce: creds.nonce(),
        signatureExpirationLedger: creds.signatureExpirationLedger(),
        invocation: op3.auth[1]!.rootInvocation(),
      }),
    );
    const sig = creds.signature().vec()![0]!.map()!;
    const byKey = Object.fromEntries(sig.map((e) => [e.key().sym().toString(), e.val()]));
    expect(Address.fromScVal(nativeToScVal(agent.publicKey(), { type: 'address' })).toString()).toBe(agent.publicKey());
    expect(agent.verify(hash(preimage.toXDR()), byKey.signature!.bytes())).toBe(true);
    expect(byKey.public_key!.bytes().equals(agent.rawPublicKey())).toBe(true);
  });

  it('register send fails: nothing confirmed, nothing bound, partial has no register hash', async () => {
    const rig = ownerRig();
    rig.seam.send = async () => {
      throw new Error('sendTransaction error: tx_bad_seq');
    };
    const err = await run(rig);
    expect(err.message).toMatch(/tx_bad_seq/);
    expect(err.partial!.txs).toEqual({ account: 'a'.repeat(64) });
    expect(rig.calls).not.toContain('confirm');
  });

  it('register lands but confirm fails: partial has the register hash but no agentId, no bind', async () => {
    const rig = ownerRig();
    rig.seam.confirm = async (hash) => {
      throw new Error(`transaction ${hash} did not succeed: FAILED`);
    };
    const err = await run(rig);
    expect(err.message).toMatch(/did not succeed/);
    expect(err.partial!.txs).toEqual({ account: 'a'.repeat(64), register: 'b'.repeat(64) });
    expect(err.partial!.agentId).toBeUndefined();
    expect(rig.sent).toHaveLength(1);
  });

  it('bind is sent but confirm fails: partial carries the bind hash', async () => {
    const rig = ownerRig();
    const real = rig.seam.confirm!;
    let n = 0;
    rig.seam.confirm = async (hash) => {
      if (++n === 2) throw new Error(`transaction ${hash} did not succeed: FAILED`);
      return real(hash);
    };
    const err = await run(rig);
    expect(err.message).toMatch(/did not succeed/);
    expect(err.partial).toMatchObject({ agentId: '42', txs: { account: 'a'.repeat(64), register: 'b'.repeat(64), bind: 'c'.repeat(64) } });
  });

  it('confirm is called for the register hash and then the bind hash, in that order', async () => {
    const rig = ownerRig();
    const hashes: string[] = [];
    const real = rig.seam.confirm!;
    rig.seam.confirm = async (h) => {
      hashes.push(h);
      return real(h);
    };
    await run(rig);
    expect(hashes).toEqual(['b'.repeat(64), 'c'.repeat(64)]);
  });
});

describe('createStellarAgent owner mode: agentId handling', () => {
  it('uses the simulated id when the executed tx returns no value', async () => {
    const rig = ownerRig();
    const res = await run(rig);
    expect((res as unknown as { agentId: string }).agentId).toBe('42');
  });

  for (const [label, simulated, executed] of [
    ['an empty simulated id and no executed value', '', undefined],
    ['a non-numeric simulated id and no executed value', 'abc', undefined],
    ['a void executed value', '42', xdr.ScVal.scvVoid()],
    ['a non-numeric executed value', '42', nativeToScVal('nope', { type: 'string' })],
    ['a negative executed id', '42', nativeToScVal(-1, { type: 'i32' })],
    ['an id beyond u32', '42', nativeToScVal(2n ** 40n, { type: 'u64' })],
  ] as const) {
    it(`refuses to bind on ${label}`, async () => {
      const rig = ownerRig();
      const real = rig.seam.register;
      rig.seam.register = async (inner) => ({ ...(await real(inner)), agentId: simulated });
      rig.seam.confirm = async () => executed;
      const err = await run(rig);
      expect(err.message).toMatch(/agentId/);
      expect(rig.sent).toHaveLength(1);
      expect(err.partial!.agentId).toBeUndefined();
      expect(err.partial!.txs.register).toBe('b'.repeat(64));
    });
  }

  it('accepts id 0 and the u32 maximum', async () => {
    for (const id of [0, 4294967295]) {
      const rig = ownerRig();
      rig.executedId = id;
      const res = (await run(rig)) as unknown as { agentId: string };
      expect(res.agentId).toBe(String(id));
    }
  });
});

describe('createStellarAgent keypair seam', () => {
  it('without a keypair a fresh one is generated per call, and the returned secret is the one that signed', async () => {
    const opts = (rig: OwnerRig) => ({ ...ownerOpts(rig), keypair: undefined });
    const rig1 = ownerRig();
    const rig2 = ownerRig();
    const a = await createStellarAgent(opts(rig1));
    const b = await createStellarAgent(opts(rig2));
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.publicKey).not.toBe(agent.publicKey());
    expect(Keypair.fromSecret(a.secret).publicKey()).toBe(a.publicKey);
    const kp = Keypair.fromSecret(a.secret);
    const tx1 = rig1.submitted[0]!;
    expect((tx1.operations[0] as { sponsoredId: string }).sponsoredId).toBe(a.publicKey);
    expect(tx1.signatures[1]!.hint().equals(kp.signatureHint())).toBe(true);
    const inv3 = (rig1.sent[1]!.operations[0] as unknown as { func: xdr.HostFunction }).func.invokeContract();
    expect(Address.fromScVal(inv3.args()[2]!).toString()).toBe(a.publicKey);
  });

  it('a supplied keypair is used for the account, the bind argument and the auth entry', async () => {
    const rig = ownerRig();
    const kp = Keypair.random();
    const res = await createStellarAgent({ ...ownerOpts(rig), keypair: kp });
    expect(res.publicKey).toBe(kp.publicKey());
    expect(res.secret).toBe(kp.secret());
    const op3 = rig.sent[1]!.operations[0] as unknown as { auth: xdr.SorobanAuthorizationEntry[] };
    expect(op3.auth).toHaveLength(2);
    expect(Address.fromScAddress(op3.auth[1]!.credentials().address().address()).toString()).toBe(kp.publicKey());
  });

  it('the secret never reaches the signer, the seams or the submitted XDR', async () => {
    const rig = ownerRig();
    const wire: string[] = [];
    const signer: StellarSigner = {
      publicKey: owner.publicKey(),
      async signTransaction(x, p) {
        wire.push(x);
        return ownerSigner(owner).signTransaction(x, p);
      },
    };
    await run(rig, signer);
    for (const x of [...wire, ...rig.submitted.map((t) => t.toXDR()), ...rig.sent.map((t) => t.toXDR())]) {
      expect(x.includes(agent.secret())).toBe(false);
      expect(Buffer.from(x, 'base64').includes(Buffer.from(agent.rawSecretKey()))).toBe(false);
    }
  });
});

describe('createStellarAgent sponsor mode stays unchanged', () => {
  const sponsorSeam = (over: Partial<SorobanSeam> = {}): SorobanSeam => ({
    getAccount: async (id) => new Account(id, '7'),
    register: async (inner) => {
      const sorobanData = new SorobanDataBuilder().setResourceFee(RESOURCE_FEE).build();
      return { agentId: '42', prepared: TransactionBuilder.cloneFrom(inner, { fee: inner.fee, sorobanData }).build() };
    },
    send: async () => ({ hash: 'b'.repeat(64) }),
    ...over,
  });
  const sponsorOpts = (soroban: SorobanSeam, horizonSubmit = async () => ({ hash: 'a'.repeat(64) })) => ({
    network: 'stellar:testnet' as const,
    sponsorSecret: sponsor.secret(),
    agentUri: 'x',
    identityRegistry: REGISTRY,
    keypair: agent,
    horizonSubmit,
    soroban,
  });

  it('never calls the owner-only seam methods and returns no owner or bind', async () => {
    const touched: string[] = [];
    const seam = sponsorSeam({
      prepare: async () => (touched.push('prepare'), null as never),
      latestLedger: async () => (touched.push('latestLedger'), 0),
      confirm: async () => (touched.push('confirm'), undefined),
    });
    const res = await createStellarAgent(sponsorOpts(seam));
    expect(touched).toEqual([]);
    expect(res).not.toHaveProperty('owner');
    expect(Object.keys(res.txs)).toEqual(['account', 'register']);
  });

  it('tx 1 failure: nothing registered, the error carries no partial', async () => {
    const calls: string[] = [];
    const err = (await createStellarAgent(
      sponsorOpts(sponsorSeam({ register: async () => (calls.push('register'), null as never) }), async () => {
        throw new Error('Horizon submit failed: 400');
      }),
    ).catch((e) => e)) as Failing;
    expect(err.message).toMatch(/Horizon submit failed/);
    expect(calls).toEqual([]);
    expect(err.partial).toBeUndefined();
  });

  it('register failure: nothing sent, the error carries no partial', async () => {
    const sent: unknown[] = [];
    const err = (await createStellarAgent(
      sponsorOpts(
        sponsorSeam({
          register: async () => {
            throw new Error('register_with_uri simulation failed: boom');
          },
          send: async (t) => (sent.push(t), { hash: 'b'.repeat(64) }),
        }),
      ),
    ).catch((e) => e)) as Failing;
    expect(err.message).toMatch(/simulation failed/);
    expect(sent).toHaveLength(0);
    expect(err.partial).toBeUndefined();
  });

  it('sponsor mode passes the simulated agentId through as-is (owner-mode validation does not apply)', async () => {
    const res = await createStellarAgent(sponsorOpts(sponsorSeam({ register: async (inner) => ({ ...(await sponsorSeam().register(inner)), agentId: 'abc' }) })));
    expect(res.agentId).toBe('abc');
  });

  it('without a keypair it generates one and the returned secret matches the account it created', async () => {
    const submitted: Transaction[] = [];
    const res = await createStellarAgent({
      ...sponsorOpts(sponsorSeam()),
      keypair: undefined,
      horizonSubmit: async (x) => (submitted.push(TransactionBuilder.fromXDR(x, Networks.TESTNET) as Transaction), { hash: 'a'.repeat(64) }),
    });
    expect(Keypair.fromSecret(res.secret).publicKey()).toBe(res.publicKey);
    expect((submitted[0]!.operations[1] as { destination: string }).destination).toBe(res.publicKey);
  });

  it('rejects an unknown network before any network call', async () => {
    const calls: string[] = [];
    const seam = sponsorSeam({ getAccount: async (id) => (calls.push('getAccount'), new Account(id, '7')) });
    await expect(createStellarAgent({ ...sponsorOpts(seam), network: 'stellar:nope' as never })).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
