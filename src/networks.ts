/**
 * Network table: CAIP-2 id → chain, endpoints, and the x402 `asset` → record
 * `settlement.asset` mapping. Unknown networks and assets THROW (fail closed);
 * a record must never carry an asset identity the verifier cannot pin.
 */
import type { Chain } from './record.js';

export type Caip2 =
  | 'stellar:pubnet'
  | 'stellar:testnet'
  | 'eip155:42220'
  | 'eip155:5042002'
  | 'eip155:84532'
  | 'eip155:421614'
  | 'eip155:43113'
  | 'eip155:80002'
  | 'eip155:8453'
  | 'eip155:42161'
  | 'eip155:43114'
  | 'eip155:137'
  | 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
  | 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
/** The EVM networks in the table. */
export type EvmCaip2 = Extract<Caip2, `eip155:${string}`>;
/** The Solana networks in the table (CAIP-2: the genesis hash prefix). */
export type SolanaCaip2 = Extract<Caip2, `solana:${string}`>;
export const SOLANA_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as const;
export const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' as const;

export interface NetworkInfo {
  caip2: Caip2;
  chain: Chain;
  label: string;
  /** keyed by the x402 `asset` string (SAC C… on Stellar, lowercase token address on EVM, the mint on Solana, case kept). */
  assets: Record<string, { asset: string; decimals: number }>;
  horizonUrl?: string;
  sorobanRpcUrl?: string;
  identityRegistry?: string;
  rpcUrl?: string;
}

const STELLAR_USDC_PUBNET = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const STELLAR_USDC_TESTNET = 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

export const NETWORKS: Record<Caip2, NetworkInfo> = {
  'stellar:pubnet': {
    caip2: 'stellar:pubnet',
    chain: 'stellar',
    label: 'Stellar mainnet',
    assets: { CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75: { asset: STELLAR_USDC_PUBNET, decimals: 7 } },
    horizonUrl: 'https://horizon.stellar.org',
    sorobanRpcUrl: 'https://mainnet.sorobanrpc.com',
    identityRegistry: 'CBGPDCJIHQ32G42BE7F2CIT3YW6XRN5ED6GQJHCRZSNAYH6TGMCL6X35',
  },
  'stellar:testnet': {
    caip2: 'stellar:testnet',
    chain: 'stellar',
    label: 'Stellar testnet',
    assets: { CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA: { asset: STELLAR_USDC_TESTNET, decimals: 7 } },
    horizonUrl: 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    // trionlabs/stellar-8004 testnet deployment; resolved live (find_owner / get_agent_wallet) on 2026-09-28.
    identityRegistry: 'CDE3K4COIAGWNNJQQLL26SYI3KBJF5FUDHXG5FA6GYDJCG7T5V7FIWZH',
  },
  'eip155:42220': {
    caip2: 'eip155:42220',
    chain: 'celo',
    label: 'Celo mainnet',
    assets: { '0xceba9300f2b948710d2653dd7b07f33a8b32118c': { asset: '0xceba9300f2b948710d2653dd7b07f33a8b32118c', decimals: 6 } },
    rpcUrl: 'https://forno.celo.org',
    identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  },
  'eip155:5042002': {
    caip2: 'eip155:5042002',
    chain: 'arc',
    label: 'Arc testnet',
    assets: { '0x3600000000000000000000000000000000000000': { asset: '0x3600000000000000000000000000000000000000', decimals: 6 } },
    rpcUrl: 'https://rpc.drpc.testnet.arc.io',
    identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  },
  'eip155:84532': {
    caip2: 'eip155:84532',
    chain: 'base',
    label: 'Base Sepolia',
    // Circle USDC (EIP-3009, domain "USDC" v2); name() and the code at both addresses read live on 2026-10-28.
    assets: { '0x036cbd53842c5426634e7929541ec2318f3dcf7e': { asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', decimals: 6 } },
    rpcUrl: 'https://sepolia.base.org',
    // ERC-8004 IdentityRegistry testnet deployment (name() = "AgentIdentity"), same address as on Arc testnet.
    identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  },
  // Circle USDC (EIP-3009, version "2") and the ERC-8004 testnet IdentityRegistry: code at both addresses read live on 2026-11-01.
  'eip155:421614': {
    caip2: 'eip155:421614',
    chain: 'arbitrum',
    label: 'Arbitrum Sepolia',
    assets: { '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d': { asset: '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d', decimals: 6 } },
    rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
    identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  },
  'eip155:43113': {
    caip2: 'eip155:43113',
    chain: 'avalanche',
    label: 'Avalanche Fuji',
    assets: { '0x5425890298aed601595a70ab815c96711a31bc65': { asset: '0x5425890298aed601595a70ab815c96711a31bc65', decimals: 6 } },
    rpcUrl: 'https://api.avax-test.network/ext/bc/C/rpc',
    identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  },
  'eip155:80002': {
    caip2: 'eip155:80002',
    chain: 'polygon',
    label: 'Polygon Amoy',
    assets: { '0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582': { asset: '0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582', decimals: 6 } },
    rpcUrl: 'https://polygon-amoy-bor-rpc.publicnode.com',
    identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  },
  // Mainnets: Circle USDC and the ERC-8004 mainnet IdentityRegistry (same address as on Celo), read live on 2026-11-01.
  // In the table so records from them verify; nothing here signs or sends.
  'eip155:8453': {
    caip2: 'eip155:8453',
    chain: 'base',
    label: 'Base',
    assets: { '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 } },
    rpcUrl: 'https://mainnet.base.org',
    identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  },
  'eip155:42161': {
    caip2: 'eip155:42161',
    chain: 'arbitrum',
    label: 'Arbitrum One',
    assets: { '0xaf88d065e77c8cc2239327c5edb3a432268e5831': { asset: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6 } },
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  },
  'eip155:43114': {
    caip2: 'eip155:43114',
    chain: 'avalanche',
    label: 'Avalanche',
    assets: { '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e': { asset: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', decimals: 6 } },
    rpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
    identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  },
  'eip155:137': {
    caip2: 'eip155:137',
    chain: 'polygon',
    label: 'Polygon',
    assets: { '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': { asset: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', decimals: 6 } },
    rpcUrl: 'https://polygon-bor-rpc.publicnode.com',
    identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  },
  // Circle USDC mints (6 decimals, classic SPL Token program), read live on 2026-11-01. Solana has no ERC-8004 registry:
  // records verify signature, settlement and timing there, never identity.
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': {
    caip2: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    chain: 'solana',
    label: 'Solana devnet',
    assets: { '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU': { asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', decimals: 6 } },
    rpcUrl: 'https://api.devnet.solana.com',
  },
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': {
    caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    chain: 'solana',
    label: 'Solana',
    assets: { EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 } },
    rpcUrl: 'https://api.mainnet-beta.solana.com',
  },
};

export function networkFor(caip2: string): NetworkInfo {
  const n = (NETWORKS as Record<string, NetworkInfo>)[caip2];
  if (!n) throw new Error(`agentenact: unsupported network ${caip2}`);
  return n;
}

export function recordAsset(caip2: string, x402Asset: string): { asset: string; decimals: number } {
  const n = networkFor(caip2);
  const key = n.chain === 'stellar' || n.chain === 'solana' ? x402Asset : x402Asset.toLowerCase();
  const a = n.assets[key];
  if (!a) throw new Error(`agentenact: unknown asset ${x402Asset} on ${caip2}`);
  return a;
}

/** "10000", 7 → "0.0010000" — whole-unit decimal string, fixed fraction width. */
export function formatUnits(baseUnits: string | bigint, decimals: number): string {
  const v = BigInt(baseUnits);
  const s = v.toString().padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals);
  return decimals === 0 ? int : `${int}.${frac}`;
}

export function parseUnits(decimal: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(decimal);
  if (!m) throw new Error(`agentenact: bad decimal ${decimal}`);
  const frac = m[2] ?? '';
  if (frac.length > decimals) throw new Error(`agentenact: ${decimal} exceeds ${decimals}-decimal precision`);
  return BigInt(m[1]! + frac.padEnd(decimals, '0'));
}
