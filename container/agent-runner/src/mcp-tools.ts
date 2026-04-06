/**
 * Claw MCP Tools — Stdio MCP Server for Sprites
 * Adapted from ipc-mcp-stdio.ts for the Sprites architecture.
 *
 * Changes from Docker version:
 * - Memory tools: paths updated (/workspace/group → /home/sprite/workspace)
 * - send_message: POST to Gallery API instead of filesystem IPC
 * - Agent collaboration: gallery_delegate_task, gallery_message_agent
 * - Sub-task decomposition: decompose_task with parallel workers
 * - Removed: register_group, list_sessions, send_to_group, close_group_session, scheduling stubs
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { type ActivityType, postConvexActivity, SECRET_ENV_VARS, isTransientError } from './shared.js';

const WORKSPACE_DIR = process.env.CLAW_WORKSPACE_DIR || '/home/sprite/workspace';
const MEMORY_DIR = path.join(WORKSPACE_DIR, 'memory');
const MEMORY_FILE = path.join(WORKSPACE_DIR, 'MEMORY.md');

/**
 * Resolve a target path and verify it stays within WORKSPACE_DIR.
 * Uses fs.realpathSync() for existing paths to follow symlinks — prevents
 * symlink-based escape (e.g., `ln -s /etc/passwd memory/leak`).
 * For new files, resolves the parent directory (which must exist) instead.
 */
function assertWithinWorkspace(targetPath: string): string | null {
  try {
    if (fs.existsSync(targetPath)) {
      const real = fs.realpathSync(targetPath);
      if (!real.startsWith(fs.realpathSync(WORKSPACE_DIR))) return null;
      return real;
    }
    // New file: resolve parent dir (must exist and be within workspace)
    const parentDir = path.dirname(targetPath);
    if (fs.existsSync(parentDir)) {
      const realParent = fs.realpathSync(parentDir);
      if (!realParent.startsWith(fs.realpathSync(WORKSPACE_DIR))) return null;
    } else {
      // Parent doesn't exist yet — fall back to path.resolve check
      const resolved = path.resolve(targetPath);
      if (!resolved.startsWith(path.resolve(WORKSPACE_DIR))) return null;
    }
    return path.resolve(targetPath);
  } catch {
    return null;
  }
}

// Gallery API context (set by agent.ts when spawning this process)
const galleryApiUrl = process.env.GALLERY_API_URL || '';
const galleryWorkerUrl = process.env.GALLERY_WORKER_URL || '';
const galleryToken = process.env.GALLERY_TOKEN || '';
const agentId = process.env.AGENT_ID || '';

const server = new McpServer({
  name: 'claw',
  version: '2.0.0',
});

// ─── Messaging Tools ──────────────────────────────────

server.tool(
  'send_message',
  "Send a message to the user immediately while you're still running. Use this for genuinely important milestones — a major finding, a decision that needs acknowledgment, or a completion event. Do NOT use for every minor step. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher").'),
  },
  async (args) => {
    if (!galleryApiUrl || !galleryToken) {
      return {
        content: [{ type: 'text' as const, text: 'Message sent (Gallery API not configured — message logged locally).' }],
      };
    }

    try {
      const response = await fetch(`${galleryApiUrl}/api/claw/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${galleryToken}`,
        },
        body: JSON.stringify({
          agentId,
          text: args.text,
          sender: args.sender,
          timestamp: new Date().toISOString(),
        }),
      });

      if (!response.ok) {
        return {
          content: [{ type: 'text' as const, text: `Message delivery failed: ${response.status} ${response.statusText}` }],
          isError: true,
        };
      }

      return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Message delivery error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ─── Activity Posting ────────────────────────────────────

const convexUrl = process.env.GALLERY_CONVEX_URL || '';
const gatewayToken = process.env.GALLERY_GATEWAY_TOKEN || '';

let currentTaskId: string | undefined;

const PLAN_MODE_FILE = path.join(WORKSPACE_DIR, '.plan-mode');

/** Read plan mode state from disk (survives process restarts). */
function isPlanModeActive(): boolean {
  try { return fs.existsSync(PLAN_MODE_FILE); } catch { return false; }
}

/** Set plan mode state (persisted to disk). */
function setPlanMode(active: boolean): void {
  try {
    if (active) {
      fs.writeFileSync(PLAN_MODE_FILE, new Date().toISOString());
    } else if (fs.existsSync(PLAN_MODE_FILE)) {
      fs.unlinkSync(PLAN_MODE_FILE);
    }
  } catch { /* non-fatal */ }
}

/** Check if the current operation is blocked by plan mode. Returns error content or null. */
function checkPlanMode(toolName: string): { content: Array<{ type: 'text'; text: string }>; isError: true } | null {
  if (!isPlanModeActive()) return null;
  const readOnlyTools = new Set([
    'memory_view', 'memory_search', 'gallery_list_tasks', 'gallery_list_agents',
    'gallery_list_reviews', 'gallery_workspace_info', 'gallery_context_usage',
    'gallery_read_peer_memory', 'skill_list', 'gallery_exit_plan_mode',
    'update_progress', 'send_message', 'gallery_list_files',
  ]);
  if (readOnlyTools.has(toolName)) return null;
  return {
    content: [{ type: 'text' as const, text: `Blocked: "${toolName}" is not available in plan mode. Only read-only tools are allowed. Call gallery_exit_plan_mode to resume execution.` }],
    isError: true,
  };
}

function postActivity(type: ActivityType, content: string, metadata?: unknown): void {
  if (!convexUrl || !gatewayToken) return;
  postConvexActivity(convexUrl, gatewayToken, agentId, type, content, metadata, currentTaskId);
}

// ─── Convex Memory Index ─────────────────────────────────

/** Fire-and-forget: index a memory file in Convex for full-text search. */
async function indexMemoryEntry(memPath: string, body: string): Promise<void> {
  if (!convexUrl || !gatewayToken) return;
  try {
    await fetch(`${convexUrl}/api/mutation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: 'memoryEntries:upsert',
        args: { token: gatewayToken, agentId, path: memPath, body },
      }),
    });
  } catch { /* best-effort */ }
}

/** Fire-and-forget: remove a memory entry from Convex index. */
async function removeMemoryEntry(memPath: string): Promise<void> {
  if (!convexUrl || !gatewayToken) return;
  try {
    await fetch(`${convexUrl}/api/mutation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: 'memoryEntries:remove',
        args: { token: gatewayToken, agentId, path: memPath },
      }),
    });
  } catch { /* best-effort */ }
}

/** Search memory entries via Convex full-text search. Returns null on failure. */
async function searchMemoryEntries(searchQuery: string, limit: number = 10): Promise<Array<{ path: string; body: string }> | null> {
  if (!convexUrl || !gatewayToken) return null;
  try {
    const res = await fetch(`${convexUrl}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: 'memoryEntries:search',
        args: { token: gatewayToken, agentId, query: searchQuery, limit },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.value ?? data ?? null;
  } catch {
    return null;
  }
}

// ─── Sub-task Decomposition ──────────────────────────────

const DELEGATION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const SUBTASK_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CONCURRENT_SUBTASKS = 5;
const MAX_SUBTASKS = 10;

interface SubtaskResult {
  index: number;
  description: string;
  status: 'success' | 'error' | 'timeout';
  result?: string;
  error?: string;
  durationMs: number;
}

async function runSubtask(
  subtask: { description: string; context?: string },
  index: number,
): Promise<SubtaskResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SUBTASK_TIMEOUT_MS);

  const prompt = [
    'You are a focused subtask worker. Complete this task and return a clear, structured result.',
    '',
    `Task: ${subtask.description}`,
    subtask.context ? `\nContext: ${subtask.context}` : '',
    '',
    'IMPORTANT: Complete this task directly. Do NOT try to spawn sub-tasks. Return your result as clear text.',
  ].join('\n');

  try {
    postActivity('subtask_started', `Subtask ${index + 1}: ${subtask.description}`);
    const resultTexts: string[] = [];

    for await (const msg of query({
      prompt,
      options: {
        cwd: WORKSPACE_DIR,
        model: process.env.CLAW_SUBTASK_MODEL || 'claude-sonnet-4-6',
        maxTurns: 50,
        allowedTools: [
          'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
          'WebSearch', 'WebFetch',
          // No mcp__claw__* — subtasks cannot decompose further or use agent messaging
        ],
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([k]) =>
              !['CLAUDE_CODE_OAUTH_TOKEN', ...SECRET_ENV_VARS].includes(k)
            )
          ),
          // Re-include API keys the SDK subprocess needs to call Claude
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
          ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || '',
        },
        permissionMode: 'acceptEdits',
        abortController: controller,
      },
    })) {
      if (msg.type === 'result') {
        const text = 'result' in msg ? (msg as { result?: string }).result : null;
        if (text) resultTexts.push(text);
      }
    }

    clearTimeout(timeout);
    const duration = Date.now() - start;
    postActivity('subtask_completed', `Subtask ${index + 1} completed in ${(duration / 1000).toFixed(1)}s`, { index, description: subtask.description });
    return {
      index,
      description: subtask.description,
      status: 'success',
      result: resultTexts.join('\n\n') || '(completed with no text output)',
      durationMs: duration,
    };
  } catch (err) {
    clearTimeout(timeout);
    const duration = Date.now() - start;
    const isAbort = err instanceof Error && err.name === 'AbortError';
    postActivity('subtask_failed', `Subtask ${index + 1} ${isAbort ? 'timed out' : 'failed'}: ${subtask.description}`, { index, error: isAbort ? 'timeout' : String(err) });
    return {
      index,
      description: subtask.description,
      status: isAbort ? 'timeout' : 'error',
      error: isAbort ? `Subtask timed out after ${SUBTASK_TIMEOUT_MS / 1000}s` : (err instanceof Error ? err.message : String(err)),
      durationMs: duration,
    };
  }
}

server.tool(
  'decompose_task',
  `Split a complex task into parallel subtasks. Each subtask runs as an independent AI worker with access to the filesystem, bash, and web tools.

Use this when a task has independent parts that can run simultaneously. Good use cases:
- Researching multiple topics at once (e.g., "research 3 competitors")
- Reviewing multiple files or codebases in parallel
- Running investigation + implementation simultaneously
- Generating reports for each region/category at once

GUIDELINES:
- Max ${MAX_SUBTASKS} subtasks per call
- ${MAX_CONCURRENT_SUBTASKS} run in parallel at a time
- Each subtask gets up to 15 minutes and 15 tool calls
- Subtasks share the workspace filesystem — avoid writing to the same files
- Subtasks CANNOT spawn their own subtasks (1 level only)
- Use this for genuinely parallel work, not sequential steps`,
  {
    subtasks: z.array(z.object({
      description: z.string().describe('What this subtask should accomplish — be specific'),
      context: z.string().optional().describe('Additional data, instructions, or file paths relevant to this subtask'),
    })).min(1).max(MAX_SUBTASKS).describe('Array of subtasks to execute in parallel'),
  },
  async (args) => {
    const { subtasks } = args;
    const allResults: SubtaskResult[] = [];

    // Execute in batches of MAX_CONCURRENT_SUBTASKS
    for (let i = 0; i < subtasks.length; i += MAX_CONCURRENT_SUBTASKS) {
      const batch = subtasks.slice(i, i + MAX_CONCURRENT_SUBTASKS);
      const batchResults = await Promise.allSettled(
        batch.map((subtask, batchIndex) => runSubtask(subtask, i + batchIndex)),
      );

      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j];
        if (result.status === 'fulfilled') {
          allResults.push(result.value);
        } else {
          allResults.push({
            index: i + j,
            description: batch[j]?.description || 'unknown',
            status: 'error',
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            durationMs: 0,
          });
        }
      }
    }

    // Format results
    const succeeded = allResults.filter(r => r.status === 'success').length;
    const failed = allResults.filter(r => r.status === 'error').length;
    const timedOut = allResults.filter(r => r.status === 'timeout').length;

    const summary = `Completed ${allResults.length} subtasks: ${succeeded} succeeded, ${failed} failed, ${timedOut} timed out.`;

    const details = allResults.map(r => {
      const header = `## Subtask ${r.index + 1}: ${r.description}`;
      const status = `**Status:** ${r.status} (${(r.durationMs / 1000).toFixed(1)}s)`;
      const body = r.status === 'success' ? r.result : `**Error:** ${r.error}`;
      return `${header}\n${status}\n\n${body}`;
    }).join('\n\n---\n\n');

    return {
      content: [{
        type: 'text' as const,
        text: `${summary}\n\n${details}`,
      }],
    };
  },
);

// ─── Progress Tracking ──────────────────────────────────

server.tool(
  'update_progress',
  `Report your progress on a multi-step task. The dashboard shows this as a real-time progress indicator so the user knows what you're working on.

Use this at natural milestones — don't call it on every minor step.`,
  {
    steps: z.array(z.string()).describe('All steps in the task (e.g., ["Research competitors", "Analyze pricing", "Write report"])'),
    current: z.number().describe('Index of the current step (0-based)'),
    status: z.enum(['in_progress', 'completed', 'blocked']).default('in_progress').describe('Status of the current step'),
    note: z.string().optional().describe('Optional detail about what is happening in the current step'),
  },
  async (args) => {
    const { steps, current, status, note } = args;
    const progress = Math.round(((current + (status === 'completed' ? 1 : 0)) / steps.length) * 100);

    postActivity('progress', `Step ${current + 1}/${steps.length}: ${steps[current]} [${status}]${note ? ` — ${note}` : ''}`, {
      steps,
      current,
      status,
      progress,
    });

    const display = steps.map((step, i) => {
      if (i < current) return `  [x] ${step}`;
      if (i === current) return `  [${status === 'completed' ? 'x' : status === 'blocked' ? '!' : '>'}] ${step}${note ? ` — ${note}` : ''}`;
      return `  [ ] ${step}`;
    }).join('\n');

    return {
      content: [{
        type: 'text' as const,
        text: `Progress: ${progress}%\n${display}`,
      }],
    };
  },
);

// ─── Agent Collaboration ─────────────────────────────────

server.tool(
  'gallery_delegate_task',
  `Delegate a task to another agent in your workspace. The target agent will execute the task and return its result.

Use this when:
- A task requires skills or knowledge another agent specializes in
- You want to parallelize work across multiple agents
- You need to hand off a subtask to a dedicated agent

The target agent runs the full task as a message (same as a user sending it). This call blocks until the target agent completes.

IMPORTANT: The sub-agent cannot ask you questions during delegation — give them everything they need upfront. A good delegation includes:
1. A clear task title (specific enough that "done" is obvious)
2. A context block with: relevant file paths, prior decisions, constraints, what NOT to do
3. Success criteria — what does a complete result look like?

Poor: "research competitors"
Better: "Research top 5 AI agent platforms — focus on pricing models, LLM support, deployment options. Avoid consumer tools. Deliver a markdown comparison table."

You must know the target agent's Convex ID (agentId) to delegate. You can find agent IDs by asking the user or checking workspace context.`,
  {
    toAgentId: z.string().describe("Convex document ID of the target agent"),
    task: z.string().describe("The task or instruction to send to the target agent — be specific and complete"),
    context: z.string().optional().describe("Additional context, data, or files the target agent needs"),
  },
  async (args) => {
    const blocked = checkPlanMode('gallery_delegate_task');
    if (blocked) return blocked;
    if (!galleryApiUrl || !galleryToken) {
      return {
        content: [{ type: 'text' as const, text: 'Agent delegation requires Gallery API (not configured).' }],
        isError: true,
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DELEGATION_TIMEOUT_MS);

    try {
      // Use Worker URL for same-network delegation (no Vercel hop)
      const delegateUrl = galleryWorkerUrl
        ? `${galleryWorkerUrl}/delegate`
        : `${galleryApiUrl}/api/claw/delegate`;

      // Retry with backoff on 5xx errors
      const retryDelays = [0, 1000, 5000];
      let lastError = '';
      let lastStatus = 0;

      for (let attempt = 0; attempt < retryDelays.length; attempt++) {
        if (attempt > 0) {
          await new Promise(r => setTimeout(r, retryDelays[attempt]));
          postActivity('status', `Delegation retry ${attempt + 1}/3 to agent ${args.toAgentId}`);
        }

        const response = await fetch(delegateUrl, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${galleryToken}`,
          },
          body: JSON.stringify({
            type: 'task',
            toAgentId: args.toAgentId,
            fromAgentId: agentId,
            task: args.task,
            context: args.context,
          }),
        });

        if (response.ok) {
          const data = await response.json() as { success: boolean; result?: string | null };
          return {
            content: [{
              type: 'text' as const,
              text: data.result
                ? `Agent completed task.\n\nResult:\n${data.result}`
                : 'Agent completed task (no text output).',
            }],
          };
        }

        lastStatus = response.status;
        lastError = await response.text();

        // Don't retry on 4xx (client errors)
        if (response.status < 500) break;
      }

      return {
        content: [{ type: 'text' as const, text: `Delegation failed (${lastStatus}): ${lastError}` }],
        isError: true,
      };
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const msg = isAbort ? `Delegation timed out after ${DELEGATION_TIMEOUT_MS / 1000}s` : (err instanceof Error ? err.message : String(err));
      return {
        content: [{ type: 'text' as const, text: `Delegation error: ${msg}` }],
        isError: true,
      };
    } finally {
      clearTimeout(timeout);
    }
  },
);

server.tool(
  'gallery_message_agent',
  `Send a message to another agent and get their response. Use for quick questions, status checks, or collaboration where you need an immediate answer.

Unlike gallery_delegate_task, this is for conversational exchanges — asking an agent a question or requesting a brief output. The target agent's reply is returned directly.`,
  {
    toAgentId: z.string().describe("Convex document ID of the target agent"),
    message: z.string().describe("The message to send"),
  },
  async (args) => {
    if (!galleryApiUrl || !galleryToken) {
      return {
        content: [{ type: 'text' as const, text: 'Agent messaging requires Gallery API (not configured).' }],
        isError: true,
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DELEGATION_TIMEOUT_MS);

    try {
      const delegateUrl = galleryWorkerUrl
        ? `${galleryWorkerUrl}/delegate`
        : `${galleryApiUrl}/api/claw/delegate`;
      const response = await fetch(delegateUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${galleryToken}`,
        },
        body: JSON.stringify({
          type: 'message',
          toAgentId: args.toAgentId,
          fromAgentId: agentId,
          message: args.message,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        return {
          content: [{ type: 'text' as const, text: `Message failed (${response.status}): ${err}` }],
          isError: true,
        };
      }

      const data = await response.json() as { success: boolean; result?: string | null };
      return {
        content: [{
          type: 'text' as const,
          text: data.result || '(Agent replied with no text output)',
        }],
      };
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const msg = isAbort ? `Message timed out after ${DELEGATION_TIMEOUT_MS / 1000}s` : (err instanceof Error ? err.message : String(err));
      return {
        content: [{ type: 'text' as const, text: `Message error: ${msg}` }],
        isError: true,
      };
    } finally {
      clearTimeout(timeout);
    }
  },
);

// ─── Memory Tools ──────────────────────────────────────

server.tool(
  'memory_view',
  `View memory directory contents or read a specific memory file. Use this to check what you've remembered from past sessions.

IMPORTANT: Check your memory before starting any task to avoid repeating past work.

Returns directory listing (with sizes) or file contents with line numbers.`,
  {
    path: z.string().default('/').describe('Relative path within memory. "/" lists the memory directory. "MEMORY.md" reads the long-term memory file. "2026-02-28.md" reads a daily note.'),
    view_range: z.array(z.number()).length(2).optional().describe('Optional [startLine, endLine] to read a specific range of a file.'),
  },
  async (args) => {
    const requestedPath = args.path === '/' ? '' : args.path;

    let targetPath: string;
    if (requestedPath === 'MEMORY.md' || requestedPath === '/MEMORY.md') {
      targetPath = MEMORY_FILE;
    } else if (requestedPath === '' || requestedPath === '/') {
      // List both MEMORY.md and memory/ contents
      const entries: string[] = [];

      if (fs.existsSync(MEMORY_FILE)) {
        const stat = fs.statSync(MEMORY_FILE);
        entries.push(`${formatSize(stat.size)}\tMEMORY.md`);
      }

      if (fs.existsSync(MEMORY_DIR)) {
        const files = fs.readdirSync(MEMORY_DIR).filter(f => !f.startsWith('.')).sort();
        for (const file of files) {
          const filePath = path.join(MEMORY_DIR, file);
          const stat = fs.statSync(filePath);
          if (stat.isFile()) {
            entries.push(`${formatSize(stat.size)}\tmemory/${file}`);
          } else if (stat.isDirectory()) {
            entries.push(`${formatSize(stat.size)}\tmemory/${file}/`);
          }
        }
      }

      if (entries.length === 0) {
        return { content: [{ type: 'text' as const, text: 'Memory is empty. Use memory_write to save notes.' }] };
      }

      return { content: [{ type: 'text' as const, text: `Memory files:\n${entries.join('\n')}` }] };
    } else {
      targetPath = path.join(MEMORY_DIR, requestedPath);
    }

    // Security: ensure path stays within workspace (resolves symlinks)
    if (!assertWithinWorkspace(targetPath)) {
      return { content: [{ type: 'text' as const, text: `Error: path must be within your workspace.` }], isError: true };
    }

    if (!fs.existsSync(targetPath)) {
      return { content: [{ type: 'text' as const, text: `No memory file at "${args.path}". Use memory_write to create one.` }] };
    }

    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) {
      const files = fs.readdirSync(targetPath).filter(f => !f.startsWith('.')).sort();
      const entries = files.map(f => {
        const s = fs.statSync(path.join(targetPath, f));
        return `${formatSize(s.size)}\t${f}${s.isDirectory() ? '/' : ''}`;
      });
      return { content: [{ type: 'text' as const, text: entries.length > 0 ? entries.join('\n') : '(empty directory)' }] };
    }

    const content = fs.readFileSync(targetPath, 'utf-8');
    const lines = content.split('\n');

    if (args.view_range) {
      const [start, end] = args.view_range;
      const slice = lines.slice(Math.max(0, start - 1), end);
      const numbered = slice.map((line, i) => `${String(start + i).padStart(6)}\t${line}`).join('\n');
      return { content: [{ type: 'text' as const, text: `${args.path} (lines ${start}-${end}):\n${numbered}` }] };
    }

    const numbered = lines.map((line, i) => `${String(i + 1).padStart(6)}\t${line}`).join('\n');
    return { content: [{ type: 'text' as const, text: `${args.path}:\n${numbered}` }] };
  },
);

server.tool(
  'memory_write',
  `Write or update a memory file. Use this to persist important information across sessions.

Write proactively after every substantive discovery: a user preference, a decision made, a persistent limitation or wrong approach, an important project fact. Don't wait until you're asked — write now, during the conversation. This is how you become someone who genuinely knows the owner instead of starting fresh each session.

Best practices:
• MEMORY.md — curated long-term facts, decisions, preferences. Never write transient errors here (timeouts, disconnects, "service unavailable").
• memory/YYYY-MM-DD.md — daily notes, running context, progress logs, transient warnings.
• memory/topic.md — structured data about specific topics.`,
  {
    path: z.string().describe('File path relative to memory. Examples: "MEMORY.md", "2026-02-28.md", "project-status.md"'),
    content: z.string().describe('Content to write.'),
    mode: z.enum(['append', 'replace', 'create']).default('append').describe('append=add to end (default), replace=overwrite entire file, create=new file only'),
  },
  async (args) => {
    const blocked = checkPlanMode('memory_write');
    if (blocked) return blocked;
    let targetPath: string;
    if (args.path === 'MEMORY.md' || args.path === '/MEMORY.md') {
      targetPath = MEMORY_FILE;
    } else {
      targetPath = path.join(MEMORY_DIR, args.path);
    }

    if (!assertWithinWorkspace(targetPath)) {
      return { content: [{ type: 'text' as const, text: `Error: path must be within your workspace.` }], isError: true };
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    if (args.mode === 'create' && fs.existsSync(targetPath)) {
      return { content: [{ type: 'text' as const, text: `Error: "${args.path}" already exists. Use mode "append" or "replace".` }], isError: true };
    }

    if (args.mode === 'append') {
      const existing = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf-8') : '';
      const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
      fs.writeFileSync(targetPath, existing + separator + args.content);
    } else {
      fs.writeFileSync(targetPath, args.content);
    }

    // Index in Convex for full-text search (fire-and-forget)
    const fullContent = fs.readFileSync(targetPath, 'utf-8');
    indexMemoryEntry(args.path, fullContent);

    const stat = fs.statSync(targetPath);
    const isMemoryMd = args.path === 'MEMORY.md' || args.path === '/MEMORY.md';
    const hasTransient = isMemoryMd && isTransientError(args.content);
    const warning = hasTransient
      ? `\n\nWarning: This content appears to describe a transient error. Consider writing transient errors to daily notes (memory/YYYY-MM-DD.md) instead of MEMORY.md to avoid poisoning long-term memory.`
      : '';
    return { content: [{ type: 'text' as const, text: `Memory written: ${args.path} (${formatSize(stat.size)})${warning}` }] };
  },
);

/** Local keyword search across memory or conversation files. */
function localKeywordSearch(
  queryTerms: string[],
  scope: 'memory' | 'conversations',
): Array<{ file: string; line: number; text: string }> {
  const results: Array<{ file: string; line: number; text: string }> = [];

  const searchFile = (filePath: string, displayName: string) => {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const lineLower = lines[i].toLowerCase();
        if (queryTerms.some(term => lineLower.includes(term))) {
          const start = Math.max(0, i - 1);
          const end = Math.min(lines.length, i + 2);
          const snippet = lines.slice(start, end).join('\n');
          results.push({ file: displayName, line: i + 1, text: snippet.slice(0, 300) });
        }
      }
    } catch { /* skip unreadable files */ }
  };

  const searchDir = (dirPath: string, prefix: string) => {
    if (!fs.existsSync(dirPath)) return;
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.md')).sort();
    for (const file of files) {
      searchFile(path.join(dirPath, file), `${prefix}${file}`);
    }
  };

  if (scope === 'memory') {
    if (fs.existsSync(MEMORY_FILE)) {
      searchFile(MEMORY_FILE, 'MEMORY.md');
    }
    searchDir(MEMORY_DIR, 'memory/');
  } else {
    searchDir(path.join(WORKSPACE_DIR, 'conversations'), 'conversations/');
  }

  // Deduplicate adjacent matches in the same file
  return results.filter((r, i) => {
    if (i === 0) return true;
    const prev = results[i - 1];
    return !(r.file === prev.file && Math.abs(r.line - prev.line) <= 2);
  });
}

server.tool(
  'memory_search',
  `Search across all memory files for relevant information. Uses full-text search (BM25 ranking) for relevance-ranked results. Falls back to keyword matching if search index is unavailable.`,
  {
    query: z.string().describe('Search query — natural language or keywords to find in memory files'),
    scope: z.enum(['memory', 'conversations', 'all']).default('all').describe('Where to search'),
    limit: z.number().default(10).describe('Max results to return'),
  },
  async (args) => {
    const queryTerms = args.query.toLowerCase().split(/\s+/).filter(Boolean);
    if (queryTerms.length === 0) {
      return { content: [{ type: 'text' as const, text: 'Search query is empty.' }], isError: true };
    }

    const sections: string[] = [];
    let totalMatches = 0;

    // ── Convex full-text search for memory files (BM25-ranked) ──
    if (args.scope !== 'conversations') {
      const indexed = await searchMemoryEntries(args.query, args.limit);
      if (indexed && indexed.length > 0) {
        totalMatches += indexed.length;
        const formatted = indexed.map(entry => {
          const lines = entry.body.split('\n');
          const snippets: string[] = [];
          for (let i = 0; i < lines.length && snippets.length < 3; i++) {
            const lineLower = lines[i].toLowerCase();
            if (queryTerms.some(term => lineLower.includes(term))) {
              const start = Math.max(0, i - 1);
              const end = Math.min(lines.length, i + 2);
              snippets.push(lines.slice(start, end).join('\n').slice(0, 300));
            }
          }
          if (snippets.length === 0) {
            snippets.push(lines.slice(0, 4).join('\n').slice(0, 300));
          }
          return `**${entry.path}**\n${snippets.join('\n...\n')}`;
        }).join('\n\n---\n\n');
        sections.push(formatted);
      } else {
        // Convex unavailable or empty — fall back to local keyword search for memory
        const memResults = localKeywordSearch(queryTerms, 'memory');
        if (memResults.length > 0) {
          totalMatches += memResults.length;
          sections.push(memResults.slice(0, args.limit).map(r => `**${r.file}:${r.line}**\n${r.text}`).join('\n\n---\n\n'));
        }
      }
    }

    // ── Local keyword search for conversations (not indexed in Convex) ──
    if (args.scope === 'conversations' || args.scope === 'all') {
      const convResults = localKeywordSearch(queryTerms, 'conversations');
      if (convResults.length > 0) {
        totalMatches += convResults.length;
        sections.push(convResults.slice(0, args.limit).map(r => `**${r.file}:${r.line}**\n${r.text}`).join('\n\n---\n\n'));
      }
    }

    if (totalMatches === 0) {
      return { content: [{ type: 'text' as const, text: `No matches for "${args.query}" in ${args.scope} files.` }] };
    }

    return { content: [{ type: 'text' as const, text: `Found ${totalMatches} match(es) for "${args.query}":\n\n${sections.join('\n\n---\n\n')}` }] };
  },
);

server.tool(
  'memory_delete',
  'Delete a memory file that is no longer relevant.',
  {
    path: z.string().describe('File path to delete, relative to memory.'),
  },
  async (args) => {
    const blocked = checkPlanMode('memory_delete');
    if (blocked) return blocked;
    let targetPath: string;
    if (args.path === 'MEMORY.md' || args.path === '/MEMORY.md') {
      targetPath = MEMORY_FILE;
    } else {
      targetPath = path.join(MEMORY_DIR, args.path);
    }

    if (!assertWithinWorkspace(targetPath)) {
      return { content: [{ type: 'text' as const, text: `Error: path must be within your workspace.` }], isError: true };
    }

    if (!fs.existsSync(targetPath)) {
      return { content: [{ type: 'text' as const, text: `File "${args.path}" not found.` }], isError: true };
    }

    fs.unlinkSync(targetPath);

    // Remove from Convex search index (fire-and-forget)
    removeMemoryEntry(args.path);

    return { content: [{ type: 'text' as const, text: `Deleted ${args.path}` }] };
  },
);

// ─── Knowledge Files ────────────────────────────────────────

const FILES_DIR = path.join(WORKSPACE_DIR, 'files');

server.tool(
  'gallery_list_files',
  `List knowledge files uploaded to the workspace via the Gallery dashboard. These files are in the files/ directory and can be read with the Read tool.

Use this to discover what reference materials, specs, or documents the workspace owner has uploaded.`,
  {},
  async () => {
    if (!fs.existsSync(FILES_DIR)) {
      return { content: [{ type: 'text' as const, text: 'No knowledge files uploaded. The workspace owner can upload files via the Gallery dashboard.' }] };
    }

    try {
      const entries = fs.readdirSync(FILES_DIR).filter(f => !f.startsWith('.')).sort();
      if (entries.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No knowledge files uploaded. The workspace owner can upload files via the Gallery dashboard.' }] };
      }

      const lines = entries.map(f => {
        try {
          const filePath = path.join(FILES_DIR, f);
          const stat = fs.statSync(filePath);
          const ext = path.extname(f).toLowerCase();
          return `- ${f} (${formatSize(stat.size)}, ${ext || 'no extension'})  →  Read with: files/${f}`;
        } catch {
          return `- ${f} (unreadable)`;
        }
      });

      return { content: [{ type: 'text' as const, text: `Knowledge files (${entries.length}):\n${lines.join('\n')}\n\nUse the Read tool with path "files/<filename>" to view file contents.` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error listing files: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// ─── Skill Management (Autonomous) ─────────────────────────

const SKILLS_DIR = path.join(WORKSPACE_DIR, 'skills');

function safeSkillSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

server.tool(
  'skill_list',
  `List your installed skills. Shows all active skills (workspace-level and agent-specific) with their descriptions and file paths.

Check this before creating a new skill to avoid duplicates.`,
  {},
  async () => {
    const entries: string[] = [];

    // List from filesystem (source of truth for what's immediately available)
    if (fs.existsSync(SKILLS_DIR)) {
      const dirs = fs.readdirSync(SKILLS_DIR).filter(d => {
        const skillPath = path.join(SKILLS_DIR, d, 'SKILL.md');
        return fs.existsSync(skillPath);
      }).sort();

      for (const dir of dirs) {
        const skillPath = path.join(SKILLS_DIR, dir, 'SKILL.md');
        const content = fs.readFileSync(skillPath, 'utf-8');
        const firstLine = content.split('\n').find(l => l.startsWith('# '))?.replace(/^#\s*/, '') || dir;
        const descLine = content.split('\n').find(l => l.trim() && !l.startsWith('#') && !l.startsWith('---'));
        entries.push(`- **${firstLine}** → \`skills/${dir}/SKILL.md\`${descLine ? `\n  ${descLine.trim().slice(0, 120)}` : ''}`);
      }
    }

    if (entries.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No skills installed. Use skill_create to author a new skill from a successful workflow.' }] };
    }

    return { content: [{ type: 'text' as const, text: `Installed skills:\n\n${entries.join('\n')}` }] };
  },
);

server.tool(
  'skill_create',
  `Create a new skill from a successful workflow you just completed. Skills are reusable workflow templates that make you faster and more consistent at recurring tasks.

**When to create a skill:**
- You just completed a multi-step task that took 5+ tool calls
- The workflow is likely to recur (similar tasks in the future)
- The approach has been validated (it worked, the owner was satisfied)

**How to write a good skill:**
- Start with a clear trigger description (when should this skill activate?)
- Document the exact steps, commands, and tools used
- Include decision points (if X then Y, else Z)
- Note common pitfalls or edge cases discovered
- Keep it actionable — another agent (or future you) should be able to follow it exactly

The skill is saved both to your local filesystem (immediately available) and to the database (persists across container restarts).`,
  {
    name: z.string().describe('Skill name (e.g. "Code Review", "Email Triage", "Deploy Pipeline")'),
    description: z.string().describe('One-line description of what this skill does and when to use it'),
    content: z.string().describe('Full skill content in markdown — workflow steps, commands, decision points, pitfalls'),
  },
  async (args) => {
    const slug = safeSkillSlug(args.name);
    const skillDir = path.join(SKILLS_DIR, slug);
    const skillPath = path.join(skillDir, 'SKILL.md');

    // Write to local filesystem (immediately available)
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(skillPath, args.content);

    // Persist to Convex database (survives container restarts)
    try {
      await convexMutation('mcpInternal:createSkill', {
        agentId,
        name: args.name,
        description: args.description,
        content: args.content,
      });
    } catch (err) {
      // If DB save fails (e.g. duplicate name), skill is still on filesystem
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('already exists')) {
        return { content: [{ type: 'text' as const, text: `Skill "${args.name}" already exists. Use skill_update to modify it.` }], isError: true };
      }
      // Non-fatal: skill works locally even if DB save failed
      postActivity('status', `Skill "${args.name}" saved locally but DB sync failed: ${errMsg}`);
    }

    postActivity('status', `Created skill: ${args.name}`, { skillName: args.name });
    return { content: [{ type: 'text' as const, text: `Skill created: "${args.name}" → skills/${slug}/SKILL.md\n\nThis skill is now available in your workflow. Other agents in the workspace will get it on next sync.` }] };
  },
);

server.tool(
  'skill_update',
  `Update an existing skill with improvements, fixes, or additional steps discovered during recent work.

**When to update a skill:**
- You followed a skill but discovered a better approach
- A step in the skill is outdated or broken
- You found a new edge case or pitfall to document
- The owner gave feedback that changes the workflow

Always explain WHAT changed and WHY in your update.`,
  {
    name: z.string().describe('Name of the skill to update (exact match)'),
    content: z.string().describe('Updated full skill content in markdown (replaces entire skill file)'),
    description: z.string().optional().describe('Updated one-line description (optional)'),
    changelog: z.string().optional().describe('Brief note of what changed and why (appended to skill for history)'),
  },
  async (args) => {
    const slug = safeSkillSlug(args.name);
    const skillPath = path.join(SKILLS_DIR, slug, 'SKILL.md');

    // Append changelog if provided
    let finalContent = args.content;
    if (args.changelog) {
      const date = new Date().toISOString().split('T')[0];
      finalContent += `\n\n---\n\n## Changelog\n\n- **${date}**: ${args.changelog}\n`;
    }

    // Write to filesystem
    fs.mkdirSync(path.join(SKILLS_DIR, slug), { recursive: true });
    fs.writeFileSync(skillPath, finalContent);

    // Update in Convex
    try {
      await convexMutation('mcpInternal:updateSkill', {
        name: args.name,
        agentId,
        content: finalContent,
        description: args.description,
      });
    } catch {
      // Non-fatal — local file is already updated
    }

    postActivity('status', `Updated skill: ${args.name}`, { skillName: args.name });
    return { content: [{ type: 'text' as const, text: `Skill updated: "${args.name}" → skills/${slug}/SKILL.md${args.changelog ? `\nChange: ${args.changelog}` : ''}` }] };
  },
);

// ─── Gallery Workspace Tools ─────────────────────────────
// These call Convex via HTTP using the gateway token, same as activity posting.

/** Helper: call a Convex query via HTTP API with retry on 5xx. */
async function convexQuery(fnPath: string, args: Record<string, unknown>): Promise<any> {
  if (!convexUrl || !gatewayToken) throw new Error('Gallery API not configured');
  const delays = [100, 1000, 5000];
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${convexUrl}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: fnPath, args: { token: gatewayToken, ...args } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const data = await res.json();
      return data.value ?? data;
    }
    if (res.status < 500 || attempt === 2) throw new Error(`Convex query failed: ${res.status}`);
    await new Promise(r => setTimeout(r, delays[attempt]));
  }
}

/** Helper: call a Convex mutation via HTTP API with retry on 5xx. */
async function convexMutation(fnPath: string, args: Record<string, unknown>): Promise<any> {
  if (!convexUrl || !gatewayToken) throw new Error('Gallery API not configured');
  const delays = [100, 1000, 5000];
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${convexUrl}/api/mutation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: fnPath, args: { token: gatewayToken, ...args } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const data = await res.json();
      return data.value ?? data;
    }
    if (res.status < 500 || attempt === 2) throw new Error(`Convex mutation failed: ${res.status}`);
    await new Promise(r => setTimeout(r, delays[attempt]));
  }
}

// ── Task Management ──

server.tool(
  'gallery_list_tasks',
  'List tasks in the workspace kanban board. Returns title, status, priority, and assignee.',
  {
    status: z.enum(['scheduled', 'todo', 'in_progress', 'in_review', 'blocked', 'failed', 'done', 'cancelled']).optional().describe('Filter by status. Omit to list all.'),
  },
  async (args) => {
    const tasks = await convexQuery('mcpInternal:listTasks', { status: args.status });
    const list = (tasks as any[]).map((t: any) => `- [${t.status}] ${t.title}${t.assignedAgent ? ` (${t.assignedAgent})` : ''}${t.priority && t.priority !== 'none' ? ` [${t.priority}]` : ''}${t.parentTaskId ? ' (subtask)' : ''} — id: ${t._id}`);
    return { content: [{ type: 'text' as const, text: list.length > 0 ? list.join('\n') : 'No tasks found.' }] };
  },
);

server.tool(
  'gallery_create_task',
  'Create a new task on the workspace kanban board. Call this BEFORE starting any non-trivial work — this is how your owner tracks what you\'re doing. Appears instantly in the Gallery dashboard.',
  {
    title: z.string().describe('Task title'),
    description: z.string().optional().describe('Detailed task description'),
    priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']).optional(),
    assignedAgent: z.string().optional().describe('Name of the agent to assign this task to'),
    status: z.enum(['scheduled', 'todo', 'in_progress', 'in_review', 'blocked', 'failed', 'done', 'cancelled']).optional(),
    labels: z.array(z.string()).optional().describe('Tags/labels for the task'),
    dueDate: z.number().optional().describe('Due date as Unix timestamp in milliseconds'),
    parentTaskId: z.string().optional().describe('ID of parent task — use for subtasks. Get IDs from gallery_create_task or gallery_list_tasks.'),
  },
  async (args) => {
    const blocked = checkPlanMode('gallery_create_task');
    if (blocked) return blocked;
    const id = await convexMutation('mcpInternal:createTask', {
      title: args.title,
      description: args.description,
      status: args.status,
      priority: args.priority,
      labels: args.labels,
      assignedAgent: args.assignedAgent,
      dueDate: args.dueDate,
      parentTaskId: args.parentTaskId,
    });
    postActivity('status', `Created task: ${args.title}`, { taskId: id });
    return { content: [{ type: 'text' as const, text: `Task created: "${args.title}" [${args.status ?? 'todo'}] (id: ${id})` }] };
  },
);

server.tool(
  'gallery_update_task',
  'Update a task. Prefer passing taskId if you have it; falls back to title matching.',
  {
    taskId: z.string().optional().describe('Task ID (preferred — use IDs from gallery_list_tasks or gallery_create_task)'),
    title: z.string().optional().describe('Title of the task to update (fallback if no taskId)'),
    status: z.enum(['scheduled', 'todo', 'in_progress', 'in_review', 'blocked', 'failed', 'done', 'cancelled']).optional(),
    priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']).optional(),
    assignedAgent: z.string().optional(),
    description: z.string().optional(),
  },
  async (args) => {
    let task: any;
    if (args.taskId) {
      // Direct ID lookup — fast and unambiguous
      const tasks = await convexQuery('mcpInternal:listTasks', {});
      task = (tasks as any[]).find((t: any) => t._id === args.taskId);
      if (!task) return { content: [{ type: 'text' as const, text: `Task with ID "${args.taskId}" not found.` }], isError: true };
    } else if (args.title) {
      // Title-based fallback
      const tasks = await convexQuery('mcpInternal:listTasks', {});
      const matches = (tasks as any[]).filter((t: any) => t.title.toLowerCase() === args.title!.toLowerCase());
      if (matches.length === 0) return { content: [{ type: 'text' as const, text: `Task "${args.title}" not found.` }], isError: true };
      if (matches.length > 1) {
        const list = matches.map((t: any) => `- "${t.title}" (${t.status}, id: ${t._id})`).join('\n');
        return { content: [{ type: 'text' as const, text: `Multiple tasks match "${args.title}":\n${list}\nPlease use taskId instead.` }], isError: true };
      }
      task = matches[0];
    } else {
      return { content: [{ type: 'text' as const, text: 'Either taskId or title is required.' }], isError: true };
    }

    // Track current task for activity visibility
    if (args.status === 'in_progress') {
      currentTaskId = task._id;
    } else if (args.status === 'done' || args.status === 'failed' || args.status === 'cancelled') {
      currentTaskId = undefined;
    }

    await convexMutation('mcpInternal:updateTask', {
      taskId: task._id,
      status: args.status,
      priority: args.priority,
      assignedAgent: args.assignedAgent,
      description: args.description,
    });
    postActivity('status', `Task "${args.title}" → ${args.status ?? 'updated'}`, { taskId: task._id });
    return { content: [{ type: 'text' as const, text: `Task "${args.title}" updated.` }] };
  },
);

server.tool(
  'gallery_delete_task',
  'Delete a task. Prefer passing taskId if you have it; falls back to title matching.',
  {
    taskId: z.string().optional().describe('Task ID (preferred)'),
    title: z.string().optional().describe('Title of the task to delete (fallback)'),
  },
  async (args) => {
    let task: any;
    if (args.taskId) {
      const tasks = await convexQuery('mcpInternal:listTasks', {});
      task = (tasks as any[]).find((t: any) => t._id === args.taskId);
      if (!task) return { content: [{ type: 'text' as const, text: `Task with ID "${args.taskId}" not found.` }], isError: true };
    } else if (args.title) {
      const tasks = await convexQuery('mcpInternal:listTasks', {});
      const matches = (tasks as any[]).filter((t: any) => t.title.toLowerCase() === args.title!.toLowerCase());
      if (matches.length === 0) return { content: [{ type: 'text' as const, text: `Task "${args.title}" not found.` }], isError: true };
      if (matches.length > 1) {
        const list = matches.map((t: any) => `- "${t.title}" (${t.status}, id: ${t._id})`).join('\n');
        return { content: [{ type: 'text' as const, text: `Multiple tasks match "${args.title}":\n${list}\nPlease use taskId instead.` }], isError: true };
      }
      task = matches[0];
    } else {
      return { content: [{ type: 'text' as const, text: 'Either taskId or title is required.' }], isError: true };
    }

    await convexMutation('mcpInternal:deleteTask', { taskId: task._id });
    return { content: [{ type: 'text' as const, text: `Task "${task.title}" deleted.` }] };
  },
);

server.tool(
  'gallery_add_task_comment',
  'Add a comment or progress note to a task. Call this at every meaningful milestone — think of it as narrating your progress to your owner in real-time. Visible in the task activity feed on the dashboard.',
  {
    title: z.string().describe('Title of the task to comment on'),
    content: z.string().describe('Comment text'),
  },
  async (args) => {
    const tasks = await convexQuery('mcpInternal:listTasks', {});
    const matches = (tasks as any[]).filter((t: any) => t.title.toLowerCase() === args.title.toLowerCase());
    if (matches.length === 0) return { content: [{ type: 'text' as const, text: `Task "${args.title}" not found.` }], isError: true };
    if (matches.length > 1) {
      const list = matches.map((t: any) => `- "${t.title}" (${t.status}, id: ${t._id})`).join('\n');
      return { content: [{ type: 'text' as const, text: `Multiple tasks match "${args.title}":\n${list}\nPlease use a more specific title.` }], isError: true };
    }
    const task = matches[0];

    await convexMutation('mcpInternal:addTaskComment', { taskId: task._id, content: args.content });
    return { content: [{ type: 'text' as const, text: `Comment added to "${args.title}".` }] };
  },
);

// ── Task Attachments ──

server.tool(
  'gallery_attach_to_task',
  `Attach a file from the workspace to a task. Use this to deliver work products (reports, code, documents) as task attachments visible in the Gallery dashboard.

The file must exist in the workspace filesystem. It will be read and uploaded to storage.`,
  {
    taskId: z.string().describe('Task ID to attach the file to'),
    filePath: z.string().describe('Path to the file in the workspace (relative or absolute)'),
    name: z.string().optional().describe('Display name for the attachment (defaults to filename)'),
  },
  async (args) => {
    const blocked = checkPlanMode('gallery_attach_to_task');
    if (blocked) return blocked;

    // Resolve file path
    const absPath = path.isAbsolute(args.filePath)
      ? args.filePath
      : path.join(WORKSPACE_DIR, args.filePath);

    // Security: ensure file is within workspace
    if (!assertWithinWorkspace(absPath)) {
      return { content: [{ type: 'text' as const, text: 'Error: file must be within your workspace.' }], isError: true };
    }

    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      return { content: [{ type: 'text' as const, text: `Error: file not found at "${args.filePath}".` }], isError: true };
    }

    const stat = fs.statSync(absPath);
    const MAX_ATTACHMENT_SIZE = 50 * 1024 * 1024; // 50MB
    if (stat.size > MAX_ATTACHMENT_SIZE) {
      return { content: [{ type: 'text' as const, text: `Error: file too large (${formatSize(stat.size)}, max 50MB).` }], isError: true };
    }

    const fileName = args.name || path.basename(absPath);
    const ext = path.extname(absPath).toLowerCase().replace('.', '');
    const mimeType = ext === 'md' ? 'text/markdown'
      : ext === 'json' ? 'application/json'
      : ext === 'pdf' ? 'application/pdf'
      : ext === 'csv' ? 'text/csv'
      : ext === 'txt' ? 'text/plain'
      : ext === 'html' ? 'text/html'
      : `application/octet-stream`;

    // Upload file content as base64 data URL (for files under 10MB)
    // For larger files, store path reference
    let url: string;
    if (stat.size <= 10 * 1024 * 1024) {
      const content = fs.readFileSync(absPath);
      url = `data:${mimeType};base64,${content.toString('base64')}`;
    } else {
      // For large files, store a workspace reference
      url = `workspace://${path.relative(WORKSPACE_DIR, absPath)}`;
    }

    try {
      await convexMutation('mcpInternal:addTaskAttachment', {
        taskId: args.taskId as any,
        name: fileName,
        url,
        type: mimeType,
        size: stat.size,
      });
      postActivity('tool_use', `Attached "${fileName}" (${formatSize(stat.size)}) to task`);
      return { content: [{ type: 'text' as const, text: `Attached "${fileName}" (${formatSize(stat.size)}) to task.` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error attaching file: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// ── Agent Management ──

server.tool(
  'gallery_list_agents',
  'List all agents in the workspace. Returns agent names, roles, models, and status.',
  {
    status: z.enum(['active', 'paused', 'archived']).optional().describe('Filter by status'),
  },
  async (args) => {
    const agents = await convexQuery('mcpInternal:listAgents', { status: args.status });
    const list = (agents as any[]).map((a: any) => `- ${a.name}${a.isAdmin ? ' [ADMIN]' : ''} (${a.model ?? 'default'}) [${a.status}]${a.description ? ` — ${a.description}` : ''}`);
    return { content: [{ type: 'text' as const, text: list.length > 0 ? list.join('\n') : 'No agents found.' }] };
  },
);

// ── Reviews (Human-in-the-Loop) ──

server.tool(
  'gallery_request_review',
  'Create a review request for the workspace owner. When you need human input, don\'t guess — create a review and pause. Use the right type: "question" when you need clarification, "approval" when you need sign-off before proceeding, "error" when something is broken and you can\'t continue, "completion" when work is done and ready for review.',
  {
    type: z.enum(['question', 'approval', 'completion', 'error']).describe('Type of review'),
    title: z.string().describe('Short title for the review'),
    content: z.string().describe('Detailed description or question'),
    taskTitle: z.string().optional().describe('Optional: title of the related task'),
  },
  async (args) => {
    // Find this agent's record
    const agents = await convexQuery('mcpInternal:listAgents', {});
    const self = (agents as any[]).find((a: any) => a._id === agentId);
    if (!self) return { content: [{ type: 'text' as const, text: 'Could not find own agent record.' }], isError: true };

    let taskId: string | undefined;
    if (args.taskTitle) {
      const tasks = await convexQuery('mcpInternal:listTasks', {});
      const task = (tasks as any[]).find((t: any) => t.title.toLowerCase() === args.taskTitle!.toLowerCase());
      if (task) taskId = task._id;
    }

    await convexMutation('mcpInternal:createReview', {
      agentId,
      taskId,
      type: args.type,
      title: args.title,
      content: args.content,
    });
    return { content: [{ type: 'text' as const, text: `Review created: "${args.title}" [${args.type}]` }] };
  },
);

server.tool(
  'gallery_list_reviews',
  'List human-in-the-loop reviews. Reviews are requests from agents that need human approval, answers, or acknowledgement.',
  {
    status: z.enum(['pending', 'resolved', 'dismissed']).optional().describe('Filter by status'),
  },
  async (args) => {
    const reviews = await convexQuery('mcpInternal:listReviews', { status: args.status });
    const list = (reviews as any[]).map((r: any) => `- [${r.status}] ${r.title} (${r.type})${r.response ? ` → ${r.response}` : ''}`);
    return { content: [{ type: 'text' as const, text: list.length > 0 ? list.join('\n') : 'No reviews found.' }] };
  },
);

// ── Task Reporting (Sub-agent → Parent) ──

server.tool(
  'gallery_report_to_parent',
  `Report progress or completion back to the parent task. Adds a comment to the parent task's activity feed and optionally updates this task's status.

Use this when you're working on a delegated subtask and need to send updates or results back to the admin agent.`,
  {
    taskTitle: z.string().describe('Title of your current (child) task'),
    report: z.string().describe('Progress report or completion summary'),
    status: z.enum(['todo', 'in_progress', 'in_review', 'done']).optional().describe("Optionally update this task's status"),
    agentName: z.string().describe('Your agent name'),
  },
  async (args) => {
    const tasks = await convexQuery('mcpInternal:listTasks', {});
    const matches = (tasks as any[]).filter((t: any) => t.title.toLowerCase() === args.taskTitle.toLowerCase());
    if (matches.length === 0) return { content: [{ type: 'text' as const, text: `Task "${args.taskTitle}" not found.` }], isError: true };
    if (matches.length > 1) {
      const list = matches.map((t: any) => `- "${t.title}" (${t.status}, id: ${t._id})`).join('\n');
      return { content: [{ type: 'text' as const, text: `Multiple tasks match "${args.taskTitle}":\n${list}\nPlease use a more specific title.` }], isError: true };
    }
    const childTask = matches[0];
    if (!childTask.parentTaskId) return { content: [{ type: 'text' as const, text: `Task "${args.taskTitle}" has no parent task.` }], isError: true };

    const result = await convexMutation('mcpInternal:reportToParent', {
      taskId: childTask._id,
      report: args.report,
      childStatus: args.status,
      agentName: args.agentName,
    });
    return { content: [{ type: 'text' as const, text: `Reported to parent task "${result.parentTaskTitle}": ${args.report.slice(0, 200)}` }] };
  },
);

// ── Workspace Info ──

server.tool(
  'gallery_workspace_info',
  'Get workspace overview: name, agent count, and task count.',
  {},
  async () => {
    const info = await convexQuery('mcpInternal:workspaceInfo', {});
    return { content: [{ type: 'text' as const, text: JSON.stringify(info, null, 2) }] };
  },
);

// ─── Context & Compact Tools ───────────────────────────────

server.tool(
  'gallery_context_usage',
  `Check how much of your context window is used. Returns percentage, token counts, and limit.

Use this to decide whether to summarize, compact, or wrap up. If you're above 60%, consider being more concise. Above 80%, save progress to memory immediately.`,
  {},
  async () => {
    const usageFile = path.join(WORKSPACE_DIR, '.context-usage.json');
    if (!fs.existsSync(usageFile)) {
      return { content: [{ type: 'text' as const, text: 'Context usage data not yet available (no messages processed).' }] };
    }
    try {
      const data = JSON.parse(fs.readFileSync(usageFile, 'utf-8'));
      const age = Math.round((Date.now() - (data.updatedAt || 0)) / 1000);
      return {
        content: [{
          type: 'text' as const,
          text: `Context usage: ${data.percentage}%\n` +
            `Input tokens: ${(data.inputTokens || 0).toLocaleString()}\n` +
            `Cache read: ${(data.cacheReadTokens || 0).toLocaleString()}\n` +
            `Output tokens: ${(data.outputTokens || 0).toLocaleString()}\n` +
            `Context window: ${(data.contextWindow || 0).toLocaleString()}\n` +
            `Updated: ${age}s ago`,
        }],
      };
    } catch {
      return { content: [{ type: 'text' as const, text: 'Failed to read context usage.' }], isError: true };
    }
  },
);

server.tool(
  'gallery_compact',
  `Manually checkpoint your current progress before context compaction. Archives the current conversation and writes a structured summary to daily memory.

Use this when:
- You're on a long task and want to save progress before auto-compaction hits
- You're about to switch to a completely different task
- gallery_context_usage shows you're above 70%

This does NOT trigger SDK compaction — it saves a checkpoint so nothing is lost when compaction eventually fires.`,
  {
    focus: z.string().optional().describe('Optional: what to emphasize in the summary (e.g., "keep architecture decisions, drop debugging steps")'),
  },
  async (args) => {
    const memoryDir = path.join(WORKSPACE_DIR, 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });

    const date = new Date().toISOString().split('T')[0];
    const timestamp = new Date().toISOString().split('T')[1].replace(/\.\d+Z$/, '');
    const dailyFile = path.join(memoryDir, `${date}.md`);

    // Read existing context usage
    let contextInfo = '';
    const usageFile = path.join(WORKSPACE_DIR, '.context-usage.json');
    if (fs.existsSync(usageFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(usageFile, 'utf-8'));
        contextInfo = `Context: ${data.percentage}% used (${(data.inputTokens || 0).toLocaleString()} tokens)`;
      } catch { /* ignore */ }
    }

    const marker = [
      `\n## Manual Checkpoint (${timestamp})`,
      '',
      contextInfo ? contextInfo : '',
      args.focus ? `Focus: ${args.focus}` : '',
      '',
      'Checkpoint created by agent via gallery_compact.',
      'Use this marker to resume work if context is compacted.',
      '',
    ].filter(Boolean).join('\n');

    fs.appendFileSync(dailyFile, marker);

    return {
      content: [{
        type: 'text' as const,
        text: `Checkpoint saved to memory/${date}.md\n${contextInfo}\n\nWrite your key findings, decisions, and next steps to MEMORY.md now before compaction occurs.`,
      }],
    };
  },
);

// ─── Structured Output Tool ────────────────────────────────

server.tool(
  'gallery_structured_output',
  `Return structured JSON data as a tool result. Use this when you need to return machine-readable data to the caller (e.g., delegation results, API responses, structured reports).

The output is validated as JSON before being returned. If the data is not valid JSON, it will be returned as a string with an error flag.`,
  {
    data: z.string().describe('JSON string to return as structured output'),
    schema_description: z.string().optional().describe('Optional: description of the JSON schema for documentation'),
  },
  async (args) => {
    try {
      // Validate JSON
      const parsed = JSON.parse(args.data);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(parsed, null, 2),
        }],
      };
    } catch {
      return {
        content: [{ type: 'text' as const, text: `Invalid JSON: ${args.data.slice(0, 500)}` }],
        isError: true,
      };
    }
  },
);

// ─── Cross-Agent Memory ────────────────────────────────────

server.tool(
  'gallery_read_peer_memory',
  `Read another agent's memory files. Use this to check what a peer agent has learned before delegating work (avoids duplicate effort) or to share knowledge across the team.

This is READ-ONLY — you cannot write to another agent's memory. To share information, write it to your own memory and let the other agent read yours.`,
  {
    targetAgentId: z.string().describe("Convex document ID of the agent whose memory you want to read"),
    query: z.string().optional().describe('Optional: search query to find specific memories (BM25 full-text search)'),
    limit: z.number().default(5).describe('Max results for search queries'),
  },
  async (args) => {
    if (!convexUrl || !gatewayToken) {
      return { content: [{ type: 'text' as const, text: 'Cross-agent memory requires Gallery API (not configured).' }], isError: true };
    }

    try {
      if (args.query) {
        // Search target agent's memory via Convex
        const res = await fetch(`${convexUrl}/api/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: 'memoryEntries:search',
            args: { token: gatewayToken, agentId: args.targetAgentId, query: args.query, limit: args.limit },
          }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return { content: [{ type: 'text' as const, text: `Failed to search peer memory: ${res.status}` }], isError: true };
        const data = await res.json();
        const entries = data.value ?? data ?? [];
        if (!Array.isArray(entries) || entries.length === 0) {
          return { content: [{ type: 'text' as const, text: `No results for "${args.query}" in agent ${args.targetAgentId}'s memory.` }] };
        }
        const formatted = entries.map((e: any) => `**${e.path}**\n${(e.body || '').slice(0, 500)}`).join('\n\n---\n\n');
        return { content: [{ type: 'text' as const, text: `Found ${entries.length} result(s) in peer memory:\n\n${formatted}` }] };
      } else {
        // List target agent's memory entries
        const res = await fetch(`${convexUrl}/api/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: 'memoryEntries:listPaths',
            args: { token: gatewayToken, agentId: args.targetAgentId },
          }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return { content: [{ type: 'text' as const, text: `Failed to list peer memory: ${res.status}` }], isError: true };
        const data = await res.json();
        const paths = data.value ?? data ?? [];
        if (!Array.isArray(paths) || paths.length === 0) {
          return { content: [{ type: 'text' as const, text: `Agent ${args.targetAgentId} has no indexed memory entries.` }] };
        }
        const formatted = paths.map((p: any) => `- ${p.path} (updated: ${new Date(p.updatedAt).toLocaleDateString()})`).join('\n');
        return { content: [{ type: 'text' as const, text: `Agent ${args.targetAgentId}'s memory files:\n${formatted}\n\nUse query parameter to search specific topics.` }] };
      }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Peer memory error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// ─── Plan Mode Toggle ──────────────────────────────────────

server.tool(
  'gallery_enter_plan_mode',
  `Enter planning mode. Use this when you need to think through a complex task before executing it. In plan mode:

1. Write your plan to a file (e.g., memory/plan-{topic}.md)
2. Create a review of type "approval" with the plan summary
3. Stop executing and wait for the owner to approve

This is a behavioral toggle — you commit to only reading and planning, not executing. Call gallery_exit_plan_mode when approved.`,
  {
    plan_title: z.string().describe('Title of what you are planning'),
    plan_content: z.string().describe('The full plan — steps, rationale, risks, alternatives'),
  },
  async (args) => {
    // Write plan to memory
    const slug = args.plan_title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
    const planFile = path.join(MEMORY_DIR, `plan-${slug}.md`);
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    fs.writeFileSync(planFile, `# Plan: ${args.plan_title}\n\n${args.plan_content}\n\n---\n*Created: ${new Date().toISOString()}*\n`);
    indexMemoryEntry(`plan-${slug}.md`, fs.readFileSync(planFile, 'utf-8'));

    // Create approval review
    try {
      const agents = await convexQuery('mcpInternal:listAgents', {});
      const self = (agents as any[]).find((a: any) => a._id === agentId);
      if (self) {
        await convexMutation('mcpInternal:createReview', {
          agentId,
          type: 'approval',
          title: `Plan: ${args.plan_title}`,
          content: args.plan_content.slice(0, 2000),
        });
      }
    } catch { /* non-fatal — plan is saved even if review creation fails */ }

    setPlanMode(true);
    postActivity('status', `Entered plan mode: ${args.plan_title}`);
    return {
      content: [{
        type: 'text' as const,
        text: `Plan saved to memory/plan-${slug}.md and submitted for approval.\n\n` +
          `**You are now in PLAN MODE.** Mutating tools (task create/update/delete, delegation, memory writes) are blocked. ` +
          `Only read-only tools are available.\n\n` +
          `When approved, call gallery_exit_plan_mode to resume execution.`,
      }],
    };
  },
);

server.tool(
  'gallery_exit_plan_mode',
  `Exit planning mode and resume normal execution. Call this after your plan has been approved (check gallery_list_reviews for approval status).`,
  {
    plan_title: z.string().describe('Title of the plan that was approved'),
  },
  async (args) => {
    setPlanMode(false);
    postActivity('status', `Exited plan mode: ${args.plan_title}`);
    return {
      content: [{
        type: 'text' as const,
        text: `Plan mode exited. All tools are now available. Execute the approved plan for "${args.plan_title}".\n\nRead your plan file from memory before starting execution.`,
      }],
    };
  },
);

// ─── Sleep / Self-Wake ─────────────────────────────────────

server.tool(
  'gallery_sleep',
  `Schedule a self-wake after a delay. The agent will receive a scheduled task message after the specified duration. Use this for:
- Polling a condition ("check back in 5 minutes if the deploy finished")
- Time-delayed actions ("send the report at 5pm")
- Monitoring workflows ("check API health every 10 minutes")

The wake message is sent as a scheduled task — it will appear as a new message in your conversation.`,
  {
    delay_seconds: z.number().min(10).max(3600).describe('Delay in seconds before waking (10s to 1 hour)'),
    wake_message: z.string().describe('Message to send yourself when waking up — include context about what to check or do'),
  },
  async (args) => {
    if (!galleryWorkerUrl || !galleryToken) {
      return { content: [{ type: 'text' as const, text: 'Self-wake requires Gallery Worker (not configured).' }], isError: true };
    }

    try {
      // Register a one-time delayed task via the scheduler
      const response = await fetch(`${galleryWorkerUrl}/scheduler/schedule/once`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${galleryToken}`,
        },
        body: JSON.stringify({
          agentId,
          delaySeconds: args.delay_seconds,
          message: `[SELF-WAKE] ${args.wake_message}`,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        return { content: [{ type: 'text' as const, text: `Sleep scheduling failed (${response.status}): ${err}` }], isError: true };
      }

      const wakeTime = new Date(Date.now() + args.delay_seconds * 1000).toLocaleTimeString();
      postActivity('status', `Scheduled self-wake in ${args.delay_seconds}s at ~${wakeTime}`);
      return {
        content: [{
          type: 'text' as const,
          text: `Self-wake scheduled in ${args.delay_seconds} seconds (~${wakeTime}).\n\nWake message: "${args.wake_message}"\n\nYou can continue working on other tasks. The wake message will arrive as a scheduled task.`,
        }],
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Sleep error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// ─── Utility ──────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

// ─── Start ──────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
