import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** The verifier bundle's URL, versioned by its content so browsers never keep a stale copy. Build time only (reads the file). */
export function verifierSrc(): string {
  const bundle = readFileSync(path.join(process.cwd(), 'public', 'verifier', 'agentenact.js'));
  return `/verifier/agentenact.js?v=${createHash('sha256').update(bundle).digest('hex').slice(0, 12)}`;
}
