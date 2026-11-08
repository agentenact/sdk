/**
 * `mcp` — a Model Context Protocol server for the orchestrator tools, so any MCP harness (Claude Code, Codex,
 * Hermes, Cursor, …) can find, verify and hire agents.
 *
 * Zero dependencies: MCP's tool surface is a handful of JSON-RPC 2.0 methods (initialize, ping, tools/list,
 * tools/call, notifications/initialized, notifications/cancelled), implemented here so the package pulls in no
 * HTTP framework. `createMcpServer().handle()` takes one JSON-RPC message and returns the reply (or null for a
 * notification), so the same server sits behind stdio (`serveStdio`, below) or a Streamable HTTP POST route.
 * Checked against @modelcontextprotocol/sdk's client in tests/mcp.test.ts.
 *
 * Tool results carry the JSON both as `structuredContent` and as one text block (older clients read only text).
 * A refusal is a tool result with `isError: true` and a short code, never a JSON-RPC error and never a stack.
 */
import { isToolRefusal, type OrchestratorTool } from './orchestrate.js';

/** Newest first. A client asking for one of these gets it back; anything else gets the newest. */
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

export type JsonRpcId = string | number;
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}
export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId | null; result: unknown }
  | { jsonrpc: '2.0'; id: JsonRpcId | null; error: { code: number; message: string } };

/** A tool result as MCP sends it. */
export interface McpToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

/**
 * A tool that answers with a whole MCP tool result, and sees the request's `_meta`. For transports that carry data
 * beside the arguments, e.g. x402 over MCP (`_meta["x402/payment"]` in, `_meta["x402/payment-response"]` out).
 */
export interface McpRawTool {
  name: string;
  description: string;
  inputSchema: OrchestratorTool['inputSchema'] | Record<string, unknown>;
  annotations?: Record<string, unknown>;
  call(args: unknown, ctx: { signal: AbortSignal; meta: Record<string, unknown> | null }): Promise<McpToolResult>;
}

export interface McpServerOptions {
  name: string;
  version: string;
  tools: (OrchestratorTool | McpRawTool)[];
  /** Shown to the client's model as server instructions. */
  instructions?: string;
  /** Called with internal errors (never with tool arguments). Default: nothing. */
  onError?: (e: unknown) => void;
}

export interface McpServer {
  /** One JSON-RPC message in, its reply out; null for notifications. Never throws. */
  handle(message: unknown): Promise<JsonRpcResponse | null>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const err = (id: JsonRpcId | null, code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });

export function createMcpServer(o: McpServerOptions): McpServer {
  const byName = new Map(o.tools.map((t) => [t.name, t]));
  const inflight = new Map<JsonRpcId, AbortController>();

  async function call(id: JsonRpcId, params: unknown): Promise<unknown> {
    if (!isObj(params) || typeof params.name !== 'string') throw Object.assign(new Error('invalid params'), { rpc: -32602 });
    const tool = byName.get(params.name);
    if (!tool) throw Object.assign(new Error(`unknown tool: ${params.name}`), { rpc: -32602 });
    const ctl = new AbortController();
    inflight.set(id, ctl);
    try {
      if ('call' in tool) return await tool.call(params.arguments, { signal: ctl.signal, meta: isObj(params._meta) ? params._meta : null });
      const value = await tool.run(params.arguments, ctl.signal);
      const structured = isObj(value) ? value : { value };
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: structured };
    } catch (e) {
      const code = isToolRefusal(e) ? e.reason : 'tool_failed';
      if (!isToolRefusal(e)) o.onError?.(e);
      return { content: [{ type: 'text', text: JSON.stringify({ error: code }) }], structuredContent: { error: code }, isError: true };
    } finally {
      inflight.delete(id);
    }
  }

  return {
    async handle(message) {
      if (!isObj(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
        return err(isObj(message) && (typeof message.id === 'string' || typeof message.id === 'number') ? message.id : null, -32600, 'invalid request');
      }
      const { method, params } = message;
      const hasId = typeof message.id === 'string' || typeof message.id === 'number';
      if (!hasId) {
        if (method === 'notifications/cancelled' && isObj(params) && (typeof params.requestId === 'string' || typeof params.requestId === 'number')) {
          inflight.get(params.requestId)?.abort();
        }
        return null;
      }
      const id = message.id as JsonRpcId;
      try {
        switch (method) {
          case 'initialize': {
            const asked = isObj(params) && typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
            const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0];
            return {
              jsonrpc: '2.0',
              id,
              result: {
                protocolVersion,
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: o.name, version: o.version },
                ...(o.instructions ? { instructions: o.instructions } : {}),
              },
            };
          }
          case 'ping':
            return { jsonrpc: '2.0', id, result: {} };
          case 'tools/list':
            return {
              jsonrpc: '2.0',
              id,
              result: { tools: o.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}) })) },
            };
          case 'tools/call':
            return { jsonrpc: '2.0', id, result: await call(id, params) };
          default:
            return err(id, -32601, `method not found: ${method}`);
        }
      } catch (e) {
        const rpc = (e as { rpc?: number }).rpc;
        if (rpc) return err(id, rpc, (e as Error).message);
        o.onError?.(e);
        return err(id, -32603, 'internal error');
      }
    },
  };
}

/** Lines in, lines out: MCP's stdio transport (newline-delimited JSON-RPC, no embedded newlines). */
export interface StdioStreams {
  input: AsyncIterable<Uint8Array | string>;
  write(line: string): void;
}

/**
 * Serve over stdio until the input ends. Requests run concurrently (a slow hire never blocks a ping), replies are
 * written as they finish. Anything that is not JSON gets a parse error with id null.
 */
export async function serveStdio(server: McpServer, io: StdioStreams): Promise<void> {
  const decoder = new TextDecoder();
  const pending = new Set<Promise<void>>();
  let buf = '';
  const dispatch = (line: string) => {
    if (!line.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      io.write(JSON.stringify(err(null, -32700, 'parse error')));
      return;
    }
    const p = server.handle(msg).then((r) => {
      if (r) io.write(JSON.stringify(r));
    });
    pending.add(p);
    void p.finally(() => pending.delete(p));
  };
  for await (const chunk of io.input) {
    buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      dispatch(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  dispatch(buf);
  await Promise.all(pending);
}

/**
 * MCP's Streamable HTTP transport, stateless and JSON-only: one POST carries one JSON-RPC message; a request gets
 * its reply as `application/json`, a notification gets 202. No sessions and no server-sent stream, so GET and
 * DELETE get 405 (the spec allows a server without a stream). Origin checks and CORS are the caller's: this only
 * speaks the protocol.
 */
export async function handleMcpHttp(server: McpServer, req: Request, o: { maxBytes?: number } = {}): Promise<Response> {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
  const max = o.maxBytes ?? 256 * 1024;
  if (Number(req.headers.get('content-length') ?? '0') > max) return json(413, err(null, -32600, 'too large'));
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > max) return json(413, err(null, -32600, 'too large'));
  let msg: unknown;
  try {
    msg = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return json(400, err(null, -32700, 'parse error'));
  }
  // A client's reply to a server request (we never send any) is acknowledged like a notification.
  const isReply = !!msg && typeof msg === 'object' && !('method' in msg) && ('result' in msg || 'error' in msg);
  if (isReply) return new Response(null, { status: 202 });
  const reply = await server.handle(msg);
  return reply ? json(200, reply) : new Response(null, { status: 202 });
}
