import { describe, expect, it } from 'bun:test';
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from '@solana-program/compute-budget';
import { findAssociatedTokenPda, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromPrivateKeyBytes,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
} from '@solana/kit';
import { solanaAddressOf } from '../src/adapters/solana';
import { associatedTokenAddress, decodeSolanaTransfer } from '../src/solana-transfer';

const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as const;
const USDC = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const MEMO = address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
// PayAI's devnet fee payer, as its /supported listed it on 2026-11-01.
const FEE_PAYER = address('2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4');
const BLOCKHASH = { blockhash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' as never, lastValidBlockHeight: 1n };

const seed = new Uint8Array(32).fill(3);
const payer = await createKeyPairSignerFromPrivateKeyBytes(seed);
const seller = address(await solanaAddressOf(new Uint8Array(32).fill(4)));

/** The message as @x402/svm's ExactSvmScheme builds it, base64 of the bytes the payer signs. */
async function built(o: { amount?: bigint; mint?: Address; feePayer?: Address; extra?: Instruction[]; payTo?: Address; version?: 0 | 'legacy'; decimals?: number } = {}) {
  const mint = o.mint ?? USDC;
  const [source] = await findAssociatedTokenPda({ mint, owner: payer.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const [destination] = await findAssociatedTokenPda({ mint, owner: o.payTo ?? seller, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const transfer = getTransferCheckedInstruction({ source, mint, destination, authority: payer, amount: o.amount ?? 10_000n, decimals: o.decimals ?? 6 });
  const memo: Instruction = { programAddress: MEMO, accounts: [], data: new TextEncoder().encode('a1b2c3d4e5f60718293a4b5c6d7e8f90') };
  const msg = pipe(
    createTransactionMessage({ version: o.version ?? 0 }),
    (m) => setTransactionMessageFeePayer(o.feePayer ?? FEE_PAYER, m),
    (m) => appendTransactionMessageInstructions([getSetComputeUnitLimitInstruction({ units: 20_000 }), getSetComputeUnitPriceInstruction({ microLamports: 1n }), transfer, memo, ...(o.extra ?? [])], m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(BLOCKHASH, m),
  );
  const tx = compileTransaction(msg);
  // The payer signs only the message bytes.
  return btoa(String.fromCharCode(...new Uint8Array(tx.messageBytes)));
}

const reason = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'decoded';
  } catch (e) {
    return (e as { reason?: string }).reason ?? String(e);
  }
};

describe('decodeSolanaTransfer', () => {
  it('derives the same associated token address as @solana-program/token', async () => {
    const [ata] = await findAssociatedTokenPda({ mint: USDC, owner: seller, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(await associatedTokenAddress(seller, USDC, TOKEN_PROGRAM_ADDRESS)).toBe(ata);
  });

  it('decodes the x402 exact message (v0 and legacy) into the spend it moves', async () => {
    for (const version of [0, 'legacy'] as const) {
      const t = await decodeSolanaTransfer(await built({ version }), DEVNET, { payer: payer.address, payTo: seller });
      expect(t.intent).toEqual({ network: DEVNET, asset: USDC, amount: 10_000n, from: payer.address, payTo: seller });
    }
  });

  it('refuses anything else before a signature', async () => {
    const ok = { payer: payer.address, payTo: seller };
    const other = address(await solanaAddressOf(new Uint8Array(32).fill(9)));
    expect(await reason(decodeSolanaTransfer(await built(), 'eip155:84532', ok))).toBe('wrong_network');
    expect(await reason(decodeSolanaTransfer(await built({ mint: address('So11111111111111111111111111111111111111112') }), DEVNET, ok))).toBe('unknown_asset');
    expect(await reason(decodeSolanaTransfer(await built({ feePayer: payer.address }), DEVNET, ok))).not.toBe('decoded');
    expect(await reason(decodeSolanaTransfer(await built({ payTo: other }), DEVNET, ok))).toBe('bad_payload');
    expect(await reason(decodeSolanaTransfer(await built(), DEVNET, { payer: other, payTo: seller }))).toBe('unknown_wallet');
    expect(await reason(decodeSolanaTransfer(await built({ decimals: 7 }), DEVNET, ok))).toBe('bad_payload');
    expect(await reason(decodeSolanaTransfer(await built({ amount: 0n }), DEVNET, ok))).toBe('bad_amount');
    // A second transfer, or any other program, is refused.
    const [source] = await findAssociatedTokenPda({ mint: USDC, owner: payer.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const [dest] = await findAssociatedTokenPda({ mint: USDC, owner: other, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const second = getTransferCheckedInstruction({ source, mint: USDC, destination: dest, authority: payer, amount: 1n, decimals: 6 });
    expect(await reason(decodeSolanaTransfer(await built({ extra: [second] }), DEVNET, ok))).toBe('unsupported_payload');
    const system: Instruction = { programAddress: address('11111111111111111111111111111111'), accounts: [], data: new Uint8Array([2, 0, 0, 0]) };
    expect(await reason(decodeSolanaTransfer(await built({ extra: [system] }), DEVNET, ok))).toBe('unsupported_payload');
    // Garbage and a v1 message.
    expect(await reason(decodeSolanaTransfer(btoa('\x81\x02'), DEVNET, ok))).toBe('unsupported_payload');
    expect(await reason(decodeSolanaTransfer(btoa('\x02\x01'), DEVNET, ok))).toBe('bad_payload');
    expect(await reason(decodeSolanaTransfer('%%%', DEVNET, ok))).toBe('bad_payload');
  });
});
