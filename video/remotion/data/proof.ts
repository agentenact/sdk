// Real Enactment Record + settlement, captured on Stellar testnet.
// Source: /Users/knrs/Developer/PROJECTS/agentenact/site/public/proofs/latest.json
// (copied as literals — not imported — so the video bundle never reaches
// outside video/). Values are exact; only display formatting (shortened
// hashes) happens in the scenes.

export const PROOF = {
  network: 'Stellar testnet',
  capturedAt: '2026-09-22T21:35:25.094Z',

  agent: {
    full: 'GDO73LCGQTKWCEKQ55C5BUBOFKGCAXXOP6MZ35YQ6BRSQKCKDDSAWECM',
    short: 'GDO73LCG…SAWECM',
  },

  input: {
    sha256Full: '78423bdf0afa22997f74d9c7a9c15fcd1400db82a4c74ca3b4da47e17aebaddb',
    sha256Short: '78423bdf…ebaddb',
    mediaType: 'text/plain',
  },

  output: {
    sha256Full: '4135af45e93f3646c1657873f49721b73a1f4e2398aa8c976123018901aacf4e',
    sha256Short: '4135af45…aacf4e',
    mediaType: 'application/json',
    bytes: 109,
    // The actual captured output text — a real agent response, not a mock.
    text: '{"summary":"Paid outputs carry a signed record tying input, output and settlement together.","inputBytes":76}',
  },

  settlement: {
    chain: 'stellar',
    refFull: 'f2a1cf804df37d1e779d759ef87bbeca5b37fa9bcca75fc2d59ad92e0eb47f75',
    refShort: 'f2a1cf80…b47f75',
    payerFull: 'GCH36APKUXHZV7XIYRNACW353E6AWT5TTCEEOHRSWHMS2BM74DVNKNZ3',
    payerShort: 'GCH36APK…NKNZ3',
    amount: '0.001',
    assetCode: 'USDC',
    assetIssuerShort: 'GBBD47IF…LLFLA5',
    at: '2026-09-22T21:35:22Z',
  },

  issuedAt: '2026-09-22T21:35:24.765Z',
  // issuedAt is 2.7s after settlement.at — well inside the 24h timing window.
  timingDeltaLabel: '+2.7s',

  sig: {
    alg: 'ed25519',
    valueShort: '7fc36d24…7f8b0d',
  },

  verification: {
    ok: true,
    checks: {
      signature: 'pass' as const,
      settlement: 'pass' as const,
      timing: 'pass' as const,
      identity: 'skipped' as const, // real result — identity check is skipped on testnet
    },
  },

  explorer: 'https://stellar.expert/explorer/testnet/tx/f2a1cf804df37d1e779d759ef87bbeca5b37fa9bcca75fc2d59ad92e0eb47f75',
} as const;
