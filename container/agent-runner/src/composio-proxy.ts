/**
 * Composio MCP Proxy — bridges stdio ↔ Streamable HTTP for the Claude Code CLI.
 *
 * The CLI connects to this process via stdio (stdin/stdout). This proxy
 * connects to Composio's HTTP MCP endpoint and forwards all JSON-RPC
 * messages bidirectionally.
 *
 * Usage:
 *   node composio-proxy.bundle.js <url> [api-key]
 *
 * The URL and API key come from the .mcp.json config, passed as args
 * by the CLI when spawning this stdio server.
 *
 * Why: The CLI's built-in HTTP/SSE MCP client fails silently in
 * Cloudflare Sandbox containers. This proxy converts the remote
 * transport to stdio, which is reliable.
 */

import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const url = process.argv[2];
const apiKey = process.argv[3];

if (!url) {
  process.stderr.write('[composio-proxy] Missing URL argument\n');
  process.exit(1);
}

const headers: Record<string, string> = {};
if (apiKey) {
  headers['x-api-key'] = apiKey;
}

// Stdio transport — receives from CLI, sends back to CLI
const stdio = new StdioServerTransport();

// Streamable HTTP transport — connects to Composio's POST endpoint
const remote = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: {
    headers,
  },
});

// Bridge: stdio → remote (CLI sends request, proxy forwards to Composio)
stdio.onmessage = async (message) => {
  try {
    await remote.send(message);
  } catch (err) {
    process.stderr.write(`[composio-proxy] Error forwarding to remote: ${err}\n`);
  }
};

// Bridge: remote → stdio (Composio responds, proxy forwards to CLI)
remote.onmessage = async (message) => {
  try {
    await stdio.send(message);
  } catch (err) {
    process.stderr.write(`[composio-proxy] Error forwarding to stdio: ${err}\n`);
  }
};

// Error handling
remote.onerror = (err) => {
  process.stderr.write(`[composio-proxy] Remote error: ${err.message}\n`);
};

stdio.onerror = (err) => {
  process.stderr.write(`[composio-proxy] stdio error: ${err.message}\n`);
};

// Cleanup
remote.onclose = () => {
  process.stderr.write('[composio-proxy] Remote connection closed\n');
  process.exit(0);
};

stdio.onclose = () => {
  remote.close().catch(() => {});
  process.exit(0);
};

// Start both transports
try {
  await remote.start();
  process.stderr.write(`[composio-proxy] Connected to ${url}\n`);
  await stdio.start();
} catch (err) {
  process.stderr.write(`[composio-proxy] Failed to start: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
}
