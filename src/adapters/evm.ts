/**
 * EVM adapter (Celo, Arc, Base Sepolia) for Enactment Records.
 *  - Signing: EIP-191 personal_sign over the RAW 32-byte digest (viem signMessage
 *    { raw }). Same scheme AgentKarma verifies for EVM claims.
 *  - Settlement: ERC-20 Transfer logs in the tx receipt; unknown tokens are skipped
 *    (never guessed); asset = token address lowercase.
 *  - Identity: ERC-8004 IdentityRegistry ownerOf + getAgentWallet, lowercase.
 * Only this file imports viem (optional peer).
 */
import { createPublicClient, decodeAbiParameters, http, keccak256, toHex, verifyMessage, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ChainAdapter, IdentityBinding, Settlement } from '../adapter.js';
import { bytesToHex } from '../record.js';
import { formatUnits, networkFor, recordAsset, type EvmCaip2 } from '../networks.js';

export interface EvmReadClient {
  getTransactionReceipt(args: { hash: Hex }): Promise<{
    status: 'success' | 'reverted';
    blockNumber: bigint;
    logs: Array<{ address: string; topics: readonly Hex[]; data: Hex }>;
  }>;
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
  readContract(args: { address: Hex; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }): Promise<unknown>;
}

export interface EvmAdapterOptions {
  network: EvmCaip2;
  rpcUrl?: string;
  identityRegistry?: Hex;
  /** Test seam: a viem PublicClient-like. */
  client?: EvmReadClient;
}

const TRANSFER_TOPIC = keccak256(toHex('Transfer(address,address,uint256)'));
const IDENTITY_ABI = [
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'getAgentWallet', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
] as const;

const topicToAddress = (t: Hex): string => `0x${t.slice(-40)}`.toLowerCase();

export function createEvmAdapter(opts: EvmAdapterOptions): ChainAdapter {
  const net = networkFor(opts.network);
  const registry = (opts.identityRegistry ?? net.identityRegistry) as Hex | undefined;
  const client: EvmReadClient =
    opts.client ?? (createPublicClient({ transport: http(opts.rpcUrl ?? net.rpcUrl) }) as unknown as EvmReadClient);

  return {
    chain: net.chain,
    sigAlg: 'secp256k1-eip191',

    async sign(digest, secret) {
      const account = privateKeyToAccount(`0x${bytesToHex(secret)}`);
      return account.signMessage({ message: { raw: digest.slice() } });
    },

    async verify(digest, signatureHex, address) {
      try {
        return await verifyMessage({ address: address as Hex, message: { raw: digest.slice() }, signature: signatureHex as Hex });
      } catch {
        return false;
      }
    },

    async readSettlement(ref): Promise<Settlement[]> {
      let receipt: Awaited<ReturnType<EvmReadClient['getTransactionReceipt']>>;
      try {
        receipt = await client.getTransactionReceipt({ hash: ref as Hex });
      } catch {
        return [];
      }
      if (receipt.status !== 'success') return [];
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      const at = new Date(Number(block.timestamp) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const out: Settlement[] = [];
      for (const log of receipt.logs) {
        if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length < 3) continue;
        let known: { asset: string; decimals: number };
        try {
          known = recordAsset(opts.network, log.address);
        } catch {
          continue; // unknown token: skip, never guess
        }
        const [value] = decodeAbiParameters([{ type: 'uint256' }], log.data);
        out.push({
          chain: net.chain,
          ref,
          payer: topicToAddress(log.topics[1]!),
          payee: topicToAddress(log.topics[2]!),
          amount: formatUnits(value, known.decimals),
          asset: known.asset,
          at,
        });
      }
      return out;
    },

    async resolveIdentity(agentId): Promise<IdentityBinding | null> {
      if (!/^\d+$/.test(agentId) || !registry) return null;
      const id = BigInt(agentId);
      try {
        const owner = (await client.readContract({ address: registry, abi: IDENTITY_ABI, functionName: 'ownerOf', args: [id] })) as string;
        const wallet = (await client.readContract({ address: registry, abi: IDENTITY_ABI, functionName: 'getAgentWallet', args: [id] })) as string;
        return { owner: owner.toLowerCase(), wallet: wallet ? wallet.toLowerCase() : null };
      } catch {
        return null; // ownerOf reverts for a non-existent token
      }
    },
  };
}
