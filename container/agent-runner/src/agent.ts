/**
 * Claw Agent — V2 Session-based query logic for Sprites
 *
 * Uses persistent V2 sessions (send/stream) instead of spawning a new CLI
 * subprocess per message via query(). This eliminates ~10-15s of subprocess
 * spawn + session replay overhead, reducing response time from 14-20s to 2-5s.
 *
 * Required environment variables (set during sprite provisioning):
 *   ANTHROPIC_BASE_URL     — Gallery AI proxy URL (e.g., https://gallery.dev/api/ai)
 *   ANTHROPIC_API_KEY      — Workspace gateway token (= GALLERY_GATEWAY_TOKEN)
 *   GALLERY_GATEWAY_TOKEN  — Auth token for Gallery API (activity posting, auth)
 *   GALLERY_CONVEX_URL     — Convex deployment URL (activity posting)
 *   GALLERY_TOKEN          — Gallery auth token
 *   GALLERY_API_URL        — Gallery API base URL (for gallery CLI tools)
 *   AGENT_ID               — This agent's Convex document ID
 *
 * Note: Claude API calls go through Gallery's AI proxy (/api/ai) for billing.
 * No direct Anthropic API key needed — ANTHROPIC_API_KEY is the gateway token.
 */

import fs from 'fs';
import path from 'path';
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
} from '@anthropic-ai/claude-agent-sdk';
import type { SDKSession, SDKSessionOptions } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import {
  ToolCallTracker,
  ActivityPoster,
  ContextWindowTracker,
  createPreCompactHook,
  createSanitizeBashHook,
  createLoopDetectionHook,
  createContextSafetyHook,
} from './shared.js';

// ─── Configuration ──────────────────────────────────────

const WORKSPACE_DIR = process.env.CLAW_WORKSPACE_DIR || '/home/sprite/workspace';
const SESSION_ID_FILE = path.join(WORKSPACE_DIR, '.current-session-id');
const MCP_CONFIG_FILE = path.join(WORKSPACE_DIR, '.mcp.json');
const MODEL = process.env.CLAW_MODEL || 'claude-opus-4-6';

function log(message: string): void {
  console.error(`[claw] ${message}`);
}

/** Default context window sizes by model family. */
function getDefaultContextWindow(model: string): number {
  const m = model.toLowerCase();
  if (m.includes('opus-4-6') || m.includes('opus-4.6') || m.includes('sonnet-4-6') || m.includes('sonnet-4.6')) return 1_000_000;
  if (m.includes('claude') || m.startsWith('anthropic/')) return 200_000;
  if (m.includes('gpt-5')) return 256_000;
  if (m.includes('gpt-4')) return 128_000;
  if (m.includes('gemini-3') || m.includes('gemini-2.5')) return 1_000_000;
  if (m.includes('deepseek')) return 128_000;
  return 128_000;
}

// ─── Session Persistence ─────────────────────────────────

function getPersistedSessionId(): string | undefined {
  try {
    if (fs.existsSync(SESSION_ID_FILE)) {
      return fs.readFileSync(SESSION_ID_FILE, 'utf-8').trim() || undefined;
    }
  } catch { /* ignore */ }
  return undefined;
}

function persistSessionId(sessionId: string): void {
  try {
    fs.mkdirSync(path.dirname(SESSION_ID_FILE), { recursive: true });
    fs.writeFileSync(SESSION_ID_FILE, sessionId);
  } catch { /* non-fatal */ }
}

/**
 * Read .mcp.json to get customer MCP server names for allowedTools patterns.
 * The SDK auto-loads .mcp.json from cwd for server configuration;
 * we just need the names to add mcp__<name>__* to allowedTools.
 */
function getDynamicMcpToolPatterns(): string[] {
  try {
    if (!fs.existsSync(MCP_CONFIG_FILE)) return [];
    const config = JSON.parse(fs.readFileSync(MCP_CONFIG_FILE, 'utf-8'));
    const servers = config.mcpServers || {};
    const names = Object.keys(servers);
    if (names.length > 0) {
      log(`[mcp] Found ${names.length} customer MCP servers: ${names.join(', ')}`);
    }
    return names.map(name => `mcp__${name}__*`);
  } catch { return []; }
}

// ─── Public Interfaces ───────────────────────────────────

export interface MessageParams {
  message: string;
  sessionId?: string;
  isScheduledTask?: boolean;
  assistantName?: string;
}

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCostUsd: number;
  numTurns: number;
  durationMs: number;
  contextWindow: number;
  contextPercentage: number;
}

export interface MessageResult {
  status: 'success' | 'error';
  result: string | null;
  sessionId: string;
  error?: string;
  usage?: UsageInfo;
}

/** SSE event emitted during streaming. */
export interface StreamEvent {
  type: 'text' | 'tool_call_start' | 'tool_call_end' | 'thinking' | 'progress' | 'context_usage' | 'done';
  data: Record<string, unknown>;
}

// ─── Persistent State ────────────────────────────────────
// These survive across HTTP requests (sprite stays alive between requests).
// On sleep/wake the process restarts — session resumes from disk via sessionId.

let session: SDKSession | null = null;
let activityPoster: ActivityPoster | null = null;
const loopTracker = new ToolCallTracker();
const contextTracker = new ContextWindowTracker();
contextTracker.contextWindow = getDefaultContextWindow(MODEL);

// Serialize access to the V2 session (one send/stream cycle at a time)
let messageLock: Promise<void> = Promise.resolve();

// ─── Session Lifecycle ───────────────────────────────────

function ensureActivityPoster(agentId: string): ActivityPoster {
  if (!activityPoster) {
    activityPoster = new ActivityPoster(
      process.env.GALLERY_CONVEX_URL || null,
      process.env.GALLERY_GATEWAY_TOKEN || process.env.GALLERY_TOKEN || null,
      agentId,
    );
    log('[activity] Gallery activity posting enabled');
  }
  return activityPoster;
}

function buildSessionOptions(assistantName?: string): SDKSessionOptions {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return {
    model: MODEL,
    pathToClaudeCodeExecutable: path.join(__dirname, 'cli.js'),
    env: { ...process.env },
    allowedTools: [
      'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
      'WebSearch', 'WebFetch',
      'Task', 'TaskOutput', 'TaskStop',
      'NotebookEdit',
      ...getDynamicMcpToolPatterns(),
    ],
    permissionMode: 'acceptEdits',
    hooks: {
      PreCompact: [{ hooks: [createPreCompactHook(WORKSPACE_DIR, assistantName, log)] }],
      PreToolUse: [
        { matcher: 'Bash', hooks: [createSanitizeBashHook()] },
        { hooks: [createLoopDetectionHook(loopTracker, log)] },
        { hooks: [createContextSafetyHook(contextTracker, activityPoster, log)] },
      ],
    },
  };
}

function getOrCreateSession(assistantName?: string): SDKSession {
  if (session) return session;

  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const persistedId = getPersistedSessionId();
  const options = buildSessionOptions(assistantName);

  if (persistedId) {
    log(`Resuming V2 session: ${persistedId}`);
    session = unstable_v2_resumeSession(persistedId, options);
  } else {
    log('Creating new V2 session');
    session = unstable_v2_createSession(options);
  }

  return session;
}

// ─── Core Message Processing ─────────────────────────────

export async function processMessage(params: MessageParams, onEvent?: (event: StreamEvent) => void): Promise<MessageResult> {
  // Serialize access — V2 session handles one send/stream cycle at a time
  const prevLock = messageLock;
  let releaseLock!: () => void;
  messageLock = new Promise(resolve => { releaseLock = resolve; });
  await prevLock;

  try {
    return await processMessageInner(params, onEvent);
  } finally {
    releaseLock();
  }
}

async function processMessageInner(params: MessageParams, onEvent?: (event: StreamEvent) => void): Promise<MessageResult> {
  const { message, isScheduledTask, assistantName } = params;

  // Initialize activity poster before session creation (hooks reference it)
  const agentId = process.env.AGENT_ID || assistantName || 'unknown';
  ensureActivityPoster(agentId);
  activityPoster!.post('status', 'Processing message');

  // Build prompt with timezone context
  const tz = process.env.AGENT_TIMEZONE || 'UTC';
  const localTime = new Date().toLocaleString('en-US', {
    timeZone: tz,
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
  let prompt = `<context timezone="${tz}" localTime="${localTime}" />\n\n`;
  if (isScheduledTask) {
    prompt += `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user.]\n\n`;
  }
  prompt += message;

  let currentSessionId = getPersistedSessionId() || '';
  const resultTexts: string[] = [];
  let messageCount = 0;
  let usageInfo: UsageInfo | undefined;

  try {
    const sess = getOrCreateSession(assistantName);
    await sess.send(prompt);

    for await (const msg of sess.stream()) {
      messageCount++;
      const msgType = msg.type === 'system' ? `system/${(msg as { subtype?: string }).subtype}` : msg.type;
      log(`[msg #${messageCount}] type=${msgType}`);

      // ─── Assistant messages ───────────────────────
      if (msg.type === 'assistant') {
        const msgUsage = (msg as any).message?.usage;
        if (msgUsage) {
          contextTracker.update(
            msgUsage.input_tokens ?? 0,
            msgUsage.output_tokens ?? 0,
          );
        }

        const content = (msg as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              activityPoster!.post('output', block.text);
              onEvent?.({ type: 'text', data: { content: block.text } });
            } else if (block.type === 'tool_use') {
              activityPoster!.post('tool_use', `${block.name}(${JSON.stringify(block.input).slice(0, 200)})`);
              onEvent?.({ type: 'tool_call_start', data: { id: block.id, name: block.name, input: block.input } });
            } else if (block.type === 'tool_result') {
              onEvent?.({ type: 'tool_call_end', data: { id: block.tool_use_id, status: block.is_error ? 'error' : 'completed', result: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) } });
            } else if (block.type === 'thinking' && block.thinking) {
              activityPoster!.post('thinking', block.thinking.slice(0, 500));
              onEvent?.({ type: 'thinking', data: { content: block.thinking } });
            }
          }
        }
      }

      // ─── System messages ──────────────────────────
      if (msg.type === 'system' && msg.subtype === 'init') {
        currentSessionId = msg.session_id;
        log(`Session initialized: ${currentSessionId}`);
        activityPoster!.post('status', `Session initialized: ${currentSessionId}`);
        persistSessionId(currentSessionId);
      }

      if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'task_notification') {
        const tn = msg as { task_id: string; status: string; summary: string };
        log(`Task notification: task=${tn.task_id} status=${tn.status}`);
        activityPoster!.post('status', `Task ${tn.status}: ${tn.summary}`);
      }

      // ─── Result message ───────────────────────────
      if (msg.type === 'result') {
        const textResult = 'result' in msg ? (msg as { result?: string }).result : null;
        log(`Result #${resultTexts.length + 1}: ${textResult ? textResult.slice(0, 200) : '(no text)'}`);
        activityPoster!.post('output', textResult ? textResult.slice(0, 500) : 'Query completed');
        if (textResult) resultTexts.push(textResult);

        // Extract usage data from the result message
        const resultMsg = msg as {
          usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
          modelUsage?: Record<string, { inputTokens: number; outputTokens: number; contextWindow: number; costUSD: number }>;
          total_cost_usd?: number;
          num_turns?: number;
          duration_ms?: number;
        };

        if (resultMsg.usage || resultMsg.modelUsage) {
          const modelEntries = resultMsg.modelUsage ? Object.values(resultMsg.modelUsage) : [];
          const contextWindow = modelEntries[0]?.contextWindow ?? contextTracker.contextWindow;
          if (contextWindow > 0) contextTracker.contextWindow = contextWindow;
          const inputTokens = resultMsg.usage?.input_tokens ?? 0;
          const outputTokens = resultMsg.usage?.output_tokens ?? 0;
          const contextPercentage = contextWindow > 0
            ? Math.round((inputTokens + outputTokens) / contextWindow * 100)
            : 0;

          usageInfo = {
            inputTokens,
            outputTokens,
            cacheReadTokens: resultMsg.usage?.cache_read_input_tokens ?? 0,
            cacheCreationTokens: resultMsg.usage?.cache_creation_input_tokens ?? 0,
            totalCostUsd: resultMsg.total_cost_usd ?? 0,
            numTurns: resultMsg.num_turns ?? 0,
            durationMs: resultMsg.duration_ms ?? 0,
            contextWindow,
            contextPercentage,
          };

          log(`[usage] ${inputTokens} in / ${outputTokens} out | context: ${contextPercentage}% of ${contextWindow}`);
          activityPoster!.post('status', `Context: ${contextPercentage}% used (${inputTokens} in / ${outputTokens} out)`, { usage: usageInfo });
          onEvent?.({ type: 'context_usage', data: { promptTokens: inputTokens, completionTokens: outputTokens, model: MODEL, contextWindow, contextPercentage } });
        }

        onEvent?.({ type: 'done', data: { result: textResult ?? '', sessionId: currentSessionId } });
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    activityPoster!.post('error', errorMessage);

    // Session may have crashed — close and null it for recovery on next message
    if (session) {
      try { session.close(); } catch { /* ignore close errors */ }
      session = null;
      log('Session closed due to error — will recreate on next message');
    }

    return {
      status: 'error',
      result: null,
      sessionId: currentSessionId,
      error: errorMessage,
    };
  }

  // Capture sessionId from session object if we missed system/init
  if (!currentSessionId && session) {
    try {
      currentSessionId = session.sessionId;
      persistSessionId(currentSessionId);
    } catch { /* sessionId may not be available yet */ }
  }

  const resultText = resultTexts.length > 0 ? resultTexts.join('\n\n') : null;
  log(`Query done. Messages: ${messageCount}, results: ${resultTexts.length}, sessionId: ${currentSessionId}`);
  activityPoster!.post('status', 'Message processed');

  // Fire-and-forget memory extraction — don't block the response
  if (resultText && process.env.CLAW_AUTO_MEMORY !== 'false') {
    extractMemory(message, resultText).catch(() => {});
  }

  return {
    status: 'success',
    result: resultText,
    sessionId: currentSessionId,
    usage: usageInfo,
  };
}

// ─── Automatic Memory Extraction ────────────────────────

/**
 * Post-conversation memory extraction. Sends a summary of the conversation
 * to a cheap/fast model and appends extracted facts to MEMORY.md.
 * Runs fire-and-forget — never blocks the response.
 */
async function extractMemory(userMessage: string, assistantResult: string): Promise<void> {
  const memoryFile = path.join(WORKSPACE_DIR, 'MEMORY.md');
  const existing = fs.existsSync(memoryFile) ? fs.readFileSync(memoryFile, 'utf-8') : '';

  // Skip trivial interactions
  if (userMessage.length < 20 && assistantResult.length < 100) return;

  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!baseUrl || !apiKey) return;

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
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: `Extract key facts, decisions, or preferences from this conversation that would be useful to remember in future sessions. Only extract genuinely important information — skip routine/trivial exchanges.

EXISTING MEMORY (do NOT repeat what's already here):
${existing.slice(0, 2000)}

CONVERSATION:
User: ${userMessage.slice(0, 3000)}
Assistant: ${assistantResult.slice(0, 3000)}

Respond with ONLY the new facts to append (as bullet points), or "NONE" if nothing worth remembering. Do not include headers or timestamps — just bullet points.`,
        }],
      }),
    });

    if (!response.ok) {
      log(`[memory] API returned ${response.status}`);
      return;
    }

    const data = await response.json() as { content?: Array<{ type: string; text?: string }> };
    const text = data.content?.[0]?.type === 'text' ? data.content[0].text?.trim() : '';
    if (!text || text === 'NONE' || text.length < 5) return;

    // Append under today's date section (reuse existing header if present)
    const date = new Date().toISOString().split('T')[0];
    const header = `## Auto-extracted (${date})`;
    if (existing.includes(header)) {
      fs.appendFileSync(memoryFile, `\n${text}\n`);
    } else {
      fs.appendFileSync(memoryFile, `\n\n${header}\n${text}\n`);
    }
    log(`[memory] Extracted ${text.split('\n').length} facts to MEMORY.md`);
  } catch (err) {
    log(`[memory] Extraction failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Lifecycle Exports ──────────────────────────────────

/**
 * Flush pending activity events and close session. Call on SIGTERM before exit.
 */
export async function shutdown(): Promise<void> {
  if (session) {
    try { session.close(); } catch { /* ignore */ }
    session = null;
  }
  if (activityPoster) {
    activityPoster.post('status', 'Sprite shutting down');
    await activityPoster.stop();
  }
}

/**
 * Activity poster metrics for health endpoint.
 */
export function getActivityMetrics(): { activityQueueSize: number; activityDropped: number } {
  return {
    activityQueueSize: activityPoster?.getQueueSize() ?? 0,
    activityDropped: activityPoster?.getDroppedCount() ?? 0,
  };
}

/**
 * Get current agent status.
 */
export function getStatus(): {
  sessionId: string | undefined;
  workspaceDir: string;
  memoryFiles: string[];
  uptime: number;
} {
  const sessionId = getPersistedSessionId();
  const memoryFiles: string[] = [];

  const memoryDir = path.join(WORKSPACE_DIR, 'memory');
  if (fs.existsSync(path.join(WORKSPACE_DIR, 'MEMORY.md'))) {
    memoryFiles.push('MEMORY.md');
  }
  if (fs.existsSync(memoryDir)) {
    try {
      const files = fs.readdirSync(memoryDir).filter(f => !f.startsWith('.'));
      memoryFiles.push(...files.map(f => `memory/${f}`));
    } catch { /* ignore */ }
  }

  return {
    sessionId,
    workspaceDir: WORKSPACE_DIR,
    memoryFiles,
    uptime: process.uptime(),
  };
}
