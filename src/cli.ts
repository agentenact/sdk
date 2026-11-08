#!/usr/bin/env node
/**
 * `agentenact verify <record>`: re-runs the four checks from public chain data
 * and prints one line per check. Exit 0 = verified, 1 = not verified, 2 = could
 * not check (usage, file, network).
 *
 * <record> is a file (a record, or JSON with a `record` field), an https URL
 * returning either, or an Enactment-Record header value. Optional --input and
 * --output files are hashed locally and compared with the record.
 */
import { readFile } from 'node:fs/promises';
import { decodeRecordHeader, sha256Hex, type EnactmentRecord } from './record.js';
import type { ChainAdapter } from './adapter.js';
import { verifyRecord, type VerifyCheck, type VerifyResult } from './verify.js';

export interface CliDeps {
  readFile: (path: string) => Promise<Uint8Array>;
  fetch: typeof fetch;
  adapter: (opts: { network: 'testnet' | 'pubnet'; horizonUrl?: string }) => Promise<ChainAdapter>;
}

export interface CliOutput {
  code: 0 | 1 | 2;
  lines: string[];
}

const USAGE = [
  'usage: agentenact verify <record-file | https-url | header-value> [options]',
  '  --input <file>      check the record binds these exact input bytes',
  '  --output <file>     check the record binds these exact output bytes',
  '  --network <name>    testnet (default) or pubnet',
  '  --horizon <url>     read settlements from this Horizon instead of the default',
  '  --window <seconds>  max seconds between settlement and signing (default 86400)',
  '  --json              print the verifier result as JSON',
];

const LABEL: Record<VerifyCheck, string> = {
  signature: 'signature',
  settlement: 'settlement',
  timing: 'timing',
  identity: 'identity',
};

/** Words for a failure reason; history_unavailable is told apart from a forgery on purpose. */
function reasonText(reason: string): string {
  if (reason === 'history_unavailable')
    return 'history_unavailable: the payment predates the history this Horizon serves (testnet reset or pruned node); unverifiable, not proven forged';
  return reason;
}

function parseArgs(argv: string[]): { target?: string; flags: Map<string, string | true> } | null {
  const flags = new Map<string, string | true>();
  let target: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') flags.set('json', true);
    else if (['--input', '--output', '--network', '--horizon', '--window'].includes(a)) {
      const v = argv[++i];
      if (v === undefined) return null;
      flags.set(a.slice(2), v);
    } else if (a.startsWith('--')) return null;
    else if (target === undefined) target = a;
    else return null;
  }
  return { target, flags };
}

async function loadRecord(target: string, deps: CliDeps): Promise<unknown> {
  const unwrap = (doc: unknown) =>
    doc && typeof doc === 'object' && 'record' in doc ? (doc as { record: unknown }).record : doc;
  if (target.startsWith('https://')) {
    const res = await deps.fetch(target);
    if (!res.ok) throw new Error(`${target}: HTTP ${res.status}`);
    return unwrap(await res.json());
  }
  if (target.startsWith('http://')) throw new Error('refusing plain http; use https');
  const bytes = await deps.readFile(target).catch(() => null);
  if (bytes) return unwrap(JSON.parse(new TextDecoder().decode(bytes)));
  if (/^[A-Za-z0-9_-]{40,}$/.test(target)) return decodeRecordHeader(target);
  throw new Error(`${target}: not a file, an https URL or a header value`);
}

export async function runCli(argv: string[], deps: CliDeps): Promise<CliOutput> {
  if (argv[0] !== 'verify') return { code: 2, lines: USAGE };
  const args = parseArgs(argv.slice(1));
  if (!args || !args.target) return { code: 2, lines: USAGE };
  const { flags } = args;
  const network = (flags.get('network') ?? 'testnet') as string;
  if (network !== 'testnet' && network !== 'pubnet') return { code: 2, lines: [`unknown network: ${network}`, ...USAGE] };
  const window = flags.has('window') ? Number(flags.get('window')) : undefined;
  if (window !== undefined && !(Number.isFinite(window) && window > 0)) return { code: 2, lines: ['--window must be a positive number'] };

  let raw: unknown;
  let result: VerifyResult;
  try {
    raw = await loadRecord(args.target, deps);
    const horizon = flags.get('horizon');
    const adapter = await deps.adapter({ network, ...(typeof horizon === 'string' ? { horizonUrl: horizon } : {}) });
    result = await verifyRecord(raw, adapter, window === undefined ? {} : { windowSeconds: window });
  } catch (err) {
    return { code: 2, lines: [`could not check: ${(err as Error).message}`] };
  }

  const lines: string[] = [];
  let ok = result.ok;
  for (const check of ['signature', 'settlement', 'timing', 'identity'] as const) {
    const state = result.checks[check];
    const failure = result.failure && result.failure.check === check ? `  ${reasonText(result.failure.reason)}` : '';
    lines.push(`${state === 'pass' ? 'MATCH' : state === 'fail' ? 'FAIL ' : 'SKIP '} ${LABEL[check]}${failure}`);
  }
  if (result.failure?.check === 'record') lines.push(`FAIL  record  ${result.failure.reason}: ${result.failure.message}`);

  const record = raw as EnactmentRecord;
  for (const side of ['input', 'output'] as const) {
    const path = flags.get(side);
    if (typeof path !== 'string') continue;
    try {
      const got = await sha256Hex(await deps.readFile(path));
      const match = got === record[side]?.sha256;
      if (!match) ok = false;
      lines.push(`${match ? 'MATCH' : 'FAIL '} ${side} sha256  ${got}`);
    } catch (err) {
      return { code: 2, lines: [...lines, `could not read ${side}: ${(err as Error).message}`] };
    }
  }

  if (result.ok && result.settlement) {
    const s = result.settlement;
    lines.push(`paid  ${s.amount} ${s.asset.split(':')[0]} from ${s.payer} to ${s.payee} (${network}, tx ${s.ref})`);
  }
  lines.push(ok ? 'VERIFIED: signer, payment and timing check out. This says nothing about whether the output is right.' : 'NOT VERIFIED');
  if (flags.get('json')) return { code: ok ? 0 : 1, lines: [JSON.stringify({ ...result, ok }, null, 2)] };
  return { code: ok ? 0 : 1, lines };
}

async function main(): Promise<void> {
  const { code, lines } = await runCli(process.argv.slice(2), {
    readFile: (p) => readFile(p),
    fetch: globalThis.fetch,
    adapter: async (opts) => {
      const mod = await import('./adapters/stellar.js').catch(() => {
        throw new Error('the Stellar adapter needs @stellar/stellar-sdk; install it next to agentenact');
      });
      return mod.createStellarAdapter(opts);
    },
  });
  for (const l of lines) (code === 2 ? console.error : console.log)(l);
  process.exit(code);
}

const invoked = typeof process !== 'undefined' && process.argv[1] && /(?:^|[\\/])(?:cli\.[jt]s|agentenact)$/.test(process.argv[1]);
if (invoked) await main();
