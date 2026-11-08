/**
 * Base58 (Bitcoin alphabet), as Solana writes addresses and signatures. Zero deps.
 */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)]! + out;
    n /= 58n;
  }
  return '1'.repeat(zeros) + out;
}

/** Throws on a character outside the alphabet. */
export function base58Decode(s: string): Uint8Array {
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  let n = 0n;
  for (const c of s) {
    const v = INDEX.get(c);
    if (v === undefined) throw new Error('agentenact: bad base58');
    n = n * 58n + BigInt(v);
  }
  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return new Uint8Array([...new Array<number>(zeros).fill(0), ...body]);
}

/** A Solana address: base58 of exactly 32 bytes (on or off the curve; program-derived addresses are off it). */
export function isSolanaAddress(a: unknown): a is string {
  if (typeof a !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return false;
  try {
    return base58Decode(a).length === 32;
  } catch {
    return false;
  }
}
