import { describe, expect, it } from 'bun:test';
import { Keypair } from '@stellar/stellar-sdk';
import {
  canonicalJson,
  handleSigningDigest,
  signHandleChange,
  verifyHandleChange,
  parseCommunityTemplate,
  signCommunityTemplate,
  templateAnchorKey,
  templateHash,
  templateSigningDigest,
  verifyCommunityTemplate,
  type CommunityTemplate,
  type TemplateAnchorReader,
} from '../src/community.js';
import { recordDigest, sha256Hex } from '../src/record.js';
import { createStellarAdapter, createStellarTemplateAnchors, stellarSecretToBytes, templateAnchorOperation } from '../src/adapters/stellar.js';
import type { ChainAdapter } from '../src/adapter.js';
import { UNSIGNED } from './record.test.js';

const AUTHOR = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
const SECRET = stellarSecretToBytes(AUTHOR.secret());

/** The real Stellar adapter for sign/verify (offline); identity is faked, settlement never read. */
function adapter(identity: Record<string, { owner: string; wallet: string | null }> = {}): ChainAdapter {
  const real = createStellarAdapter({ network: 'testnet', fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch });
  return { ...real, async resolveIdentity(id) { return identity[id] ?? null; } };
}

const TEMPLATE: CommunityTemplate = {
  format: 'agentenact.template/1',
  slug: 'gas-spike',
  version: 1,
  title: 'Gas spike alert',
  summary: 'Emails you when network fees jump.',
  author: { network: 'stellar:testnet', address: AUTHOR.publicKey() },
  createdAt: '2026-10-27T21:00:00Z',
  kind: 'agentenact.draft/1',
  body: { name: 'Gas spike', spec: { triggers: [{ kind: 'condition', every_s: 300 }] }, params: [] },
};

const anchors = (held: Record<string, string>): TemplateAnchorReader => ({
  network: 'stellar:testnet',
  async readAnchor(address, slug) {
    return held[`${address}/${slug}`] ?? null;
  },
});

describe('canonicalJson', () => {
  it('sorts keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}');
  });
  it('refuses what JSON cannot carry exactly', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ a: undefined })).toThrow(/not JSON/);
    expect(() => canonicalJson(new Date())).toThrow(/not JSON/);
  });
});

describe('parseCommunityTemplate', () => {
  it('drops unknown keys, so they never change the hash', async () => {
    const extra = { ...TEMPLATE, note: 'ignored' };
    expect(parseCommunityTemplate(extra)).toEqual(TEMPLATE);
    expect(await templateHash(extra as CommunityTemplate)).toBe(await templateHash(TEMPLATE));
  });
  it('hash is independent of key order and changes with any byte of the body', async () => {
    const reordered = JSON.parse(JSON.stringify({ body: TEMPLATE.body, ...TEMPLATE }));
    expect(await templateHash(reordered)).toBe(await templateHash(TEMPLATE));
    expect(await templateHash({ ...TEMPLATE, body: { ...(TEMPLATE.body as object), name: 'Gas spikf' } })).not.toBe(await templateHash(TEMPLATE));
  });
  it.each([
    ['format', { format: 'agentenact.template/2' }],
    ['slug', { slug: 'Gas Spike' }],
    ['slug', { slug: 'x'.repeat(58) }],
    ['version', { version: 0 }],
    ['title', { title: '' }],
    ['author', { author: { network: 'bitcoin:main', address: 'x' } }],
    ['agentId', { author: { network: 'stellar:testnet', address: 'G', agentId: 'abc' } }],
    ['createdAt', { createdAt: '2026-10-27' }],
    ['name', { author: { network: 'stellar:testnet', address: 'G', name: 'Kerem' } }],
    ['name', { author: { network: 'stellar:testnet', address: 'G', name: 'kеrem' } }], // Cyrillic е
    ['name', { author: { network: 'stellar:testnet', address: 'G', name: 'ab' } }],
    ['name', { author: { network: 'stellar:testnet', address: 'G', name: '-kerem' } }],
    ['kind', { kind: 'draft' }],
  ])('refuses a bad %s', (_, patch) => {
    expect(() => parseCommunityTemplate({ ...TEMPLATE, ...patch })).toThrow();
  });
  it('keeps a valid author name, and the name is signed with the rest', async () => {
    const named = { ...TEMPLATE, author: { ...TEMPLATE.author, name: 'kerem_n' } };
    expect(parseCommunityTemplate(named).author.name).toBe('kerem_n');
    expect(await templateHash(named)).not.toBe(await templateHash(TEMPLATE));
  });
  it('refuses a document over 32 KiB', () => {
    expect(() => parseCommunityTemplate({ ...TEMPLATE, body: 'x'.repeat(33 * 1024) })).toThrow(/limit/);
  });
  it('the anchor key fits a Stellar data entry name for the longest slug', () => {
    expect(new TextEncoder().encode(templateAnchorKey('a'.repeat(57))).length).toBe(64);
  });
});

describe('signing', () => {
  it('signs a domain-separated digest, never the bare hash or a record digest', async () => {
    const { sha256 } = await signCommunityTemplate(TEMPLATE, SECRET, adapter());
    const digest = await sha256Hex(await templateSigningDigest(sha256));
    expect(digest).not.toBe(sha256);
    expect(digest).not.toBe(await sha256Hex(await recordDigest(UNSIGNED)));
  });
  it('refuses to sign for another chain', async () => {
    await expect(signCommunityTemplate({ ...TEMPLATE, author: { network: 'eip155:42220', address: '0xabc' } }, SECRET, adapter())).rejects.toThrow(/chain/);
  });
});

describe('verifyCommunityTemplate', () => {
  it('passes a signed template and reports its anchor', async () => {
    const { template, sha256 } = await signCommunityTemplate(TEMPLATE, SECRET, adapter());
    const v = await verifyCommunityTemplate(JSON.parse(JSON.stringify(template)), {
      adapter: adapter(),
      anchors: anchors({ [`${AUTHOR.publicKey()}/gas-spike`]: sha256 }),
    });
    expect(v).toMatchObject({ ok: true, sha256, anchor: 'anchored', identity: 'none' });
  });
  it('reports superseded, unanchored and unchecked', async () => {
    const { template } = await signCommunityTemplate(TEMPLATE, SECRET, adapter());
    const other = 'ab'.repeat(32);
    const at = (r?: TemplateAnchorReader) => verifyCommunityTemplate(template, { adapter: adapter(), anchors: r }).then((v) => (v.ok ? v.anchor : v));
    expect(await at(anchors({ [`${AUTHOR.publicKey()}/gas-spike`]: other }))).toBe('superseded');
    expect(await at(anchors({}))).toBe('unanchored');
    expect(await at(undefined)).toBe('unchecked');
    expect(await at({ network: 'stellar:testnet', readAnchor: () => Promise.reject(new Error('down')) })).toBe('unchecked');
    // a pubnet reader never answers for a testnet author: anchors are per network
    expect(await at({ network: 'stellar:pubnet', readAnchor: async () => 'ab'.repeat(32) })).toBe('unchecked');
  });
  it('fails a tampered body, a swapped author and a missing signature', async () => {
    const { template } = await signCommunityTemplate(TEMPLATE, SECRET, adapter());
    const tampered = await verifyCommunityTemplate({ ...template, title: 'Gas spike alert!' }, { adapter: adapter() });
    expect(tampered).toMatchObject({ ok: false, failure: { check: 'signature', reason: 'bad_signature' } });
    const swapped = await verifyCommunityTemplate({ ...template, author: { network: 'stellar:testnet', address: Keypair.random().publicKey() } }, { adapter: adapter() });
    expect(swapped).toMatchObject({ ok: false, failure: { check: 'signature', reason: 'bad_signature' } });
    const { sig: _sig, ...unsigned } = template;
    expect(await verifyCommunityTemplate(unsigned, { adapter: adapter() })).toMatchObject({ ok: false, sha256: null, failure: { check: 'format' } });
  });
  it('binds author.agentId only when the author owns the agent or is its wallet', async () => {
    const withId = { ...TEMPLATE, author: { ...TEMPLATE.author, agentId: '108' } };
    const { template } = await signCommunityTemplate(withId, SECRET, adapter());
    const me = AUTHOR.publicKey();
    const other = Keypair.random().publicKey();
    expect(await verifyCommunityTemplate(template, { adapter: adapter({ '108': { owner: other, wallet: me } }) })).toMatchObject({ ok: true, identity: 'bound' });
    expect(await verifyCommunityTemplate(template, { adapter: adapter({ '108': { owner: other, wallet: null } }) })).toMatchObject({ ok: false, failure: { check: 'identity', reason: 'not_owner_or_wallet' } });
    expect(await verifyCommunityTemplate(template, { adapter: adapter() })).toMatchObject({ ok: false, failure: { check: 'identity', reason: 'agent_not_found' } });
  });
  it('runs the index body check last, after the signature', async () => {
    const { template } = await signCommunityTemplate(TEMPLATE, SECRET, adapter());
    let calls = 0;
    const checkBody = (kind: string) => (calls++, kind === 'agentenact.draft/1' ? 'no condition code' : null);
    expect(await verifyCommunityTemplate(template, { adapter: adapter(), checkBody })).toMatchObject({ ok: false, failure: { check: 'body', reason: 'no condition code' } });
    await verifyCommunityTemplate({ ...template, title: 'tampered' }, { adapter: adapter(), checkBody });
    expect(calls).toBe(1);
  });
});

describe('stellar template anchors', () => {
  it('builds a manage_data op with the 32 raw hash bytes, and a removal', () => {
    const hash = 'cd'.repeat(32);
    const op = templateAnchorOperation('gas-spike', hash);
    const body = op.body().manageDataOp();
    expect(body.dataName().toString()).toBe('ae.tpl:gas-spike');
    expect(Buffer.from(body.dataValue()!).toString('hex')).toBe(hash);
    expect(templateAnchorOperation('gas-spike', null).body().manageDataOp().dataValue()).toBeNull();
  });
  it('reads the entry from a Horizon account (realistic shape: other data, other keys)', async () => {
    const hash = 'ef'.repeat(32);
    const account = {
      id: AUTHOR.publicKey(),
      sequence: '123',
      balances: [{ asset_type: 'native', balance: '9.9999900' }],
      data: { 'config.memo': Buffer.from('hi').toString('base64'), 'ae.tpl:gas-spike': Buffer.from(hash, 'hex').toString('base64'), 'ae.tpl:bad': Buffer.from('short').toString('base64') },
    };
    const urls: string[] = [];
    const fetchFake = (async (url: string) => {
      urls.push(url);
      return url.endsWith(AUTHOR.publicKey()) ? new Response(JSON.stringify(account)) : new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const r = createStellarTemplateAnchors({ network: 'testnet', fetch: fetchFake });
    expect(await r.readAnchor(AUTHOR.publicKey(), 'gas-spike')).toBe(hash);
    expect(await r.readAnchor(AUTHOR.publicKey(), 'missing')).toBeNull();
    expect(await r.readAnchor(AUTHOR.publicKey(), 'bad')).toBeNull();
    expect(await r.readAnchor(Keypair.random().publicKey(), 'gas-spike')).toBeNull();
    expect(await r.readAnchor('not-an-address', 'gas-spike')).toBeNull();
    expect(urls[0]).toBe(`https://horizon-testnet.stellar.org/accounts/${AUTHOR.publicKey()}`);
  });
  it('throws on a Horizon error instead of reporting "unanchored"', async () => {
    const r = createStellarTemplateAnchors({ fetch: (async () => new Response('', { status: 503 })) as unknown as typeof fetch });
    await expect(r.readAnchor(AUTHOR.publicKey(), 'gas-spike')).rejects.toThrow(/503/);
  });
});

describe('handle changes', () => {
  const change = { format: 'agentenact.handle/1' as const, network: 'stellar:testnet' as const, address: AUTHOR.publicKey(), name: 'kerem' as string | null, issuedAt: '2026-10-28T15:20:00Z' };

  it('a key signs its own handle, or drops it with null', async () => {
    const signed = await signHandleChange(change, SECRET, adapter());
    expect(await verifyHandleChange(JSON.parse(JSON.stringify({ ...signed, junk: 1 })), adapter())).toMatchObject({ ok: true, change: { name: 'kerem' } });
    const dropped = await signHandleChange({ ...change, name: null }, SECRET, adapter());
    expect(await verifyHandleChange(dropped, adapter())).toMatchObject({ ok: true, change: { name: null } });
  });

  it('fails a changed name, another address, a bad handle or a missing signature', async () => {
    const signed = await signHandleChange(change, SECRET, adapter());
    expect(await verifyHandleChange({ ...signed, name: 'mallory' }, adapter())).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await verifyHandleChange({ ...signed, address: Keypair.random().publicKey() }, adapter())).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await verifyHandleChange({ ...signed, issuedAt: '2026-10-28T15:21:00Z' }, adapter())).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await verifyHandleChange({ ...signed, name: 'Kerem' }, adapter())).toEqual({ ok: false, reason: 'malformed' });
    const { sig: _s, ...unsigned } = signed;
    expect(await verifyHandleChange(unsigned, adapter())).toEqual({ ok: false, reason: 'malformed' });
  });

  it('a handle signature never passes as a template signature', async () => {
    const digest = await sha256Hex(await handleSigningDigest(change));
    const { sha256 } = await signCommunityTemplate(TEMPLATE, SECRET, adapter());
    expect(digest).not.toBe(await sha256Hex(await templateSigningDigest(sha256)));
  });
});
