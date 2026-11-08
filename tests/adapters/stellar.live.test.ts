import { describe, expect, it } from 'bun:test';
import { STELLAR_USDC, createStellarAdapter } from '../../src/adapters/stellar.js';

// Opt-in: AGENTENACT_LIVE=1 bun test tests/adapters/stellar.live.test.ts
const live = process.env.AGENTENACT_LIVE === '1';

// A real mainnet Soroban USDC SAC transfer (invoke_host_function), observed 2026-09-02:
// 19.97 USDC from GD3KBZI2… to contract CDHZXE6Y…. Horizon keeps full history, so
// this fixture is stable even though RPC getEvents retention is ~7 days.
const SOROBAN_USDC_TX = '0978f5aa4416b31a6b9872741e47ec574e048aa01870c7f777f0e2cdb809fddf';

describe.skipIf(!live)('stellar adapter — mainnet', () => {
  const adapter = createStellarAdapter();
  it('resolves AgentKarma agentId 66 to a G… owner', async () => {
    const b = await adapter.resolveIdentity('66');
    expect(b?.owner).toMatch(/^G[A-Z2-7]{55}$/);
  }, 30_000);
  it('returns null for an unregistered agentId', async () => {
    expect(await adapter.resolveIdentity('4000000000')).toBeNull();
  }, 30_000);
  it('reads a real Soroban USDC transfer from Horizon asset_balance_changes', async () => {
    const s = await adapter.readSettlement(SOROBAN_USDC_TX);
    expect(s).toEqual([
      {
        chain: 'stellar',
        ref: SOROBAN_USDC_TX,
        payer: 'GD3KBZI226VDYJP2FY2GPAHG6IHYOJQTR7XUV5RBONVMCV2CIIP2WIKB',
        payee: 'CDHZXE6YUCSUBSFYYENM4HKZWB5UMVUTXKSQJF4QGMAWZAO62IQCWUEI',
        amount: '19.9700000',
        asset: STELLAR_USDC,
        at: expect.stringMatching(/Z$/),
      },
    ]);
  }, 30_000);
  it('returns [] for a non-existent tx hash', async () => {
    expect(await adapter.readSettlement('0'.repeat(64))).toEqual([]);
  }, 30_000);
});
