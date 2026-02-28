# Claw

An AI agent runtime by [Gallery.dev](https://gallery.dev). Runs Claude agents in isolated containers, managed from a web dashboard.

Claw is a fork of [NanoClaw](https://github.com/qwibitai/NanoClaw), customized for Gallery.dev's agent platform.

## What It Does

- **Dashboard-managed agents** -- Agents are configured and synced from the Gallery.dev dashboard to the VM via SSH, not manually on the host.
- **Telegram as primary channel** -- Telegram bot integration with swarm pool bots for sub-agent identities. WhatsApp also supported.
- **Soul system** -- Personality, tone, and behavioral boundaries injected into each agent's CLAUDE.md from Gallery.
- **Container isolation** -- Each agent runs in its own Linux container (Apple Container on macOS, Docker on macOS/Linux) with filesystem isolation.
- **Scheduled tasks** -- Recurring and one-time jobs via cron, interval, or timestamp.
- **Browser automation** -- Chromium pre-installed in containers with persistent browser profiles across sessions.
- **Tool loop detection** -- Automatic detection and blocking of repetitive tool calls.
- **Heartbeat standing instructions** -- Agents can have periodic self-check routines via HEARTBEAT.md.
- **Multi-session management** -- Main agent can inspect, message, and close other agent sessions.
- **Webhook triggers** -- External services can trigger agent actions via API endpoints.
- **AI proxy** -- API requests routed through Vercel AI Gateway.
- **Credit-based billing** -- Usage tracked and billed through Gallery.dev.
- **Agent swarms** -- Teams of specialized agents that collaborate on complex tasks.

## Architecture

```
Gallery.dev Dashboard --> SSH Sync --> Claw VM
Telegram/WhatsApp --> SQLite --> Polling loop --> Container (Claude Agent SDK) --> Response
```

Single Node.js process. Agents execute in isolated Linux containers with filesystem isolation. Only mounted directories are accessible. Per-group message queue with concurrency control. IPC via filesystem.

Key files:
- `src/index.ts` -- Orchestrator: state, message loop, agent invocation
- `src/channels/telegram.ts` -- Telegram bot connection, auth, send/receive
- `src/channels/whatsapp.ts` -- WhatsApp connection, auth, send/receive
- `src/ipc.ts` -- IPC watcher and task processing
- `src/router.ts` -- Message formatting and outbound routing
- `src/group-queue.ts` -- Per-group queue with global concurrency limit
- `src/container-runner.ts` -- Spawns streaming agent containers
- `src/task-scheduler.ts` -- Runs scheduled tasks
- `src/config.ts` -- Trigger pattern, paths, intervals
- `src/db.ts` -- SQLite operations (messages, groups, sessions, state)
- `groups/*/CLAUDE.md` -- Per-group memory
- `container/agent-runner/src/index.ts` -- In-container agent runner with loop detection, session management
- `container/agent-runner/src/ipc-mcp-stdio.ts` -- MCP server for agent tools (messaging, tasks, memory)

## Requirements

- macOS or Linux
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- [Apple Container](https://github.com/apple/container) (macOS) or [Docker](https://docker.com/products/docker-desktop) (macOS/Linux)

## Quick Start

```bash
cd claw
claude
```

Then run `/setup`. Claude Code handles dependencies, authentication, container setup and service configuration.

## Customizing

Tell Claude Code what you want:

- "Change the trigger word to @Bob"
- "Add a custom greeting when I say good morning"
- "Store conversation summaries weekly"

Or run `/customize` for guided changes. The codebase is small enough that Claude can safely modify it.

## Upstream

Claw tracks [NanoClaw](https://github.com/qwibitai/NanoClaw) as an upstream remote. Use `/update` to pull upstream changes and merge with local customizations.

## License

MIT
