# Claw

AI agent runtime for Gallery.dev. Each agent runs inside a Cloudflare Sandbox container (Firecracker microVM) with its own filesystem, memory, and MCP tools.

## Architecture

```
Gallery UI → POST /api/chat → Cloudflare Worker → container POST /message → Claude Agent SDK query() → SSE events → UI
```

- **Worker** (`cloudflare/claw/src/index.ts`): manages Sandbox containers, routes messages, handles delegation
- **Scheduler** (`cloudflare/claw/src/scheduler.ts`): Durable Object for task dispatch and health checks
- **Agent Runner** (`container/agent-runner/src/`): runs inside each container

## Key Files

| File | Purpose |
|------|---------|
| `container/agent-runner/src/server.ts` | HTTP server (port 8080), request queuing, SSE streaming |
| `container/agent-runner/src/agent.ts` | Claude Agent SDK integration, session persistence, activity posting |
| `container/agent-runner/src/mcp-tools.ts` | 31 MCP tools: messaging, tasks, memory, skills, delegation, reviews, files, workspace |
| `container/agent-runner/src/shared.ts` | Hooks: bash sanitization, loop detection, context tracking, activity posting |
| `container/agent-runner/esbuild.config.mjs` | Bundle config: server.bundle.js, mcp-tools.bundle.js, cli.js |
| `cloudflare/claw/src/index.ts` | Cloudflare Worker: container lifecycle, routing, auth |
| `cloudflare/claw/src/scheduler.ts` | Durable Object: scheduled tasks, health checks |
| `cloudflare/claw/Dockerfile` | Container image (cloudflare/sandbox base) |
| `cloudflare/claw/claw-bundles/` | Pre-built JS bundles copied into container image |

## Development

```bash
# Build bundles
cd container/agent-runner && node esbuild.config.mjs

# Copy to Worker
cp dist/server.bundle.js dist/mcp-tools.bundle.js dist/cli.js ../../cloudflare/claw/claw-bundles/

# Deploy Worker (rebuilds container image)
cd ../../cloudflare/claw && npx wrangler deploy
```

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_BASE_URL` | AI Gateway proxy URL |
| `ANTHROPIC_API_KEY` | Workspace gateway token |
| `GALLERY_GATEWAY_TOKEN` | Auth token for Gallery API and Convex |
| `GALLERY_CONVEX_URL` | Convex deployment URL |
| `GALLERY_API_URL` | Gallery API base URL |
| `GALLERY_WORKER_URL` | Cloudflare Worker URL (for agent delegation) |
| `AGENT_ID` | This agent's Convex document ID |
| `CLAW_MODEL` | Model to use (default: claude-opus-4-6) |
| `CLAW_EFFORT` | Thinking effort (default: high) |
| `CLAW_MAX_TURNS` | Max tool turns per query (default: 50) |
| `CLAW_AUTO_MEMORY` | Enable auto memory extraction (default: true) |
| `CLAW_AUTH_TOKEN` | Bearer token for container HTTP endpoints |
