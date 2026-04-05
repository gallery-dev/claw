/**
 * Composio MCP Proxy — bridges stdio ↔ SSE for the Claude Code CLI.
 *
 * The CLI connects to this process via stdio (stdin/stdout). This proxy
 * connects to Composio's SSE MCP endpoint and forwards all JSON-RPC
 * messages bidirectionally.
 *
 * Usage:
 *   node composio-proxy.bundle.js <url> [api-key]
 *
 * The URL and API key come from the .mcp.json config, passed as args
 * by the CLI when spawning this stdio server.
 *
 * Why: The CLI's --mcp-config flag handles stdio servers but SSE
 * connections fail silently in the container environment. This proxy
 * converts the SSE transport to stdio, which is reliable.
 */

import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
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

// SSE transport — connects to Composio
const sseUrl = new URL(url);
const sse = new SSEClientTransport(sseUrl, {
  requestInit: {
    headers,
  },
  eventSourceInit: {
    fetch: (input: string | URL | Request, init?: RequestInit) =>
      fetch(input, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string> || {}),
          ...headers,
        },
      }),
  },
});

// Bridge: stdio → SSE (CLI sends request, proxy forwards to Composio)
stdio.onmessage = async (message) => {
  try {
    await sse.send(message);
  } catch (err) {
    process.stderr.write(`[composio-proxy] Error forwarding to SSE: ${err}\n`);
  }
};

// Bridge: SSE → stdio (Composio responds, proxy forwards to CLI)
sse.onmessage = async (message) => {
  try {
    await stdio.send(message);
  } catch (err) {
    process.stderr.write(`[composio-proxy] Error forwarding to stdio: ${err}\n`);
  }
};

// Error handling
sse.onerror = (err) => {
  process.stderr.write(`[composio-proxy] SSE error: ${err.message}\n`);
};

stdio.onerror = (err) => {
  process.stderr.write(`[composio-proxy] stdio error: ${err.message}\n`);
};

// Cleanup
sse.onclose = () => {
  process.stderr.write('[composio-proxy] SSE connection closed\n');
  process.exit(0);
};

stdio.onclose = () => {
  sse.close().catch(() => {});
  process.exit(0);
};

// Start both transports
try {
  await sse.start();
  process.stderr.write(`[composio-proxy] Connected to ${sseUrl.origin}${sseUrl.pathname}\n`);
  await stdio.start();
} catch (err) {
  process.stderr.write(`[composio-proxy] Failed to start: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
}
