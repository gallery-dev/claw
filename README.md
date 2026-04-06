# Claw

AI agent runtime by [Gallery.dev](https://gallery.dev). Runs autonomous Claude agents in isolated Cloudflare Sandbox containers, managed from a web dashboard.

## What It Does

- **Isolated agent containers** — Each agent runs in its own Cloudflare Sandbox (Firecracker microVM) with persistent R2-mounted filesystem, environment variables, and process isolation.
- **Claude Agent SDK** — Full autonomous agent loop with tool use, V2 session persistence, and configurable thinking effort.
- **MCP tool system** — Agents access Gallery tools via a stdio MCP server (task management, reviews, memory, delegation) and external integrations via Composio MCP proxy (Gmail, Slack, GitHub, 500+ apps).
- **Agent collaboration** — Agents delegate tasks to each other, decompose work into subtasks, and report results back through the Claw Worker's `/delegate` endpoint.
- **Scheduled automation** — Cron-based schedules dispatch tasks to agents on a recurring basis (e.g., check inbox every 5 minutes).
- **Human-in-the-loop reviews** — Agents submit approval requests, questions, and error reports. Humans approve/reject via the dashboard, and agents are notified instantly.
- **AI Gateway** — All API requests routed through Gallery's billing-aware proxy at `ai.gallery.dev` with Cloudflare AI Gateway Unified Billing.
- **Safety guardrails** — Bash secret sanitization, tool loop detection, context window tracking, request queuing, and memory extraction filtering.

## Architecture

```
Gallery.dev Dashboard
  ├── /api/chat (web chat) → ai.gallery.dev → Claude API
  └── /api/claw/provision → Cloudflare Worker → Sandbox Container
                                    ↓
                            POST /task or /message
                                    ↓
                          Claude Agent SDK query()
                            ├── MCP tools (Gallery CLI)
                            ├── MCP tools (Composio proxy)
                            ├── Bash (built-in)
                            └── Read/Write/Glob/Grep (built-in)
```

### Components

| Component | Location | Purpose |
|-----------|----------|---------|
| **Agent Runner** | `container/agent-runner/` | Runs inside each container — HTTP server, SDK session management, MCP tools |
| **Claw Worker** | `cloudflare/claw/` (in gallery.dev repo) | Cloudflare Worker managing container lifecycle, routing, auth, delegation |
| **Scheduler DO** | `cloudflare/claw/src/scheduler.ts` | Durable Object for cron schedules, heartbeat health checks, task dispatch |
| **AI Gateway** | `cloudflare/ai/` (in gallery.dev repo) | Billing-aware proxy to Claude API via Cloudflare AI Gateway |

### Container Filesystem

```
/mnt/r2/workspace/          ← R2-mounted persistent storage
├── .mcp.json               ← MCP server configs (auto-generated)
├── .git/HEAD               ← Project root marker for CLI discovery
├── CLAUDE.md               ← Agent instructions (written during provision)
├── HEARTBEAT.md            ← Periodic standing instructions
├── MEMORY.md               ← Agent memory (auto-extracted, editable)
├── memory/                 ← Structured memory files
├── files/                  ← Knowledge files uploaded via dashboard
├── conversations/          ← Session history
├── skills/                 ← Skill definition files
└── .sessions/              ← SDK session state
```

### Key Files

| File | Purpose |
|------|---------|
| `container/agent-runner/src/server.ts` | HTTP server: `/message`, `/task`, `/health`, `/ready`, `/status` |
| `container/agent-runner/src/agent.ts` | Claude Agent SDK integration, V2 session management |
| `container/agent-runner/src/mcp-tools.ts` | Gallery MCP tools — tasks, reviews, memory, delegation, context management |
| `container/agent-runner/src/composio-proxy.ts` | Stdio↔StreamableHTTP bridge for Composio MCP (Gmail, Slack, etc.) |
| `container/agent-runner/src/gallery-cli.ts` | Gallery CLI — `gallery` command for Bash-based tool access |
| `container/agent-runner/src/shared.ts` | Bash sanitization, loop detection, context tracking, activity posting, memory extraction |
| `container/agent-runner/src/cli-wrapper.js` | CLI wrapper that injects `--mcp-config` from `.mcp.json` into argv |
| `container/agent-runner/src/session-manager.ts` | Session lifecycle — create, resume, destroy |
| `container/agent-runner/esbuild.config.mjs` | Bundle build config |

## MCP Tools

Agents have two MCP servers available:

### Gallery CLI (stdio)

29 tools for workspace operations. The agent calls these as MCP tools — no Bash needed.

| Category | Tools |
|----------|-------|
| **Tasks** | `gallery_create_task`, `gallery_update_task`, `gallery_list_tasks`, `gallery_add_task_comment`, `gallery_add_task_attachment` |
| **Reviews** | `gallery_create_review`, `gallery_list_reviews` |
| **Memory** | `gallery_memory_view`, `gallery_memory_write`, `gallery_memory_search`, `gallery_memory_delete` |
| **Agents** | `gallery_agent_list`, `gallery_agent_delegate`, `gallery_agent_message` |
| **Context** | `gallery_context_usage`, `gallery_compact` |
| **Progress** | `update_progress`, `decompose_task` |
| **Workspace** | `gallery_workspace_info`, `gallery_send_message` |

### Composio (stdio proxy → StreamableHTTP)

External integrations via Composio's MCP endpoint. A local stdio proxy bridges the CLI's stdio transport to Composio's HTTP POST-based MCP endpoint.

Available tools depend on connected integrations: `GMAIL_FETCH_EMAILS`, `SLACK_SEND_MESSAGE`, `GITHUB_CREATE_ISSUE`, etc.

## Development

### Prerequisites

- Node.js 22+
- Docker (for container image builds)
- Access to Gallery.dev Cloudflare account

### Build & Deploy

```bash
# From the gallery.dev repo root:
./scripts/deploy.sh

# This script:
# 1. Computes version from git hash
# 2. Builds agent-runner bundles with CLAW_VERSION baked in
# 3. Copies bundles to cloudflare/claw/claw-bundles/
# 4. Deploys Worker with --var CLAW_BUNDLE_VERSION:<hash>
# 5. Existing containers auto-reprovision on next heartbeat (~2 min)
```

### Manual Build

```bash
cd container/agent-runner

# Install dependencies
npm install

# Build bundles
node esbuild.config.mjs

# Output: dist/
#   server.bundle.js          — HTTP server + agent engine
#   mcp-tools.bundle.js       — Gallery MCP tools (stdio server)
#   composio-proxy.bundle.js  — Composio MCP bridge
#   gallery-cli.bundle.js     — Gallery CLI binary
#   cli-wrapper.js            — CLI wrapper for MCP config injection
#   cli.js                    — Claude Agent SDK CLI
```

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_BASE_URL` | AI Gateway proxy URL (`https://ai.gallery.dev`) |
| `ANTHROPIC_API_KEY` | Workspace gateway token (for billing) |
| `GALLERY_GATEWAY_TOKEN` | Auth token for Gallery API and Convex |
| `GALLERY_CONVEX_URL` | Convex deployment URL |
| `GALLERY_API_URL` | Gallery web app URL |
| `GALLERY_WORKER_URL` | Claw Worker URL (`https://claw.gallery.dev`) |
| `AGENT_ID` | This agent's Convex document ID |
| `CLAW_MODEL` | Model to use (default: `claude-sonnet-4-6`) |
| `CLAW_WORKSPACE_DIR` | Workspace directory (`/mnt/r2/workspace`) |
| `SSE_FORMAT` | Response format (`aisdk`) |

## Container Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Health check (requires gateway token auth) |
| `/message` | POST | Send message, get SSE streaming response |
| `/task` | POST | Fire-and-forget task dispatch |
| `/ready` | GET | Readiness probe |
| `/status` | GET | Container status + version |

## Auto-Update

When deploying with `./scripts/deploy.sh`, the `CLAW_BUNDLE_VERSION` env var is set on the Worker. The Scheduler DO's health check compares each container's version (from `/health`) against the expected version. Mismatches trigger automatic destroy + reprovision — no manual action needed.

## License

MIT
