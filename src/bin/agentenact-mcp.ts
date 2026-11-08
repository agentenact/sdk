#!/usr/bin/env node
/** `npx agentenact-mcp`: the orchestrator tools over MCP stdio. Configuration: see mcp-cli.ts. Logs go to stderr only. */
import { serveStdio } from '../mcp.js';
import { serverFromEnv } from '../mcp-cli.js';

try {
  const { server, tools } = await serverFromEnv(process.env);
  process.stderr.write(`agentenact-mcp: ready (${tools.join(', ')})\n`);
  await serveStdio(server, { input: process.stdin, write: (line) => process.stdout.write(`${line}\n`) });
} catch (e) {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
}
