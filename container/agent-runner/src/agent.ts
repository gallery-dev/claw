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
  ContextWindowTracker,
  createPreCompactHook,
  createSanitizeBashHook,
  createLoopDetectionHook,
  createContextSafetyHook,
} from './shared.js';

// ─── Configuration ──────────────────────────────────────

const WORKSPACE_DIR = process.env.CLAW_WORKSPACE_DIR || '/home/sprite/workspace';
const SESSION_ID_FILE = path.join(WORKSPACE_DIR, '.current-session-id');
const RESUME_AT_FILE = path.join(WORKSPACE_DIR, '.resume-at');

function log(message: string): void {
  console.error(`[claw] ${message}`);
}

/** Default context window sizes by model family. Refined at runtime from modelUsage. */
function getDefaultContextWindow(model: string): number {
  const m = model.toLowerCase();
  // Anthropic — Opus 4.6 and Sonnet 4.6 have 1M context (GA), older models 200k
  if (m.includes('opus-4-6') || m.includes('opus-4.6') || m.includes('sonnet-4-6') || m.includes('sonnet-4.6')) return 1_000_000;
  if (m.includes('claude') || m.startsWith('anthropic/')) return 200_000;
  // OpenAI
  if (m.includes('gpt-5')) return 256_000;
  if (m.includes('gpt-4')) return 128_000;
  // Google
  if (m.includes('gemini-3') || m.includes('gemini-2.5')) return 1_000_000;
  // DeepSeek
  if (m.includes('deepseek')) return 128_000;
  // Safe default
  return 128_000;
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

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCostUsd: number;
  numTurns: number;
  durationMs: number;
  /** Context window size for the model used */
  contextWindow: number;
  /** Approximate percentage of context window used: (input + output) / contextWindow */
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

// ─── Dynamic MCP Server Loading ──────────────────────────

interface McpServerConfig {
  name: string;
  url: string;
  authHeader?: string;
}

/**
 * Load customer-provided MCP servers from .mcp-servers.json.
 * Written by Gallery during provisioning (from Convex mcpServers table).
 * Returns SDK-compatible mcpServers entries keyed by name.
 */
function loadDynamicMcpServers(): Record<string, { type: 'http'; url: string; headers?: Record<string, string> }> {
  const configPath = path.join(WORKSPACE_DIR, '.mcp-servers.json');
  const servers: Record<string, { type: 'http'; url: string; headers?: Record<string, string> }> = {};

  try {
    if (!fs.existsSync(configPath)) return servers;
    const raw = fs.readFileSync(configPath, 'utf-8');
    const configs: McpServerConfig[] = JSON.parse(raw);

    for (const cfg of configs) {
      if (!cfg.name || !cfg.url) continue;
      servers[cfg.name] = {
        type: 'http' as const,
        url: cfg.url,
        ...(cfg.authHeader ? { headers: { Authorization: cfg.authHeader } } : {}),
      };
    }

    if (Object.keys(servers).length > 0) {
      log(`[mcp] Loaded ${Object.keys(servers).length} dynamic MCP servers: ${Object.keys(servers).join(', ')}`);
    }
  } catch (err) {
    log(`[mcp] Failed to load .mcp-servers.json (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  return servers;
}

// Persistent state across requests (sprite stays alive between requests)
// On sleep/wake, the process restarts — read from disk to survive hibernation
let activityPoster: ActivityPoster | null = null;
let lastResumeAt: string | undefined = getPersistedResumeAt();

export async function processMessage(params: MessageParams, onEvent?: (event: StreamEvent) => void): Promise<MessageResult> {
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
  const contextTracker = new ContextWindowTracker();
  // Set a default context window based on model — will be refined from modelUsage in result
  const model = process.env.CLAW_MODEL || 'claude-opus-4-6';
  const isClaude = model.includes('claude') || model.startsWith('anthropic/');
  contextTracker.contextWindow = getDefaultContextWindow(model);
  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  const resultTexts: string[] = [];
  let messageCount = 0;
  let usageInfo: UsageInfo | undefined;

  // Load customer-provided MCP servers (re-read on each message in case config was updated)
  const dynamicMcpServers = loadDynamicMcpServers();
  const dynamicToolPatterns = Object.keys(dynamicMcpServers).map(name => `mcp__${name}__*`);

  try {
    for await (const msg of query({
      prompt,
      options: {
        cwd: WORKSPACE_DIR,
        model: process.env.CLAW_MODEL || 'claude-opus-4-6',
        // thinking + effort are Claude-only — omit for non-Claude models
        ...(isClaude ? {
          thinking: { type: 'adaptive' as const },
          effort: (process.env.CLAW_EFFORT || 'high') as 'low' | 'medium' | 'high' | 'max',
        } : {}),
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
          ...dynamicToolPatterns,
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
              GALLERY_WORKER_URL: process.env.GALLERY_WORKER_URL || '',
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
          ...dynamicMcpServers,
        },
        hooks: {
          PreCompact: [{ hooks: [createPreCompactHook(WORKSPACE_DIR, assistantName, log)] }],
          PreToolUse: [
            { matcher: 'Bash', hooks: [createSanitizeBashHook()] },
            { hooks: [createLoopDetectionHook(loopTracker, log)] },
            { hooks: [createContextSafetyHook(contextTracker, activityPoster, log)] },
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

        // Track context window usage from the API response
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
              activityPoster.post('output', block.text);
              onEvent?.({ type: 'text', data: { content: block.text } });
            } else if (block.type === 'tool_use') {
              activityPoster.post('tool_use', `${block.name}(${JSON.stringify(block.input).slice(0, 200)})`);
              onEvent?.({ type: 'tool_call_start', data: { id: block.id, name: block.name, input: block.input } });
            } else if (block.type === 'tool_result') {
              onEvent?.({ type: 'tool_call_end', data: { id: block.tool_use_id, status: block.is_error ? 'error' : 'completed', result: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) } });
            } else if (block.type === 'thinking' && block.thinking) {
              activityPoster.post('thinking', block.thinking.slice(0, 500));
              onEvent?.({ type: 'thinking', data: { content: block.thinking } });
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

        // Extract usage data from the result message
        const resultMsg = msg as {
          usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
          modelUsage?: Record<string, { inputTokens: number; outputTokens: number; contextWindow: number; costUSD: number }>;
          total_cost_usd?: number;
          num_turns?: number;
          duration_ms?: number;
        };

        if (resultMsg.usage || resultMsg.modelUsage) {
          // Get context window from modelUsage (first model entry)
          const modelEntries = resultMsg.modelUsage ? Object.values(resultMsg.modelUsage) : [];
          const contextWindow = modelEntries[0]?.contextWindow ?? contextTracker.contextWindow;
          // Update tracker with authoritative context window from API
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
          activityPoster.post('status', `Context: ${contextPercentage}% used (${inputTokens} in / ${outputTokens} out)`, {
            usage: usageInfo,
          });
          onEvent?.({ type: 'context_usage', data: { promptTokens: inputTokens, completionTokens: outputTokens, model, contextWindow, contextPercentage } });
        }

        // Emit done event with the final result text
        onEvent?.({ type: 'done', data: { result: textResult ?? '', sessionId: newSessionId || sessionId || '' } });
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
      // Append to existing day section
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
