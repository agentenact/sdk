import { describe, expect, it } from 'bun:test';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import {
  DELEGATION_HEADER, checkIncomingDelegation, childDelegation, decodeDelegation, encodeDelegation, type Delegation,
} from '../src/delegation.js';
import { createEnactServer, type X402Server } from '../src/serve.js';
import type { ChainAdapter } from '../src/index.js';

const A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const C = 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

describe('delegation codec', () => {
  it('round-trips through the header', () => {
    const d: Delegation = { v: 1, root: 'abc123', depth: 2, payees: [A, B] };
    expect(decodeDelegation(encodeDelegation(d))).toEqual(d);
  });
  it('refuses anything malformed', () => {
    const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '');
    for (const bad of [
      '', 'not base64!', enc({ v: 2, root: 'r', depth: 1, payees: [A] }), enc({ v: 1, root: 'r', depth: 0, payees: [A] }),
      enc({ v: 1, root: 'r', depth: 1, payees: [] }), enc({ v: 1, root: 'r r', depth: 1, payees: [A] }),
      enc({ v: 1, root: 'r', depth: 1, payees: [A], extra: true }), enc({ v: 1, root: 'r', depth: 1.5, payees: [A] }),
      enc({ v: 1, root: 'r', depth: 1, payees: Array(17).fill(A) }), 'x'.repeat(3000),
    ]) {
      expect(() => decodeDelegation(bad)).toThrow('bad_delegation');
    }
  });
});

describe('childDelegation', () => {
  it('at the root: depth 1, payees = [self], root = the task', () => {
    expect(childDelegation({ parent: null, root: 't1', self: A, payee: B, maxDepth: 2 })).toEqual({ v: 1, root: 't1', depth: 1, payees: [A] });
  });
  it('under a parent: keeps its root, adds self once, depth + 1', () => {
    const parent: Delegation = { v: 1, root: 'r0', depth: 1, payees: [A] };
    expect(childDelegation({ parent, root: 'ignored', self: B, payee: C, maxDepth: 2 })).toEqual({ v: 1, root: 'r0', depth: 2, payees: [A, B] });
  });
  it('refuses a payee already in the chain (A → B → A) and paying itself', () => {
    const parent: Delegation = { v: 1, root: 'r0', depth: 1, payees: [A] };
    expect(childDelegation({ parent, root: 'x', self: B, payee: A, maxDepth: 3 })).toEqual({ refused: 'delegation_loop' });
    expect(childDelegation({ parent: null, root: 'x', self: A, payee: A, maxDepth: 3 })).toEqual({ refused: 'delegation_loop' });
  });
  it('refuses past maxDepth', () => {
    const parent: Delegation = { v: 1, root: 'r0', depth: 2, payees: [A, B] };
    expect(childDelegation({ parent, root: 'x', self: C, maxDepth: 2 })).toEqual({ refused: 'max_depth' });
  });
});

describe('checkIncomingDelegation', () => {
  const header = (d: Delegation) => encodeDelegation(d);
  it('accepts no header (a root call) and a valid chain', () => {
    expect(checkIncomingDelegation(null, { self: C, maxDepth: 2 })).toEqual({ ok: true, delegation: null });
    expect(checkIncomingDelegation(header({ v: 1, root: 'r', depth: 2, payees: [A, B] }), { self: C, maxDepth: 2 }).ok).toBe(true);
  });
  it('refuses a loop, too deep, and garbage', () => {
    expect(checkIncomingDelegation(header({ v: 1, root: 'r', depth: 1, payees: [C] }), { self: C, maxDepth: 2 })).toEqual({ ok: false, reason: 'delegation_loop' });
    expect(checkIncomingDelegation(header({ v: 1, root: 'r', depth: 3, payees: [A, B, A.replace('GA', 'GD')] }), { self: C, maxDepth: 2 })).toEqual({ ok: false, reason: 'max_depth' });
    expect(checkIncomingDelegation('%%%', { self: C, maxDepth: 2 })).toEqual({ ok: false, reason: 'bad_delegation' });
  });
});

describe('serve with delegation', () => {
  const adapter: ChainAdapter = {
    chain: 'stellar', sigAlg: 'ed25519',
    async sign() { return 'sig'; }, async verify() { return true; },
    async readSettlement() { return []; }, async resolveIdentity() { return null; },
  };
  const REQ = { scheme: 'exact', network: 'stellar:testnet', amount: '10000', asset: 'CBIELT', payTo: C, maxTimeoutSeconds: 300, extra: {} } as unknown as PaymentRequirements;
  let verified = 0;
  let settled = 0;
  const x402: X402Server = {
    async accepts() { return [REQ]; },
    async paymentRequired() { return { status: 402, headers: { 'PAYMENT-REQUIRED': 'req' }, body: '{}' }; },
    async verify() { verified++; return { ok: true, requirements: REQ, payload: {} as PaymentPayload, payer: A, asset: 'USDC:G', decimals: 7 }; },
    async settle() { settled++; return { ok: false, reason: 'unused' }; },
  };
  const make = (delegation?: { maxDepth: number }) =>
    createEnactServer({
      network: 'stellar:testnet', agent: { address: C, secret: new Uint8Array(32) }, adapter, price: '0.001',
      facilitator: { url: 'https://example.invalid', apiKey: 'k' }, resource: 'https://c.example/x',
      handler: async () => ({ body: new Uint8Array(), mediaType: 'text/plain' }), x402,
      ...(delegation ? { delegation } : {}),
    });
  const req = (h: Record<string, string>) => new Request('https://c.example/x', { method: 'POST', body: '{}', headers: h });

  it('a looping chain gets 508 before the 402, so nothing is verified or settled even with a payment attached', async () => {
    const handle = await make({ maxDepth: 2 });
    const loop = encodeDelegation({ v: 1, root: 'r', depth: 2, payees: [A, C] });
    const r1 = await handle(req({ [DELEGATION_HEADER]: loop }));
    const r2 = await handle(req({ [DELEGATION_HEADER]: loop, 'PAYMENT-SIGNATURE': 'good' }));
    expect([r1.status, r2.status]).toEqual([508, 508]);
    expect(await r2.json()).toEqual({ error: 'delegation_loop' });
    expect([verified, settled]).toEqual([0, 0]);
  });
  it('a malformed header is 400; a valid one goes on to the usual 402', async () => {
    const handle = await make({ maxDepth: 2 });
    expect((await handle(req({ [DELEGATION_HEADER]: 'nope' }))).status).toBe(400);
    expect((await handle(req({ [DELEGATION_HEADER]: encodeDelegation({ v: 1, root: 'r', depth: 1, payees: [A] }) }))).status).toBe(402);
  });
  it('without the option the header is ignored (no behavior change)', async () => {
    const handle = await make();
    const loop = encodeDelegation({ v: 1, root: 'r', depth: 9, payees: [C] });
    expect((await handle(req({ [DELEGATION_HEADER]: loop }))).status).toBe(402);
  });
});
