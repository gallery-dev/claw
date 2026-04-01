#!/usr/bin/env node
/**
 * Gallery CLI — Command-line tools for Claw agents.
 * Replaces the MCP stdio server with direct CLI commands the agent calls via Bash.
 *
 * Usage: node gallery-cli.js <command> [subcommand] [--flag value ...]
 *
 * Auth via env vars (set during sandbox provisioning):
 *   GALLERY_CONVEX_URL, GALLERY_GATEWAY_TOKEN, GALLERY_TOKEN,
 *   GALLERY_API_URL, GALLERY_WORKER_URL, AGENT_ID
 */

import fs from 'fs';
import path from 'path';
import { type ActivityType, postConvexActivity } from './shared.js';

// ─── Configuration ──────────────────────────────────────

const WORKSPACE_DIR = process.env.CLAW_WORKSPACE_DIR || '/home/sprite/workspace';
const MEMORY_DIR = path.join(WORKSPACE_DIR, 'memory');
const MEMORY_FILE = path.join(WORKSPACE_DIR, 'MEMORY.md');

const convexUrl = process.env.GALLERY_CONVEX_URL || '';
const gatewayToken = process.env.GALLERY_GATEWAY_TOKEN || '';
const galleryApiUrl = process.env.GALLERY_API_URL || '';
const galleryWorkerUrl = process.env.GALLERY_WORKER_URL || '';
const galleryToken = process.env.GALLERY_TOKEN || '';
const agentId = process.env.AGENT_ID || '';

// ─── Arg Parsing ────────────────────────────────────────

interface ParsedArgs {
  command: string;
  subcommand: string;
  flags: Record<string, string>;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2); // skip node + script
  const command = args[0] || '';
  const subcommand = args[1] && !args[1].startsWith('--') ? args[1] : '';
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  const start = subcommand ? 2 : 1;

  for (let i = start; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(args[i]);
    }
  }

  return { command, subcommand, flags, positional };
}

// ─── Output Helpers ─────────────────────────────────────

function ok(result: unknown): never {
  console.log(JSON.stringify({ ok: true, result }));
  process.exit(0);
}

function fail(error: string): never {
  console.log(JSON.stringify({ ok: false, error }));
  process.exit(1);
}

// ─── HTTP Helpers ───────────────────────────────────────

async function convexQuery(fnPath: string, args: Record<string, unknown>): Promise<any> {
  if (!convexUrl || !gatewayToken) throw new Error('Gallery API not configured');
  const res = await fetch(`${convexUrl}/api/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: fnPath, args: { token: gatewayToken, ...args } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Convex query failed: ${res.status}`);
  const data = await res.json();
  return data.value ?? data;
}

async function convexMutation(fnPath: string, args: Record<string, unknown>): Promise<any> {
  if (!convexUrl || !gatewayToken) throw new Error('Gallery API not configured');
  const res = await fetch(`${convexUrl}/api/mutation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: fnPath, args: { token: gatewayToken, ...args } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Convex mutation failed: ${res.status}`);
  const data = await res.json();
  return data.value ?? data;
}

function postActivity(type: ActivityType, content: string, metadata?: unknown): void {
  if (!convexUrl || !gatewayToken) return;
  postConvexActivity(convexUrl, gatewayToken, agentId, type, content, metadata);
}

async function galleryPost(endpoint: string, body: Record<string, unknown>): Promise<Response> {
  if (!galleryApiUrl || !galleryToken) throw new Error('Gallery API not configured');
  return fetch(`${galleryApiUrl}/api/claw/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${galleryToken}`,
    },
    body: JSON.stringify(body),
  });
}

// ─── Memory Helpers ─────────────────────────────────────

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
    } catch { /* skip unreadable */ }
  };

  const searchDir = (dirPath: string, prefix: string) => {
    if (!fs.existsSync(dirPath)) return;
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.md')).sort();
    for (const file of files) {
      searchFile(path.join(dirPath, file), `${prefix}${file}`);
    }
  };

  if (scope === 'memory') {
    if (fs.existsSync(MEMORY_FILE)) searchFile(MEMORY_FILE, 'MEMORY.md');
    searchDir(MEMORY_DIR, 'memory/');
  } else {
    searchDir(path.join(WORKSPACE_DIR, 'conversations'), 'conversations/');
  }

  return results.filter((r, i) => {
    if (i === 0) return true;
    const prev = results[i - 1];
    return !(r.file === prev.file && Math.abs(r.line - prev.line) <= 2);
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

// ─── Command Handlers ───────────────────────────────────

// -- send-message --

async function handleSendMessage(flags: Record<string, string>) {
  const text = flags['text'];
  if (!text) fail('Missing --text');

  const response = await galleryPost('message', {
    agentId,
    text,
    sender: flags['sender'],
    timestamp: new Date().toISOString(),
  });

  if (!response.ok) fail(`Message delivery failed: ${response.status} ${response.statusText}`);
  ok('Message sent.');
}

// -- progress --

async function handleProgress(flags: Record<string, string>) {
  const stepsRaw = flags['steps'];
  const currentRaw = flags['current'];
  const status = flags['status'] || 'in_progress';
  const note = flags['note'];

  if (!stepsRaw || currentRaw === undefined) fail('Missing --steps (JSON array) and --current (number)');

  let steps: string[];
  try { steps = JSON.parse(stepsRaw); } catch { fail('--steps must be a JSON array of strings'); }

  const current = parseInt(currentRaw, 10);
  if (isNaN(current)) fail('--current must be a number');

  const progress = Math.round(((current + (status === 'completed' ? 1 : 0)) / steps.length) * 100);

  postActivity('progress', `Step ${current + 1}/${steps.length}: ${steps[current]} [${status}]${note ? ` — ${note}` : ''}`, {
    steps, current, status, progress,
  });

  const display = steps.map((step, i) => {
    if (i < current) return `  [x] ${step}`;
    if (i === current) return `  [${status === 'completed' ? 'x' : status === 'blocked' ? '!' : '>'}] ${step}${note ? ` — ${note}` : ''}`;
    return `  [ ] ${step}`;
  }).join('\n');

  ok(`Progress: ${progress}%\n${display}`);
}

// -- task --

async function handleTask(sub: string, flags: Record<string, string>) {
  switch (sub) {
    case 'list': {
      const tasks = await convexQuery('mcpInternal:listTasks', { status: flags['status'] });
      const list = (tasks as any[]).map((t: any) =>
        `- [${t.status}] ${t.title}${t.assignedAgent ? ` (${t.assignedAgent})` : ''}${t.priority ? ` [${t.priority}]` : ''}`
      );
      ok(list.length > 0 ? list.join('\n') : 'No tasks found.');
      break;
    }

    case 'create': {
      const title = flags['title'];
      if (!title) fail('Missing --title');
      const labels = flags['labels'] ? JSON.parse(flags['labels']) : undefined;
      const id = await convexMutation('mcpInternal:createTask', {
        title,
        description: flags['description'],
        status: flags['status'],
        priority: flags['priority'],
        labels,
        assignedAgent: flags['assigned-agent'],
      });
      postActivity('status', `Created task: ${title}`, { taskId: id });
      ok(`Task created: "${title}" [${flags['status'] ?? 'todo'}]`);
      break;
    }

    case 'update': {
      const title = flags['title'];
      if (!title) fail('Missing --title');
      const tasks = await convexQuery('mcpInternal:listTasks', {});
      const task = (tasks as any[]).find((t: any) => t.title.toLowerCase() === title.toLowerCase());
      if (!task) fail(`Task "${title}" not found.`);
      await convexMutation('mcpInternal:updateTask', {
        taskId: task._id,
        status: flags['status'],
        priority: flags['priority'],
        assignedAgent: flags['assigned-agent'],
        description: flags['description'],
      });
      ok(`Task "${title}" updated.`);
      break;
    }

    case 'delete': {
      const title = flags['title'];
      if (!title) fail('Missing --title');
      const tasks = await convexQuery('mcpInternal:listTasks', {});
      const task = (tasks as any[]).find((t: any) => t.title.toLowerCase() === title.toLowerCase());
      if (!task) fail(`Task "${title}" not found.`);
      await convexMutation('mcpInternal:deleteTask', { taskId: task._id });
      ok(`Task "${title}" deleted.`);
      break;
    }

    case 'comment': {
      const title = flags['title'];
      const content = flags['content'];
      if (!title || !content) fail('Missing --title and --content');
      const tasks = await convexQuery('mcpInternal:listTasks', {});
      const task = (tasks as any[]).find((t: any) => t.title.toLowerCase() === title.toLowerCase());
      if (!task) fail(`Task "${title}" not found.`);
      await convexMutation('mcpInternal:addTaskComment', { taskId: task._id, content });
      ok(`Comment added to "${title}".`);
      break;
    }

    case 'report': {
      const taskTitle = flags['task-title'] || flags['title'];
      const report = flags['report'];
      const agentName = flags['agent-name'];
      if (!taskTitle || !report || !agentName) fail('Missing --task-title, --report, and --agent-name');
      const tasks = await convexQuery('mcpInternal:listTasks', {});
      const childTask = (tasks as any[]).find((t: any) => t.title.toLowerCase() === taskTitle.toLowerCase());
      if (!childTask) fail(`Task "${taskTitle}" not found.`);
      if (!childTask.parentTaskId) fail(`Task "${taskTitle}" has no parent task.`);
      const result = await convexMutation('mcpInternal:reportToParent', {
        taskId: childTask._id,
        report,
        childStatus: flags['status'],
        agentName,
      });
      ok(`Reported to parent task "${result.parentTaskTitle}": ${report.slice(0, 200)}`);
      break;
    }

    default:
      fail(`Unknown task subcommand: ${sub}. Use: list, create, update, delete, comment, report`);
  }
}

// -- agent --

async function handleAgent(sub: string, flags: Record<string, string>) {
  switch (sub) {
    case 'list': {
      const agents = await convexQuery('mcpInternal:listAgents', { status: flags['status'] });
      const list = (agents as any[]).map((a: any) =>
        `- ${a.name}${a.isAdmin ? ' [ADMIN]' : ''} (${a.model ?? 'default'}) [${a.status}]${a.description ? ` — ${a.description}` : ''}`
      );
      ok(list.length > 0 ? list.join('\n') : 'No agents found.');
      break;
    }

    case 'delegate': {
      const toAgentId = flags['to'] || flags['to-agent'];
      const task = flags['task'];
      if (!toAgentId || !task) fail('Missing --to (agent ID) and --task');

      const delegateUrl = galleryWorkerUrl
        ? `${galleryWorkerUrl}/delegate`
        : `${galleryApiUrl}/api/claw/delegate`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);
      try {
        const response = await fetch(delegateUrl, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${galleryToken}`,
          },
          body: JSON.stringify({
            type: 'task',
            toAgentId,
            fromAgentId: agentId,
            task,
            context: flags['context'],
          }),
        });
        if (!response.ok) {
          const err = await response.text();
          fail(`Delegation failed (${response.status}): ${err}`);
        }
        const data = await response.json() as { success: boolean; result?: string | null };
        ok(data.result ? `Agent completed task.\n\nResult:\n${data.result}` : 'Agent completed task (no text output).');
      } catch (err) {
        const isAbort = err instanceof Error && err.name === 'AbortError';
        fail(isAbort ? 'Delegation timed out after 600s' : (err instanceof Error ? err.message : String(err)));
      } finally {
        clearTimeout(timeout);
      }
      break;
    }

    case 'message': {
      const toAgentId = flags['to'] || flags['to-agent'];
      const message = flags['message'];
      if (!toAgentId || !message) fail('Missing --to (agent ID) and --message');

      const delegateUrl = galleryWorkerUrl
        ? `${galleryWorkerUrl}/delegate`
        : `${galleryApiUrl}/api/claw/delegate`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);
      try {
        const response = await fetch(delegateUrl, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${galleryToken}`,
          },
          body: JSON.stringify({
            type: 'message',
            toAgentId,
            fromAgentId: agentId,
            message,
          }),
        });
        if (!response.ok) {
          const err = await response.text();
          fail(`Message failed (${response.status}): ${err}`);
        }
        const data = await response.json() as { success: boolean; result?: string | null };
        ok(data.result || '(Agent replied with no text output)');
      } catch (err) {
        const isAbort = err instanceof Error && err.name === 'AbortError';
        fail(isAbort ? 'Message timed out after 600s' : (err instanceof Error ? err.message : String(err)));
      } finally {
        clearTimeout(timeout);
      }
      break;
    }

    default:
      fail(`Unknown agent subcommand: ${sub}. Use: list, delegate, message`);
  }
}

// -- review --

async function handleReview(sub: string, flags: Record<string, string>) {
  switch (sub) {
    case 'create': {
      const type = flags['type'];
      const title = flags['title'];
      const content = flags['content'];
      if (!type || !title || !content) fail('Missing --type, --title, and --content');

      let taskId: string | undefined;
      if (flags['task-title']) {
        const tasks = await convexQuery('mcpInternal:listTasks', {});
        const task = (tasks as any[]).find((t: any) => t.title.toLowerCase() === flags['task-title'].toLowerCase());
        if (task) taskId = task._id;
      }

      await convexMutation('mcpInternal:createReview', {
        agentId,
        taskId,
        type,
        title,
        content,
      });
      ok(`Review created: "${title}" [${type}]`);
      break;
    }

    case 'list': {
      const reviews = await convexQuery('mcpInternal:listReviews', { status: flags['status'] });
      const list = (reviews as any[]).map((r: any) =>
        `- [${r.status}] ${r.title} (${r.type})${r.response ? ` → ${r.response}` : ''}`
      );
      ok(list.length > 0 ? list.join('\n') : 'No reviews found.');
      break;
    }

    default:
      fail(`Unknown review subcommand: ${sub}. Use: create, list`);
  }
}

// -- workspace --

async function handleWorkspace(sub: string) {
  if (sub !== 'info' && sub !== '') fail(`Unknown workspace subcommand: ${sub}. Use: info`);
  const info = await convexQuery('mcpInternal:workspaceInfo', {});
  ok(info);
}

// -- memory --

async function handleMemory(sub: string, flags: Record<string, string>, positional: string[]) {
  switch (sub) {
    case 'view': {
      const requestedPath = positional[0] || flags['path'] || '/';
      const normalized = requestedPath === '/' ? '' : requestedPath;

      let targetPath: string;
      if (normalized === 'MEMORY.md' || normalized === '/MEMORY.md') {
        targetPath = MEMORY_FILE;
      } else if (normalized === '' || normalized === '/') {
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
            entries.push(`${formatSize(stat.size)}\t${stat.isDirectory() ? `memory/${file}/` : `memory/${file}`}`);
          }
        }
        ok(entries.length > 0 ? `Memory files:\n${entries.join('\n')}` : 'Memory is empty. Use `gallery memory write` to save notes.');
        break;
      } else {
        targetPath = path.join(MEMORY_DIR, normalized);
      }

      const resolved = path.resolve(targetPath);
      if (!resolved.startsWith(WORKSPACE_DIR)) fail('Path must be within workspace.');
      if (!fs.existsSync(targetPath)) { ok(`No memory file at "${requestedPath}". Use \`gallery memory write\` to create one.`); break; }

      const stat = fs.statSync(targetPath);
      if (stat.isDirectory()) {
        const files = fs.readdirSync(targetPath).filter(f => !f.startsWith('.')).sort();
        const entries = files.map(f => {
          const s = fs.statSync(path.join(targetPath, f));
          return `${formatSize(s.size)}\t${f}${s.isDirectory() ? '/' : ''}`;
        });
        ok(entries.length > 0 ? entries.join('\n') : '(empty directory)');
        break;
      }

      const content = fs.readFileSync(targetPath, 'utf-8');
      const lines = content.split('\n');

      if (flags['range']) {
        const [startStr, endStr] = flags['range'].split(':');
        const start = parseInt(startStr, 10);
        const end = parseInt(endStr, 10);
        const slice = lines.slice(Math.max(0, start - 1), end);
        const numbered = slice.map((line, i) => `${String(start + i).padStart(6)}\t${line}`).join('\n');
        ok(`${requestedPath} (lines ${start}-${end}):\n${numbered}`);
      } else {
        const numbered = lines.map((line, i) => `${String(i + 1).padStart(6)}\t${line}`).join('\n');
        ok(`${requestedPath}:\n${numbered}`);
      }
      break;
    }

    case 'write': {
      const memPath = flags['path'];
      const content = flags['content'];
      const mode = flags['mode'] || 'append';
      if (!memPath || !content) fail('Missing --path and --content');

      let targetPath: string;
      if (memPath === 'MEMORY.md' || memPath === '/MEMORY.md') {
        targetPath = MEMORY_FILE;
      } else {
        targetPath = path.join(MEMORY_DIR, memPath);
      }

      const resolved = path.resolve(targetPath);
      if (!resolved.startsWith(WORKSPACE_DIR)) fail('Path must be within workspace.');

      fs.mkdirSync(path.dirname(targetPath), { recursive: true });

      if (mode === 'create' && fs.existsSync(targetPath)) {
        fail(`"${memPath}" already exists. Use --mode append or --mode replace.`);
      }

      if (mode === 'append') {
        const existing = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf-8') : '';
        const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
        fs.writeFileSync(targetPath, existing + separator + content);
      } else {
        fs.writeFileSync(targetPath, content);
      }

      const fullContent = fs.readFileSync(targetPath, 'utf-8');
      indexMemoryEntry(memPath, fullContent);

      const stat = fs.statSync(targetPath);
      ok(`Memory written: ${memPath} (${formatSize(stat.size)})`);
      break;
    }

    case 'search': {
      const query = flags['query'];
      if (!query) fail('Missing --query');
      const scope = (flags['scope'] || 'all') as 'memory' | 'conversations' | 'all';
      const limit = parseInt(flags['limit'] || '10', 10);
      const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
      if (queryTerms.length === 0) fail('Search query is empty.');

      const sections: string[] = [];
      let totalMatches = 0;

      if (scope !== 'conversations') {
        const indexed = await searchMemoryEntries(query, limit);
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
            if (snippets.length === 0) snippets.push(lines.slice(0, 4).join('\n').slice(0, 300));
            return `**${entry.path}**\n${snippets.join('\n...\n')}`;
          }).join('\n\n---\n\n');
          sections.push(formatted);
        } else {
          const memResults = localKeywordSearch(queryTerms, 'memory');
          if (memResults.length > 0) {
            totalMatches += memResults.length;
            sections.push(memResults.slice(0, limit).map(r => `**${r.file}:${r.line}**\n${r.text}`).join('\n\n---\n\n'));
          }
        }
      }

      if (scope === 'conversations' || scope === 'all') {
        const convResults = localKeywordSearch(queryTerms, 'conversations');
        if (convResults.length > 0) {
          totalMatches += convResults.length;
          sections.push(convResults.slice(0, limit).map(r => `**${r.file}:${r.line}**\n${r.text}`).join('\n\n---\n\n'));
        }
      }

      if (totalMatches === 0) {
        ok(`No matches for "${query}" in ${scope} files.`);
      } else {
        ok(`Found ${totalMatches} match(es) for "${query}":\n\n${sections.join('\n\n---\n\n')}`);
      }
      break;
    }

    case 'delete': {
      const memPath = positional[0] || flags['path'];
      if (!memPath) fail('Missing --path or positional path argument');

      let targetPath: string;
      if (memPath === 'MEMORY.md' || memPath === '/MEMORY.md') {
        targetPath = MEMORY_FILE;
      } else {
        targetPath = path.join(MEMORY_DIR, memPath);
      }

      const resolved = path.resolve(targetPath);
      if (!resolved.startsWith(WORKSPACE_DIR)) fail('Path must be within workspace.');
      if (!fs.existsSync(targetPath)) fail(`File "${memPath}" not found.`);

      fs.unlinkSync(targetPath);
      removeMemoryEntry(memPath);
      ok(`Deleted ${memPath}`);
      break;
    }

    default:
      fail(`Unknown memory subcommand: ${sub}. Use: view, write, search, delete`);
  }
}

// -- context --

async function handleContext(sub: string) {
  if (sub !== 'usage' && sub !== '') fail(`Unknown context subcommand: ${sub}. Use: usage`);
  const usageFile = path.join(WORKSPACE_DIR, '.context-usage.json');
  if (!fs.existsSync(usageFile)) { ok('Context usage data not yet available (no messages processed).'); return; }
  try {
    const data = JSON.parse(fs.readFileSync(usageFile, 'utf-8'));
    const age = Math.round((Date.now() - (data.updatedAt || 0)) / 1000);
    ok(
      `Context usage: ${data.percentage}%\n` +
      `Input tokens: ${(data.inputTokens || 0).toLocaleString()}\n` +
      `Cache read: ${(data.cacheReadTokens || 0).toLocaleString()}\n` +
      `Output tokens: ${(data.outputTokens || 0).toLocaleString()}\n` +
      `Context window: ${(data.contextWindow || 0).toLocaleString()}\n` +
      `Updated: ${age}s ago`,
    );
  } catch { fail('Failed to read context usage.'); }
}

// -- compact --

async function handleCompact(flags: Record<string, string>) {
  const memoryDirPath = path.join(WORKSPACE_DIR, 'memory');
  fs.mkdirSync(memoryDirPath, { recursive: true });

  const date = new Date().toISOString().split('T')[0];
  const timestamp = new Date().toISOString().split('T')[1].replace(/\.\d+Z$/, '');
  const dailyFile = path.join(memoryDirPath, `${date}.md`);

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
    contextInfo || null,
    flags['focus'] ? `Focus: ${flags['focus']}` : null,
    '',
    'Checkpoint created by agent via `gallery compact`.',
    'Use this marker to resume work if context is compacted.',
    '',
  ].filter(Boolean).join('\n');

  fs.appendFileSync(dailyFile, marker);
  ok(`Checkpoint saved to memory/${date}.md\n${contextInfo}\n\nWrite your key findings, decisions, and next steps to MEMORY.md now before compaction occurs.`);
}

// -- structured-output --

async function handleStructuredOutput(flags: Record<string, string>) {
  const data = flags['data'];
  if (!data) fail('Missing --data (JSON string)');
  try {
    const parsed = JSON.parse(data);
    ok(JSON.stringify(parsed, null, 2));
  } catch { fail(`Invalid JSON: ${data.slice(0, 500)}`); }
}

// -- peer-memory --

async function handlePeerMemory(sub: string, flags: Record<string, string>) {
  const targetAgent = flags['agent'] || flags['agent-id'];
  if (!targetAgent) fail('Missing --agent (target agent ID)');

  switch (sub) {
    case 'search': {
      const query = flags['query'];
      if (!query) fail('Missing --query');
      const limit = parseInt(flags['limit'] || '5', 10);
      const res = await fetch(`${convexUrl}/api/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: 'memoryEntries:search',
          args: { token: gatewayToken, agentId: targetAgent, query, limit },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) fail(`Failed to search peer memory: ${res.status}`);
      const data = await res.json();
      const entries = data.value ?? data ?? [];
      if (!Array.isArray(entries) || entries.length === 0) { ok(`No results for "${query}" in agent ${targetAgent}'s memory.`); break; }
      const formatted = entries.map((e: any) => `**${e.path}**\n${(e.body || '').slice(0, 500)}`).join('\n\n---\n\n');
      ok(`Found ${entries.length} result(s) in peer memory:\n\n${formatted}`);
      break;
    }

    case 'list': {
      const res = await fetch(`${convexUrl}/api/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: 'memoryEntries:listPaths',
          args: { token: gatewayToken, agentId: targetAgent },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) fail(`Failed to list peer memory: ${res.status}`);
      const data = await res.json();
      const paths = data.value ?? data ?? [];
      if (!Array.isArray(paths) || paths.length === 0) { ok(`Agent ${targetAgent} has no indexed memory entries.`); break; }
      const formatted = paths.map((p: any) => `- ${p.path} (updated: ${new Date(p.updatedAt).toLocaleDateString()})`).join('\n');
      ok(`Agent ${targetAgent}'s memory files:\n${formatted}\n\nUse 'gallery peer-memory search --agent ${targetAgent} --query "..."' to search.`);
      break;
    }

    default:
      fail(`Unknown peer-memory subcommand: ${sub}. Use: list, search`);
  }
}

// -- plan --

async function handlePlan(sub: string, flags: Record<string, string>) {
  switch (sub) {
    case 'enter': {
      const title = flags['title'];
      const content = flags['content'];
      if (!title || !content) fail('Missing --title and --content');

      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
      const planFile = path.join(MEMORY_DIR, `plan-${slug}.md`);
      fs.mkdirSync(MEMORY_DIR, { recursive: true });
      fs.writeFileSync(planFile, `# Plan: ${title}\n\n${content}\n\n---\n*Created: ${new Date().toISOString()}*\n`);
      indexMemoryEntry(`plan-${slug}.md`, fs.readFileSync(planFile, 'utf-8'));

      try {
        await convexMutation('mcpInternal:createReview', {
          agentId,
          type: 'approval',
          title: `Plan: ${title}`,
          content: content.slice(0, 2000),
        });
      } catch { /* non-fatal */ }

      postActivity('status', `Entered plan mode: ${title}`);
      ok(`Plan saved to memory/plan-${slug}.md and submitted for approval.\n\n**PLAN MODE:** Do not execute file writes, bash commands, or external actions until approved. Only read, research, and refine.\n\nWhen approved, run: gallery plan exit --title "${title}"`);
      break;
    }

    case 'exit': {
      const title = flags['title'] || 'untitled';
      postActivity('status', `Exited plan mode: ${title}`);
      ok(`Plan mode exited. You may now execute the approved plan for "${title}".\n\nRead your plan file from memory before starting execution.`);
      break;
    }

    default:
      fail(`Unknown plan subcommand: ${sub}. Use: enter, exit`);
  }
}

// -- sleep --

async function handleSleep(flags: Record<string, string>) {
  const delayStr = flags['delay'] || flags['seconds'];
  const message = flags['message'];
  if (!delayStr || !message) fail('Missing --delay (seconds) and --message');

  const delay = parseInt(delayStr, 10);
  if (isNaN(delay) || delay < 10 || delay > 3600) fail('--delay must be 10–3600 seconds');

  if (!galleryWorkerUrl || !galleryToken) fail('Self-wake requires Gallery Worker (not configured).');

  const response = await fetch(`${galleryWorkerUrl}/scheduler/schedule/once`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${galleryToken}`,
    },
    body: JSON.stringify({
      agentId,
      delaySeconds: delay,
      message: `[SELF-WAKE] ${message}`,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    fail(`Sleep scheduling failed (${response.status}): ${err}`);
  }

  const wakeTime = new Date(Date.now() + delay * 1000).toLocaleTimeString();
  postActivity('status', `Scheduled self-wake in ${delay}s at ~${wakeTime}`);
  ok(`Self-wake scheduled in ${delay} seconds (~${wakeTime}).\nWake message: "${message}"\n\nContinue other work. The wake message will arrive as a scheduled task.`);
}

// ─── Main Dispatch ──────────────────────────────────────

async function main() {
  const { command, subcommand, flags, positional } = parseArgs(process.argv);

  try {
    switch (command) {
      case 'send-message':
        await handleSendMessage(flags);
        break;
      case 'progress':
        await handleProgress(flags);
        break;
      case 'task':
        await handleTask(subcommand, flags);
        break;
      case 'agent':
        await handleAgent(subcommand, flags);
        break;
      case 'review':
        await handleReview(subcommand, flags);
        break;
      case 'workspace':
        await handleWorkspace(subcommand);
        break;
      case 'memory':
        await handleMemory(subcommand, flags, positional);
        break;
      case 'context':
        await handleContext(subcommand);
        break;
      case 'compact':
        await handleCompact(flags);
        break;
      case 'structured-output':
        await handleStructuredOutput(flags);
        break;
      case 'peer-memory':
        await handlePeerMemory(subcommand, flags);
        break;
      case 'plan':
        await handlePlan(subcommand, flags);
        break;
      case 'sleep':
        await handleSleep(flags);
        break;
      default:
        fail(`Unknown command: ${command}. Available: task, agent, review, workspace, memory, send-message, progress, context, compact, structured-output, peer-memory, plan, sleep`);
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

main();
