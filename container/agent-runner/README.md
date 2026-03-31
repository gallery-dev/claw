# Claw Agent Runner

The AI agent brain that runs inside Cloudflare Sandbox containers for [Gallery.dev](https://gallery.dev). Each agent gets its own isolated Firecracker microVM with persistent filesystem, memory, and MCP tools.

## Architecture

```
Gallery UI → /api/chat → Cloudflare Worker → POST /message → Claude Agent SDK → SSE events → UI
```

The agent runner is an HTTP server that:
1. Receives messages from the Cloudflare Worker
2. Executes Claude Agent SDK sessions with MCP tools
3. Streams results back as SSE events (AI SDK UI protocol)
4. Persists session state and memory to the container filesystem
5. Extracts structured memories after each conversation
6. Archives and summarizes context on compaction

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
- **server.bundle.js** — HTTP server + agent query engine + session manager
- **mcp-tools.bundle.js** — MCP stdio server (25 tools), spawned as child process
- **cli.js** — Claude Agent SDK CLI, copied from npm package

## Source Files

| File | Purpose |
|------|---------|
| `src/server.ts` | HTTP server: `/message`, `/task`, `/health`, `/status` endpoints, request queuing, SSE streaming |
| `src/agent.ts` | Claude Agent SDK V2 session management, memory extraction, cost tracking |
| `src/session-manager.ts` | Multi-conversation session lifecycle, LRU eviction, per-conversation locking |
| `src/mcp-tools.ts` | MCP stdio server with 25 tools (messaging, tasks, memory, skills, delegation, reviews) |
| `src/shared.ts` | Hooks (bash sanitization, loop detection, context safety, PreCompact), activity posting, secrets redaction |
| `src/ui-stream.ts` | AI SDK UI Message Stream writer for SSE protocol |
| `src/gallery-cli.ts` | CLI wrapper for Gallery tools (`gallery` command) |
| `esbuild.config.mjs` | Builds bundles + copies cli.js from SDK |

## MCP Tools (25)

| Category | Tools |
|----------|-------|
| Messaging | `send_message`, `update_progress` |
| Sub-tasks | `decompose_task` (up to 5 parallel subtasks, configurable model) |
| Delegation | `gallery_delegate_task` (with context guidance), `gallery_message_agent` |
| Memory | `memory_view`, `memory_write`, `memory_search`, `memory_delete` |
| Skills | `skill_create`, `skill_update`, `skill_list` (autonomous skill authoring) |
| Tasks | `gallery_list_tasks`, `gallery_create_task`, `gallery_update_task`, `gallery_delete_task`, `gallery_add_task_comment` |
| Workspace | `gallery_list_agents`, `gallery_workspace_info` |
| Reviews | `gallery_request_review`, `gallery_list_reviews` |
| Reporting | `gallery_report_to_parent` |

## Agent Prompt System (CLAUDE.md)

Each agent receives a comprehensive CLAUDE.md generated at provisioning time by `lib/claw-claude-md.ts`. Sections include:

| Section | Purpose |
|---------|---------|
| **Soul** | Core truths ("Act, don't narrate"), autonomy calibration, failure recovery, self-improvement, session startup checklist |
| **Owner** | Name, timezone, preferences |
| **Skills** | Installed skills with mandatory read protocol + autonomous creation guidance |
| **Tools Reference** | Gallery CLI commands + SDK tools |
| **Security** | Secrets handling, external content trust, credential file protection |
| **Loop Detection** | Repetitive tool call thresholds |
| **Agent Roster** | Sub-agent list with roles and models (admin agents only) |
| **Communication** | Output channel, internal tags, messaging rules |
| **Output Format** | Response format taxonomy (conversational, research, code, multi-step) |
| **Code Quality** | Read before writing, error handling, testing, cleanup, naming |
| **Verification** | Verify work before marking done (code, files, research, general) |
| **Research** | Multiple sources, source quality, conflict flagging, confidence levels |
| **Priority Management** | Stuck detection (20+ calls), priority ordering, incremental delivery |
| **Memory** | Protocol (before/during/after), user profiling, context window survival |
| **Heartbeat** | Annotated standing instructions checklist |
| **Gallery Protocol** | Task tracking, review types, resilience rules, completion rollup |
| **Collaboration** | Delegation with context guidance, sub-agent reception protocol |
| **Context** | Current date, model identity |

## Memory System

- **Auto-extraction**: After each conversation, Haiku extracts structured memories (user preferences, decisions, key facts, things that didn't work) and appends to `MEMORY.md`
- **PreCompact summaries**: Before context compaction, generates structured Goal/Accomplished/In Progress/Key Decisions/Next Steps summary. Iterative — merges with existing daily summary
- **Cross-session search**: Memory files indexed in Convex for full-text search across agents
- **Autonomous skills**: Agents can create reusable workflow skills from successful multi-step tasks

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Server listen port |
| `CLAW_MODEL` | `claude-opus-4-6` | Model to use |
| `CLAW_SUBTASK_MODEL` | `claude-sonnet-4-6` | Model for decompose_task subtasks |
| `CLAW_MAX_TURNS` | `50` | Max tool turns per query |
| `CLAW_AUTO_MEMORY` | `true` | Auto-extract memories after conversations |
| `CLAW_CONTEXT_WARN_THRESHOLD` | `0.70` | Context % to warn agent |
| `CLAW_CONTEXT_CHECKPOINT_THRESHOLD` | `0.80` | Context % to advise checkpoint |
| `ANTHROPIC_BASE_URL` | — | AI Gateway proxy URL |
| `ANTHROPIC_API_KEY` | — | Gateway token |
| `GALLERY_GATEWAY_TOKEN` | — | Auth token for Gallery API |
| `GALLERY_CONVEX_URL` | — | Convex deployment URL |
| `GALLERY_API_URL` | — | Gallery API base URL |
| `GALLERY_WORKER_URL` | — | Worker URL for agent delegation |
| `AGENT_ID` | — | Agent's Convex document ID |
| `AGENT_TIMEZONE` | `UTC` | Agent's timezone for local time display |
| `CLAW_AUTH_TOKEN` | — | Bearer token for container HTTP endpoints |

## Safety & Security

- **Secrets redaction**: 19 env vars unset before bash commands + 12 inline pattern regexes (sk-, ghp_, xox, AKIA, Authorization headers, private keys, DB connection strings)
- **Loop detection**: 4 detection methods (same call ×3, force stop ×6, cycle detection, same tool ×5)
- **Context tracking**: Cache-aware percentage calculation, warns at 70%, checkpoints at 80%
- **Prompt injection scanning**: 10 threat patterns for untrusted content
- **Request queuing**: Serial processing with 10-minute timeout, max 50 queued
- **Auth**: Bearer token required (warns at startup if not configured)
- **Message validation**: 500KB size limit
- **Convex retry**: 3 attempts with exponential backoff on 5xx errors
- **Budget limits**: Per-query turn limits + USD budget caps
