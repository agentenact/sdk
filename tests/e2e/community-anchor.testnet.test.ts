import { beforeAll, describe, expect, it } from 'bun:test';
import { Horizon, Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';
import { signCommunityTemplate, verifyCommunityTemplate, type CommunityTemplate } from '../../src/community.js';
import { createStellarAdapter, createStellarTemplateAnchors, stellarSecretToBytes, templateAnchorOperation } from '../../src/adapters/stellar.js';

const live = process.env.AGENTENACT_TESTNET === '1';
const HORIZON = 'https://horizon-testnet.stellar.org';

describe.skipIf(!live)('community template anchored on Stellar testnet (manage_data on the author account)', () => {
  let author: Keypair;
  const horizon = new Horizon.Server(HORIZON);

  const anchor = async (slug: string, hash: string | null) => {
    const account = await horizon.loadAccount(author.publicKey());
    const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: Networks.TESTNET })
      .addOperation(templateAnchorOperation(slug, hash))
      .setTimeout(60)
      .build();
    tx.sign(author);
    return (await horizon.submitTransaction(tx)).hash;
  };

  beforeAll(async () => {
    author = Keypair.random();
    const r = await fetch(`https://friendbot.stellar.org/?addr=${author.publicKey()}`);
    if (!r.ok) throw new Error(`friendbot ${r.status}`);
  }, 60_000);

  it('sign → anchor → verify reads "anchored"; a new version supersedes; removal unanchors', async () => {
    const adapter = createStellarAdapter({ network: 'testnet' });
    const anchors = createStellarTemplateAnchors({ network: 'testnet' });
    const v1: CommunityTemplate = {
      format: 'agentenact.template/1',
      slug: 'e2e-anchor',
      version: 1,
      title: 'E2E anchor',
      summary: 'Testnet anchor round trip.',
      author: { network: 'stellar:testnet', address: author.publicKey() },
      createdAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      kind: 'agentenact.draft/1',
      body: { name: 'E2E' },
    };
    const secret = stellarSecretToBytes(author.secret());
    const one = await signCommunityTemplate(v1, secret, adapter);
    const two = await signCommunityTemplate({ ...v1, version: 2 }, secret, adapter);

    expect(await verifyCommunityTemplate(one.template, { adapter, anchors })).toMatchObject({ ok: true, anchor: 'unanchored' });
    const txHash = await anchor('e2e-anchor', one.sha256);
    console.log(`anchored ${one.sha256} in tx ${txHash}`);
    expect(await verifyCommunityTemplate(one.template, { adapter, anchors })).toMatchObject({ ok: true, anchor: 'anchored' });

    await anchor('e2e-anchor', two.sha256);
    expect(await verifyCommunityTemplate(one.template, { adapter, anchors })).toMatchObject({ ok: true, anchor: 'superseded' });
    expect(await verifyCommunityTemplate(two.template, { adapter, anchors })).toMatchObject({ ok: true, anchor: 'anchored' });

    await anchor('e2e-anchor', null);
    expect(await verifyCommunityTemplate(two.template, { adapter, anchors })).toMatchObject({ ok: true, anchor: 'unanchored' });
  }, 90_000);
});
