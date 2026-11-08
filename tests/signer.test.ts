import { beforeAll, describe, expect, it } from 'bun:test';
import { Address, Keypair, Networks, authorizeEntry, hash, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { verifyTypedData } from 'viem';
import { createMemoryLedger, type SpendPolicy } from '../src/policy.js';
import { createPolicySigner, createSignerHandler, generateWalletKey, type PolicySigner } from '../src/signer.js';
import { evmPaySigner, httpSignerTransport, listWallets, stellarPaySigner, type SignerTransport, type WalletInfo } from '../src/wallet.js';

const SAC_TESTNET = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const SAC_PUBNET = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75';
const OTHER_SAC = 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA';
const USDC_TESTNET = 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const CELO_USDC = '0xceba9300f2b948710d2653dd7b07f33a8b32118c';
const NOW = new Date('2026-10-17T12:00:00Z');
const nowS = BigInt(NOW.getTime() / 1000);

const policy: SpendPolicy = {
  rules: [
    { network: 'stellar:testnet', asset: USDC_TESTNET, perTx: '0.05', perWindow: '0.08' },
    { network: 'eip155:5042002', asset: ARC_USDC, perTx: '0.05', perWindow: '0.08' },
  ],
};

/** A SAC call exactly as simulation would hand it to authorizeEntry. */
const entry = (o: { from: string; to: string; amount: bigint; contract?: string; fn?: string; sub?: xdr.SorobanAuthorizedInvocation[] }) =>
  new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(o.from).toScAddress(),
        nonce: xdr.Int64.fromString('7071'),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(o.contract ?? SAC_TESTNET).toScAddress(),
          functionName: o.fn ?? 'transfer',
          args: [new Address(o.from).toScVal(), new Address(o.to).toScVal(), nativeToScVal(o.amount, { type: 'i128' })],
        }),
      ),
      subInvocations: o.sub ?? [],
    }),
  });

let stellarKey: Keypair;
let evmSecret: `0x${string}`;
let evmAddress: string;
let signer: PolicySigner;
let ledger: ReturnType<typeof createMemoryLedger>;
let transport: SignerTransport;
let calls = 0;
let stellarWallet: WalletInfo;
let evmWallet: WalletInfo;
const seller = Keypair.random().publicKey();
const evmSeller = '0x00000000000000000000000000000000000000aa';

const fresh = async (p: SpendPolicy = policy) => {
  ledger = createMemoryLedger();
  signer = await createPolicySigner({
    keys: [{ network: 'stellar:testnet', secret: stellarKey.secret() }, { network: 'eip155:5042002', secret: evmSecret }],
    policy: p,
    ledger,
    now: () => NOW,
  });
  // JSON round trip: what crosses the sandbox boundary is plain data.
  transport = async (req) => (calls++, JSON.parse(JSON.stringify(await signer.handle(JSON.parse(JSON.stringify(req))))));
};

beforeAll(async () => {
  stellarKey = Keypair.random();
  evmSecret = generatePrivateKey();
  evmAddress = privateKeyToAccount(evmSecret).address.toLowerCase();
  stellarWallet = { network: 'stellar:testnet', address: stellarKey.publicKey() };
  evmWallet = { network: 'eip155:5042002', address: evmAddress };
  await fresh();
});

/** Sign through the SDK's own authorizeEntry, which verifies the returned signature against the address. */
const authorize = (e: xdr.SorobanAuthorizationEntry, passphrase = Networks.TESTNET) =>
  authorizeEntry(
    e,
    async (preimage) => {
      const { signedAuthEntry } = await stellarPaySigner(transport, stellarWallet).signAuthEntry(preimage.toXDR('base64'));
      return Buffer.from(signedAuthEntry, 'base64');
    },
    1000,
    passphrase,
  );
const refusal = (p: Promise<unknown>) => p.then(() => 'signed', (e: { reason?: string }) => e.reason);

describe('policy signer: setup', () => {
  it('lists one wallet per network and never exposes a secret', async () => {
    const ws = await listWallets(transport);
    expect(ws).toEqual([stellarWallet, evmWallet]);
    expect(JSON.stringify(ws)).not.toContain(stellarKey.secret());
    expect(JSON.stringify(ws)).not.toContain(evmSecret.slice(2));
  });
  it('throws on a bad policy, an unknown network or a duplicate key, before signing anything', async () => {
    const k = { network: 'stellar:testnet' as const, secret: stellarKey.secret() };
    await expect(createPolicySigner({ keys: [k], policy: { rules: [{ ...policy.rules[0]!, perTx: '9' }] } })).rejects.toThrow();
    await expect(createPolicySigner({ keys: [{ ...k, network: 'stellar:nowhere' as never }], policy })).rejects.toThrow();
    await expect(createPolicySigner({ keys: [k, k], policy })).rejects.toThrow(/duplicate/);
  });
  it('generates keys for any listed network, address only for the agent', async () => {
    const s = await generateWalletKey('stellar:testnet');
    expect(Keypair.fromSecret(s.secret).publicKey()).toBe(s.address);
    const e = await generateWalletKey('eip155:42220');
    expect(privateKeyToAccount(e.secret as `0x${string}`).address.toLowerCase()).toBe(e.address);
  });
});

describe('policy signer: Stellar auth entries', () => {
  it('signs a USDC transfer inside the policy; the SDK accepts the signature; the spend is counted', async () => {
    await fresh();
    const signed = await authorize(entry({ from: stellarKey.publicKey(), to: seller, amount: 500_000n }));
    expect(signed.credentials().address().signature().switch().name).toBe('scvVec');
    expect(ledger.entries()).toHaveLength(1);
    expect(ledger.entries()[0]).toMatchObject({ network: 'stellar:testnet', asset: USDC_TESTNET, amount: 500_000n, payTo: seller });
  });
  it('signs on its own until the window is spent, then refuses', async () => {
    await fresh();
    const pay = () => refusal(authorize(entry({ from: stellarKey.publicKey(), to: seller, amount: 300_000n })));
    expect([await pay(), await pay(), await pay()]).toEqual(['signed', 'signed', 'over_window']);
  });
  it('concurrent requests cannot both slip under the window', async () => {
    await fresh();
    const pay = () => refusal(authorize(entry({ from: stellarKey.publicKey(), to: seller, amount: 500_000n })));
    const out = await Promise.all([pay(), pay(), pay()]);
    expect(out.filter((r) => r === 'signed')).toHaveLength(1);
    expect(ledger.entries()).toHaveLength(1);
  });
  it.each([
    ['over the per-tx cap', { amount: 500_001n }, 'over_per_tx'],
    ['an unpinned token', { contract: OTHER_SAC }, 'unknown_asset'],
    ['the pubnet USDC on a testnet wallet', { contract: SAC_PUBNET }, 'unknown_asset'],
    ['a non-transfer call', { fn: 'approve' }, 'unsupported_payload'],
  ] as const)('refuses %s, and counts nothing', async (_n, o, reason) => {
    await fresh();
    expect(await refusal(authorize(entry({ from: stellarKey.publicKey(), to: seller, amount: 100n, ...o })))).toBe(reason);
    expect(ledger.entries()).toHaveLength(0);
  });
  it('refuses a transfer hidden in a sub-invocation', async () => {
    await fresh();
    const inner = entry({ from: stellarKey.publicKey(), to: seller, amount: 100n }).rootInvocation();
    expect(await refusal(authorize(entry({ from: stellarKey.publicKey(), to: seller, amount: 100n, sub: [inner] })))).toBe('unsupported_payload');
  });
  it('refuses a transfer from another account and a preimage for another network', async () => {
    await fresh();
    const other = Keypair.random().publicKey();
    const preimage = (from: string, passphrase: string) =>
      xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
        new xdr.HashIdPreimageSorobanAuthorization({
          networkId: hash(Buffer.from(passphrase)),
          nonce: xdr.Int64.fromString('1'),
          signatureExpirationLedger: 1000,
          invocation: entry({ from, to: seller, amount: 100n }).rootInvocation(),
        }),
      ).toXDR('base64');
    const s = stellarPaySigner(transport, stellarWallet);
    expect(await refusal(s.signAuthEntry(preimage(other, Networks.TESTNET)))).toBe('unknown_wallet');
    expect(await refusal(s.signAuthEntry(preimage(stellarKey.publicKey(), Networks.PUBLIC)))).toBe('wrong_network');
    expect(await refusal(s.signAuthEntry('not xdr at all'))).toBe('bad_payload');
  });
  it('refuses a wallet it does not hold', async () => {
    const s = stellarPaySigner(transport, { network: 'stellar:testnet', address: Keypair.random().publicKey() });
    expect(await refusal(s.signAuthEntry('AAAA'))).toBe('unknown_wallet');
  });
});

describe('policy signer: EVM EIP-3009 typed data', () => {
  /** Exactly what @x402/evm's exact client hands its signer: bigints, checksummed addresses. */
  const typedData = (o: { message?: Record<string, unknown>; domain?: Record<string, unknown>; types?: Record<string, unknown>; primaryType?: string } = {}) => ({
    domain: { name: 'USDC', version: '2', chainId: 5042002, verifyingContract: '0x3600000000000000000000000000000000000000', ...o.domain },
    types: o.types ?? {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: o.primaryType ?? 'TransferWithAuthorization',
    message: {
      from: privateKeyToAccount(evmSecret).address, to: '0x00000000000000000000000000000000000000AA', value: 40_000n,
      validAfter: nowS - 600n, validBefore: nowS + 300n, nonce: `0x${'11'.repeat(32)}`, ...o.message,
    },
  });

  it('signs a USDC authorization inside the policy, and the signature verifies for the wallet', async () => {
    await fresh();
    const td = typedData();
    const signature = await evmPaySigner(transport, evmWallet).signTypedData(td);
    expect(await verifyTypedData({ ...(td as never), address: privateKeyToAccount(evmSecret).address, signature })).toBe(true);
    expect(ledger.entries()[0]).toMatchObject({ network: 'eip155:5042002', asset: ARC_USDC, amount: 40_000n, payTo: evmSeller });
  });
  it('the per-network rules are independent: an EVM spend does not touch the Stellar window', async () => {
    await fresh();
    await evmPaySigner(transport, evmWallet).signTypedData(typedData({ message: { value: 50_000n } }));
    expect(await refusal(authorize(entry({ from: stellarKey.publicKey(), to: seller, amount: 500_000n })))).toBe('signed');
    expect(await refusal(evmPaySigner(transport, evmWallet).signTypedData(typedData({ message: { value: 50_000n } })))).toBe('over_window');
  });
  it.each([
    ['over the per-tx cap', { message: { value: 50_001n } }, 'over_per_tx'],
    ['another chain id', { domain: { chainId: 42220 } }, 'wrong_network'],
    ['an unpinned token', { domain: { verifyingContract: '0x00000000000000000000000000000000000000cc' } }, 'unknown_asset'],
    ['Celo USDC on the Arc wallet', { domain: { verifyingContract: CELO_USDC } }, 'unknown_asset'],
    ['a transfer from someone else', { message: { from: '0x00000000000000000000000000000000000000dd' } }, 'unknown_wallet'],
    ['a validity window over 300 s', { message: { validBefore: nowS + 301n } }, 'bad_validity'],
    ['an expired authorization', { message: { validBefore: nowS } }, 'bad_validity'],
    ['a Permit2 witness', { primaryType: 'PermitWitnessTransferFrom' }, 'unsupported_payload'],
    ['re-labelled fields', { types: { TransferWithAuthorization: [{ name: 'to', type: 'address' }, { name: 'from', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] } }, 'unsupported_payload'],
    ['a value that is not an integer', { message: { value: '1e6' } }, 'bad_payload'],
  ] as const)('refuses %s, and counts nothing', async (_n, o, reason) => {
    await fresh();
    expect(await refusal(evmPaySigner(transport, evmWallet).signTypedData(typedData(o as never)))).toBe(reason);
    expect(ledger.entries()).toHaveLength(0);
  });
  it('refuses a payee outside the allowlist', async () => {
    await fresh({ rules: [{ ...policy.rules[1]!, payTo: ['0x00000000000000000000000000000000000000bb'] }] });
    expect(await refusal(evmPaySigner(transport, evmWallet).signTypedData(typedData()))).toBe('pay_to_not_allowed');
  });
});

describe('createSignerHandler', () => {
  const TOKEN = 't'.repeat(40);
  const call = (h: (r: Request) => Promise<Response>, body: unknown, auth = `Bearer ${TOKEN}`, method = 'POST') =>
    h(new Request('http://signer.local/', { method, headers: { authorization: auth }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }));

  it('requires a long token', () => {
    expect(() => createSignerHandler(signer, { token: 'short' })).toThrow();
  });
  it('answers an authorized request and refuses everything else', async () => {
    await fresh();
    const h = createSignerHandler(signer, { token: TOKEN });
    const ok = await call(h, { kind: 'wallets' });
    expect([ok.status, ((await ok.json()) as { wallets: unknown[] }).wallets.length]).toEqual([200, 2]);
    expect((await call(h, { kind: 'wallets' }, `Bearer ${'x'.repeat(40)}`)).status).toBe(401);
    expect((await call(h, { kind: 'wallets' }, '')).status).toBe(401);
    expect((await call(h, null, `Bearer ${TOKEN}`, 'GET')).status).toBe(405);
    expect((await call(h, { kind: 'sign_anything' })).status).toBe(403);
  });
});

describe('httpSignerTransport', () => {
  const TOKEN = 'k'.repeat(48);
  let srv: ReturnType<typeof Bun.serve>;
  let seen: Request[] = [];
  beforeAll(async () => {
    await fresh();
    const h = createSignerHandler(signer, { token: TOKEN });
    srv = Bun.serve({ port: 0, fetch: (req) => (seen.push(req.clone()), h(req)) });
  });
  const url = () => `http://localhost:${srv.port}/sign`;

  it('signs over real HTTP; the SDK accepts the signature; only the request and the token cross', async () => {
    seen = [];
    const t = httpSignerTransport({ url: url(), token: TOKEN });
    const [w] = await listWallets(t);
    expect(w).toEqual(stellarWallet);
    const signed = await authorizeEntry(
      entry({ from: stellarKey.publicKey(), to: seller, amount: 100_000n }),
      async (pre) => Buffer.from((await stellarPaySigner(t, w!).signAuthEntry(pre.toXDR('base64'))).signedAuthEntry, 'base64'),
      1000,
      Networks.TESTNET,
    );
    expect(signed.credentials().address().signature().switch().name).toBe('scvVec');
    for (const r of seen) {
      const body = await r.text();
      expect(r.method).toBe('POST');
      expect(body).not.toContain(stellarKey.secret());
      expect(body).not.toContain(evmSecret.slice(2));
    }
    srv.stop(true);
  });
  it('surfaces a refusal and a wrong token as typed refusals', async () => {
    srv = Bun.serve({ port: 0, fetch: createSignerHandler(signer, { token: TOKEN }) });
    const big = entry({ from: stellarKey.publicKey(), to: seller, amount: 500_001n });
    const sign = (token: string) =>
      refusal(authorizeEntry(big, async (pre) => Buffer.from((await stellarPaySigner(httpSignerTransport({ url: url(), token }), stellarWallet).signAuthEntry(pre.toXDR('base64'))).signedAuthEntry, 'base64'), 1000, Networks.TESTNET));
    expect(await sign(TOKEN)).toBe('over_per_tx');
    expect(await sign('x'.repeat(48))).toBe('unauthorized');
    srv.stop(true);
  });
  it('treats a non-JSON or malformed answer as bad_request, never as a signature', async () => {
    for (const body of ['<html>', JSON.stringify({ ok: true }), JSON.stringify({ ok: false, reason: 'anything goes' }), JSON.stringify({ ok: true, wallets: [{ network: 1 }] })]) {
      const t = httpSignerTransport({ url: 'http://signer.local/', token: TOKEN, fetch: (async () => new Response(body)) as never });
      expect(await t({ kind: 'wallets' })).toEqual({ ok: false, reason: 'bad_request' });
    }
  });
  it('throws on a timeout', async () => {
    const hang = (async (_u: string, init: RequestInit) =>
      new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as never;
    await expect(httpSignerTransport({ url: 'http://signer.local/', token: TOKEN, fetch: hang, timeoutMs: 20 })({ kind: 'wallets' })).rejects.toThrow();
  });
});
