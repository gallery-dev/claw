# Claw

AI agent runtime by [Gallery.dev](https://gallery.dev). Runs autonomous Claude agents in isolated Cloudflare Sandbox containers (Firecracker microVMs), managed from a web dashboard.

## What It Does

- **Dashboard-managed agents** — Agents are configured from the Gallery.dev dashboard. Each gets its own Sandbox container with persistent filesystem.
- **Claude Agent SDK** — Full autonomous agent loop with tool use, session persistence, and automatic memory extraction.
- **19 MCP tools** — Messaging, task management, memory, agent delegation, workspace integration, and human-in-the-loop review.
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
| `container/agent-runner/src/agent.ts` | Claude Agent SDK integration, session management, memory extraction |
| `container/agent-runner/src/mcp-tools.ts` | MCP stdio server with 19 tools |
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
- **mcp-tools.bundle.js** — MCP stdio server, spawned as child process by the SDK
- **cli.js** — Claude Agent SDK CLI, copied from npm package

## Development

```bash
# Install dependencies
cd container/agent-runner && npm install

# Build bundles
node esbuild.config.mjs

# Copy to Worker
cp dist/server.bundle.js dist/mcp-tools.bundle.js dist/cli.js ../../cloudflare/claw/claw-bundles/

# Deploy
cd ../../cloudflare/claw && npx wrangler deploy
```

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
## License

MIT
