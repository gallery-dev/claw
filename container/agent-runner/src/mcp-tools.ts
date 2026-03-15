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
import { type ActivityType, postConvexActivity } from './shared.js';

const WORKSPACE_DIR = process.env.CLAW_WORKSPACE_DIR || '/home/sprite/workspace';
const MEMORY_DIR = path.join(WORKSPACE_DIR, 'memory');
const MEMORY_FILE = path.join(WORKSPACE_DIR, 'MEMORY.md');

// Gallery API context (set by agent.ts when spawning this process)
const galleryApiUrl = process.env.GALLERY_API_URL || '';
const galleryToken = process.env.GALLERY_TOKEN || '';
const agentId = process.env.AGENT_ID || '';

const server = new McpServer({
  name: 'claw',
  version: '2.0.0',
});

// ─── Messaging Tools ──────────────────────────────────

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate.",
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

function postActivity(type: ActivityType, content: string, metadata?: unknown): void {
  if (!convexUrl || !gatewayToken) return;
  postConvexActivity(convexUrl, gatewayToken, agentId, type, content, metadata);
}

// ─── Sub-task Decomposition ──────────────────────────────

const DELEGATION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const SUBTASK_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const MAX_CONCURRENT_SUBTASKS = 3;
const MAX_SUBTASKS = 5;

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
        model: 'claude-sonnet-4-6',
        maxTurns: 15,
        allowedTools: [
          'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
          'WebSearch', 'WebFetch',
          // No mcp__claw__* — subtasks cannot decompose further or use agent messaging
        ],
        env: {
          ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || '',
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
          PATH: process.env.PATH || '',
          HOME: process.env.HOME || '',
        },
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
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
  `Split a complex task into parallel subtasks. Each subtask runs as an independent AI worker with access to the filesystem, bash, and web tools. Use this when a task has independent parts that can run simultaneously (e.g., "research 3 competitors", "review 5 files", "generate reports for each region").

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

IMPORTANT: You must know the target agent's Convex ID (agentId) to delegate. You can find agent IDs by asking the user or checking workspace context.`,
  {
    toAgentId: z.string().describe("Convex document ID of the target agent"),
    task: z.string().describe("The task or instruction to send to the target agent — be specific and complete"),
    context: z.string().optional().describe("Additional context, data, or files the target agent needs"),
  },
  async (args) => {
    if (!galleryApiUrl || !galleryToken) {
      return {
        content: [{ type: 'text' as const, text: 'Agent delegation requires Gallery API (not configured).' }],
        isError: true,
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DELEGATION_TIMEOUT_MS);

    try {
      const response = await fetch(`${galleryApiUrl}/api/claw/delegate`, {
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

      if (!response.ok) {
        const err = await response.text();
        return {
          content: [{ type: 'text' as const, text: `Delegation failed (${response.status}): ${err}` }],
          isError: true,
        };
      }

      const data = await response.json() as { success: boolean; result?: string | null };
      return {
        content: [{
          type: 'text' as const,
          text: data.result
            ? `Agent completed task.\n\nResult:\n${data.result}`
            : 'Agent completed task (no text output).',
        }],
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
      const response = await fetch(`${galleryApiUrl}/api/claw/delegate`, {
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

    // Security: ensure path stays within workspace
    const resolved = path.resolve(targetPath);
    if (!resolved.startsWith(WORKSPACE_DIR)) {
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

Best practices:
• MEMORY.md — curated long-term facts, decisions, preferences.
• memory/YYYY-MM-DD.md — daily notes, running context, progress logs.
• memory/topic.md — structured data about specific topics.`,
  {
    path: z.string().describe('File path relative to memory. Examples: "MEMORY.md", "2026-02-28.md", "project-status.md"'),
    content: z.string().describe('Content to write.'),
    mode: z.enum(['append', 'replace', 'create']).default('append').describe('append=add to end (default), replace=overwrite entire file, create=new file only'),
  },
  async (args) => {
    let targetPath: string;
    if (args.path === 'MEMORY.md' || args.path === '/MEMORY.md') {
      targetPath = MEMORY_FILE;
    } else {
      targetPath = path.join(MEMORY_DIR, args.path);
    }

    const resolved = path.resolve(targetPath);
    if (!resolved.startsWith(WORKSPACE_DIR)) {
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

    const stat = fs.statSync(targetPath);
    return { content: [{ type: 'text' as const, text: `Memory written: ${args.path} (${formatSize(stat.size)})` }] };
  },
);

server.tool(
  'memory_search',
  `Search across all memory files for relevant information. Uses keyword matching across MEMORY.md, memory/*.md, and conversations/*.md.`,
  {
    query: z.string().describe('Search query — keywords or phrases to find in memory files'),
    scope: z.enum(['memory', 'conversations', 'all']).default('all').describe('Where to search'),
  },
  async (args) => {
    const results: Array<{ file: string; line: number; text: string }> = [];
    const queryLower = args.query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter(Boolean);

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

    if (args.scope === 'memory' || args.scope === 'all') {
      if (fs.existsSync(MEMORY_FILE)) {
        searchFile(MEMORY_FILE, 'MEMORY.md');
      }
      searchDir(MEMORY_DIR, 'memory/');
    }

    if (args.scope === 'conversations' || args.scope === 'all') {
      searchDir(path.join(WORKSPACE_DIR, 'conversations'), 'conversations/');
    }

    if (results.length === 0) {
      return { content: [{ type: 'text' as const, text: `No matches for "${args.query}" in ${args.scope} files.` }] };
    }

    const deduped = results.filter((r, i) => {
      if (i === 0) return true;
      const prev = results[i - 1];
      return !(r.file === prev.file && Math.abs(r.line - prev.line) <= 2);
    });

    const top = deduped.slice(0, 10);
    const formatted = top.map(r => `**${r.file}:${r.line}**\n${r.text}`).join('\n\n---\n\n');
    const truncated = deduped.length > 10 ? `\n\n(${deduped.length - 10} more results omitted)` : '';

    return { content: [{ type: 'text' as const, text: `Found ${deduped.length} match(es) for "${args.query}":\n\n${formatted}${truncated}` }] };
  },
);

server.tool(
  'memory_delete',
  'Delete a memory file that is no longer relevant.',
  {
    path: z.string().describe('File path to delete, relative to memory.'),
  },
  async (args) => {
    let targetPath: string;
    if (args.path === 'MEMORY.md' || args.path === '/MEMORY.md') {
      targetPath = MEMORY_FILE;
    } else {
      targetPath = path.join(MEMORY_DIR, args.path);
    }

    const resolved = path.resolve(targetPath);
    if (!resolved.startsWith(WORKSPACE_DIR)) {
      return { content: [{ type: 'text' as const, text: `Error: path must be within your workspace.` }], isError: true };
    }

    if (!fs.existsSync(targetPath)) {
      return { content: [{ type: 'text' as const, text: `File "${args.path}" not found.` }], isError: true };
    }

    fs.unlinkSync(targetPath);
    return { content: [{ type: 'text' as const, text: `Deleted ${args.path}` }] };
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
