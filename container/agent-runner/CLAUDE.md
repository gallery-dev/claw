# Claw Agent Runner

Source code for the AI agent runtime that runs inside each Cloudflare Sandbox container.

## Source Files

| File | Purpose |
|------|---------|
| `src/server.ts` | HTTP server: `/message`, `/task`, `/health`, `/status` endpoints, request queuing, SSE streaming |
| `src/agent.ts` | Claude Agent SDK V2 sessions, memory extraction (structured 4-category), cost tracking |
| `src/session-manager.ts` | Multi-conversation lifecycle, LRU eviction, per-conversation locking |
| `src/mcp-tools.ts` | MCP stdio server with 25 tools (messaging, tasks, memory, skills, delegation, reviews) |
| `src/shared.ts` | Hooks (bash sanitization, loop detection, context safety, PreCompact), secrets redaction, activity posting |
| `src/ui-stream.ts` | AI SDK UI Message Stream writer for SSE protocol |
| `src/gallery-cli.ts` | CLI wrapper for Gallery tools (`gallery` command in containers) |
| `esbuild.config.mjs` | Builds bundles + copies cli.js from SDK |

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
- Convex helpers have 15s timeouts with 3-attempt retry on 5xx
- Activity events are batched (10 per flush, 2s interval) and posted fire-and-forget to Convex
- Session state persisted to filesystem (survives container sleep/wake)
- Memory extraction uses Haiku with 4 structured categories (preferences, decisions, facts, failures)
- PreCompact hook writes structured session summaries with iterative compression
- Secrets redaction: 19 env vars unset + 12 inline pattern regexes
- Subtasks inherit full process.env for Gallery API access
- Context window tracking is cache-aware (includes cache_read_input_tokens)
