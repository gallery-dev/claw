# Claw

AI agent runtime by [Gallery.dev](https://gallery.dev). Runs autonomous Claude agents in isolated Cloudflare Sandbox containers (Firecracker microVMs), managed from a web dashboard.

## What It Does

- **Dashboard-managed agents** — Agents are configured from the Gallery.dev dashboard. Each gets its own Sandbox container with persistent filesystem.
- **Claude Agent SDK** — Full autonomous agent loop with tool use, V2 session persistence, and automatic memory extraction.
- **Gallery CLI** — Agents interact with tasks, memory, delegation, and workspace via the `gallery` CLI command (called through Bash). Zero token overhead vs. MCP tool schema injection.
- **Agent collaboration** — Agents can delegate tasks to each other, decompose work into subtasks, and report results back.
- **Soul system** — Personality, tone, and behavioral boundaries injected into each agent's system prompt from Gallery.
- **AI Gateway** — API requests routed through Gallery's AI proxy with multi-model support.
- **Safety guardrails** — Bash secret sanitization, tool loop detection, context window tracking, and request queuing.
- **Credit-based billing** — Usage tracked and billed through Gallery.dev.

## Architecture

```
Gallery.dev UI → /api/chat → Cloudflare Worker → POST /message → Claude Agent SDK query() → SSE → UI
```

Each agent runs in its own Cloudflare Sandbox container. The Worker manages container lifecycle, routing, authentication, and agent-to-agent delegation. A Durable Object handles scheduled task dispatch and health checks.

### Key Files

| File | Purpose |
|------|---------|
| `container/agent-runner/src/server.ts` | HTTP server: `/message`, `/task`, `/health`, `/ready`, `/status` |
| `container/agent-runner/src/agent.ts` | Claude Agent SDK integration, V2 session management, memory extraction |
| `container/agent-runner/src/gallery-cli.ts` | Gallery CLI — all agent tools via `gallery` command. Replaces MCP tools. |
| `container/agent-runner/src/shared.ts` | Bash sanitization, loop detection, context tracking, activity posting |
| `container/agent-runner/esbuild.config.mjs` | Bundle build config |

### Bundle Pipeline

```
Source (TypeScript)
  ↓ esbuild (node22, ESM, all deps bundled)
dist/ bundles
  ↓ copy to cloudflare/claw/claw-bundles/
Cloudflare Worker
  ↓ Dockerfile COPY
Sandbox Container (Firecracker microVM)
```

Three output files:
- **server.bundle.js** — HTTP server + agent query engine
- **gallery-cli.bundle.js** — Gallery CLI binary, installed at `/usr/local/bin/gallery`
- **cli.js** — Claude Agent SDK CLI, copied from npm package

## Development

```bash
# Install dependencies
cd container/agent-runner && npm install

# Build bundles
node esbuild.config.mjs

# Copy to Worker
cp dist/server.bundle.js dist/gallery-cli.bundle.js dist/cli.js ../../cloudflare/claw/claw-bundles/

# Deploy
cd ../../cloudflare/claw && npx wrangler deploy
```

## Gallery CLI

Agents call `gallery <command>` via Bash. Output is JSON: `{ "ok": true, "result": "..." }`.

| Category | Commands |
|----------|----------|
| Tasks | `gallery task list/create/update/delete/comment/report` |
| Agents | `gallery agent list/delegate/message` |
| Reviews | `gallery review create/list` |
| Memory | `gallery memory view/write/search/delete` |
| Workspace | `gallery workspace info` |
| Messaging | `gallery send-message` |
| Progress | `gallery progress` |

## License

MIT
