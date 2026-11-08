import { describe, expect, it } from 'bun:test';
import { Keypair } from '@stellar/stellar-sdk';
import { STELLAR_USDC, createStellarAdapter } from '../../src/adapters/stellar.js';
import {
  decodeRecordHeader,
  encodeRecordHeader,
  randomNonce,
  sha256Hex,
  signRecord,
  verifyRecord,
  type UnsignedEnactmentRecord,
} from '../../src/index.js';
import { fakeRpc } from './stellar.test.js';

const agent = Keypair.random();
const payer = Keypair.random();
const TX = 'a'.repeat(64);
const SETTLED_AT = '2026-09-02T09:59:00Z';

const fetchStub = (async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(url).pathname;
  if (path === `/transactions/${TX}`) return Response.json({ successful: true, created_at: SETTLED_AT });
  if (path === `/transactions/${TX}/payments`) {
    return Response.json({
      _embedded: {
        records: [
          {
            type: 'invoke_host_function',
            asset_balance_changes: [
              { type: 'transfer', from: payer.publicKey(), to: agent.publicKey(), amount: '0.0100000', asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: STELLAR_USDC.split(':')[1] },
            ],
          },
        ],
      },
    });
  }
  return new Response('{}', { status: 404 });
}) as typeof fetch;

const rpcStub = fakeRpc({ find_owner: agent.publicKey(), get_agent_wallet: null });

describe('stellar end to end', () => {
  it('agent signs, header round-trips, third party verifies all four checks', async () => {
    const signer = createStellarAdapter({ fetch: fetchStub, rpc: rpcStub });
    const unsigned: UnsignedEnactmentRecord = {
      v: '0.1',
      agent: { chain: 'stellar', address: agent.publicKey(), agentId: '66' },
      input: { sha256: await sha256Hex('summarise this'), mediaType: 'text/plain' },
      output: { sha256: await sha256Hex('{"summary":"ok"}'), mediaType: 'application/json', bytes: 16 },
      settlement: { chain: 'stellar', ref: TX, payer: payer.publicKey(), amount: '0.01', asset: STELLAR_USDC },
      issuedAt: '2026-09-02T10:00:00Z',
      nonce: randomNonce(),
    };
    const signed = await signRecord(unsigned, signer, new Uint8Array(agent.rawSecretKey()));
    const wire = encodeRecordHeader(signed);

    // A verifier holds only public data: the header value and public RPC/Horizon.
    const verifier = createStellarAdapter({ fetch: fetchStub, rpc: rpcStub });
    const res = await verifyRecord(decodeRecordHeader(wire), verifier);
    expect(res).toMatchObject({
      ok: true,
      checks: { signature: 'pass', settlement: 'pass', timing: 'pass', identity: 'pass' },
    });
    expect(res.settlement?.payee).toBe(agent.publicKey());
  });

  it('a record claiming bare "USDC" (no issuer) does not match a pinned settlement', async () => {
    const signer = createStellarAdapter({ fetch: fetchStub, rpc: rpcStub });
    const unsigned: UnsignedEnactmentRecord = {
      v: '0.1',
      agent: { chain: 'stellar', address: agent.publicKey() },
      input: { sha256: await sha256Hex('x') },
      output: { sha256: await sha256Hex('y') },
      settlement: { chain: 'stellar', ref: TX, payer: payer.publicKey(), amount: '0.01', asset: 'USDC' },
      issuedAt: '2026-09-02T10:00:00Z',
      nonce: randomNonce(),
    };
    const signed = await signRecord(unsigned, signer, new Uint8Array(agent.rawSecretKey()));
    const res = await verifyRecord(signed, createStellarAdapter({ fetch: fetchStub, rpc: rpcStub }));
    expect(res.failure).toEqual({ check: 'settlement', reason: 'no_matching_payment' });
  });

  it('a record signed by a different key than the claimed agent fails signature', async () => {
    const impostor = Keypair.random();
    const signer = createStellarAdapter({ fetch: fetchStub, rpc: rpcStub });
    const unsigned: UnsignedEnactmentRecord = {
      v: '0.1',
      agent: { chain: 'stellar', address: agent.publicKey() },
      input: { sha256: await sha256Hex('x') },
      output: { sha256: await sha256Hex('y') },
      settlement: { chain: 'stellar', ref: TX, payer: payer.publicKey(), amount: '0.01', asset: STELLAR_USDC },
      issuedAt: '2026-09-02T10:00:00Z',
      nonce: randomNonce(),
    };
    const forged = await signRecord(unsigned, signer, new Uint8Array(impostor.rawSecretKey()));
    const res = await verifyRecord(forged, createStellarAdapter({ fetch: fetchStub, rpc: rpcStub }));
    expect(res.failure).toEqual({ check: 'signature', reason: 'invalid_signature' });
  });
});
