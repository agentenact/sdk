import { describe, expect, it } from 'bun:test';
import { NETWORKS, formatUnits, networkFor, parseUnits, recordAsset } from '../src/networks.js';
import { CHAINS } from '../src/record.js';
import { STELLAR_USDC } from '../src/adapters/stellar.js';

describe('networks', () => {
  it('maps the Stellar pubnet USDC SAC to the pinned CODE:ISSUER', () => {
    expect(recordAsset('stellar:pubnet', 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75')).toEqual({ asset: STELLAR_USDC, decimals: 7 });
  });
  it('maps testnet USDC to the Circle testnet issuer', () => {
    expect(recordAsset('stellar:testnet', 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA').asset).toBe(
      'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    );
  });
  it('maps EVM USDC to the lowercase token address with 6 decimals', () => {
    expect(recordAsset('eip155:42220', '0xcebA9300f2b948710d2653dD7B07f33A8B32118C')).toEqual({
      asset: '0xceba9300f2b948710d2653dd7b07f33a8b32118c',
      decimals: 6,
    });
    expect(recordAsset('eip155:5042002', '0x3600000000000000000000000000000000000000').decimals).toBe(6);
  });
  it('throws on unknown network or asset (fail closed)', () => {
    expect(() => networkFor('eip155:1')).toThrow(/unsupported network/);
    expect(() => recordAsset('stellar:pubnet', 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toThrow(/unknown asset/);
  });
  it('formatUnits / parseUnits round-trip', () => {
    expect(formatUnits('10000', 7)).toBe('0.0010000');
    expect(formatUnits(123456789n, 6)).toBe('123.456789');
    expect(parseUnits('0.001', 7)).toBe(10000n);
    expect(parseUnits('1', 6)).toBe(1000000n);
    expect(() => parseUnits('0.00000001', 7)).toThrow(/precision/);
  });
  it('every network carries a chain the core knows', () => {
    for (const n of Object.values(NETWORKS)) expect(CHAINS).toContain(n.chain);
  });
  it('Base Sepolia pins Circle USDC in 6 decimals and the ERC-8004 testnet registry', () => {
    expect(recordAsset('eip155:84532', '0x036CbD53842c5426634e7929541eC2318f3dCF7e')).toEqual({ asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', decimals: 6 });
    expect(networkFor('eip155:84532')).toMatchObject({ chain: 'base', identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e' });
  });
  it('Arbitrum, Avalanche and Polygon pin Circle USDC with the testnet registry on testnets and the mainnet one on mainnets', () => {
    const rows: [string, string, string, string][] = [
      ['eip155:421614', 'arbitrum', '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', '0x8004A818BFB912233c491871b3d84c89A494BD9e'],
      ['eip155:43113', 'avalanche', '0x5425890298aed601595a70AB815c96711a31Bc65', '0x8004A818BFB912233c491871b3d84c89A494BD9e'],
      ['eip155:80002', 'polygon', '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582', '0x8004A818BFB912233c491871b3d84c89A494BD9e'],
      ['eip155:8453', 'base', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'],
      ['eip155:42161', 'arbitrum', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'],
      ['eip155:43114', 'avalanche', '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'],
      ['eip155:137', 'polygon', '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'],
    ];
    for (const [caip2, chain, usdc, registry] of rows) {
      expect(recordAsset(caip2, usdc)).toEqual({ asset: usdc.toLowerCase(), decimals: 6 });
      expect(networkFor(caip2)).toMatchObject({ chain, identityRegistry: registry });
    }
  });
});
