# Claw Agent Runner

The AI agent brain that runs inside Cloudflare Sandbox containers for [Gallery.dev](https://gallery.dev). Each agent gets its own isolated Firecracker microVM with persistent filesystem, memory, and MCP tools.

## Architecture

```
Gallery UI → /api/chat → Cloudflare Worker → POST /message → Claude Agent SDK query() → SSE events → UI
```

The agent runner is an HTTP server that:
1. Receives messages from the Cloudflare Worker
2. Executes Claude Agent SDK `query()` with MCP tools
3. Streams results back as SSE events
4. Persists session state and memory to the container filesystem

## Quick Start

```bash
# Install dependencies
npm install

# Build bundles
node esbuild.config.mjs

# Copy bundles to Worker
cp dist/server.bundle.js dist/mcp-tools.bundle.js dist/cli.js ../../../cloudflare/claw/claw-bundles/

# Deploy (from Worker directory)
cd ../../../cloudflare/claw && npx wrangler deploy
```

## Bundle Pipeline

```
Source (TypeScript)
  ↓ esbuild (node22, ESM, all deps bundled)
Bundles (dist/)
  ↓ cp to claw-bundles/
Cloudflare Worker (cloudflare/claw/)
  ↓ Dockerfile COPY
Sandbox Container (Firecracker microVM)
```

Three output files:
- **server.bundle.js** — HTTP server + agent query engine
- **mcp-tools.bundle.js** — MCP stdio server (19 tools), spawned as child process
- **cli.js** — Claude Agent SDK CLI, copied from npm package

## MCP Tools

| Category | Tools |
|----------|-------|
| Messaging | `send_message`, `update_progress` |
| Sub-tasks | `decompose_task` (up to 5 parallel subtasks) |
| Delegation | `gallery_delegate_task`, `gallery_message_agent` |
| Memory | `memory_view`, `memory_write`, `memory_search`, `memory_delete` |
| Tasks | `gallery_list_tasks`, `gallery_create_task`, `gallery_update_task`, `gallery_delete_task`, `gallery_add_task_comment` |
| Workspace | `gallery_list_agents`, `gallery_workspace_info` |
| Review | `gallery_request_review`, `gallery_list_reviews` |
| Reporting | `gallery_report_to_parent` |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Server listen port |
| `CLAW_MODEL` | `claude-opus-4-6` | Model to use |
| `CLAW_EFFORT` | `high` | Thinking effort level |
| `CLAW_MAX_TURNS` | `50` | Max tool turns per query |
| `CLAW_AUTO_MEMORY` | `true` | Auto-extract memories after conversations |
| `ANTHROPIC_BASE_URL` | — | AI Gateway proxy URL |
| `ANTHROPIC_API_KEY` | — | Gateway token |
| `GALLERY_GATEWAY_TOKEN` | — | Auth token for Gallery API |
| `GALLERY_CONVEX_URL` | — | Convex deployment URL |
| `GALLERY_API_URL` | — | Gallery API base URL |
| `GALLERY_WORKER_URL` | — | Worker URL for agent delegation |
| `AGENT_ID` | — | Agent's Convex document ID |

## Safety Features

- **Bash sanitization**: Strips secret env vars from all shell commands
- **Loop detection**: Catches repeated tool calls (3 same-call threshold, 6 force-stop)
- **Context tracking**: Warns at 70% context usage, checkpoints at 80%
- **Request queuing**: Serial processing with 10-minute timeout, max 50 queued
- **Auth**: Bearer token required on all endpoints except health checks
