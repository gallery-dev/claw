# Claw Agent Runner

The AI agent brain that runs inside Cloudflare Sandbox containers for [Gallery.dev](https://gallery.dev). Each agent gets its own isolated Firecracker microVM with persistent filesystem, memory, and tool access via the `gallery` CLI.

## Architecture

```
Gallery UI → /api/chat → Cloudflare Worker → POST /message → Claude Agent SDK → SSE events → UI
```

The agent runner is an HTTP server that:
1. Receives messages from the Cloudflare Worker
2. Executes Claude Agent SDK V2 sessions with persistent context
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
cp dist/server.bundle.js dist/gallery-cli.bundle.js dist/cli.js ../../../cloudflare/claw/claw-bundles/

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
- **gallery-cli.bundle.js** — Gallery CLI binary, installed at `/usr/local/bin/gallery` in the container
- **cli.js** — Claude Agent SDK CLI, copied from npm package (spawned by SDK for session management)

## Source Files

| File | Purpose |
|------|---------|
| `src/server.ts` | HTTP server: `/message`, `/task`, `/health`, `/status` endpoints, request queuing, SSE streaming |
| `src/agent.ts` | Claude Agent SDK V2 session management, memory extraction, cost tracking |
| `src/session-manager.ts` | Multi-conversation session lifecycle, LRU eviction, per-conversation locking |
| `src/gallery-cli.ts` | Gallery CLI — all agent tools (`gallery` command). Replaces MCP tools. |
| `src/shared.ts` | Hooks (bash sanitization, loop detection, context safety, PreCompact), activity posting, secrets redaction |
| `src/ui-stream.ts` | AI SDK UI Message Stream writer for SSE protocol |
| `esbuild.config.mjs` | Builds bundles + copies cli.js from SDK |

## Gallery CLI

Agents interact with Gallery via the `gallery` CLI, called through the SDK's `Bash` tool. Output is always JSON: `{ "ok": true, "result": "..." }` or `{ "ok": false, "error": "..." }`.

This approach was chosen over MCP tools because CLI commands have zero token overhead in the system prompt — no tool schema injection per turn.

| Category | Commands |
|----------|----------|
| Tasks | `gallery task list/create/update/delete/comment/report` |
| Agents | `gallery agent list/delegate/message` |
| Reviews | `gallery review create/list` |
| Memory | `gallery memory view/write/search/delete` |
| Workspace | `gallery workspace info` |
| Messaging | `gallery send-message` |
| Progress | `gallery progress` |

The CLI talks directly to Convex (queries/mutations) and the Gallery API. Auth via env vars set at provisioning time.

## Agent Prompt System (CLAUDE.md)

Each agent receives a comprehensive CLAUDE.md generated at provisioning time by `lib/claw-claude-md.ts` in the gallery.dev repo. Sections include:

| Section | Purpose |
|---------|---------|
| **Soul** | Core truths ("Act, don't narrate"), autonomy calibration, failure recovery, self-improvement, session startup checklist |
| **Owner** | Name, timezone, preferences |
| **Skills** | Installed skills with mandatory read protocol + autonomous creation guidance |
| **Tools Reference** | Gallery CLI commands + SDK built-in tools |
| **Security** | Secrets handling, external content trust, credential file protection |
| **Loop Detection** | Repetitive tool call thresholds |
| **Agent Roster** | Sub-agent list with roles and models (admin agents only) |
| **Communication** | Output channel, internal tags, messaging rules |
| **Memory** | Protocol (before/during/after), user profiling, context window survival |
| **Gallery Protocol** | Task tracking, review types, resilience rules, completion rollup |
| **Collaboration** | Delegation with context guidance, sub-agent reception protocol |

## Memory System

- **Auto-extraction**: After each conversation, Haiku extracts structured memories (user preferences, decisions, key facts, things that didn't work) and appends to `MEMORY.md`
- **PreCompact summaries**: Before context compaction, generates structured Goal/Accomplished/In Progress/Key Decisions/Next Steps summary. Iterative — merges with existing daily summary
- **Cross-session search**: Memory files indexed in Convex for full-text search across agents
- **Autonomous skills**: Agents can document reusable workflow skills in memory for future reuse

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Server listen port |
| `CLAW_MODEL` | `claude-opus-4-6` | Model to use |
| `CLAW_SUBTASK_MODEL` | `claude-sonnet-4-6` | Model for delegated subtasks |
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
