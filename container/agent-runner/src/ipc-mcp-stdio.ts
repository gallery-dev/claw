/**
 * Stdio MCP Server for Claw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.CLAW_CHAT_JID!;
const groupFolder = process.env.CLAW_GROUP_FOLDER!;
const isMain = process.env.CLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'claw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const data = {
      type: 'schedule_task',
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    const filename = writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new WhatsApp group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
  {
    jid: z.string().describe('The WhatsApp JID (e.g., "120363336345536173@g.us")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Folder name for group files (lowercase, hyphens, e.g., "family-chat")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

// ─── Memory Tools ──────────────────────────────────────
// Adapted from Anthropic's Memory Tool protocol + OpenClaw's memory_search/memory_get.
// Files stored in /workspace/group/memory/ (daily notes) and /workspace/group/MEMORY.md (long-term).

const MEMORY_DIR = '/workspace/group/memory';
const MEMORY_FILE = '/workspace/group/MEMORY.md';

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

    // MEMORY.md lives at the group root, daily notes in memory/
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

    // Security: ensure path stays within group workspace
    const resolved = path.resolve(targetPath);
    if (!resolved.startsWith('/workspace/group/')) {
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
• MEMORY.md — curated long-term facts, decisions, preferences. Append-only unless reorganizing.
• memory/YYYY-MM-DD.md — daily notes, running context, progress logs.
• memory/topic.md — structured data about specific topics.

When updating, prefer str_replace mode to avoid overwriting existing content.`,
  {
    path: z.string().describe('File path relative to memory. Examples: "MEMORY.md", "2026-02-28.md", "project-status.md"'),
    content: z.string().describe('Content to write. For "append" mode, this is added to the end. For "replace" mode, this replaces the entire file. For "create" mode, this creates a new file.'),
    mode: z.enum(['append', 'replace', 'create']).default('append').describe('append=add to end (default), replace=overwrite entire file, create=new file only (fails if exists)'),
  },
  async (args) => {
    let targetPath: string;
    if (args.path === 'MEMORY.md' || args.path === '/MEMORY.md') {
      targetPath = MEMORY_FILE;
    } else {
      targetPath = path.join(MEMORY_DIR, args.path);
    }

    // Security: ensure path stays within group workspace
    const resolved = path.resolve(targetPath);
    if (!resolved.startsWith('/workspace/group/')) {
      return { content: [{ type: 'text' as const, text: `Error: path must be within your workspace.` }], isError: true };
    }

    // Ensure parent directory exists
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
  `Search across all memory files for relevant information. Uses keyword matching across MEMORY.md, memory/*.md, and conversations/*.md.

Returns matching snippets with file paths and line numbers. Use this when you need to find something but don't know which file it's in.`,
  {
    query: z.string().describe('Search query — keywords or phrases to find in memory files'),
    scope: z.enum(['memory', 'conversations', 'all']).default('all').describe('Where to search: memory=MEMORY.md + memory/, conversations=conversations/, all=everything'),
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
            // Include context: line before + matched line + line after
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

    // Search memory files
    if (args.scope === 'memory' || args.scope === 'all') {
      if (fs.existsSync(MEMORY_FILE)) {
        searchFile(MEMORY_FILE, 'MEMORY.md');
      }
      searchDir(MEMORY_DIR, 'memory/');
    }

    // Search conversations
    if (args.scope === 'conversations' || args.scope === 'all') {
      searchDir('/workspace/group/conversations', 'conversations/');
    }

    if (results.length === 0) {
      return { content: [{ type: 'text' as const, text: `No matches for "${args.query}" in ${args.scope} files.` }] };
    }

    // Deduplicate nearby results from the same file
    const deduped = results.filter((r, i) => {
      if (i === 0) return true;
      const prev = results[i - 1];
      return !(r.file === prev.file && Math.abs(r.line - prev.line) <= 2);
    });

    // Limit to top 10 results
    const top = deduped.slice(0, 10);
    const formatted = top.map(r => `**${r.file}:${r.line}**\n${r.text}`).join('\n\n---\n\n');
    const truncated = deduped.length > 10 ? `\n\n(${deduped.length - 10} more results omitted)` : '';

    return { content: [{ type: 'text' as const, text: `Found ${deduped.length} match(es) for "${args.query}":\n\n${formatted}${truncated}` }] };
  },
);

server.tool(
  'memory_delete',
  'Delete a memory file that is no longer relevant. Keeps memory organized.',
  {
    path: z.string().describe('File path to delete, relative to memory. Examples: "2026-01-15.md", "old-project.md"'),
  },
  async (args) => {
    let targetPath: string;
    if (args.path === 'MEMORY.md' || args.path === '/MEMORY.md') {
      targetPath = MEMORY_FILE;
    } else {
      targetPath = path.join(MEMORY_DIR, args.path);
    }

    const resolved = path.resolve(targetPath);
    if (!resolved.startsWith('/workspace/group/')) {
      return { content: [{ type: 'text' as const, text: `Error: path must be within your workspace.` }], isError: true };
    }

    if (!fs.existsSync(targetPath)) {
      return { content: [{ type: 'text' as const, text: `File "${args.path}" not found.` }], isError: true };
    }

    fs.unlinkSync(targetPath);
    return { content: [{ type: 'text' as const, text: `Deleted ${args.path}` }] };
  },
);

// ─── Multi-Session Management Tools ──────────────────────

server.tool(
  'list_sessions',
  'List all active agent sessions across groups. Main group only. Shows group name, folder, and container status.',
  {},
  async () => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can list all sessions.' }], isError: true };
    }

    const sessionsFile = path.join(IPC_DIR, 'active_sessions.json');
    try {
      if (!fs.existsSync(sessionsFile)) {
        return { content: [{ type: 'text' as const, text: 'No session data available. Sessions are populated before each agent run.' }] };
      }
      const sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf-8'));
      if (!Array.isArray(sessions) || sessions.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No groups registered.' }] };
      }
      const formatted = sessions
        .map((s: { groupFolder: string; groupName: string; hasActiveContainer: boolean; hasSession: boolean }) =>
          `- **${s.groupName}** (${s.groupFolder}): ${s.hasActiveContainer ? 'container active' : 'idle'}${s.hasSession ? ', has session' : ''}`)
        .join('\n');
      return { content: [{ type: 'text' as const, text: `Active sessions:\n${formatted}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error reading sessions: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  },
);

server.tool(
  'send_to_group',
  'Send a message to another group\'s agent. Main group only. The message will be queued as if a user sent it, triggering the target agent to process it.',
  {
    target_group_folder: z.string().describe('The target group folder name (e.g., "researcher", "family-chat")'),
    text: z.string().describe('The message text to send to the target group\'s agent'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can send messages to other groups.' }], isError: true };
    }

    const data = {
      type: 'send_to_group',
      targetGroupFolder: args.target_group_folder,
      text: args.text,
      sourceGroup: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Message queued for group "${args.target_group_folder}".` }] };
  },
);

server.tool(
  'close_group_session',
  'Close another group\'s active agent container. Main group only. Use to free resources or restart a stuck agent.',
  {
    target_group_folder: z.string().describe('The target group folder name to close'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can close other group sessions.' }], isError: true };
    }

    const data = {
      type: 'close_group_session',
      targetGroupFolder: args.target_group_folder,
      sourceGroup: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);
    return { content: [{ type: 'text' as const, text: `Close request sent for group "${args.target_group_folder}".` }] };
  },
);

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
