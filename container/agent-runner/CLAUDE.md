# Claw Agent Runner

Source code for the AI agent runtime that runs inside each Cloudflare Sandbox container.

## Source Files

| File | Purpose |
|------|---------|
| `src/server.ts` | HTTP server: `/message`, `/task`, `/health`, `/ready`, `/status` endpoints |
| `src/agent.ts` | Core query execution via Claude Agent SDK, session management, memory extraction |
| `src/mcp-tools.ts` | MCP stdio server with 19 tools (spawned as child process by SDK) |
| `src/shared.ts` | Shared utilities: bash sanitization, loop detection, context tracking, activity posting |
| `esbuild.config.mjs` | Builds two bundles + copies cli.js from SDK |

## Build

```bash
node esbuild.config.mjs
```

Produces:
- `dist/server.bundle.js` — main HTTP service (entry: server.ts)
- `dist/mcp-tools.bundle.js` — MCP stdio server (entry: mcp-tools.ts)
- `dist/cli.js` — copied from `@anthropic-ai/claude-agent-sdk/cli.js`

## Deploy

```bash
cp dist/server.bundle.js dist/mcp-tools.bundle.js dist/cli.js ../../../cloudflare/claw/claw-bundles/
cd ../../../cloudflare/claw && npx wrangler deploy
```

## Key Patterns

- All npm deps are bundled by esbuild; Node built-ins remain external
- MCP tools server runs as a child process (stdio transport), spawned by the SDK
- Convex helpers (convexQuery/convexMutation) have 15s timeouts
- Activity events are batched (10 per flush, 2s interval) and posted fire-and-forget to Convex
- Session state persisted to filesystem (survives container sleep/wake)
