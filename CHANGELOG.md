# Changelog

## 0.4.0 (2026-11-02)

More EVM networks and pay/verify on Solana devnet. No change to the record
format.

### Networks

- Arbitrum Sepolia (`eip155:421614`), Avalanche Fuji (`eip155:43113`) and
  Polygon Amoy (`eip155:80002`) join `NETWORKS`, with the Base, Arbitrum,
  Avalanche and Polygon mainnets.
- Solana devnet and mainnet (`solana:…`) entries, with pinned USDC.

### Solana

- `agentenact/adapters/solana`: ed25519 records, SPL transfers read from
  `getTransaction`, and the base58 helpers (`base58Encode`, `base58Decode`,
  `isSolanaAddress`).
- `hire()` pays over `@x402/svm` with a secret or a policy signer.
  `agentenact/signer` exports `decodeSolanaTransfer`, which refuses any message
  but one pinned-USDC transfer before signing.
- New optional peers: `@x402/svm` (`>=2.29.0 <3`) and `@solana/kit`
  (`>=8.0.0 <9`), loaded only by the Solana paths.

## 0.3.0 (2026-10-29)

Hire on EVM networks, and ready for Stellar Protocol 30 (Bell). No change to the
record format.

### Protocol 30

- `@stellar/stellar-sdk` peer moves to `>=16.4.1 <17` and `@x402/*` to
  `>=2.29.0 <3`. Protocol 30 (testnet vote 2026-11-03, mainnet 2026-11-23) puts
  a millisecond `StellarValue` (CAP-88) in every ledger header; stellar-sdk
  15.x and 16.0–16.3 throw on it in `rpc.getLatestLedger`, which `create` and
  the x402 client call before every Stellar payment. 0.2.0 users must upgrade
  before the testnet vote.
- `tests/protocol30.test.ts` pins a Protocol 30 header, close meta and a CAP-84
  muxed contract (`W…`) address.

### EVM hire

- `hire()` pays USDC on `eip155:*` through an EIP-3009 authorization (x402
  exact), with a raw key or an `evmPaySigner`. The payment guard checks EVM
  offers too: pinned token, a real non-zero `payTo`, case-insensitive self and
  `payTo` pins.
- Base Sepolia (`eip155:84532`, record chain `base`) joins `NETWORKS` with
  Circle USDC and the ERC-8004 testnet registry.
- `serve` lowercases an EVM payer before it enters the record;
  `agentenact/signer` exports `decodeEvmTransfer` for multi-tenant signers.

### Community templates

- `agentenact/community`: the `agentenact.template/1` format. A template's id
  is the sha256 of its canonical JSON; the author signs a domain-separated
  digest of it through any `ChainAdapter`. `verifyCommunityTemplate` checks
  format, signature, optional ERC-8004 identity (`author.agentId`), the
  index's own body check, and reports the anchor.
- `adapters/stellar`: `templateAnchorOperation(slug, sha256 | null)` (a
  `manage_data` op on the author's own account) and
  `createStellarTemplateAnchors` (reads it back from Horizon). Proven on
  testnet by `tests/e2e/community-anchor.testnet.test.ts`.

## 0.2.0 (2026-10-27)

Agents that hire agents, over MCP. No change to the record format: records stay
v0.1 / v0.2, and a parent output cites the records it used through the
`get_task` manifest.

### Orchestration

- `agentenact/orchestrate`: orchestrator tools as data. `find_agents` and
  `get_agent` read the stellar-8004 registry on chain (a discovery API is
  opt-in), `verify_record` runs the four checks, and `start_task`, `hire_agent`,
  `get_task`, `list_tasks` hire through `hire()` inside a session budget carved
  into per-task budgets. A hire is refused before anything is signed when the
  price is above `max_usdc`, the task budget or the per-call cap.
- `agentenact/mcp`: a zero-dependency MCP server (initialize with version
  negotiation, ping, tools/list, tools/call, cancellation) over stdio or
  stateless Streamable HTTP (`handleMcpHttp`). Raw tools see the request's
  `_meta`, which carries x402 over MCP.
- `agentenact-mcp` bin: the orchestrator tools over stdio for Claude Code,
  Codex, Hermes or any MCP client. Read-only by default; it never reads a key.
  With `AGENTENACT_SIGNER_URL` and `AGENTENACT_SIGNER_TOKEN` it pays through a
  policy signer (`agentenact/signer`), whose limits stay the floor.
- `AgentEnact-Delegation` header (root task, depth, payees). `hire_agent` sends
  it; `serve` takes `delegation: { maxDepth }` and answers 508 to a loop or a
  chain too deep, before the 402. Advisory: the money caps are the bound.
- `createStellarRegistryReader` in `adapters/stellar`: `total_agents` and one
  agent's owner, wallet and URI.

Proven on Stellar testnet on 2026-10-27: the `agentenact-mcp` binary,
driven by the MCP SDK client, found a freshly registered agent (agentId 108),
hired its service for 0.01 USDC through a policy signer (tx `b0b13845…`), and
the returned record passed all four checks, identity included.

## 0.1.1 (2026-10-27)

0.1.0 on npm shipped without `dist/`, so no subpath could be imported and the
`agentenact` bin was missing. 0.1.1 is the same source, packed with `dist/`.

- `prepack` now cleans, builds and checks that every file `main`, `types`,
  `bin` and `exports` point at exists, so a pack without `dist/` fails.
- `homepage` is <https://agentenact.io>.

## 0.1.0 (2026-10-27, deprecated: published without `dist/`)

The first release on npm (only the `0.0.1` name placeholder was published
before). Proven end to end on Stellar testnet; mainnet paths are read-only and
no mainnet transaction has been sent from this code.

### Records and verification

- Enactment Record **v0.1**: signed binding of `sha256(input)`, `sha256(output)`,
  the settlement transaction and the agent's on-chain identity; canonical bytes,
  digest and `Enactment-Record` header codec.
- Enactment Record **v0.2**: v0.1 plus the list of skills an output used
  (skills.sh id and the approved content `sha256`). v0.1 records still verify.
- `verifyRecord`: signature, settlement, timing and identity checks from public
  chain data. A settlement older than the history the Horizon still serves is
  `history_unavailable` (it does not verify, but is not reported as forged).
- `agentenact verify` CLI (`npx agentenact verify <record> --input … --output …`):
  the four checks plus local input/output hashes; exit 0 verified, 1 not, 2
  could not check.
- Conformance vectors in `tests/vectors/` (15 records, recorded Horizon and
  Soroban answers, pinned by `MANIFEST.sha256`) for verifiers in other languages.

### Chains

- `adapters/stellar`: ed25519, classic payments and Soroban transfers on
  Horizon, stellar-8004 identity.
- `adapters/evm`: Celo and Arc, EIP-191, ERC-20 `Transfer` logs, ERC-8004 `ownerOf`.

### Agents

- `serve`: x402-gated handler that emits a record per paid response
  (verify → run → settle → sign → send; bounded handler time).
- `hire`: pays via x402, then verifies the returned record; the payment guard
  refuses a bad offer before any signature and requires `maxAmount` with a payer.
- `create`: Stellar agent birth with a sponsor, an owner wallet or an
  auth-entry (passkey smart-wallet) owner; resume via `err.partial`; `sponsorLock`.
- `templates`: agent templates as data → registration doc, `agentUri`, serve handler.
- `skills`: find skills on skills.sh, review them, approve by pinned content hash.
- `wallet` / `signer`: multi-network agent wallets; the key stays in a policy
  signer outside the sandbox that signs within owner-set caps and allowlists.
