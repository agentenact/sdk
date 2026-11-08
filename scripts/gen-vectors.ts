/**
 * Writes the conformance vectors in tests/vectors/: records with the verdict
 * each one must get, and a MANIFEST.sha256 over every file the test reads.
 *
 *   bun run scripts/gen-vectors.ts
 *
 * The verdicts below are written by hand from what each vector is built to
 * break. This script never calls verifyRecord, so a verifier bug cannot write
 * its own expected result. Run it only to add or change a vector, and review
 * the diff of vectors.json like code.
 *
 * Three sources of records:
 * - real: records the testnet demo agent signed (site/public/proofs), verbatim.
 * - tampered: a real record with one field changed after signing.
 * - vector key: signed here with a published test-only key (VECTOR_SEED_TEXT),
 *   against a synthetic settlement tx that pays that key. The synthetic tx is
 *   the real f951b337… Horizon response with its hash and payee replaced.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Keypair } from '@stellar/stellar-sdk';
import { sha256, sha256Hex, signRecord, type EnactmentRecord, type UnsignedEnactmentRecord } from '../src/index.js';
import { createStellarAdapter } from '../src/adapters/stellar.js';
import { horizonFile } from './capture-vector-fixtures.js';

const ROOT = join(import.meta.dir, '..');
const DIR = join(ROOT, 'tests', 'vectors');
const HORIZON_DIR = join(DIR, 'fixtures', 'horizon');

/** Test-only key. Its seed is public on purpose; it never holds funds. */
export const VECTOR_SEED_TEXT = 'agentenact conformance vector key v1';
const PROOF_REF = 'f951b337cdf8305e523a88fc2cf9db9c44a763c837718aa819a9041f00be73d0';
const FIRST_REF = 'f2a1cf804df37d1e779d759ef87bbeca5b37fa9bcca75fc2d59ad92e0eb47f75';
const MISSING_REF = '00000000000000000000000000000000000000000000000000000000000000ff';

type Checks = Record<'signature' | 'settlement' | 'timing' | 'identity', 'pass' | 'fail' | 'skipped'>;
interface Vector {
  name: string;
  description: string;
  record: unknown;
  input?: string;
  output?: string;
  expect: { ok: boolean; checks: Checks; failure?: { check: string; reason: string } };
}

const checks = (signature: string, settlement = 'skipped', timing = 'skipped', identity = 'skipped') =>
  ({ signature, settlement, timing, identity }) as Checks;

async function proof(ref: string): Promise<{ record: EnactmentRecord; input: string; output: string }> {
  const raw = JSON.parse(await readFile(join(ROOT, 'site', 'public', 'proofs', `${ref}.json`), 'utf8'));
  return { record: raw.record, input: raw.input, output: raw.output };
}

/** The real proof tx, re-addressed: new hash, paying `payee`. Same shapes and magnitudes. */
async function writeSyntheticTx(ref: string, payee: string): Promise<void> {
  const swap = (s: string) => s.replaceAll(PROOF_REF, ref).replaceAll('GDO73LCGQTKWCEKQ55C5BUBOFKGCAXXOP6MZ35YQ6BRSQKCKDDSAWECM', payee);
  for (const path of [`/transactions/${PROOF_REF}`, `/transactions/${PROOF_REF}/payments?limit=200`]) {
    const body = await readFile(join(HORIZON_DIR, horizonFile(path)), 'utf8');
    await writeFile(join(HORIZON_DIR, horizonFile(path.replace(PROOF_REF, ref))), swap(body));
  }
}

async function main(): Promise<void> {
  const adapter = createStellarAdapter({ network: 'testnet' });
  const seed = await sha256(VECTOR_SEED_TEXT);
  const key = Keypair.fromRawEd25519Seed(Buffer.from(seed));
  const synthRef = await sha256Hex('agentenact conformance synthetic settlement v1');
  await writeSyntheticTx(synthRef, key.publicKey());

  const p = await proof(PROOF_REF);
  const first = await proof(FIRST_REF);
  const flipped = p.record.sig.value.slice(0, -2) + (p.record.sig.value.endsWith('00') ? '01' : '00');

  const base: UnsignedEnactmentRecord = {
    v: '0.1',
    agent: { chain: 'stellar', address: key.publicKey() },
    input: { sha256: p.record.input.sha256, mediaType: 'text/plain' },
    output: { sha256: p.record.output.sha256, mediaType: 'application/json', bytes: 109 },
    settlement: {
      chain: 'stellar',
      ref: synthRef,
      payer: p.record.settlement.payer,
      amount: '0.0010000',
      asset: p.record.settlement.asset,
    },
    // The synthetic tx closed at 2026-09-28T17:17:32Z, like the real one.
    issuedAt: '2026-09-28T17:17:36.000Z',
    nonce: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
  };
  const signed = (u: UnsignedEnactmentRecord) => signRecord(u, adapter, seed);

  const vectors: Vector[] = [
    {
      name: 'real-proof-identity',
      description: 'The site proof, signed by demo agent 31; all four checks pass.',
      record: p.record,
      input: p.input,
      output: p.output,
      expect: { ok: true, checks: checks('pass', 'pass', 'pass', 'pass') },
    },
    {
      name: 'real-first-payment',
      description: 'The first x402 payment record (2026-09-22); no agentId, so identity is skipped.',
      record: first.record,
      input: first.input,
      output: first.output,
      expect: { ok: true, checks: checks('pass', 'pass', 'pass', 'skipped') },
    },
    {
      name: 'tampered-input-hash',
      description: 'input.sha256 changed after signing.',
      record: { ...p.record, input: { ...p.record.input, sha256: '0'.repeat(64) } },
      expect: { ok: false, checks: checks('fail'), failure: { check: 'signature', reason: 'invalid_signature' } },
    },
    {
      name: 'tampered-amount',
      description: 'settlement.amount raised after signing.',
      record: { ...p.record, settlement: { ...p.record.settlement, amount: '1.0000000' } },
      expect: { ok: false, checks: checks('fail'), failure: { check: 'signature', reason: 'invalid_signature' } },
    },
    {
      name: 'tampered-signature-byte',
      description: 'Last byte of the signature changed.',
      record: { ...p.record, sig: { ...p.record.sig, value: flipped } },
      expect: { ok: false, checks: checks('fail'), failure: { check: 'signature', reason: 'invalid_signature' } },
    },
    {
      name: 'wrong-alg',
      description: 'sig.alg claims secp256k1-eip191 on a Stellar record.',
      record: { ...p.record, sig: { ...p.record.sig, alg: 'secp256k1-eip191' } },
      expect: { ok: false, checks: checks('fail'), failure: { check: 'signature', reason: 'alg_mismatch' } },
    },
    {
      name: 'unsupported-version',
      description: 'v is not 0.1.',
      record: { ...p.record, v: '0.9' },
      expect: { ok: false, checks: checks('skipped'), failure: { check: 'record', reason: 'unsupported_version' } },
    },
    {
      name: 'settlement-not-found',
      description: 'Valid signature over a settlement ref Horizon does not know.',
      record: await signed({ ...base, settlement: { ...base.settlement, ref: MISSING_REF } }),
      expect: { ok: false, checks: checks('pass', 'fail'), failure: { check: 'settlement', reason: 'not_found' } },
    },
    {
      name: 'settlement-before-history',
      description: 'Missing settlement, issued 2025-06-01: before the oldest testnet ledger (reset 2025-12-17).',
      record: await signed({ ...base, issuedAt: '2025-06-01T12:00:00.000Z', settlement: { ...base.settlement, ref: MISSING_REF } }),
      expect: { ok: false, checks: checks('pass', 'fail'), failure: { check: 'settlement', reason: 'history_unavailable' } },
    },
    {
      name: 'settlement-pays-someone-else',
      description: 'Valid signature, but the real proof tx paid demo agent 31, not this key.',
      record: await signed({ ...base, settlement: { ...base.settlement, ref: PROOF_REF } }),
      expect: { ok: false, checks: checks('pass', 'fail'), failure: { check: 'settlement', reason: 'no_matching_payment' } },
    },
    {
      name: 'vector-key-good',
      description: 'Vector key paid by the synthetic tx; passes without identity.',
      record: await signed(base),
      expect: { ok: true, checks: checks('pass', 'pass', 'pass', 'skipped') },
    },
    {
      name: 'issued-before-settlement',
      description: 'issuedAt one minute before the tx closed.',
      record: await signed({ ...base, issuedAt: '2026-09-28T17:16:32.000Z' }),
      expect: { ok: false, checks: checks('pass', 'pass', 'fail'), failure: { check: 'timing', reason: 'issued_before_settlement' } },
    },
    {
      name: 'issued-after-window',
      description: 'issuedAt two days after the tx closed (default window 24 h).',
      record: await signed({ ...base, issuedAt: '2026-09-30T17:17:36.000Z' }),
      expect: { ok: false, checks: checks('pass', 'pass', 'fail'), failure: { check: 'timing', reason: 'issued_after_window' } },
    },
    {
      name: 'identity-unregistered',
      description: 'Claims agentId 4000000, which the testnet registry does not know.',
      record: await signed({ ...base, agent: { ...base.agent, agentId: '4000000' } }),
      expect: { ok: false, checks: checks('pass', 'pass', 'pass', 'fail'), failure: { check: 'identity', reason: 'unregistered' } },
    },
    {
      name: 'identity-not-bound',
      description: 'Claims agentId 31, which binds the demo agent, not this key.',
      record: await signed({ ...base, agent: { ...base.agent, agentId: '31' } }),
      expect: { ok: false, checks: checks('pass', 'pass', 'pass', 'fail'), failure: { check: 'identity', reason: 'address_not_bound' } },
    },
  ];

  await writeFile(join(DIR, 'vectors.json'), JSON.stringify(vectors, null, 2) + '\n');

  const files = ['vectors.json', ...(await Array.fromAsync(new Bun.Glob('fixtures/**/*.json').scan({ cwd: DIR })))].sort();
  const lines = await Promise.all(files.map(async (f) => `${await sha256Hex(await readFile(join(DIR, f)))}  ${f}`));
  await writeFile(join(DIR, 'MANIFEST.sha256'), lines.join('\n') + '\n');
}

if (import.meta.main) await main();
