import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Hex, verifyRecord } from '../src/index.js';
import { replayAdapter, VECTORS_DIR as DIR } from './vectors/replay.js';

// Conformance vectors: recorded testnet responses + records with hand-written
// verdicts (scripts/gen-vectors.ts). Fully offline. The files are pinned by
// MANIFEST.sha256 so a regenerated expectation shows up as a manifest diff.

interface Vector {
  name: string;
  record: unknown;
  input?: string;
  output?: string;
  expect: { ok: boolean; checks: Record<string, string>; failure?: { check: string; reason: string } };
}

const vectors = JSON.parse(await readFile(join(DIR, 'vectors.json'), 'utf8')) as Vector[];
const adapter = replayAdapter();

describe('conformance vectors', () => {
  it('match MANIFEST.sha256', async () => {
    const manifest = (await readFile(join(DIR, 'MANIFEST.sha256'), 'utf8')).trim().split('\n');
    expect(manifest.length).toBeGreaterThan(1);
    for (const line of manifest) {
      const [hash, file] = line.split(/\s+/);
      expect(`${await sha256Hex(await readFile(join(DIR, file!)))}  ${file}`).toBe(`${hash}  ${file}`);
    }
  });

  it('cover every verify outcome', () => {
    const reasons = new Set(vectors.map((v) => v.expect.failure?.reason ?? 'ok'));
    for (const r of ['ok', 'invalid_signature', 'alg_mismatch', 'unsupported_version', 'not_found', 'history_unavailable', 'no_matching_payment',
      'issued_before_settlement', 'issued_after_window', 'unregistered', 'address_not_bound']) {
      expect(reasons.has(r)).toBe(true);
    }
  });

  for (const v of vectors) {
    it(v.name, async () => {
      const res = await verifyRecord(v.record, adapter);
      expect(res.ok).toBe(v.expect.ok);
      expect(res.checks).toEqual(v.expect.checks as typeof res.checks);
      if (v.expect.failure) expect(res.failure).toMatchObject(v.expect.failure);
      else expect(res.failure).toBeUndefined();
      const rec = v.record as { input: { sha256: string }; output: { sha256: string } };
      if (v.input !== undefined) expect(await sha256Hex(v.input)).toBe(rec.input.sha256);
      if (v.output !== undefined) expect(await sha256Hex(v.output)).toBe(rec.output.sha256);
    });
  }
});
