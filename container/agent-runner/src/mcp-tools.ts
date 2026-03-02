/**
 * Claw MCP Tools — Stdio MCP Server for Sprites
 * Adapted from ipc-mcp-stdio.ts for the Sprites architecture.
 *
 * Changes from Docker version:
 * - Memory tools: paths updated (/workspace/group → /home/sprite/workspace)
 * - send_message: POST to Gallery API instead of filesystem IPC
 * - Scheduling tools: stubbed (wired to Gallery in Phase 2)
 * - Removed: register_group, list_sessions, send_to_group, close_group_session
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

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

// ─── Scheduling Tools (stubbed for Phase 2) ──────────────

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
• cron: Standard cron expression (e.g., "0 9 * * *" for daily at 9am)
• interval: Milliseconds between runs (e.g., "3600000" for 1 hour)
• once: Local time (e.g., "2026-03-01T15:30:00")`,
  {
    prompt: z.string().describe('What the agent should do when the task runs.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron | interval | once'),
    schedule_value: z.string().describe('The schedule value'),
  },
  async () => {
    return {
      content: [{ type: 'text' as const, text: 'Task scheduling is being migrated to Gallery. This feature will be available soon. For now, please ask the user to set up scheduled tasks in the Gallery dashboard.' }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks.",
  {},
  async () => {
    return {
      content: [{ type: 'text' as const, text: 'Task listing is being migrated to Gallery. Please check the Gallery dashboard for scheduled tasks.' }],
    };
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task.',
  { task_id: z.string().describe('The task ID to pause') },
  async () => {
    return {
      content: [{ type: 'text' as const, text: 'Task management is being migrated to Gallery. Please use the Gallery dashboard.' }],
    };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async () => {
    return {
      content: [{ type: 'text' as const, text: 'Task management is being migrated to Gallery. Please use the Gallery dashboard.' }],
    };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async () => {
    return {
      content: [{ type: 'text' as const, text: 'Task management is being migrated to Gallery. Please use the Gallery dashboard.' }],
    };
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
