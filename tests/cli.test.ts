import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeRecordHeader, type EnactmentRecord } from '../src/index.js';
import { runCli, type CliDeps } from '../src/cli.js';
import { replayAdapter, VECTORS_DIR } from './vectors/replay.js';

interface Vector { name: string; record: EnactmentRecord; input?: string; output?: string }
const vectors = JSON.parse(await readFile(join(VECTORS_DIR, 'vectors.json'), 'utf8')) as Vector[];
const vec = (name: string) => vectors.find((v) => v.name === name)!;

/** Files and URLs served from memory; settlements and identity from the recorded testnet answers. */
function deps(files: Record<string, string | object> = {}, urls: Record<string, object> = {}): CliDeps & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    readFile: async (p) => {
      const f = files[p];
      if (f === undefined) throw new Error(`ENOENT ${p}`);
      return new TextEncoder().encode(typeof f === 'string' ? f : JSON.stringify(f));
    },
    fetch: (async (u: string) => {
      const body = urls[String(u)];
      return body ? new Response(JSON.stringify(body)) : new Response('{}', { status: 404 });
    }) as typeof fetch,
    adapter: async (opts) => {
      seen.push(`${opts.network} ${opts.horizonUrl ?? ''}`.trim());
      return replayAdapter();
    },
  };
}

describe('agentenact verify', () => {
  const proof = vec('real-proof-identity');

  it('verifies a record file and its input/output files, one MATCH line per check', async () => {
    const out = await runCli(['verify', 'r.json', '--input', 'in.txt', '--output', 'out.json'],
      deps({ 'r.json': { record: proof.record }, 'in.txt': proof.input!, 'out.json': proof.output! }));
    expect(out.code).toBe(0);
    expect(out.lines.slice(0, 6)).toEqual([
      'MATCH signature', 'MATCH settlement', 'MATCH timing', 'MATCH identity',
      `MATCH input sha256  ${proof.record.input.sha256}`, `MATCH output sha256  ${proof.record.output.sha256}`,
    ]);
    expect(out.lines.at(-1)).toMatch(/^VERIFIED: .*says nothing about whether the output is right/);
  });

  it('accepts an https URL and a header value', async () => {
    const url = 'https://api.example/a/x/records/f951';
    expect((await runCli(['verify', url], deps({}, { [url]: { record: proof.record } }))).code).toBe(0);
    expect((await runCli(['verify', encodeRecordHeader(proof.record)], deps())).code).toBe(0);
  });

  it('a verified record with the wrong output file is NOT VERIFIED', async () => {
    const out = await runCli(['verify', 'r.json', '--output', 'out.json'], deps({ 'r.json': proof.record, 'out.json': 'something else' }));
    expect(out.code).toBe(1);
    expect(out.lines).toContain('NOT VERIFIED');
    expect(out.lines.some((l) => l.startsWith('FAIL  output sha256'))).toBe(true);
  });

  it('a tampered record fails at the signature and skips the rest', async () => {
    const out = await runCli(['verify', 'r.json'], deps({ 'r.json': vec('tampered-amount').record }));
    expect(out.code).toBe(1);
    expect(out.lines.slice(0, 4)).toEqual(['FAIL  signature  invalid_signature', 'SKIP  settlement', 'SKIP  timing', 'SKIP  identity']);
  });

  it('says a reset-lost payment is unverifiable, not forged', async () => {
    const out = await runCli(['verify', 'r.json'], deps({ 'r.json': vec('settlement-before-history').record }));
    expect(out.code).toBe(1);
    expect(out.lines[1]).toMatch(/^FAIL  settlement  history_unavailable: .*not proven forged/);
  });

  it('passes --network and --horizon to the adapter', async () => {
    const d = deps({ 'r.json': proof.record });
    await runCli(['verify', 'r.json', '--horizon', 'https://horizon.example'], d);
    expect(d.seen).toEqual(['testnet https://horizon.example']);
  });

  it('exits 2 on usage errors, plain http and unreadable input', async () => {
    for (const argv of [[], ['verify'], ['verify', 'a', 'b'], ['verify', 'r.json', '--network', 'mainnet'], ['verify', 'r.json', '--nope'],
      ['verify', 'r.json', '--window', '-1'], ['verify', 'http://x.example/r'], ['verify', 'missing.json'], ['sign', 'r.json']]) {
      expect((await runCli(argv, deps({ 'r.json': proof.record }))).code).toBe(2);
    }
  });

  it('--json prints the verifier result', async () => {
    const out = await runCli(['verify', 'r.json', '--json'], deps({ 'r.json': proof.record }));
    expect(JSON.parse(out.lines[0]!)).toMatchObject({ ok: true, checks: { identity: 'pass' } });
  });
});
