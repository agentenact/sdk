# agentenact

Provable agent outputs. An **Enactment Record** is a signed document binding
`sha256(input)`, `sha256(output)`, the settlement transaction that paid for the
work, and the agent's on-chain identity. Anyone can verify it from public data.

It proves **attribution**, **payment binding** and **non-repudiation**. It does
not prove the output is correct, and uses no zero-knowledge machinery —
correctness is what reputation (AgentKarma) scores.

> **Testnet first.** 0.4.0 is proven end to end on Stellar **testnet**: paid x402
> calls, agent-to-agent hires, records verified from public data, and agent
> birth with sponsor, owner-wallet and passkey owners. The mainnet networks are in
> the table and their read paths (identity, settlement) are checked against
> mainnet, but no transaction has been sent to a mainnet from this code yet. Build
> and test on `stellar:testnet`; treat mainnet as unproven.

## Install

    bun add agentenact

Everything chain- or rail-specific is an optional peer, pulled only by the
subpath that needs it:

| subpath | needs |
|---|---|
| `agentenact` (record + verifier) | nothing |
| `agentenact/adapters/stellar` | `@stellar/stellar-sdk` |
| `agentenact/adapters/evm` | `viem` |
| `agentenact/adapters/solana` | nothing (JSON-RPC over fetch, WebCrypto Ed25519) |
| `agentenact/serve`, `agentenact/hire` | `@x402/core` `@x402/stellar` `@x402/fetch` (v2, same major); paying on Solana also `@x402/svm` `@solana/kit` |
| `agentenact/create` | `@stellar/stellar-sdk` |
| `agentenact/orchestrate`, `agentenact/mcp` | nothing (hire_agent needs the `hire` peers; the `agentenact-mcp` binary needs `@stellar/stellar-sdk`) |

## Serve — an x402-gated agent that proves every paid output

```ts
import { createEnactServer } from 'agentenact/serve';
import { createStellarAdapter, stellarSecretToBytes } from 'agentenact/adapters/stellar';

const handler = await createEnactServer({
  network: 'stellar:testnet',
  agent: { address: AGENT_G_ADDRESS, agentId: '31', secret: stellarSecretToBytes(process.env.AGENT_SECRET!) },
  adapter: createStellarAdapter({ network: 'testnet' }),
  price: '$0.001',
  facilitator: { url: 'https://channels.openzeppelin.com/x402/testnet', apiKey: process.env.OZ_API_KEY! },
  resource: 'https://agent.example/summarise',
  handler: async (input) => ({ body: await summarise(input), mediaType: 'application/json' }),
});

Bun.serve({ port: 3000, fetch: handler }); // or any Request → Response host
```

Order inside the handler is the invariant: **verify → run in memory → settle →
sign → send**. A handler error means nothing is settled. A settlement failure
means the output is discarded. A success returns the body plus
`PAYMENT-RESPONSE` and `Enactment-Record` headers bound to the real tx hash.

A Stellar x402 auth entry expires `maxTimeoutSeconds` after the client signs it
(x402 default 300 s), so the handler is bounded by `handlerTimeoutMs` (default
45 s, a wide margin inside that window): a slow handler
returns 504 **before** settlement rather than settling into an expired entry.
Nothing that can fail on the agent's side runs after money has moved; if the
record step itself fails, the response is a 500 that still carries
`PAYMENT-RESPONSE` and the transaction hash.

## Hire — pay, receive, verify

```ts
import { hire } from 'agentenact/hire';
import { createStellarAdapter } from 'agentenact/adapters/stellar';

const r = await hire('https://agent.example/summarise', { method: 'POST', body: text }, {
  adapter: createStellarAdapter({ network: 'testnet' }),
  payer: { secret: process.env.PAYER_SECRET!, network: 'stellar:testnet' },
  maxAmount: '0.05', // required with a payer: the most this call may pay, in USDC
});
// r.output, r.settlement.transaction, r.paid, r.record, r.verification.checks, r.consistent, r.problems
```

`hire` pays whatever the seller's 402 asks, so it checks the offer first and
refuses **before anything is signed or sent** (it throws an error with
`code: 'payment_refused'` and a `reason`). With a `payer`, `maxAmount` is
required. The offer must be the network's pinned USDC (or the `asset` you pin,
as `CODE:ISSUER`), `exact` scheme, x402 v2, a valid `payTo` that is not the
payer (or the `payTo` you pin), an amount at most `maxAmount`, and an
authorization lifetime of at most 300 s. One offer is approved and paid once;
a second payment request is refused. `onPay(offer)` runs right before the
signed payment leaves (reserve a spend there; throw to refuse, nothing is
sent). `createPaymentGuard` and `checkPaymentRequired` are exported from
`agentenact/hire` for callers that wrap their own fetch.

`hire` never throws on a bad record. `consistent` is true only when the record
verifies from public data **and** its input hash, output hash and settlement
reference match what this client sent, received and paid.

## Wallets — keys outside the sandbox, spending inside a policy

An agent can own wallets on several networks (any network in `NETWORKS`:
Stellar, Celo, Arc). The keys never enter the agent's sandbox. They live in a
**policy signer** on the operator's infra, which signs on its own, with no
human per transaction, whenever a request fits the spend policy the owner set
once:

```ts
// outside the sandbox (operator infra)
import { createPolicySigner, createSignerHandler, generateWalletKey } from 'agentenact/signer';

const evm = await generateWalletKey('eip155:5042002'); // store evm.secret here; give the agent only the address
const signer = await createPolicySigner({
  keys: [{ network: 'stellar:testnet', secret: process.env.AGENT_STELLAR_SECRET! }, evm],
  policy: {
    rules: [
      { network: 'stellar:testnet', asset: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', perTx: '0.05', perWindow: '5' },
      { network: 'eip155:5042002', asset: '0x3600000000000000000000000000000000000000', perTx: '0.05', perWindow: '5', payTo: ['0x…'] },
    ],
    expiresAt: '2026-12-31T00:00:00Z',
  },
  // ledger: a persistent SpendLedger; the default is in memory and forgets the window on restart
});
Bun.serve({ port: 7402, fetch: createSignerHandler(signer, { token: process.env.SIGNER_TOKEN! }) });

// inside the sandbox (the agent)
import { httpSignerTransport, listWallets, stellarPaySigner, evmPaySigner } from 'agentenact/wallet';
const transport = httpSignerTransport({ url: process.env.SIGNER_URL!, token: process.env.SIGNER_TOKEN! });
const [stellar] = await listWallets(transport);
await hire(url, init, { adapter, payer: { signer: stellarPaySigner(transport, stellar), network: 'stellar:testnet' }, maxAmount: '0.05' });
```

The signer never trusts the agent's description of a payment. It decodes the
exact payload it signs: on Stellar, the auth-entry preimage (only a single
pinned-SAC `transfer` from this wallet, on this network, no sub-invocations);
on EVM, EIP-3009 `TransferWithAuthorization` typed data (canonical fields,
this chain id, a pinned token, from this wallet, valid at most 300 s). The
amount, asset and payee checked against the policy are the ones in that
payload. Check, count and sign run under one lock. A spend is counted when it
is signed, whether or not it settles. Anything else is refused with
`{ ok: false, reason }` (`no_rule`, `over_per_tx`, `over_window`,
`pay_to_not_allowed`, `policy_expired`, `unsupported_payload`, …).

`httpSignerTransport` POSTs only the request and the bearer token to the URL
you give it (serve the handler where only the sandbox can reach it); a
refusal comes back as `{ ok: false, reason }`, a network failure or timeout
throws. `stellarPaySigner` and `evmPaySigner` have the shapes `@x402/stellar` and
`@x402/evm` clients expect; `solanaPaySigner` sends each Solana transfer message
with the offer's `payTo`. `hire` pays on Stellar, on the EVM networks below (USDC
through an EIP-3009 authorization, x402 `exact`; the payer needs no gas) and on
Solana (one SPL `TransferChecked` whose fee the seller's facilitator pays; the
signer decodes the message with `decodeSolanaTransfer` and refuses anything else):

```ts
const [base] = (await listWallets(transport)).filter((w) => w.network === 'eip155:84532');
await hire(url, init, { adapter: createEvmAdapter({ network: 'eip155:84532' }), payer: { signer: evmPaySigner(transport, base), network: 'eip155:84532' }, maxAmount: '0.05' });
```

## Create — an agent born with an account, a trustline and an identity

```ts
import { createStellarAgent } from 'agentenact/create';

const born = await createStellarAgent({
  network: 'stellar:testnet',
  sponsorSecret: process.env.SPONSOR_SECRET!, // your own funded account; never stored
  agentUri: 'https://agent.example/.well-known/agent.json',
});
// born.publicKey, born.secret (returned once), born.agentId, born.txs.{account,register}
```

Sponsored reserves (CAP-33) open the account and USDC trustline; the
registration is fee-bumped (CAP-15). The agent holds zero XLM at every step.

Or let an owner wallet hold the identity. The owner is any signer (Freighter,
a hardware wallet, a local key); its secret never enters the package:

```ts
const born = await createStellarAgent({
  network: 'stellar:testnet',
  owner: { publicKey, signTransaction: (xdr, networkPassphrase) => wallet.sign(xdr, networkPassphrase) },
  agentUri,
});
// born.owner, born.agentId, born.txs.{account,register,bind}
```

The owner sponsors the agent account, registers the identity, and binds the
agent as its wallet (`set_agent_wallet`, authorised by both). If a step fails
after the account opened, the thrown error carries `err.partial` with the
agent's secret, so nothing on chain is orphaned.

An owner that should never touch XLM (a passkey smart wallet, `C…`) can sign
auth entries only, while a separate sponsor sources and pays for every tx:

```ts
const born = await createStellarAgent({
  network: 'stellar:testnet',
  owner: { address: 'C…', signAuthEntry: (entryXdr, validUntilLedger, passphrase) => wallet.signAuthEntry(entryXdr, validUntilLedger, passphrase) },
  sponsor: { publicKey, signTransaction },
  agentUri,
  keypair, // optional: bring the agent key you already store
});
```

`signAuthEntry` must return the whole signed `SorobanAuthorizationEntry`
(base64 XDR): what a passkey kit's `signAuthEntry` or `authorizeEntry` (for a
`G…` owner) returns. Freighter's method of the same name returns a bare
signature and cannot be passed through as-is.

Concurrent births from one sponsor must not interleave their sponsor sequence.
Pass `sponsorLock: (work) => myMutex.run(work)` (sponsor and auth-entry owner
modes) and each sponsor-sourced tx runs in one call: from reading the sponsor
account through building, re-simulating, signing and submitting, until the submit
returned or failed. The lock is never nested and never held while the owner signs
an auth entry; the recording simulation (never submitted) reads the sponsor
account outside it. In sponsor mode only tx 1 is sponsor-sourced; the fee-bump
uses the agent's sequence. Your lock must release when `work` throws. Without
the option `work` just runs. Wallet-owner mode rejects the option.

The registry records the `C…` address as owner. Each registry call is
re-simulated with the signed entries before submit, so a bad owner signature
fails before anything is sent.

If an auth-entry birth stopped part-way (the owner never approved), pass the
same `keypair` with `resume: { account: true, agentId? }` to continue from what
is on chain instead of starting over. The library checks the account, its USDC
trustline and (with `agentId`) the registry's owner and wallet itself, throws
`code: 'resume_mismatch'` before sending anything if a fact does not hold, and
returns `txs` with only the transactions this call sent.

Careful: `{ account: true }` without `agentId` always sends `register_with_uri`.
Use it only when you know no registration was sent for this key (the owner never
signed it). If a register may have landed (confirm failed, unknown outcome), pass
`agentId` if you know it, or do not resume. When the identity is already bound to
the key, `resume` returns success after checking owner and wallet only; it does
not compare the registered URI.

## Templates — start an agent from a ready-made draft

```ts
import { fromTemplate, getTemplate, TEMPLATES } from 'agentenact/templates';

const agent = fromTemplate(getTemplate('translate')!, {
  params: { to: 'English' },
  name: 'TR→EN translator', // optional; the template has defaults for name, description, price
  model: async ({ instructions, input }) => myLlm(instructions, input), // your model, your key
});

await createStellarAgent({ network: 'stellar:testnet', owner, agentUri: agent.agentUri });
const handler = await createEnactServer({ network, agent: keys, adapter, facilitator, resource, ...agent.serve });
```

A template is plain data (`summarize`, `translate`, `extract`, `classify` ship
built in; `defineTemplate` validates your own): name, description and price
defaults, the input/output media types, a byte limit and the model
instructions with `{{param}}` slots. `fromTemplate` returns the ERC-8004
registration document inline as a `data:` URI and the `price`, `description`
and `handler` for `serve`. The package ships no model and calls nothing; the
handler only shapes the call to yours. Empty, oversized or non-UTF-8 input and
a JSON template's non-JSON answer throw inside the handler, so `serve` answers
500 before settlement and the payer is not charged.

## Community templates — publish one anyone can check

```ts
import { signCommunityTemplate, verifyCommunityTemplate } from 'agentenact/community';
import { createStellarAdapter, createStellarTemplateAnchors, templateAnchorOperation } from 'agentenact/adapters/stellar';

const adapter = createStellarAdapter({ network: 'testnet' });
const { template, sha256 } = await signCommunityTemplate({
  format: 'agentenact.template/1', slug: 'gas-spike', version: 1,
  title: 'Gas spike alert', summary: 'Emails you when network fees jump.',
  author: { network: 'stellar:testnet', address: author.publicKey() },
  createdAt: '2026-10-27T21:00:00Z', kind: 'agentenact.draft/1', body: draft,
}, authorSeed, adapter);

// optional: anchor it on your own account (one manage_data op, no contract)
tx.addOperation(templateAnchorOperation('gas-spike', sha256));

// any index, anyone
const v = await verifyCommunityTemplate(template, { adapter, anchors: createStellarTemplateAnchors({ network: 'testnet' }), checkBody });
// v.ok, v.sha256, v.anchor: 'anchored' | 'superseded' | 'unanchored' | 'unchecked'
```

A community template is one JSON document. Its id is the sha256 of its
canonical JSON (sorted keys, no whitespace), so any changed byte is a new id.
The author signs `sha256("agentenact.template/1:" + id)` with their chain key,
through the same adapter that signs records; the prefix keeps a template
signature from ever passing as a record signature. With `author.agentId` the
verifier also checks the key owns that ERC-8004 agent or is its wallet. An optional
`author.name` (3–24 of `a-z 0-9 _ -`, so no look-alike letters) is signed with
the rest; it names the author, it proves nothing, so show it next to the
address. To change or drop a handle without publishing a template, sign an
`agentenact.handle/1` change (`signHandleChange`); an index keeps the newest
`issuedAt` per key, so an old change cannot be replayed.

Anchoring is optional and lives on the author's own account: on Stellar a
`manage_data` entry `ae.tpl:<slug>` holding the 32 hash bytes (0.5 XLM
reserve, refunded when removed). One entry per slug, so a new version
supersedes the old one; Horizon's history keeps every earlier anchor. There is
no template registry and no contract: any index can rebuild its list from the
documents and the authors' accounts. What a `body` means is the index's call
(`checkBody`). This proves who published which bytes; never that a template is
good.

## Orchestrate — agents that hire agents, over MCP

`agentenact-mcp` is a Model Context Protocol server (stdio) that gives any MCP
harness the tools to coordinate other agents, every hop provable:

| tool | does |
|---|---|
| `find_agents` | search the stellar-8004 registry, newest first, by what agents publish about themselves |
| `get_agent` | owner and wallet from chain, plus the agent's self-published services (url, price, input schema) |
| `verify_record` | the four checks on any Enactment Record, optionally that a given input/output is what it hashed |
| `start_task` | open a task with a USDC budget carved from the session budget |
| `hire_agent` | pay a service via x402 under the payment guard, inside the task budget; returns output + verified record |
| `get_task`, `list_tasks` | what was paid to whom, tx hashes, child record digests, and a `manifest` |

Read-only by default: discovery reads the registry on chain (no indexer, no
third-party API). Hiring turns on only with a policy signer
(`agentenact/signer`), so the MCP process never holds a key and the signer's
own limits stay the floor under the session, task and per-call caps.

```bash
# Claude Code
claude mcp add agentenact -e AGENTENACT_NETWORK=stellar:testnet -- npx -y -p agentenact -p @stellar/stellar-sdk@16 agentenact-mcp

# Codex (~/.codex/config.toml)
[mcp_servers.agentenact]
command = "npx"
args = ["-y", "-p", "agentenact", "-p", "@stellar/stellar-sdk@16", "agentenact-mcp"]
env = { AGENTENACT_NETWORK = "stellar:testnet" }
```

`npx` does not install optional peers, hence the explicit `-p @stellar/stellar-sdk@16` (the peer range is `>=16.4.1 <17`, the first line that reads Protocol 30 ledgers);
hiring also needs `-p @x402/core -p @x402/stellar -p @x402/fetch`. Any other
harness that runs stdio MCP servers takes the same command. Settings
(environment): `AGENTENACT_NETWORK`, `AGENTENACT_RPC_URL`, `AGENTENACT_HORIZON_URL`,
`AGENTENACT_DISCOVERY_URL` (opt-in search API), `AGENTENACT_SIGNER_URL` +
`AGENTENACT_SIGNER_TOKEN` (enable hiring), `AGENTENACT_BUDGET_USDC` (default 0.10),
`AGENTENACT_MAX_PER_CALL_USDC` (0.05), `AGENTENACT_MAX_DEPTH` (2),
`AGENTENACT_DELEGATION` (the chain this process was hired with).

**Delegation.** Each hire carries an `AgentEnact-Delegation` header (root task,
depth, payees so far). `hire_agent` refuses a payee already in the chain
(A → B → A) or a hire past the max depth before anything is signed, and
`createEnactServer({ delegation: { maxDepth } })` lets a seller refuse the same
with 508 before its 402. The header is advisory, a foreign agent can drop it;
the money caps are what bound spend.

**Record chaining** needs no format change: `get_task` returns a `manifest` of
the child records used. An orchestrator that includes it in its own output
commits to it through its own record's `output.sha256`. That proves who was paid
and which records the orchestrator claims to have used, not that it used them well.

The same tools are plain data (`createOrchestratorTools` from
`agentenact/orchestrate`), so a model loop can use them without MCP, and
`createMcpServer` from `agentenact/mcp` serves them over any transport.

## Verify — anyone

```ts
import { decodeRecordHeader, verifyRecord } from 'agentenact';
import { createStellarAdapter } from 'agentenact/adapters/stellar';

const result = await verifyRecord(decodeRecordHeader(headerValue), createStellarAdapter({ network: 'testnet' }));
// { ok, checks: { signature, settlement, timing, identity }, failure?, settlement? }
```

Checks, in order: signature over the canonical digest · the referenced tx pays
the agent the stated amount and asset from the stated payer · `issuedAt` is
after settlement and within 24h (`windowSeconds`) · if `agentId` is set, the
ERC-8004 identity registry binds it to the signing address.

A missing settlement is `not_found`, unless the record was issued before the
oldest ledger the Horizon still serves: then it is `history_unavailable`
(testnet resets and pruned nodes remove old payments). Either way it does not
verify; the second only means the record can no longer be checked.

From a terminal (needs `@stellar/stellar-sdk` next to the package):

```bash
npx agentenact verify record.json --input in.txt --output out.json
# MATCH signature / MATCH settlement / MATCH timing / MATCH identity
# MATCH input sha256 … / MATCH output sha256 …
# VERIFIED: signer, payment and timing check out. This says nothing about whether the output is right.
```

`<record>` is a file, an https URL, or an `Enactment-Record` header value.
`--network pubnet|testnet` (default testnet), `--horizon <url>` to read from a
Horizon of your choice, `--json` for the raw result. Exit 0 verified, 1 not, 2
could not check.

Conformance vectors in `tests/vectors/` pin the verdict for 15 records (real
testnet records, tampered copies, and records signed with a published test-only
key), replayed offline from recorded Horizon and Soroban answers. A verifier in
another language can run the same files.

## Record shape (v0.1, v0.2)

```ts
{
  v: '0.1' | '0.2',
  agent: { chain, address, agentId? },
  input:  { sha256, mediaType? },
  output: { sha256, mediaType?, bytes? },
  skills: [{ id, sha256 }], // v0.2 only, required there; sorted by id, may be empty
  settlement: { chain, ref, payer, amount, asset },
  issuedAt, // RFC 3339 UTC
  nonce,    // 16 random bytes, hex
  sig: { alg: 'ed25519' | 'secp256k1-eip191', value }
}
```

`settlement.asset` is the chain's unspoofable asset identity: `CODE:ISSUER` on
Stellar (`STELLAR_USDC` is Circle's), the lowercase token address on EVM chains,
the mint on Solana.
A bare "USDC" never verifies. The Stellar adapter reads classic payments and
Soroban `invoke_host_function` transfers (how x402 and MPP settlements appear).

v0.2 adds `skills`: the approved skills (`agentenact/skills` content hashes) the
agent says it used for this output. `serve` issues v0.2 only when the handler
returns `skills` (e.g. `recordSkills(kit.used())`); otherwise v0.1, byte for byte
as before. It is the agent's signed statement, not proof the skills ran.

Canonical bytes are fixed-order JSON without whitespace and without `sig`;
the signed digest is `sha256(canonical)`. Input and output bytes never leave
the parties — only their hashes are in the record.

## Networks

`stellar:testnet` (proven end to end), `stellar:pubnet`, `eip155:42220` (Celo),
`eip155:5042002` (Arc testnet), `eip155:84532` (Base Sepolia, record chain `base`),
`eip155:421614` (Arbitrum Sepolia), `eip155:43113` (Avalanche Fuji), `eip155:80002`
(Polygon Amoy), `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (Solana devnet), and for
verifying records only the mainnets `eip155:8453`, `eip155:42161`, `eip155:43114`,
`eip155:137` and `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`. Solana has no ERC-8004
registry, so a Solana record never carries an `agentId`. Unknown networks and assets throw; nothing is
guessed. On `stellar:pubnet` only reads have been exercised so far; registering
an identity there costs real XLM (simulate first).

## Invariants

Keys are generated and held by the operator; nothing here transmits one.
Agents serve directly — no proxy, escrow or relay. No token, no competing
registry, no competing manifest format. Enforced by `tests/invariants.test.ts`.

## Status

0.4.0 (testnet-proven): record v0.1 and v0.2, verifier and
the `agentenact verify` CLI, Stellar + EVM adapters, `serve`, `hire`, `create`
(sponsor, owner-wallet and auth-entry owners, resume, `sponsorLock`), `templates`,
`skills`, the `wallet` / `signer` policy signer, and orchestration over MCP
(`orchestrate`, `mcp`, the `agentenact-mcp` bin, delegation headers).
Offline suite green; testnet x402 serve → hire → verify and agent birth proven end
to end; Stellar and Celo identity reads and a real Soroban USDC transfer verified
against mainnet (read-only). The Stellar testnet x402 loop
(`tests/e2e/stellar-testnet.test.ts`) is opt-in and needs a funded payer plus
an OpenZeppelin Channels key — see `scripts/testnet-setup.ts`.
