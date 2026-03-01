/**
 * Claw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    if (this.done) return;
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---CLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---CLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 * Also writes a compaction marker to the daily memory log so the agent
 * knows context was reset (mirrors OpenClaw's pre-compaction flush).
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);

      // Write compaction marker to daily memory log
      // This helps the agent know context was reset and where to find the archived conversation
      const memoryDir = '/workspace/group/memory';
      fs.mkdirSync(memoryDir, { recursive: true });
      const dailyFile = path.join(memoryDir, `${date}.md`);
      const timestamp = new Date().toISOString().split('T')[1].replace(/\.\d+Z$/, '');
      const marker = `\n## Context compacted at ${timestamp}\n\nConversation archived to \`conversations/${filename}\`${summary ? `\nSummary: ${summary}` : ''}\n`;

      fs.appendFileSync(dailyFile, marker);
      log(`Wrote compaction marker to memory/${date}.md`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

// Secrets to strip from Bash tool subprocess environments.
// These are needed by claude-code for API auth but should never
// be visible to commands Kit runs.
const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

function createSanitizeBashHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command) return {};

    const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...(preInput.tool_input as Record<string, unknown>),
          command: unsetPrefix + command,
        },
      },
    };
  };
}

// ─── Tool Loop Detection ──────────────────────────────

const LOOP_SAME_CALL_THRESHOLD = parseInt(process.env.LOOP_SAME_CALL_THRESHOLD || '3', 10);
const LOOP_FORCE_STOP_THRESHOLD = parseInt(process.env.LOOP_FORCE_STOP_THRESHOLD || '6', 10);
const LOOP_CYCLE_THRESHOLD = parseInt(process.env.LOOP_CYCLE_THRESHOLD || '3', 10);
const LOOP_HISTORY_SIZE = 20;

interface ToolCallRecord {
  toolName: string;
  inputHash: string;
}

class ToolCallTracker {
  private history: ToolCallRecord[] = [];
  private warningIssued = false;

  private hashInput(input: unknown): string {
    const str = JSON.stringify(input);
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(36);
  }

  track(toolName: string, toolInput: unknown): { loopDetected: boolean; shouldStop: boolean } {
    this.history.push({ toolName, inputHash: this.hashInput(toolInput) });
    if (this.history.length > LOOP_HISTORY_SIZE) {
      this.history.shift();
    }

    // Check 1: Same tool + same input N times in a row
    const sameCallCount = this.countConsecutiveSame();
    if (sameCallCount >= LOOP_FORCE_STOP_THRESHOLD) {
      return { loopDetected: true, shouldStop: true };
    }
    if (sameCallCount >= LOOP_SAME_CALL_THRESHOLD) {
      return { loopDetected: true, shouldStop: false };
    }

    // Check 2: Repeating cycle of 2-3 tools
    const cycles2 = this.detectCycle(2);
    const cycles3 = this.detectCycle(3);
    if (cycles2 >= LOOP_CYCLE_THRESHOLD || cycles3 >= LOOP_CYCLE_THRESHOLD) {
      const totalRepeats = Math.max(cycles2, cycles3);
      return { loopDetected: true, shouldStop: totalRepeats >= LOOP_FORCE_STOP_THRESHOLD };
    }

    return { loopDetected: false, shouldStop: false };
  }

  private countConsecutiveSame(): number {
    if (this.history.length === 0) return 0;
    const last = this.history[this.history.length - 1];
    let count = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].toolName === last.toolName && this.history[i].inputHash === last.inputHash) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  private detectCycle(cycleLength: number): number {
    if (this.history.length < cycleLength * 2) return 0;
    const recent = this.history.slice(-cycleLength);
    let repetitions = 1;
    for (let offset = cycleLength; offset <= this.history.length - cycleLength; offset += cycleLength) {
      const segment = this.history.slice(-(offset + cycleLength), -offset);
      if (segment.length !== cycleLength) break;
      const matches = segment.every(
        (rec, i) => rec.toolName === recent[i].toolName && rec.inputHash === recent[i].inputHash,
      );
      if (matches) repetitions++;
      else break;
    }
    return repetitions;
  }

  resetWarning(): void { this.warningIssued = false; }
  hasIssuedWarning(): boolean { return this.warningIssued; }
  markWarningIssued(): void { this.warningIssued = true; }
}

function createLoopDetectionHook(tracker: ToolCallTracker): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const toolName = (preInput as { tool_name?: string }).tool_name || 'unknown';
    const toolInput = preInput.tool_input;

    const { loopDetected, shouldStop } = tracker.track(toolName, toolInput);

    if (shouldStop) {
      log(`[loop-detect] FORCE STOP: Tool ${toolName} in terminal loop`);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          decision: 'block',
          message: 'LOOP DETECTED: You have been calling the same tool with the same input repeatedly. This call is blocked. Try a completely different approach.',
        },
      };
    }

    if (loopDetected && !tracker.hasIssuedWarning()) {
      log(`[loop-detect] WARNING: Repetitive tool use detected for ${toolName}`);
      tracker.markWarningIssued();
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          message: 'WARNING: You appear to be repeating the same tool calls. Consider trying a different approach before this call gets blocked.',
        },
      };
    }

    if (!loopDetected) {
      tracker.resetWarning();
    }

    return {};
  };
}

// ─── End Tool Loop Detection ──────────────────────────

// ─── Gallery Activity Posting ────────────────────────────

/**
 * Posts real-time agent activity to Gallery dashboard via Convex API.
 * Batches events to avoid spamming mutations.
 */
type ActivityType = 'output' | 'tool_use' | 'thinking' | 'error' | 'status';

class ActivityPoster {
  private convexUrl: string | null;
  private token: string | null;
  private agentId: string;
  private queue: { type: ActivityType; content: string; metadata?: unknown }[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(secrets: Record<string, string>, agentId: string) {
    this.convexUrl = secrets.GALLERY_CONVEX_URL || null;
    this.token = secrets.GALLERY_GATEWAY_TOKEN || null;
    this.agentId = agentId;

    if (this.convexUrl && this.token) {
      this.timer = setInterval(() => this.flush(), 2000);
      log('[activity] Gallery activity posting enabled');
    }
  }

  post(type: ActivityType, content: string, metadata?: unknown): void {
    if (!this.convexUrl || !this.token) return;
    this.queue.push({ type, content: content.slice(0, 4000), metadata });
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0 || !this.convexUrl || !this.token) return;

    const batch = this.queue.splice(0, 10);
    for (const event of batch) {
      try {
        await fetch(`${this.convexUrl}/api/mutation`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: 'agentActivity:push',
            args: {
              token: this.token,
              agentId: this.agentId,
              type: event.type,
              content: event.content,
              metadata: event.metadata,
            },
          }),
        });
      } catch {
        // non-fatal — dashboard activity is best-effort
      }
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Drain entire queue (flush takes max 10 at a time)
    while (this.queue.length > 0) {
      await this.flush();
    }
  }
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  activityPoster: ActivityPoster,
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  const loopTracker = new ToolCallTracker();
  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  try {
    for await (const message of query({
      prompt: stream,
      options: {
        cwd: '/workspace/group',
        additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
        resume: sessionId,
        resumeSessionAt: resumeAt,
        systemPrompt: globalClaudeMd
          ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd }
          : undefined,
        allowedTools: [
          'Bash',
          'Read', 'Write', 'Edit', 'Glob', 'Grep',
          'WebSearch', 'WebFetch',
          'Task', 'TaskOutput', 'TaskStop',
          'TeamCreate', 'TeamDelete', 'SendMessage',
          'TodoWrite', 'ToolSearch', 'Skill',
          'NotebookEdit',
          'mcp__claw__*'
        ],
        env: sdkEnv,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        mcpServers: {
          claw: {
            command: 'node',
            args: [mcpServerPath],
            env: {
              CLAW_CHAT_JID: containerInput.chatJid,
              CLAW_GROUP_FOLDER: containerInput.groupFolder,
              CLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
            },
          },
        },
        hooks: {
          PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
          PreToolUse: [
            { matcher: 'Bash', hooks: [createSanitizeBashHook()] },
            { hooks: [createLoopDetectionHook(loopTracker)] },
          ],
        },
      }
    })) {
      messageCount++;
      const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
      log(`[msg #${messageCount}] type=${msgType}`);

      if (message.type === 'assistant' && 'uuid' in message) {
        lastAssistantUuid = (message as { uuid: string }).uuid;
        // Post assistant text output to dashboard
        const content = (message as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              activityPoster.post('output', block.text);
            } else if (block.type === 'tool_use') {
              activityPoster.post('tool_use', `${block.name}(${JSON.stringify(block.input).slice(0, 200)})`);
            } else if (block.type === 'thinking' && block.thinking) {
              activityPoster.post('thinking', block.thinking.slice(0, 500));
            }
          }
        }
      }

      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        log(`Session initialized: ${newSessionId}`);
        activityPoster.post('status', `Session initialized: ${newSessionId}`);
        // Persist session ID to disk for crash recovery.
        // If the container crashes before the host reads stdout, the host
        // can recover the session ID from this file on next run.
        try {
          fs.writeFileSync('/workspace/group/.current-session-id', newSessionId);
        } catch { /* non-fatal */ }
      }

      if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
        const tn = message as { task_id: string; status: string; summary: string };
        log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
        activityPoster.post('status', `Task ${tn.status}: ${tn.summary}`);
      }

      if (message.type === 'result') {
        resultCount++;
        const textResult = 'result' in message ? (message as { result?: string }).result : null;
        log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
        activityPoster.post('output', textResult ? textResult.slice(0, 500) : 'Query completed');
        writeOutput({
          status: 'success',
          result: textResult || null,
          newSessionId
        });
      }
    }
  } finally {
    ipcPolling = false;
  }
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    // Delete the temp file the entrypoint wrote — it contains secrets
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Build SDK env: merge secrets into process.env for the SDK only.
  // Secrets never touch process.env itself, so Bash subprocesses can't see them.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
  }

  // Initialize activity poster for real-time dashboard streaming
  const activityPoster = new ActivityPoster(
    containerInput.secrets || {},
    containerInput.assistantName || containerInput.groupFolder,
  );
  activityPoster.post('status', 'Agent container started');

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Clean up stale browser lock files from previous container runs.
  // These prevent Chromium from starting if the previous container exited uncleanly.
  const browserProfileDir = process.env.CHROMIUM_USER_DATA_DIR;
  if (browserProfileDir && fs.existsSync(browserProfileDir)) {
    for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      try { fs.unlinkSync(path.join(browserProfileDir, lockFile)); } catch { /* ignore */ }
    }
  }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, activityPoster, resumeAt);
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    activityPoster.post('error', errorMessage);
    await activityPoster.stop();
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }

  activityPoster.post('status', 'Agent container stopped');
  await activityPoster.stop();
}

main();
