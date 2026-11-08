import { describe, expect, it } from 'bun:test';
import { createSolanaAdapter, ed25519Sign, solanaAddressOf } from '../../src/adapters/solana';
import { base58Decode, base58Encode, isSolanaAddress } from '../../src/base58';
import { bytesToHex } from '../../src/record';

// A real devnet getTransaction answer (2026-11-01): one Circle USDC transferChecked of 10 base units.
const RECORDED = (await Bun.file(new URL('./fixtures/solana-devnet-usdc-transfer.json', import.meta.url)).json()) as { result: Record<string, unknown> };
const SIG = 'eHnxcGEbrQKB26qMVSzDEb64N5J7yQxwHnww6cHhvSw9uDNexebwscwGBtsiTeU5w76my8udmvU2yFiE2oQAjpU';
const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as const;

const rpc = (answer: (method: string, params: unknown[]) => unknown) =>
  (async (_url: string | URL | Request, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...(answer(method, params) as object) }));
  }) as typeof fetch;

describe('solana adapter', () => {
  it('base58 round-trips, keeps leading zeros, and checks a 32-byte address', () => {
    const bytes = new Uint8Array([0, 0, 1, 2, 255]);
    expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
    expect(isSolanaAddress('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')).toBe(true);
    expect(isSolanaAddress('11111111111111111111111111111111')).toBe(true);
    expect(isSolanaAddress('0xabc')).toBe(false);
    expect(isSolanaAddress(base58Encode(new Uint8Array(31).fill(9)))).toBe(false);
    expect(isSolanaAddress(base58Encode(new Uint8Array(33).fill(9)))).toBe(false);
  });

  it('signs a digest with the seed and verifies against the base58 address; a 64-byte keypair signs the same', async () => {
    const a = createSolanaAdapter({ network: DEVNET, fetch: rpc(() => ({})) });
    const seed = new Uint8Array(32).fill(7);
    const address = await solanaAddressOf(seed);
    expect(isSolanaAddress(address)).toBe(true);
    const digest = new Uint8Array(32).fill(1);
    const sig = await a.sign(digest, seed);
    expect(sig).toMatch(/^[0-9a-f]{128}$/);
    expect(await a.verify(digest, sig, address)).toBe(true);
    expect(await a.sign(digest, new Uint8Array([...seed, ...base58Decode(address)]))).toBe(sig);
    expect(await a.verify(new Uint8Array(32), sig, address)).toBe(false);
    expect(await a.verify(digest, sig, '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')).toBe(false);
    expect(await a.verify(digest, 'zz', address)).toBe(false);
    expect(bytesToHex(await ed25519Sign(digest, seed))).toBe(sig);
  });

  it('reads a recorded devnet USDC transfer: authority pays, the destination owner is paid, block time as the close time', async () => {
    const a = createSolanaAdapter({ network: DEVNET, fetch: rpc(() => RECORDED) });
    expect(await a.readSettlement(SIG)).toEqual([
      {
        chain: 'solana',
        ref: SIG,
        payer: 'Duq87BDTWEH6eH1M5uGp1vE2p7WxoEPXZ9dCxoQFEmXH',
        payee: 'CUt94yGknVuLLMZtYexd77c6a28nRQVwSoky9HYt5t5D',
        amount: '0.000010',
        asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        at: '2026-11-01T09:47:56Z',
      },
    ]);
    expect(await a.resolveIdentity('1')).toBeNull();
  });

  it('a missing or failed transaction, an unknown mint and a bad ref read as no payment; an RPC error throws', async () => {
    const tx = RECORDED.result as { meta: Record<string, unknown> & { postTokenBalances: { mint: string }[]; preTokenBalances: { mint: string }[] }; transaction: { message: { instructions: { parsed: { info: Record<string, unknown> } }[] } } };
    const failed = { result: { ...tx, meta: { ...tx.meta, err: { InstructionError: [0, 'Custom'] } } } };
    expect(await createSolanaAdapter({ network: DEVNET, fetch: rpc(() => ({ result: null })) }).readSettlement(SIG)).toEqual([]);
    expect(await createSolanaAdapter({ network: DEVNET, fetch: rpc(() => failed) }).readSettlement(SIG)).toEqual([]);
    const fake = 'So11111111111111111111111111111111111111112';
    const other = structuredClone(tx);
    for (const b of [...other.meta.postTokenBalances, ...other.meta.preTokenBalances]) b.mint = fake;
    other.transaction.message.instructions[0]!.parsed.info.mint = fake;
    expect(await createSolanaAdapter({ network: DEVNET, fetch: rpc(() => ({ result: other })) }).readSettlement(SIG)).toEqual([]);
    expect(await createSolanaAdapter({ network: DEVNET, fetch: rpc(() => RECORDED) }).readSettlement('0xnot')).toEqual([]);
    expect(createSolanaAdapter({ network: DEVNET, fetch: rpc(() => ({ error: { message: 'boom' } })) }).readSettlement(SIG)).rejects.toThrow(/boom/);
    expect(() => createSolanaAdapter({ network: 'eip155:84532' as never })).toThrow(/not a Solana network/);
  });
});
