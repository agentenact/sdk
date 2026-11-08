import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

const SRC = join(import.meta.dir, '..', 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

const CORE = ['record.ts', 'adapter.ts', 'verify.ts', 'index.ts', 'networks.ts', 'policy.ts', 'wallet.ts'].map((f) => join(SRC, f));

describe('invariants', () => {
  it('core files import nothing outside this package', () => {
    for (const f of CORE) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/from\s+'([^']+)'/g)) expect(m[1]!.startsWith('./')).toBe(true);
    }
  });
  it('no class declarations anywhere', () => {
    for (const f of walk(SRC)) expect(readFileSync(f, 'utf8')).not.toMatch(/^\s*(export\s+)?class\s/m);
  });
  it('only create.ts (to Horizon /transactions), wallet.ts (to the caller\'s own signer), orchestrate.ts (to the hired agent) and the Solana adapter (read-only JSON-RPC) post; nothing phones home', () => {
    for (const f of walk(SRC)) {
      const src = readFileSync(f, 'utf8');
      expect(src).not.toMatch(/agentkarma\.io/);
      if (f.endsWith(`${sep}create.ts`)) {
        expect(src).toMatch(/fetch\(`\$\{horizonUrl\}\/transactions`, \{\s*method: 'POST'/);
        expect(src.match(/method:\s*['"]POST['"]/g)).toHaveLength(1);
      } else if (f.endsWith(`${sep}wallet.ts`)) {
        // httpSignerTransport: one POST, to the URL its caller passes, carrying the request and the bearer token.
        expect(src).toMatch(/doFetch\(opts\.url, \{\s*method: 'POST'/);
        expect(src.match(/method:\s*['"]POST['"]/g)).toHaveLength(1);
        expect(src).not.toMatch(/secret/i);
      } else if (f.endsWith(`${sep}orchestrate.ts`)) {
        // hire_agent: one POST, through hire(), to the service url the model chose from an agent's own document.
        expect(src).toMatch(/\(o\.hire \?\? hire\)\(\s*url,\s*\{\s*method: 'POST'/);
        expect(src.match(/method:\s*['"]POST['"]/g)).toHaveLength(1);
        expect(src).not.toMatch(/secret/i);
      } else if (f.endsWith(`${sep}adapters${sep}solana.ts`)) {
        // JSON-RPC is POST even for reads: one call site, to the network's RPC, and getTransaction is its only method.
        expect(src).toMatch(/await f\(url, \{ method: 'POST'/);
        expect(src.match(/method:\s*['"]POST['"]/g)).toHaveLength(1);
        expect(src.match(/call<[^>]+>\('(\w+)'/g)).toEqual(["call<RpcTx | null>('getTransaction'"]);
      } else {
        expect(src).not.toMatch(/method:\s*['"]POST['"]/);
      }
    }
  });
  it('no module ever logs a secret', () => {
    for (const f of walk(SRC)) expect(readFileSync(f, 'utf8')).not.toMatch(/console\.\w+\([^)]*secret/i);
  });
});
