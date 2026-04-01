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

// ─── Prompt Injection Scanning ───────────────────────────

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /ignore\s+(all\s+)?above\s+instructions/i,
  /disregard\s+(all\s+)?prior\s+(instructions|context)/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /new\s+instructions?\s*:/i,
  /system\s*:\s*you\s+(are|must|should)/i,
  /<div\s+style\s*=\s*["']display:\s*none/i,
  /curl\s+.*\|\s*sh/i,
  /wget\s+.*\|\s*bash/i,
  /\u200b|\u200c|\u200d|\ufeff/,  // Zero-width characters (invisible text injection)
];

/**
 * Scan text for prompt injection patterns. Returns array of detected patterns.
 * Used to flag untrusted content (WebFetch results, user-uploaded files) before injection.
 */
export function scanForInjection(text: string): string[] {
  const detected: string[] = [];
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      detected.push(pattern.source.slice(0, 60));
    }
  }
  return detected;
}

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

// ─── Haiku API Helper ────────────────────────────────────

/**
 * Call Haiku with a prompt and return the text response.
 * Fire-and-forget safe — returns null on any failure.
 * Uses env vars directly (ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY).
 */
async function callHaikuForSummary(prompt: string, log?: (msg: string) => void): Promise<string | null> {
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!baseUrl || !apiKey) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) return null;

    const data = await response.json() as { content?: Array<{ type: string; text?: string }> };
    return data.content?.[0]?.type === 'text' ? (data.content[0].text?.trim() ?? null) : null;
  } catch (err) {
    log?.(`[haiku-summary] Failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Pre-Compact Hook ────────────────────────────────────

/**
 * Archive the full transcript to conversations/ before compaction.
 * Also writes a structured session summary to the daily memory log.
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

      // Write structured session summary to daily memory log
      const memoryDir = path.join(workspaceDir, 'memory');
      fs.mkdirSync(memoryDir, { recursive: true });
      const dailyFile = path.join(memoryDir, `${date}.md`);
      const timestamp = new Date().toISOString().split('T')[1].replace(/\.\d+Z$/, '');

      // Build structured summary via Haiku (fire-and-forget)
      // Read existing daily summary to build on (iterative compression)
      const existingSummary = fs.existsSync(dailyFile) ? fs.readFileSync(dailyFile, 'utf-8') : '';

      const transcriptSnippet = messages
        .map(m => `${m.role === 'user' ? 'User' : (assistantName || 'Assistant')}: ${m.content.slice(0, 500)}`)
        .join('\n')
        .slice(0, 6000);

      const summaryPrompt = existingSummary.length > 100
        ? `Update this existing session summary with new information from the latest conversation segment.

EXISTING SUMMARY:
${existingSummary.slice(-3000)}

NEW CONVERSATION:
${transcriptSnippet}

Merge the new information into the existing structure. Update sections — don't duplicate. Move completed items from "In Progress" to "Accomplished". Add new decisions and next steps.

Respond with EXACTLY this structure (skip sections that are empty):

## Goal
[Combined goal from all segments]

## Accomplished
[Everything completed across all segments]

## In Progress
[What is still ongoing after this segment]

## Key Decisions
[All important decisions, old and new]

## Next Steps
[Updated next steps after this segment]`
        : `Summarize this conversation in structured format for future reference.

TRANSCRIPT:
${transcriptSnippet}

Respond with EXACTLY this structure (skip sections that are empty):

## Goal
[What was the user trying to accomplish?]

## Accomplished
[What was completed or decided?]

## In Progress
[What is still ongoing or needs follow-up?]

## Key Decisions
[Important decisions made and why]

## Next Steps
[What should happen next, if anything]`;

      const structuredSummary = await callHaikuForSummary(summaryPrompt, log);

      const marker = structuredSummary
        ? `\n## Session Summary (${timestamp})\n\nArchived: \`conversations/${filename}\`${summary ? `\nSession: ${summary}` : ''}\n\n${structuredSummary}\n`
        : `\n## Context compacted at ${timestamp}\n\nConversation archived to \`conversations/${filename}\`${summary ? `\nSummary: ${summary}` : ''}\n`;

      fs.appendFileSync(dailyFile, marker);
      log?.(`Wrote ${structuredSummary ? 'structured summary' : 'compaction marker'} to memory/${date}.md`);
    } catch (err) {
      log?.(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

// ─── Bash Secret Sanitization ────────────────────────────

export const SECRET_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'GITHUB_TOKEN',
  'GITHUB_PAT',
  'SLACK_BOT_TOKEN',
  'STRIPE_SECRET_KEY',
  'SENDGRID_API_KEY',
  'HUGGINGFACE_TOKEN',
  'DATABASE_URL',
  'POSTGRES_URL',
  'MYSQL_URL',
  'REDIS_URL',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_ACCESS_KEY_ID',
  'GOOGLE_API_KEY',
  'REPLICATE_API_TOKEN',
  'GALLERY_GATEWAY_TOKEN',
  'GALLERY_TOKEN',
];

/**
 * Redact hardcoded API keys and secrets from shell command strings.
 * Catches tokens that were inlined rather than stored in env vars.
 */
export function redactSecretsFromCommand(command: string): string {
  return command
    .replace(/\b(sk-[A-Za-z0-9]{20,})/g, 'sk-***REDACTED***')
    .replace(/\b(ghp_[A-Za-z0-9]{36,})/g, 'ghp_***REDACTED***')
    .replace(/\b(github_pat_[A-Za-z0-9_]{82,})/g, 'github_pat_***REDACTED***')
    .replace(/\b(xox[bpoa]-[A-Za-z0-9-]+)/g, 'xox***REDACTED***')
    .replace(/\b(AIza[A-Za-z0-9_-]{35})/g, 'AIza***REDACTED***')
    .replace(/\b(AKIA[A-Z0-9]{16})/g, 'AKIA***REDACTED***')
    .replace(/\b(sk_live_[A-Za-z0-9]{24,})/g, 'sk_live_***REDACTED***')
    .replace(/\b(r8_[A-Za-z0-9]{37})/g, 'r8_***REDACTED***')
    .replace(/\b(gho_[A-Za-z0-9]{36,})/g, 'gho_***REDACTED***')
    .replace(/\b(ghs_[A-Za-z0-9]{36,})/g, 'ghs_***REDACTED***')
    .replace(/\b(ghr_[A-Za-z0-9]{36,})/g, 'ghr_***REDACTED***')
    .replace(/\b(xoxe-[A-Za-z0-9-]+)/g, 'xoxe-***REDACTED***')
    .replace(/\b(whsec_[A-Za-z0-9]{32,})/g, 'whsec_***REDACTED***')
    .replace(/\b(SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})/g, 'SG.***REDACTED***')
    .replace(/\b(ABIA[A-Z0-9]{16})/g, 'ABIA***REDACTED***')
    .replace(/\b(ASIA[A-Z0-9]{16})/g, 'ASIA***REDACTED***')
    .replace(/(password|secret|token|key|apikey)=["']?[A-Za-z0-9_\-\.]{8,}["']?/gi, '$1=***REDACTED***')
    .replace(/Authorization:\s*Bearer\s+[A-Za-z0-9_\-\.]+/gi, 'Authorization: Bearer ***REDACTED***')
    .replace(/-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g, '***PRIVATE_KEY_REDACTED***')
    .replace(/\b(postgres|mysql|mongodb|redis|amqp)(:\/\/)[^\s"']+/gi, '$1$2***REDACTED***');
}

export function createSanitizeBashHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command) return {};

    const redacted = redactSecretsFromCommand(command);
    const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
    // Block /proc/self/environ access to prevent leaking unset env vars from parent process
    const procGuard = `chmod 000 /proc/self/environ 2>/dev/null; `;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...(preInput.tool_input as Record<string, unknown>),
          command: procGuard + unsetPrefix + redacted,
        },
      },
    };
  };
}

// ─── Output Secret Redaction ────────────────────────────

/**
 * Redact secrets from tool output (stdout/stderr). Applied to tool_result
 * content before streaming to the user. Extends command redaction with
 * patterns specific to output formats (JSON, base64, environment dumps).
 */
export function redactSecretsFromOutput(text: string): string {
  let redacted = redactSecretsFromCommand(text);

  // JSON key-value patterns: "api_key": "sk-...", "secret": "...", "token": "..."
  redacted = redacted.replace(
    /("(?:api[_-]?key|secret|token|password|credential|auth)[^"]*"\s*:\s*")([^"]{8,})"/gi,
    '$1***REDACTED***"',
  );

  // Base64-encoded secrets (40+ chars of base64, likely a key/token)
  redacted = redacted.replace(
    /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
    (match) => {
      // Only redact if it looks like a secret (high entropy, not a known safe pattern like UUIDs)
      if (/^[0-9a-f-]+$/i.test(match)) return match; // UUID-like, keep
      if (match.length > 60) return '***BASE64_REDACTED***';
      return match;
    },
  );

  // Environment dump patterns: KEY=value from /proc/self/environ or env output
  redacted = redacted.replace(
    /\b(ANTHROPIC_API_KEY|GALLERY_GATEWAY_TOKEN|GALLERY_TOKEN|AWS_SECRET_ACCESS_KEY|OPENAI_API_KEY|STRIPE_SECRET_KEY|DATABASE_URL|GITHUB_TOKEN)=([^\s\0]+)/gi,
    '$1=***REDACTED***',
  );

  return redacted;
}

// ─── Context Usage File ─────────────────────────────────

const CONTEXT_USAGE_FILE = '.context-usage.json';

/**
 * Write context usage stats to a well-known file so the MCP process can read them.
 * Called from the context safety hook and after each assistant message.
 */
export function writeContextUsage(workspaceDir: string, tracker: ContextWindowTracker): void {
  try {
    const data = {
      percentage: Math.round(tracker.getPercentage() * 100),
      inputTokens: tracker.lastInputTokens,
      outputTokens: tracker.lastOutputTokens,
      cacheReadTokens: tracker.lastCacheReadTokens,
      cacheCreationTokens: tracker.lastCacheCreationTokens,
      contextWindow: tracker.contextWindow,
      updatedAt: Date.now(),
    };
    fs.writeFileSync(path.join(workspaceDir, CONTEXT_USAGE_FILE), JSON.stringify(data));
  } catch { /* non-fatal */ }
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
  lastCacheReadTokens = 0;
  lastCacheCreationTokens = 0;
  contextWindow = 0;
  private warnedAt70 = false;
  private checkpointedAt80 = false;

  update(inputTokens: number, outputTokens: number, contextWindow?: number, cacheReadTokens?: number, cacheCreationTokens?: number): void {
    this.lastInputTokens = inputTokens;
    this.lastOutputTokens = outputTokens;
    if (contextWindow && contextWindow > 0) this.contextWindow = contextWindow;
    if (cacheReadTokens !== undefined) this.lastCacheReadTokens = cacheReadTokens;
    if (cacheCreationTokens !== undefined) this.lastCacheCreationTokens = cacheCreationTokens;

    // Auto-reset warning flags when usage drops below thresholds (e.g., after compaction)
    const pct = this.getPercentage();
    if (pct < CONTEXT_WARN_THRESHOLD && this.warnedAt70) this.warnedAt70 = false;
    if (pct < CONTEXT_CHECKPOINT_THRESHOLD && this.checkpointedAt80) this.checkpointedAt80 = false;
  }

  getPercentage(): number {
    if (this.contextWindow <= 0) return 0;
    // Cache read tokens represent context that exists in the window but wasn't re-sent
    const effectiveTokens = this.lastInputTokens + this.lastCacheReadTokens;
    return effectiveTokens / this.contextWindow;
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
  workspaceDir?: string,
): HookCallback {
  return async (_input, _toolUseId, _context) => {
    // Write context usage to file for MCP tools to read
    if (workspaceDir) writeContextUsage(workspaceDir, tracker);

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
  taskId?: string,
): Promise<void> {
  try {
    await fetch(`${convexUrl}/api/mutation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: 'agentActivity:push',
        args: { token, agentId, taskId, type, content: content.slice(0, 4000), metadata },
      }),
    });
  } catch { /* best-effort */ }
}

export class ActivityPoster {
  private static readonly MAX_QUEUE = 500;
  private convexUrl: string | null;
  private token: string | null;
  private agentId: string;
  private queue: { type: ActivityType; content: string; metadata?: unknown; taskId?: string }[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private droppedCount = 0;
  private flushing = false;
  private currentTaskId: string | undefined;

  constructor(convexUrl: string | null, token: string | null, agentId: string) {
    this.convexUrl = convexUrl;
    this.token = token;
    this.agentId = agentId;

    if (this.convexUrl && this.token) {
      this.timer = setInterval(() => this.flush(), 2000);
    }
  }

  setTaskId(taskId: string | undefined): void {
    this.currentTaskId = taskId;
  }

  post(type: ActivityType, content: string, metadata?: unknown): void {
    if (!this.convexUrl || !this.token) return;
    this.queue.push({ type, content: content.slice(0, 4000), metadata, taskId: this.currentTaskId });
    while (this.queue.length > ActivityPoster.MAX_QUEUE) {
      this.queue.shift();
      this.droppedCount++;
    }
  }

  getQueueSize(): number { return this.queue.length; }
  getDroppedCount(): number { return this.droppedCount; }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0 || !this.convexUrl || !this.token) return;
    this.flushing = true;
    try {
      const batch = this.queue.splice(0, 25);
      const results = await Promise.allSettled(
        batch.map((event) =>
          Promise.race([
            postConvexActivity(this.convexUrl, this.token, this.agentId, event.type, event.content, event.metadata, event.taskId),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Activity post timeout')), 10_000)),
          ])
        ),
      );
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) {
        console.error(`[activity-poster] ${failed}/${batch.length} events failed to post`);
      }
    } finally {
      this.flushing = false;
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Flush remaining with a hard deadline to avoid blocking shutdown
    const deadline = Date.now() + 15_000;
    while (this.queue.length > 0 && Date.now() < deadline) {
      await this.flush();
    }
    if (this.queue.length > 0) {
      console.error(`[activity-poster] Shutdown: dropped ${this.queue.length} events (deadline exceeded)`);
    }
  }
}
