import { beforeAll, describe, expect, it } from 'bun:test';
import { Keypair, TransactionBuilder, authorizeEntry, xdr } from '@stellar/stellar-sdk';
import { createStellarAgent, type StellarAuthSigner, type StellarSigner } from '../../src/create.js';
import { createStellarAdapter } from '../../src/adapters/stellar.js';

// Opt-in, testnet only, no secrets on disk:
//   AGENTENACT_TESTNET=1 bun test tests/e2e/create-auth-owner.testnet.test.ts
const live = process.env.AGENTENACT_TESTNET === '1';

const friendbot = async (pub: string) => {
  const r = await fetch(`https://friendbot.stellar.org/?addr=${pub}`);
  if (!r.ok) throw new Error(`friendbot ${r.status}`);
};

describe.skipIf(!live)('auth-entry owner + sponsor on Stellar testnet', () => {
  let sponsorKp: Keypair;
  let ownerKp: Keypair;

  beforeAll(async () => {
    sponsorKp = Keypair.random();
    ownerKp = Keypair.random();
    // A classic account can only authorise if it exists on ledger, so the owner is funded too;
    // it still never sources, signs or pays for a transaction.
    await friendbot(sponsorKp.publicKey());
    await friendbot(ownerKp.publicKey());
  }, 60_000);

  it('registers and binds with the owner signing auth entries only; the registry reads back owner + agent', async () => {
    const sponsor: StellarSigner = {
      publicKey: sponsorKp.publicKey(),
      async signTransaction(x, p) {
        const tx = TransactionBuilder.fromXDR(x, p);
        tx.sign(sponsorKp);
        return tx.toXDR();
      },
    };
    const owner: StellarAuthSigner = {
      address: ownerKp.publicKey(),
      async signAuthEntry(e, validUntil, p) {
        const signed = await authorizeEntry(xdr.SorobanAuthorizationEntry.fromXDR(e, 'base64'), ownerKp, validUntil, p);
        return signed.toXDR('base64');
      },
    };
    const out = await createStellarAgent({
      network: 'stellar:testnet',
      owner,
      sponsor,
      agentUri: 'https://agentenact.io/a/e2e/agent.json',
    });
    expect(out.owner).toBe(ownerKp.publicKey());
    expect(out.txs.bind).toMatch(/^[0-9a-f]{64}$/);
    const binding = await createStellarAdapter({ network: 'testnet' }).resolveIdentity(out.agentId);
    expect(binding).toEqual({ owner: ownerKp.publicKey(), wallet: out.publicKey });
  }, 180_000);
  it('resume: a second call with the same key and the bound agentId sends nothing and reads back the same identity', async () => {
    const sponsor: StellarSigner = {
      publicKey: sponsorKp.publicKey(),
      async signTransaction(x, p) {
        const tx = TransactionBuilder.fromXDR(x, p);
        tx.sign(sponsorKp);
        return tx.toXDR();
      },
    };
    const owner: StellarAuthSigner = {
      address: ownerKp.publicKey(),
      async signAuthEntry(e, validUntil, p) {
        const signed = await authorizeEntry(xdr.SorobanAuthorizationEntry.fromXDR(e, 'base64'), ownerKp, validUntil, p);
        return signed.toXDR('base64');
      },
    };
    const keypair = Keypair.random();
    const first = await createStellarAgent({ network: 'stellar:testnet', owner, sponsor, agentUri: 'https://agentenact.io/a/e2e-resume/agent.json', keypair });
    await new Promise((r) => setTimeout(r, 3000)); // let the RPC's view catch up with the confirmed bind
    const again = await createStellarAgent({
      network: 'stellar:testnet',
      owner,
      sponsor,
      agentUri: 'https://agentenact.io/a/e2e-resume/agent.json',
      keypair,
      resume: { account: true, agentId: first.agentId },
    });
    expect(again.agentId).toBe(first.agentId);
    expect(again.txs).toEqual({});
  }, 180_000);

  it('resume after the owner refused the bind: skips tx 1 and tx 2, binds only', async () => {
    const sponsor: StellarSigner = {
      publicKey: sponsorKp.publicKey(),
      async signTransaction(x, p) {
        const tx = TransactionBuilder.fromXDR(x, p);
        tx.sign(sponsorKp);
        return tx.toXDR();
      },
    };
    const sign = async (e: string, validUntil: number, p: string) =>
      (await authorizeEntry(xdr.SorobanAuthorizationEntry.fromXDR(e, 'base64'), ownerKp, validUntil, p)).toXDR('base64');
    const refusing: StellarAuthSigner = {
      address: ownerKp.publicKey(),
      async signAuthEntry(e, v, p) {
        const fn = xdr.SorobanAuthorizationEntry.fromXDR(e, 'base64').rootInvocation().function().contractFn().functionName().toString();
        if (fn === 'set_agent_wallet') throw new Error('owner did not approve');
        return sign(e, v, p);
      },
    };
    const keypair = Keypair.random();
    const base = { network: 'stellar:testnet' as const, sponsor, agentUri: 'https://agentenact.io/a/e2e-resume2/agent.json', keypair };
    const failed = (await createStellarAgent({ ...base, owner: refusing }).catch((e) => e)) as Error & {
      partial?: { agentId?: string; txs: { account?: string; register?: string; bind?: string } };
    };
    expect(failed.partial?.agentId).toMatch(/^\d+$/);
    expect(failed.partial?.txs.bind).toBeUndefined();

    const out = await createStellarAgent({
      ...base,
      owner: { address: ownerKp.publicKey(), signAuthEntry: sign },
      resume: { account: true, agentId: failed.partial!.agentId },
    });
    expect(out.agentId).toBe(failed.partial!.agentId!);
    expect(Object.keys(out.txs)).toEqual(['bind']);
    const binding = await createStellarAdapter({ network: 'testnet' }).resolveIdentity(out.agentId);
    expect(binding).toEqual({ owner: ownerKp.publicKey(), wallet: keypair.publicKey() });
  }, 240_000);
});
