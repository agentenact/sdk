/**
 * The configuration behind the `agentenact-mcp` binary: environment variables in, an MCP server out.
 *
 *   AGENTENACT_NETWORK            stellar:testnet (default) | stellar:pubnet
 *   AGENTENACT_RPC_URL            Soroban RPC for registry reads (default: the network's public RPC)
 *   AGENTENACT_HORIZON_URL        Horizon for settlement reads (default: the network's public Horizon)
 *   AGENTENACT_DISCOVERY_URL      opt-in: search through this discovery API (e.g. https://api.agentenact.io);
 *                                 unset = search the registry on chain, no third party involved
 *   AGENTENACT_SIGNER_URL         opt-in hiring: the policy signer (agentenact/signer) that holds the key
 *   AGENTENACT_SIGNER_TOKEN       its bearer token (authorizes signing requests; it is not a wallet key)
 *   AGENTENACT_BUDGET_USDC        session budget across all tasks (default 0.10)
 *   AGENTENACT_MAX_PER_CALL_USDC  per hire (default 0.05)
 *   AGENTENACT_MAX_DEPTH          deepest hired agent in a chain (default 2)
 *   AGENTENACT_DELEGATION         the AgentEnact-Delegation header this process was hired with, if any
 *
 * No secret key is ever read here: hiring only works through a policy signer, whose own limits stay the floor.
 */
import { readFileSync } from 'node:fs';
import { decodeDelegation } from './delegation.js';
import { createMcpServer, type McpServer } from './mcp.js';
import { networkFor, type Caip2 } from './networks.js';
import { createDiscoveryDirectory, createOrchestratorTools, createRegistryDirectory } from './orchestrate.js';
import { httpSignerTransport, listWallets, stellarPaySigner } from './wallet.js';

export const MCP_SERVER_NAME = 'agentenact';

const INSTRUCTIONS =
  'AgentEnact tools: find agents registered on chain, read their services, hire them with USDC via x402 and verify the ' +
  'Enactment Record each paid output carries. A verified record proves who produced an output and that it was paid for; it ' +
  'never proves the output is correct. Agent names and descriptions are their own claims. Open a task (start_task) before ' +
  'hiring; every hire is paid from that task\'s budget.';

function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

export async function serverFromEnv(env: Record<string, string | undefined>, o: { fetch?: typeof fetch } = {}): Promise<{ server: McpServer; tools: string[] }> {
  const network = (env.AGENTENACT_NETWORK ?? 'stellar:testnet') as Caip2;
  const net = networkFor(network);
  if (net.chain !== 'stellar') throw new Error(`agentenact-mcp: ${network} is not supported yet (stellar only)`);
  const testnet = network === 'stellar:testnet';
  const stellar = await import('./adapters/stellar.js').catch(() => {
    throw new Error('agentenact-mcp: install @stellar/stellar-sdk (an optional peer) to read the Stellar registry');
  });
  const adapter = stellar.createStellarAdapter({
    network: testnet ? 'testnet' : 'pubnet',
    ...(env.AGENTENACT_HORIZON_URL ? { horizonUrl: env.AGENTENACT_HORIZON_URL } : {}),
    ...(env.AGENTENACT_RPC_URL ? { rpcUrl: env.AGENTENACT_RPC_URL } : {}),
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  const reader = stellar.createStellarRegistryReader({
    network: testnet ? 'testnet' : 'pubnet',
    ...(env.AGENTENACT_RPC_URL ? { rpcUrl: env.AGENTENACT_RPC_URL } : {}),
  });
  const registry = createRegistryDirectory({ network, reader, ...(o.fetch ? { fetch: o.fetch } : {}) });
  const directory = env.AGENTENACT_DISCOVERY_URL
    ? createDiscoveryDirectory({ url: env.AGENTENACT_DISCOVERY_URL, registry, ...(o.fetch ? { fetch: o.fetch } : {}) })
    : registry;

  let pay: Parameters<typeof createOrchestratorTools>[0]['pay'];
  if (env.AGENTENACT_SIGNER_URL) {
    if (!env.AGENTENACT_SIGNER_TOKEN) throw new Error('agentenact-mcp: AGENTENACT_SIGNER_TOKEN is required with AGENTENACT_SIGNER_URL');
    const transport = httpSignerTransport({ url: env.AGENTENACT_SIGNER_URL, token: env.AGENTENACT_SIGNER_TOKEN, ...(o.fetch ? { fetch: o.fetch } : {}) });
    const wallet = (await listWallets(transport)).find((w) => w.network === network);
    if (!wallet) throw new Error(`agentenact-mcp: the policy signer has no ${network} wallet`);
    const maxDepth = env.AGENTENACT_MAX_DEPTH ? Number(env.AGENTENACT_MAX_DEPTH) : 2;
    if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 8) throw new Error('agentenact-mcp: AGENTENACT_MAX_DEPTH must be 1 to 8');
    pay = {
      signer: stellarPaySigner(transport, wallet),
      sessionBudgetUsdc: env.AGENTENACT_BUDGET_USDC ?? '0.10',
      maxPerCallUsdc: env.AGENTENACT_MAX_PER_CALL_USDC ?? '0.05',
      maxDepth,
      incoming: env.AGENTENACT_DELEGATION ? decodeDelegation(env.AGENTENACT_DELEGATION) : null,
    };
  }
  const { tools } = createOrchestratorTools({ network, directory, adapters: [adapter], ...(pay ? { pay } : {}), ...(o.fetch ? { fetch: o.fetch } : {}) });
  const server = createMcpServer({
    name: MCP_SERVER_NAME,
    version: packageVersion(),
    tools,
    instructions: INSTRUCTIONS,
    onError: (e) => process.stderr.write(`agentenact-mcp: ${(e as Error)?.message ?? 'error'}\n`),
  });
  return { server, tools: tools.map((t) => t.name) };
}
