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
  type SorobanSeam,
  type StellarAuthSigner,
  type StellarSigner,
} from '../src/create.js';

const REGISTRY = 'CBGPDCJIHQ32G42BE7F2CIT3YW6XRN5ED6GQJHCRZSNAYH6TGMCL6X35';
const USDC_TESTNET_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const sponsor = Keypair.random();
const agent = Keypair.random();
const ownerC = StrKey.encodeContract(Buffer.alloc(32, 7));
const otherC = StrKey.encodeContract(Buffer.alloc(32, 9));

type Failing = Error & { partial?: PartialOwnedAgent; code?: string };

const sponsorSigner = (kp: Keypair): StellarSigner => ({
  publicKey: kp.publicKey(),
  async signTransaction(x, passphrase) {
    const tx = TransactionBuilder.fromXDR(x, passphrase);
    tx.sign(kp);
    return tx.toXDR();
  },
});

const ownerAuth = (): StellarAuthSigner => ({
  address: ownerC,
  async signAuthEntry(entryXdr, validUntil) {
    const e = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, 'base64');
    const creds = e.credentials().address();
    creds.signatureExpirationLedger(validUntil);
    creds.signature(xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('passkey')]));
    return e.toXDR('base64');
  },
});

function entry(signer: string, fn: string, source: boolean, args: xdr.ScVal[]): xdr.SorobanAuthorizationEntry {
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
      subInvocations: [],
    }),
  });
}

const op = (tx: Transaction) => (tx.operations[0] as unknown as { func: xdr.HostFunction }).func.invokeContract();
const fnOf = (tx: Transaction) => op(tx).functionName().toString();
const authOf = (tx: Transaction) => (tx.operations[0] as unknown as { auth?: xdr.SorobanAuthorizationEntry[] }).auth ?? [];

type Identity = { owner: string; wallet: string | null } | null;
type Balance = { asset_type: string; asset_code?: string; asset_issuer?: string; balance: string };

/** What Horizon returns for a sponsored agent: native balance 0, the USDC line. Optional fields absent on native. */
const usdcLine: Balance = { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_TESTNET_ISSUER, balance: '0.0000000' };
const nativeLine: Balance = { asset_type: 'native', balance: '0.0000000' };

interface Rig {
  calls: string[];
  submitted: Transaction[];
  sent: Transaction[];
  chainSeq: number;
  /** null = the agent account does not exist. */
  balances: Balance[] | null;
  identity: Identity;
  failBindSend?: boolean;
  seam: SorobanSeam;
  horizonSubmit: (x: string) => Promise<{ hash: string }>;
  horizonAccount: (id: string) => Promise<{ balances: Balance[] } | null>;
  readIdentity: (id: string) => Promise<Identity>;
}

function rig(over: Partial<Rig> = {}): Rig {
  const r: Rig = {
    calls: [], submitted: [], sent: [], chainSeq: 9, balances: [nativeLine, usdcLine], identity: null,
    seam: null as never, horizonSubmit: null as never, horizonAccount: null as never, readIdentity: null as never,
    ...over,
  };
  const assembled = (tx: Transaction) =>
    TransactionBuilder.cloneFrom(tx, { fee: tx.fee, sorobanData: new SorobanDataBuilder().setResourceFee(250_000).build() }).build();
  r.horizonSubmit = async (x) => {
    r.calls.push('horizon');
    r.submitted.push(TransactionBuilder.fromXDR(x, Networks.TESTNET) as Transaction);
    r.chainSeq++;
    return { hash: 'a'.repeat(64) };
  };
  r.horizonAccount = async (id) => {
    r.calls.push(`horizonAccount:${id === agent.publicKey() ? 'agent' : id}`);
    return r.balances ? { balances: r.balances } : null;
  };
  r.readIdentity = async (id) => {
    r.calls.push(`identity:${id}`);
    return r.identity;
  };
  r.seam = {
    getAccount: async (id) => new Account(id, String(r.chainSeq)),
    register: async () => {
      throw new Error('register() is sponsor-mode only');
    },
    latestLedger: async () => 5000,
    prepare: async (tx) => {
      const fn = fnOf(tx);
      r.calls.push(`prepare:${fn}`);
      const recording = authOf(tx).length === 0;
      const args = op(tx).args();
      const auth = !recording
        ? []
        : fn === 'register_with_uri'
          ? [entry(sponsor.publicKey(), fn, true, args), entry(ownerC, fn, false, args)]
          : [entry(ownerC, fn, false, args), entry(agent.publicKey(), fn, false, args)];
      return { prepared: assembled(tx), auth };
    },
    send: async (tx) => {
      const fn = fnOf(tx as Transaction);
      r.calls.push(`send:${fn}`);
      if (r.failBindSend && fn === 'set_agent_wallet') throw new Error('sendTransaction error: bind rejected');
      r.sent.push(tx as Transaction);
      r.chainSeq++;
      return { hash: (fn === 'register_with_uri' ? 'b' : 'c').repeat(64) };
    },
    confirm: async (hash) => {
      r.calls.push('confirm');
      return hash === 'b'.repeat(64) ? nativeToScVal(42, { type: 'u32' }) : undefined;
    },
  };
  return r;
}

const opts = (r: Rig, resume?: { account: true; agentId?: string }) => ({
  network: 'stellar:testnet' as const,
  owner: ownerAuth(),
  sponsor: sponsorSigner(sponsor),
  agentUri: 'https://agentenact.io/a/test/agent.json',
  identityRegistry: REGISTRY,
  keypair: agent,
  horizonSubmit: r.horizonSubmit,
  horizonAccount: r.horizonAccount,
  identity: r.readIdentity,
  soroban: r.seam,
  ...(resume ? { resume } : {}),
});

const run = (r: Rig, resume?: { account: true; agentId?: string }) => createStellarAgent(opts(r, resume)).catch((e) => e as Failing);
const noTx = (r: Rig) => {
  expect(r.submitted).toHaveLength(0);
  expect(r.sent).toHaveLength(0);
  expect(r.calls.some((c) => c === 'horizon' || c.startsWith('send:') || c.startsWith('prepare:'))).toBe(false);
};

describe('createStellarAgent auth-owner resume: account', () => {
  it('skips tx 1: no horizonSubmit, no createAccount op, registers and binds, txs carry only what happened', async () => {
    const r = rig();
    const out = await createStellarAgent(opts(r, { account: true }));
    expect(out).toEqual({
      publicKey: agent.publicKey(),
      secret: agent.secret(),
      agentId: '42',
      owner: ownerC,
      txs: { register: 'b'.repeat(64), bind: 'c'.repeat(64) },
    });
    expect(r.calls).toEqual([
      'horizonAccount:agent',
      'prepare:register_with_uri', 'prepare:register_with_uri', 'send:register_with_uri', 'confirm',
      'prepare:set_agent_wallet', 'prepare:set_agent_wallet', 'send:set_agent_wallet', 'confirm',
    ]);
    expect(r.submitted).toHaveLength(0);
    for (const tx of r.sent) expect(tx.operations.map((o) => o.type)).toEqual(['invokeHostFunction']);
  });

  it('a missing account throws resume_mismatch before any tx is built', async () => {
    const r = rig({ balances: null });
    const e = (await run(r, { account: true })) as Failing;
    expect(e.code).toBe('resume_mismatch');
    expect(e.partial).toBeUndefined();
    expect(r.calls).toEqual(['horizonAccount:agent']);
  });

  it('an account without the USDC trustline throws resume_mismatch before any tx', async () => {
    const r = rig({ balances: [nativeLine] });
    const e = (await run(r, { account: true })) as Failing;
    expect(e.code).toBe('resume_mismatch');
    noTx(r);
  });

  it('a trustline to another issuer or a native-only line does not count', async () => {
    const other = Keypair.random().publicKey();
    const r = rig({ balances: [nativeLine, { ...usdcLine, asset_issuer: other }, { ...usdcLine, asset_code: 'EURC' }] });
    const e = (await run(r, { account: true })) as Failing;
    expect(e.code).toBe('resume_mismatch');
    noTx(r);
  });

  it('a later failure carries publicKey, secret, owner and only this call\'s txs (no account hash)', async () => {
    const r = rig({ failBindSend: true });
    const e = (await run(r, { account: true })) as Failing;
    expect(e.partial).toEqual({
      publicKey: agent.publicKey(),
      secret: agent.secret(),
      owner: ownerC,
      agentId: '42',
      txs: { register: 'b'.repeat(64) },
    });
  });

  it('a register failure after a resumed account still carries the partial', async () => {
    const r = rig();
    r.seam.send = async () => {
      throw new Error('sendTransaction error: register rejected');
    };
    const e = (await run(r, { account: true })) as Failing;
    expect(e.partial).toEqual({ publicKey: agent.publicKey(), secret: agent.secret(), owner: ownerC, txs: {} });
  });
});

describe('createStellarAgent auth-owner resume: agentId', () => {
  it('owned by the owner, wallet unset: skips register, runs the bind only', async () => {
    const r = rig({ identity: { owner: ownerC, wallet: null } });
    const out = await createStellarAgent(opts(r, { account: true, agentId: '42' }));
    expect(out).toEqual({
      publicKey: agent.publicKey(),
      secret: agent.secret(),
      agentId: '42',
      owner: ownerC,
      txs: { bind: 'c'.repeat(64) },
    });
    expect(r.calls).toEqual([
      'horizonAccount:agent',
      'identity:42',
      'prepare:set_agent_wallet', 'prepare:set_agent_wallet', 'send:set_agent_wallet', 'confirm',
    ]);
    expect(r.submitted).toHaveLength(0);
  });

  it('wallet still defaulted to the owner (as a fresh registration leaves it) counts as unbound: bind only', async () => {
    const r = rig({ identity: { owner: ownerC, wallet: ownerC } });
    const out = await createStellarAgent(opts(r, { account: true, agentId: '42' }));
    expect(out.txs).toEqual({ bind: 'c'.repeat(64) });
    expect(r.calls).not.toContain('send:register_with_uri');
  });

  it('already bound to this key: success with zero txs, nothing signed', async () => {
    const r = rig({ identity: { owner: ownerC, wallet: agent.publicKey() } });
    const out = await createStellarAgent(opts(r, { account: true, agentId: '42' }));
    expect(out).toEqual({ publicKey: agent.publicKey(), secret: agent.secret(), agentId: '42', owner: ownerC, txs: {} });
    noTx(r);
  });

  it('a bind failure carries the resumed agentId and no register hash', async () => {
    const r = rig({ identity: { owner: ownerC, wallet: null }, failBindSend: true });
    const e = (await run(r, { account: true, agentId: '42' })) as Failing;
    expect(e.partial).toEqual({ publicKey: agent.publicKey(), secret: agent.secret(), owner: ownerC, agentId: '42', txs: {} });
  });

  it.each([
    ['missing identity', null],
    ['identity owned by someone else', { owner: otherC, wallet: null }],
    ['wallet bound to another key', { owner: ownerC, wallet: Keypair.random().publicKey() }],
  ] as [string, Identity][])('%s: resume_mismatch, no tx', async (_n, identity) => {
    const r = rig({ identity });
    const e = (await run(r, { account: true, agentId: '42' })) as Failing;
    expect(e.code).toBe('resume_mismatch');
    expect(e.partial).toBeUndefined();
    noTx(r);
  });

  it('a mismatching account stops before the registry is even read', async () => {
    const r = rig({ balances: null, identity: { owner: ownerC, wallet: null } });
    const e = (await run(r, { account: true, agentId: '42' })) as Failing;
    expect(e.code).toBe('resume_mismatch');
    expect(r.calls).toEqual(['horizonAccount:agent']);
  });

  it.each(['abc', '-1', '4294967296', '1.5', ''])('rejects the junk agentId %p before any read', async (id) => {
    const r = rig({ identity: { owner: ownerC, wallet: null } });
    const e = (await run(r, { account: true, agentId: id })) as Failing;
    expect(e).toBeInstanceOf(Error);
    expect(r.calls).toEqual([]);
  });

  it('agentId without account is refused before any read', async () => {
    const r = rig();
    const e = (await createStellarAgent({ ...opts(r), resume: { agentId: '42' } as never }).catch((x) => x)) as Failing;
    expect(e).toBeInstanceOf(Error);
    expect(r.calls).toEqual([]);
  });
});

describe('createStellarAgent auth-owner resume: failing reads', () => {
  it('a throwing horizonAccount read rejects with no tx and no registry read', async () => {
    const r = rig({ identity: { owner: ownerC, wallet: null } });
    r.horizonAccount = async () => {
      r.calls.push('horizonAccount:throws');
      throw new Error('Horizon account read failed: 503');
    };
    const e = (await run(r, { account: true, agentId: '42' })) as Failing;
    expect(e.message).toMatch(/503/);
    expect(e.code).toBeUndefined();
    expect(e.partial).toBeUndefined();
    expect(r.calls).toEqual(['horizonAccount:throws']);
    noTx(r);
  });

  it('a throwing identity read rejects with no tx sent', async () => {
    const r = rig();
    r.readIdentity = async (id) => {
      r.calls.push(`identity:${id}`);
      throw new Error('Stellar simulate find_owner failed: rpc down');
    };
    const e = (await run(r, { account: true, agentId: '42' })) as Failing;
    expect(e.message).toMatch(/rpc down/);
    expect(e.code).toBeUndefined();
    expect(e.partial).toBeUndefined();
    expect(r.calls).toEqual(['horizonAccount:agent', 'identity:42']);
    noTx(r);
  });
});

describe('createStellarAgent resume is auth-owner only', () => {
  it('sponsor mode with resume throws before any network call', async () => {
    const r = rig();
    const e = await createStellarAgent({
      network: 'stellar:testnet',
      sponsorSecret: sponsor.secret(),
      agentUri: 'https://x.test/a.json',
      identityRegistry: REGISTRY,
      keypair: agent,
      horizonSubmit: r.horizonSubmit,
      soroban: r.seam,
      resume: { account: true },
    } as never).catch((x) => x as Error);
    expect(e).toBeInstanceOf(Error);
    expect(String(e.message)).toMatch(/resume/);
    expect(r.calls).toEqual([]);
  });

  it('wallet-owner mode with resume throws before any network call', async () => {
    const r = rig();
    const e = await createStellarAgent({
      network: 'stellar:testnet',
      owner: sponsorSigner(sponsor),
      agentUri: 'https://x.test/a.json',
      identityRegistry: REGISTRY,
      keypair: agent,
      horizonSubmit: r.horizonSubmit,
      soroban: r.seam,
      resume: { account: true },
    } as never).catch((x) => x as Error);
    expect(e).toBeInstanceOf(Error);
    expect(String(e.message)).toMatch(/resume/);
    expect(r.calls).toEqual([]);
  });

  it('without resume the new seams are never touched', async () => {
    const r = rig();
    await createStellarAgent(opts(r));
    expect(r.calls.some((c) => c.startsWith('horizonAccount') || c.startsWith('identity'))).toBe(false);
    expect(r.submitted).toHaveLength(1);
  });
});
