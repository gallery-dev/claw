/**
 * Claw Agent — Core query logic for Sprites
 * Extracted from index.ts, adapted for HTTP service model.
 *
 * Differences from Docker (index.ts):
 * - No stdin/stdout protocol — called directly via processMessage()
 * - No IPC file polling — each HTTP request is one message
 * - Secrets from process.env, not stdin
 * - Working directory: /home/sprite/workspace (not /workspace/group)
 *
 * Required environment variables (set during sprite provisioning):
 *   ANTHROPIC_BASE_URL     — Gallery AI proxy URL (e.g., https://gallery.dev/api/ai)
 *   ANTHROPIC_API_KEY      — Workspace gateway token (= GALLERY_GATEWAY_TOKEN)
 *   GALLERY_GATEWAY_TOKEN  — Auth token for Gallery API (activity posting, auth)
 *   GALLERY_CONVEX_URL     — Convex deployment URL (activity posting)
 *   GALLERY_MCP_URL        — Gallery MCP server URL
 *   GALLERY_TOKEN          — Gallery MCP auth token
 *   GALLERY_API_URL        — Gallery API base URL (for claw MCP tools)
 *   AGENT_ID               — This agent's Convex document ID
 *
 * Note: Claude API calls go through Gallery's AI proxy (/api/ai) for billing.
 * No direct Anthropic API key needed — ANTHROPIC_API_KEY is the gateway token.
 */

import fs from 'fs';
import path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import {
  ToolCallTracker,
  ActivityPoster,
  createPreCompactHook,
  createSanitizeBashHook,
  createLoopDetectionHook,
} from './shared.js';

// ─── Configuration ──────────────────────────────────────

const WORKSPACE_DIR = process.env.CLAW_WORKSPACE_DIR || '/home/sprite/workspace';
const SESSION_ID_FILE = path.join(WORKSPACE_DIR, '.current-session-id');
const RESUME_AT_FILE = path.join(WORKSPACE_DIR, '.resume-at');

function log(message: string): void {
  console.error(`[claw] ${message}`);
}

// ─── Session Management ──────────────────────────────────

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

function getPersistedResumeAt(): string | undefined {
  try {
    if (fs.existsSync(RESUME_AT_FILE)) {
      return fs.readFileSync(RESUME_AT_FILE, 'utf-8').trim() || undefined;
    }
  } catch { /* ignore */ }
  return undefined;
}

function persistResumeAt(resumeAt: string): void {
  try {
    fs.writeFileSync(RESUME_AT_FILE, resumeAt);
  } catch { /* non-fatal */ }
}

// ─── Core Query Execution ────────────────────────────────

export interface MessageParams {
  message: string;
  sessionId?: string;
  isScheduledTask?: boolean;
  assistantName?: string;
}

export interface MessageResult {
  status: 'success' | 'error';
  result: string | null;
  sessionId: string;
  error?: string;
}

// Persistent state across requests (sprite stays alive between requests)
// On sleep/wake, the process restarts — read from disk to survive hibernation
let activityPoster: ActivityPoster | null = null;
let lastResumeAt: string | undefined = getPersistedResumeAt();

export async function processMessage(params: MessageParams): Promise<MessageResult> {
  const { message, isScheduledTask, assistantName } = params;

  // Use provided sessionId, or fall back to persisted one
  let sessionId = params.sessionId || getPersistedSessionId();

  // Initialize activity poster on first call
  const agentId = process.env.AGENT_ID || assistantName || 'unknown';
  if (!activityPoster) {
    activityPoster = new ActivityPoster(
      process.env.GALLERY_CONVEX_URL || null,
      process.env.GALLERY_GATEWAY_TOKEN || process.env.GALLERY_TOKEN || null,
      agentId,
    );
    log('[activity] Gallery activity posting enabled');
  }
  activityPoster.post('status', 'Processing message');

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  // Try bundled file first, fall back to tsc output
  const mcpBundlePath = path.join(__dirname, 'mcp-tools.bundle.js');
  const mcpTscPath = path.join(__dirname, 'mcp-tools.js');
  const mcpToolsPath = fs.existsSync(mcpBundlePath) ? mcpBundlePath : mcpTscPath;

  // Ensure workspace exists
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

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

  // Build SDK env from process.env
  const sdkEnv: Record<string, string | undefined> = { ...process.env };

  const loopTracker = new ToolCallTracker();
  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  const resultTexts: string[] = [];
  let messageCount = 0;

  try {
    for await (const msg of query({
      prompt,
      options: {
        cwd: WORKSPACE_DIR,
        model: process.env.CLAW_MODEL || 'claude-opus-4-6',
        thinking: { type: 'adaptive' as const },
        effort: (process.env.CLAW_EFFORT || 'high') as 'low' | 'medium' | 'high' | 'max',
        maxTurns: parseInt(process.env.CLAW_MAX_TURNS || '50', 10),
        resume: sessionId,
        resumeSessionAt: lastResumeAt,
        allowedTools: [
          'Bash',
          'Read', 'Write', 'Edit', 'Glob', 'Grep',
          'WebSearch', 'WebFetch',
          'Task', 'TaskOutput', 'TaskStop',
          'TeamCreate', 'TeamDelete', 'SendMessage',
          'TodoWrite', 'ToolSearch', 'Skill',
          'NotebookEdit',
          'mcp__claw__*',
          'mcp__gallery__*',
        ],
        env: sdkEnv,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        mcpServers: {
          claw: {
            command: 'node',
            args: [mcpToolsPath],
            env: {
              GALLERY_API_URL: process.env.GALLERY_API_URL || '',
              GALLERY_TOKEN: process.env.GALLERY_TOKEN || '',
              AGENT_ID: process.env.AGENT_ID || '',
              ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || '',
              ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
              CLAW_WORKSPACE_DIR: process.env.CLAW_WORKSPACE_DIR || '/home/sprite/workspace',
              GALLERY_CONVEX_URL: process.env.GALLERY_CONVEX_URL || '',
              GALLERY_GATEWAY_TOKEN: process.env.GALLERY_GATEWAY_TOKEN || process.env.GALLERY_TOKEN || '',
            },
          },
          ...(process.env.GALLERY_MCP_URL && process.env.GALLERY_TOKEN ? {
            gallery: {
              type: 'http' as const,
              url: process.env.GALLERY_MCP_URL,
              headers: { Authorization: `Bearer ${process.env.GALLERY_TOKEN}` },
            },
          } : {}),
        },
        hooks: {
          PreCompact: [{ hooks: [createPreCompactHook(WORKSPACE_DIR, assistantName, log)] }],
          PreToolUse: [
            { matcher: 'Bash', hooks: [createSanitizeBashHook()] },
            { hooks: [createLoopDetectionHook(loopTracker, log)] },
          ],
        },
      }
    })) {
      messageCount++;
      const msgType = msg.type === 'system' ? `system/${(msg as { subtype?: string }).subtype}` : msg.type;
      log(`[msg #${messageCount}] type=${msgType}`);

      if (msg.type === 'assistant' && 'uuid' in msg) {
        lastAssistantUuid = (msg as { uuid: string }).uuid;
        // Persist resume point immediately — if sprite crashes mid-query,
        // next request resumes from this point instead of starting over
        lastResumeAt = lastAssistantUuid;
        persistResumeAt(lastAssistantUuid);
        const content = (msg as any).message?.content;
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

      if (msg.type === 'system' && msg.subtype === 'init') {
        newSessionId = msg.session_id;
        log(`Session initialized: ${newSessionId}`);
        activityPoster.post('status', `Session initialized: ${newSessionId}`);
        persistSessionId(newSessionId);
      }

      if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'task_notification') {
        const tn = msg as { task_id: string; status: string; summary: string };
        log(`Task notification: task=${tn.task_id} status=${tn.status}`);
        activityPoster.post('status', `Task ${tn.status}: ${tn.summary}`);
      }

      if (msg.type === 'result') {
        const textResult = 'result' in msg ? (msg as { result?: string }).result : null;
        log(`Result #${resultTexts.length + 1}: ${textResult ? textResult.slice(0, 200) : '(no text)'}`);
        activityPoster.post('output', textResult ? textResult.slice(0, 500) : 'Query completed');
        if (textResult) resultTexts.push(textResult);
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    activityPoster.post('error', errorMessage);
    return {
      status: 'error',
      result: null,
      sessionId: sessionId || '',
      error: errorMessage,
    };
  }

  const finalSessionId = newSessionId || sessionId || '';
  const resultText = resultTexts.length > 0 ? resultTexts.join('\n\n') : null;
  log(`Query done. Messages: ${messageCount}, results: ${resultTexts.length}, sessionId: ${finalSessionId}`);
  activityPoster.post('status', 'Message processed');

  // Fire-and-forget memory extraction — don't block the response
  if (resultText && process.env.CLAW_AUTO_MEMORY !== 'false') {
    extractMemory(message, resultText).catch(() => {});
  }

  return {
    status: 'success',
    result: resultText,
    sessionId: finalSessionId,
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
        model: 'claude-haiku-4-5-20251001',
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

    // Append with timestamp
    const date = new Date().toISOString().split('T')[0];
    const entry = `\n\n## Auto-extracted (${date})\n${text}\n`;
    fs.appendFileSync(memoryFile, entry);
    log(`[memory] Extracted ${text.split('\n').length} facts to MEMORY.md`);
  } catch (err) {
    log(`[memory] Extraction failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Flush pending activity events. Call on SIGTERM before exit.
 */
export async function shutdown(): Promise<void> {
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
