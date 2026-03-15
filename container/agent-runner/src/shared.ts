/**
 * Shared utilities for Claw agent runners (agent.ts + index.ts).
 *
 * Contains code that is identical between the Sprites HTTP service (agent.ts)
 * and the Docker stdin/stdout runner (index.ts):
 * - Transcript parsing and archiving
 * - Tool loop detection
 * - Bash secret sanitization hook
 * - Activity posting to Gallery dashboard
 * - Session index utilities
 */

import fs from 'fs';
import path from 'path';
import { HookCallback, PreCompactHookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

// ─── Transcript Parsing ──────────────────────────────────

export interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

export function parseTranscript(content: string): ParsedMessage[] {
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
    } catch { /* skip unparseable lines */ }
  }
  return messages;
}

export function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

export function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

export function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true
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
    const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + '...' : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Session Index ──────────────────────────────────────

export interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

export interface SessionsIndex {
  entries: SessionEntry[];
}

export function getSessionSummary(sessionId: string, transcriptPath: string, log?: (msg: string) => void): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log?.(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) return entry.summary;
  } catch (err) {
    log?.(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

// ─── Pre-Compact Hook ────────────────────────────────────

/**
 * Archive the full transcript to conversations/ before compaction.
 * Also writes a compaction marker to the daily memory log.
 *
 * @param workspaceDir - The workspace root (e.g. '/home/sprite/workspace' or '/workspace/group')
 * @param assistantName - Optional name for the assistant in transcripts
 * @param log - Logging function
 */
export function createPreCompactHook(workspaceDir: string, assistantName?: string, log?: (msg: string) => void): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log?.('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log?.('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath, log);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = path.join(workspaceDir, 'conversations');
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
      fs.writeFileSync(filePath, markdown);
      log?.(`Archived conversation to ${filePath}`);

      // Write compaction marker to daily memory log
      const memoryDir = path.join(workspaceDir, 'memory');
      fs.mkdirSync(memoryDir, { recursive: true });
      const dailyFile = path.join(memoryDir, `${date}.md`);
      const timestamp = new Date().toISOString().split('T')[1].replace(/\.\d+Z$/, '');
      const marker = `\n## Context compacted at ${timestamp}\n\nConversation archived to \`conversations/${filename}\`${summary ? `\nSummary: ${summary}` : ''}\n`;
      fs.appendFileSync(dailyFile, marker);
      log?.(`Wrote compaction marker to memory/${date}.md`);
    } catch (err) {
      log?.(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

// ─── Bash Secret Sanitization ────────────────────────────

export const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

export function createSanitizeBashHook(): HookCallback {
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

// ─── Tool Loop Detection ─────────────────────────────────

export const LOOP_SAME_CALL_THRESHOLD = parseInt(process.env.LOOP_SAME_CALL_THRESHOLD || '3', 10);
export const LOOP_FORCE_STOP_THRESHOLD = parseInt(process.env.LOOP_FORCE_STOP_THRESHOLD || '6', 10);
export const LOOP_CYCLE_THRESHOLD = parseInt(process.env.LOOP_CYCLE_THRESHOLD || '3', 10);
// Same tool called with different inputs N times = likely stuck on same goal
export const LOOP_SAME_TOOL_THRESHOLD = parseInt(process.env.LOOP_SAME_TOOL_THRESHOLD || '5', 10);
// Read-only tools are commonly called many times consecutively (codebase exploration)
const SAME_TOOL_EXEMPT = new Set(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'ToolSearch']);
const LOOP_HISTORY_SIZE = 20;

interface ToolCallRecord {
  toolName: string;
  inputHash: string;
}

export class ToolCallTracker {
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

    // Check 1: Same tool + same input N times consecutively from the tail
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

    // Check 3: Same tool called with different inputs — stuck on same goal
    // Skip for read-only tools (agents legitimately read many files in a row)
    if (!SAME_TOOL_EXEMPT.has(toolName)) {
      const sameToolCount = this.countConsecutiveSameTool();
      if (sameToolCount >= LOOP_SAME_TOOL_THRESHOLD * 2) {
        return { loopDetected: true, shouldStop: true };
      }
      if (sameToolCount >= LOOP_SAME_TOOL_THRESHOLD) {
        return { loopDetected: true, shouldStop: false };
      }
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

  private countConsecutiveSameTool(): number {
    if (this.history.length === 0) return 0;
    const last = this.history[this.history.length - 1];
    let count = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].toolName === last.toolName) {
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

export function createLoopDetectionHook(tracker: ToolCallTracker, log?: (msg: string) => void): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const toolName = (preInput as { tool_name?: string }).tool_name || 'unknown';
    const toolInput = preInput.tool_input;

    const { loopDetected, shouldStop } = tracker.track(toolName, toolInput);

    if (shouldStop) {
      log?.(`[loop-detect] FORCE STOP: Tool ${toolName} in terminal loop`);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          decision: 'block',
          message: 'LOOP DETECTED: You have been calling the same tool with the same input repeatedly. This call is blocked. Try a completely different approach.',
        },
      };
    }

    if (loopDetected && !tracker.hasIssuedWarning()) {
      log?.(`[loop-detect] WARNING: Repetitive tool use detected for ${toolName}`);
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

// ─── Context Window Safety ───────────────────────────────

export const CONTEXT_WARN_THRESHOLD = parseFloat(process.env.CLAW_CONTEXT_WARN_THRESHOLD || '0.70');
export const CONTEXT_CHECKPOINT_THRESHOLD = parseFloat(process.env.CLAW_CONTEXT_CHECKPOINT_THRESHOLD || '0.80');

export class ContextWindowTracker {
  /** Last known input_tokens from the most recent assistant message (cumulative per API) */
  lastInputTokens = 0;
  lastOutputTokens = 0;
  contextWindow = 0;
  private warnedAt70 = false;
  private checkpointedAt80 = false;

  update(inputTokens: number, outputTokens: number, contextWindow?: number): void {
    this.lastInputTokens = inputTokens;
    this.lastOutputTokens = outputTokens;
    if (contextWindow && contextWindow > 0) this.contextWindow = contextWindow;
  }

  getPercentage(): number {
    if (this.contextWindow <= 0) return 0;
    // input_tokens represents the full context sent to the model (system + messages + tools)
    return this.lastInputTokens / this.contextWindow;
  }

  shouldWarn(): boolean {
    if (this.warnedAt70) return false;
    if (this.getPercentage() >= CONTEXT_WARN_THRESHOLD) {
      this.warnedAt70 = true;
      return true;
    }
    return false;
  }

  shouldCheckpoint(): boolean {
    if (this.checkpointedAt80) return false;
    if (this.getPercentage() >= CONTEXT_CHECKPOINT_THRESHOLD) {
      this.checkpointedAt80 = true;
      return true;
    }
    return false;
  }

  reset(): void {
    this.warnedAt70 = false;
    this.checkpointedAt80 = false;
  }
}

export function createContextSafetyHook(
  tracker: ContextWindowTracker,
  activityPoster: { post: (type: ActivityType, content: string, metadata?: unknown) => void } | null,
  log?: (msg: string) => void,
): HookCallback {
  return async (_input, _toolUseId, _context) => {
    const pct = tracker.getPercentage();

    if (tracker.shouldCheckpoint()) {
      const pctStr = Math.round(pct * 100);
      log?.(`[context-safety] CHECKPOINT: Context at ${pctStr}% — advising agent to save progress`);
      activityPoster?.post('status', `Context window at ${pctStr}% — checkpoint recommended`, {
        contextPercentage: pctStr,
        inputTokens: tracker.lastInputTokens,
        contextWindow: tracker.contextWindow,
      });
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          message: `WARNING: Your context window is ${pctStr}% full (${tracker.lastInputTokens.toLocaleString()} / ${tracker.contextWindow.toLocaleString()} tokens). Save your progress now: write important findings to MEMORY.md or files before context compaction occurs. Summarize your current state and next steps.`,
        },
      };
    }

    if (tracker.shouldWarn()) {
      const pctStr = Math.round(pct * 100);
      log?.(`[context-safety] WARNING: Context at ${pctStr}%`);
      activityPoster?.post('status', `Context window at ${pctStr}%`, {
        contextPercentage: pctStr,
        inputTokens: tracker.lastInputTokens,
        contextWindow: tracker.contextWindow,
      });
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          message: `Note: Your context window is ${pctStr}% full. Be concise in your remaining tool calls and consider wrapping up soon.`,
        },
      };
    }

    return {};
  };
}

// ─── Gallery Activity Posting ────────────────────────────

export type ActivityType = 'output' | 'tool_use' | 'thinking' | 'error' | 'status' | 'subtask_started' | 'subtask_completed' | 'subtask_failed' | 'progress';

/**
 * One-shot fire-and-forget Convex activity post. Used by MCP server process
 * which can't share the ActivityPoster queue with the main agent process.
 */
export async function postConvexActivity(
  convexUrl: string,
  token: string,
  agentId: string,
  type: ActivityType,
  content: string,
  metadata?: unknown,
): Promise<void> {
  try {
    await fetch(`${convexUrl}/api/mutation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: 'agentActivity:push',
        args: { token, agentId, type, content: content.slice(0, 4000), metadata },
      }),
    });
  } catch { /* best-effort */ }
}

export class ActivityPoster {
  private static readonly MAX_QUEUE = 100;
  private convexUrl: string | null;
  private token: string | null;
  private agentId: string;
  private queue: { type: ActivityType; content: string; metadata?: unknown }[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private droppedCount = 0;

  constructor(convexUrl: string | null, token: string | null, agentId: string) {
    this.convexUrl = convexUrl;
    this.token = token;
    this.agentId = agentId;

    if (this.convexUrl && this.token) {
      this.timer = setInterval(() => this.flush(), 2000);
    }
  }

  post(type: ActivityType, content: string, metadata?: unknown): void {
    if (!this.convexUrl || !this.token) return;
    this.queue.push({ type, content: content.slice(0, 4000), metadata });
    while (this.queue.length > ActivityPoster.MAX_QUEUE) {
      this.queue.shift();
      this.droppedCount++;
    }
  }

  getQueueSize(): number { return this.queue.length; }
  getDroppedCount(): number { return this.droppedCount; }

  async flush(): Promise<void> {
    if (this.queue.length === 0 || !this.convexUrl || !this.token) return;

    const batch = this.queue.splice(0, 10);
    for (const event of batch) {
      await postConvexActivity(this.convexUrl, this.token, this.agentId, event.type, event.content, event.metadata);
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.queue.length > 0) {
      await this.flush();
    }
  }
}
