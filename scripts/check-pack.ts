/**
 * Runs in `prepack` after the build: every file package.json points at (main, types, bin, each
 * exports condition) must exist, so a pack or publish without dist/ fails instead of shipping
 * a package that cannot be imported. 0.1.0 reached npm that way.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const pkg = JSON.parse(await Bun.file(join(root, 'package.json')).text());

const targets = new Set<string>([pkg.main, pkg.module, pkg.types, ...Object.values<string>(pkg.bin ?? {})]);
for (const entry of Object.values<string | Record<string, string>>(pkg.exports)) {
  for (const target of typeof entry === 'string' ? [entry] : Object.values(entry)) targets.add(target);
}

const missing = [...targets].filter((t) => t && !existsSync(join(root, t)));
if (missing.length > 0) {
  console.error(`check-pack: missing ${missing.length} packed file(s):\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
console.log(`check-pack: ${targets.size} entry files present`);
