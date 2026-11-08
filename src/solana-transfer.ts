/**
 * Decode the Solana transaction message an x402 `exact` payment asks the payer to sign, and return the spend it
 * moves. Zero deps (WebCrypto SHA-256 for the token-account derivation).
 *
 * What decodes, as @x402/svm builds it: a legacy or v0 message (v0 without address-table lookups; v1 is refused
 * until it is read here), exactly two signers with the fee payer first and the payer second as a read-only signer,
 * and only these instructions: at most one compute-unit limit and one compute-unit price (the fee payer's cost),
 * at most one memo with no accounts, and exactly one SPL Token / Token-2022 `TransferChecked` of the network's
 * pinned mint, from the payer's associated token account to `payTo`'s, with the payer as authority and the mint's
 * decimals. Anything else throws `spend_refused`, before anything is signed.
 */
import { base58Decode, base58Encode, isSolanaAddress } from './base58.js';
import { networkFor, type Caip2 } from './networks.js';
import { spendRefusal, type SpendIntent } from './policy.js';

const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ASSOCIATED_TOKEN = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const MAX_MEMO_BYTES = 256;
const TRANSFER_CHECKED = 12;

export interface SolanaTransfer {
  intent: SpendIntent;
  /** The message bytes to sign, exactly as received. */
  message: Uint8Array;
}

/** Ed25519 field prime and curve constant, for the off-curve test a program-derived address must pass. */
const P = 2n ** 255n - 19n;
const D = (-121665n * inv(121666n)) % P;
function mod(a: bigint): bigint {
  const r = a % P;
  return r < 0n ? r + P : r;
}
function pow(b: bigint, e: bigint): bigint {
  let r = 1n;
  b = mod(b);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}
function inv(a: bigint): bigint {
  return pow(a, P - 2n);
}
/** Whether 32 bytes decode to a point on ed25519 (a program-derived address must not). */
function onCurve(bytes: Uint8Array): boolean {
  const b = bytes.slice();
  b[31]! &= 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(b[i]!);
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const x2 = mod((y2 - 1n) * inv(mod(D * y2 + 1n)));
  if (x2 === 0n) return true;
  return pow(x2, (P - 1n) / 2n) === 1n;
}

async function sha256(parts: Uint8Array[]): Promise<Uint8Array> {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', all));
}

/** The associated token account of `owner` for `mint` under `tokenProgram` (findProgramAddress, highest bump). */
export async function associatedTokenAddress(owner: string, mint: string, tokenProgram: string): Promise<string> {
  const program = base58Decode(ASSOCIATED_TOKEN);
  const seeds = [base58Decode(owner), base58Decode(tokenProgram), base58Decode(mint)];
  const tag = new TextEncoder().encode('ProgramDerivedAddress');
  for (let bump = 255; bump >= 0; bump--) {
    const h = await sha256([...seeds, new Uint8Array([bump]), program, tag]);
    if (!onCurve(h)) return base58Encode(h);
  }
  throw new Error('agentenact: no program address');
}

/** A cursor over the message bytes; any read past the end is a bad payload. */
function reader(bytes: Uint8Array) {
  let i = 0;
  const take = (n: number): Uint8Array => {
    if (i + n > bytes.length) throw spendRefusal('bad_payload');
    const out = bytes.slice(i, i + n);
    i += n;
    return out;
  };
  return {
    u8: () => take(1)[0]!,
    take,
    /** Solana's compact-u16 (shortvec). */
    short(): number {
      let v = 0;
      for (let s = 0; s < 3; s++) {
        const b = take(1)[0]!;
        v |= (b & 0x7f) << (7 * s);
        if (!(b & 0x80)) return v;
      }
      throw spendRefusal('bad_payload');
    },
    done: () => i === bytes.length,
  };
}

const u64le = (b: Uint8Array): bigint => b.reduceRight((n, x) => (n << 8n) | BigInt(x), 0n);

/**
 * Decode `messageBase64` for `payer` paying `payTo` on `network`. The caller checks the payer is the wallet it
 * holds and that `payTo` is the offer it approved. Exported for multi-tenant signers that keep their own keys.
 */
export async function decodeSolanaTransfer(messageBase64: string, network: Caip2, o: { payer: string; payTo: string }): Promise<SolanaTransfer> {
  const net = networkFor(network);
  if (net.chain !== 'solana') throw spendRefusal('wrong_network');
  if (!isSolanaAddress(o.payer) || !isSolanaAddress(o.payTo) || o.payer === o.payTo) throw spendRefusal('bad_payload');
  let message: Uint8Array;
  try {
    message = Uint8Array.from(atob(messageBase64), (c) => c.charCodeAt(0));
  } catch {
    throw spendRefusal('bad_payload');
  }
  const r = reader(message);
  let first = r.u8();
  let versioned = false;
  if (first & 0x80) {
    if ((first & 0x7f) !== 0) throw spendRefusal('unsupported_payload');
    versioned = true;
    first = r.u8();
  }
  const [signers, readonlySigned] = [first, r.u8()];
  r.u8(); // read-only unsigned count: writability of non-signers does not move the payer's funds
  const keys = Array.from({ length: r.short() }, () => base58Encode(r.take(32)));
  r.take(32); // recent blockhash
  if (signers !== 2 || readonlySigned < 1 || keys.length < 2) throw spendRefusal('unsupported_payload');
  // The fee payer is key 0 (writable signer); the payer must be the other, read-only signer.
  if (keys[0] === o.payer || keys[1] !== o.payer) throw spendRefusal('unknown_wallet');

  const asset = Object.values(net.assets)[0]!;
  let transfer: SpendIntent | null = null;
  let limit = 0, price = 0, memo = 0;
  const count = r.short();
  for (let n = 0; n < count; n++) {
    const program = keys[r.u8()];
    const accounts = Array.from({ length: r.short() }, () => keys[r.u8()]);
    const data = r.take(r.short());
    if (!program || accounts.some((a) => a === undefined)) throw spendRefusal('bad_payload');
    if (program === COMPUTE_BUDGET) {
      if (accounts.length !== 0) throw spendRefusal('unsupported_payload');
      if (data[0] === 2 && data.length === 5) limit++;
      else if (data[0] === 3 && data.length === 9) price++;
      else throw spendRefusal('unsupported_payload');
      continue;
    }
    if (program === MEMO) {
      if (accounts.length !== 0 || data.length > MAX_MEMO_BYTES) throw spendRefusal('unsupported_payload');
      memo++;
      continue;
    }
    if (program !== TOKEN && program !== TOKEN_2022) throw spendRefusal('unsupported_payload');
    if (transfer || data.length !== 10 || data[0] !== TRANSFER_CHECKED || accounts.length !== 4) throw spendRefusal('unsupported_payload');
    const [source, mint, destination, authority] = accounts as [string, string, string, string];
    if (mint !== asset.asset) throw spendRefusal('unknown_asset');
    if (data[9] !== asset.decimals) throw spendRefusal('bad_payload');
    if (authority !== o.payer) throw spendRefusal('unknown_wallet');
    if (source !== (await associatedTokenAddress(o.payer, mint, program))) throw spendRefusal('bad_payload');
    if (destination !== (await associatedTokenAddress(o.payTo, mint, program))) throw spendRefusal('bad_payload');
    const amount = u64le(data.slice(1, 9));
    if (amount <= 0n) throw spendRefusal('bad_amount');
    transfer = { network, asset: asset.asset, amount, from: o.payer, payTo: o.payTo };
  }
  if (versioned && r.short() !== 0) throw spendRefusal('unsupported_payload'); // address-table lookups
  if (!r.done() || !transfer || limit > 1 || price > 1 || memo > 1) throw spendRefusal('unsupported_payload');
  return { intent: transfer, message };
}
