import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, handleMcpHttp, serveStdio, type McpServer } from '../src/mcp.js';
import { toolRefusal, type OrchestratorTool } from '../src/orchestrate.js';

let aborted = false;
const tools: OrchestratorTool[] = [
  {
    name: 'echo',
    description: 'Echo',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(a) { return { said: (a as { text: string }).text }; },
  },
  {
    name: 'refuse',
    description: 'Always refuses',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run() { throw toolRefusal('over_task_budget'); },
  },
  {
    name: 'boom',
    description: 'Throws an internal error carrying a secret-looking message',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run() { throw new Error('SABCDEF secret stack'); },
  },
  {
    name: 'slow',
    description: 'Waits until aborted',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: (_a, signal) => new Promise((resolve) => signal!.addEventListener('abort', () => ((aborted = true), resolve({ aborted: true })))),
  },
];

/** Our server behind the official SDK client, over the SDK's own in-memory transport. */
async function sdkClient(server: McpServer): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  serverSide.onmessage = (m) => void server.handle(m).then((r) => r && serverSide.send(r as never));
  await serverSide.start();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

describe('MCP server against @modelcontextprotocol/sdk', () => {
  const errors: unknown[] = [];
  const server = createMcpServer({ name: 'agentenact', version: '0.1.1', tools, instructions: 'hi', onError: (e) => errors.push(e) });

  it('initializes, lists tools with schemas and annotations, and calls one', async () => {
    const c = await sdkClient(server);
    expect(c.getServerVersion()).toEqual({ name: 'agentenact', version: '0.1.1' });
    expect(c.getInstructions()).toBe('hi');
    const list = await c.listTools();
    expect(list.tools.map((t) => t.name)).toEqual(['echo', 'refuse', 'boom', 'slow']);
    expect(list.tools[0]!.inputSchema).toMatchObject({ type: 'object', required: ['text'] });
    expect(list.tools[0]!.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
    const r = await c.callTool({ name: 'echo', arguments: { text: 'hola' } });
    expect(r.structuredContent).toEqual({ said: 'hola' });
    expect(r.content).toEqual([{ type: 'text', text: '{"said":"hola"}' }]);
    await c.ping();
    await c.close();
  });
  it('a refusal is a tool result with isError and its code; an internal error says only tool_failed', async () => {
    const c = await sdkClient(server);
    expect(await c.callTool({ name: 'refuse', arguments: {} })).toMatchObject({ isError: true, structuredContent: { error: 'over_task_budget' } });
    const boom = await c.callTool({ name: 'boom', arguments: {} });
    expect(boom).toMatchObject({ isError: true, structuredContent: { error: 'tool_failed' } });
    expect(JSON.stringify(boom)).not.toContain('SABCDEF');
    expect(errors.length).toBe(1);
    await c.close();
  });
  it('an unknown tool is a JSON-RPC invalid-params error', async () => {
    const c = await sdkClient(server);
    await expect(c.callTool({ name: 'nope', arguments: {} })).rejects.toThrow(/unknown tool/);
    await c.close();
  });
  it('a cancelled call aborts the tool', async () => {
    aborted = false;
    const c = await sdkClient(server);
    const ctl = new AbortController();
    const p = c.callTool({ name: 'slow', arguments: {} }, undefined, { signal: ctl.signal }).catch(() => 'cancelled');
    await new Promise((r) => setTimeout(r, 20));
    ctl.abort();
    expect(await p).toBe('cancelled');
    await new Promise((r) => setTimeout(r, 20));
    expect(aborted).toBe(true);
    await c.close();
  });
});

describe('protocol details', () => {
  const server = createMcpServer({ name: 'a', version: '1', tools });
  it('echoes a supported protocol version and answers the newest for anything else', async () => {
    const init = (v: string) => server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: v, capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
    expect(await init('2025-03-26')).toMatchObject({ result: { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } } } });
    expect(await init('1999-01-01')).toMatchObject({ result: { protocolVersion: '2025-11-25' } });
  });
  it('notifications get no reply; junk gets invalid-request; unknown methods get method-not-found', async () => {
    expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(await server.handle({ id: 1, method: 'ping' })).toMatchObject({ id: 1, error: { code: -32600 } });
    expect(await server.handle([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).toMatchObject({ id: null, error: { code: -32600 } });
    expect(await server.handle({ jsonrpc: '2.0', id: 'x', method: 'resources/list' })).toMatchObject({ id: 'x', error: { code: -32601 } });
  });
});

describe('serveStdio', () => {
  it('reassembles lines split across chunks, answers parse errors, and writes nothing for notifications', async () => {
    const out: string[] = [];
    async function* input() {
      yield '{"jsonrpc":"2.0","id":1,"me';
      yield new TextEncoder().encode('thod":"ping"}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\nnot json\n');
      yield '{"jsonrpc":"2.0","id":2,"method":"tools/list"}';
    }
    await serveStdio(createMcpServer({ name: 'a', version: '1', tools }), { input: input(), write: (l) => out.push(l) });
    const replies = out.map((l) => JSON.parse(l) as { id: unknown; error?: { code: number } });
    expect(replies.map((r) => r.id).sort()).toEqual([1, 2, null].sort() as never);
    expect(replies.find((r) => r.id === null)!.error!.code).toBe(-32700);
    expect(out.every((l) => !l.includes('\n'))).toBe(true);
  });
});

describe('the agentenact-mcp binary', () => {
  it('starts over stdio with no configuration and offers the read-only tools only', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dir, '..', 'src', 'bin', 'agentenact-mcp.ts')],
      env: { PATH: process.env.PATH ?? '' },
      stderr: 'pipe',
    });
    const c = new Client({ name: 'test', version: '1.0.0' });
    await c.connect(transport);
    expect(c.getServerVersion()?.name).toBe('agentenact');
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(['find_agents', 'get_agent', 'verify_record']);
    const r = await c.callTool({ name: 'get_agent', arguments: { agent_id: 'x' } });
    expect(r).toMatchObject({ isError: true, structuredContent: { error: 'bad_agent_id' } });
    await c.close();
  }, 20_000);
  it('refuses a signer url without its token, before serving', async () => {
    const p = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'src', 'bin', 'agentenact-mcp.ts')], {
      env: { PATH: process.env.PATH ?? '', AGENTENACT_SIGNER_URL: 'http://127.0.0.1:1/sign' },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    expect(await p.exited).toBe(1);
    expect(await new Response(p.stderr).text()).toContain('AGENTENACT_SIGNER_TOKEN is required');
  });
});

describe('raw tools and Streamable HTTP', () => {
  const seen: unknown[] = [];
  const raw = {
    name: 'paid',
    description: 'A tool that reads _meta and answers a whole result',
    inputSchema: { type: 'object', properties: {} },
    async call(args: unknown, ctx: { meta: Record<string, unknown> | null }) {
      seen.push([args, ctx.meta]);
      return ctx.meta?.['x402/payment']
        ? { content: [{ type: 'text' as const, text: 'ok' }], _meta: { 'x402/payment-response': { success: true } } }
        : { content: [{ type: 'text' as const, text: '{"x402Version":2}' }], structuredContent: { x402Version: 2 }, isError: true };
    },
  };
  const server = createMcpServer({ name: 'a', version: '1', tools: [raw] });
  const post = (body: unknown, method = 'POST') =>
    handleMcpHttp(server, new Request('https://x.example/mcp', { method, ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) }));

  it('passes _meta to a raw tool and returns its result as is', async () => {
    const unpaid = await (await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'paid', arguments: { a: 1 } } })).json();
    expect(unpaid).toEqual({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"x402Version":2}' }], structuredContent: { x402Version: 2 }, isError: true } });
    const paid = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'paid', arguments: {}, _meta: { 'x402/payment': { p: 1 } } } })).json();
    expect(paid).toMatchObject({ result: { _meta: { 'x402/payment-response': { success: true } } } });
    expect(seen).toEqual([[{ a: 1 }, null], [{}, { 'x402/payment': { p: 1 } }]]);
  });
  it('speaks stateless JSON over POST: 202 for notifications and replies, 405 otherwise, 400 on junk', async () => {
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    expect((await post({ jsonrpc: '2.0', id: 9, result: {} })).status).toBe(202);
    expect((await post(null, 'GET')).status).toBe(405);
    expect((await post('{nope')).status).toBe(400);
    expect((await post('x'.repeat(300_000))).status).toBe(413);
  });
  it('works behind the official SDK client over Streamable HTTP', async () => {
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const srv = Bun.serve({ port: 0, fetch: (req) => handleMcpHttp(server, req) });
    try {
      const c = new Client({ name: 'test', version: '1.0.0' });
      await c.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${srv.port}/mcp`)));
      expect((await c.listTools()).tools.map((t) => t.name)).toEqual(['paid']);
      expect(await c.callTool({ name: 'paid', arguments: {}, _meta: { 'x402/payment': { p: 2 } } })).toMatchObject({ _meta: { 'x402/payment-response': { success: true } } });
      await c.close();
    } finally {
      srv.stop();
    }
  });
});
