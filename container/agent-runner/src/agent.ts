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
import type { SDKSessionOptions } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import {
  ToolCallTracker,
  ActivityPoster,
  ContextWindowTracker,
  createPreCompactHook,
  createSanitizeBashHook,
  createLoopDetectionHook,
  createContextSafetyHook,
  redactSecretsFromOutput,
  writeContextUsage,
  scanForInjection,
} from './shared.js';
import { UIStreamWriter, generateMessageId } from './ui-stream.js';
import type { MessageMetadata } from './ui-stream.js';
import { SessionManager } from './session-manager.js';
import type { ConversationContext } from './session-manager.js';

// ─── Configuration ──────────────────────────────────────

const WORKSPACE_DIR = process.env.CLAW_WORKSPACE_DIR || '/home/sprite/workspace';
const MCP_CONFIG_FILE = path.join(WORKSPACE_DIR, '.mcp.json');
const MODEL = process.env.CLAW_MODEL || 'claude-opus-4-6';

function log(message: string): void {
  console.error(`[claw] ${message}`);
}

/** Estimate billed cost in USD from token counts. Matches AI Gateway calculation:
 *  real provider cost × 3x markup. Cache-aware: cache reads at 10%, creation at 125%. */
const BILLING_MARKUP = 3;
function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  model?: string,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
): number {
  const m = (model || MODEL).toLowerCase();
  let inputRate: number; // $ per million tokens (provider cost)
  let outputRate: number;
  if (m.includes('haiku')) {
    inputRate = 1; outputRate = 5;
  } else if (m.includes('sonnet')) {
    inputRate = 3; outputRate = 15;
  } else if (m.includes('opus')) {
    inputRate = 5; outputRate = 25;
  } else {
    // Unknown model — use Sonnet rates as reasonable default
    inputRate = 3; outputRate = 15;
  }
  const uncachedInput = Math.max(0, inputTokens - cacheReadTokens - cacheCreationTokens);
  const providerCost = (
    uncachedInput * inputRate +
    cacheReadTokens * inputRate * 0.1 +
    cacheCreationTokens * inputRate * 1.25 +
    outputTokens * outputRate
  ) / 1_000_000;
  return providerCost * BILLING_MARKUP;
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

// Session persistence is now handled by SessionManager.

/**
 * Read .mcp.json and return both the full MCP server configs (for the SDK
 * mcpServers option) and the allowedTools patterns (mcp__<name>__*).
 *
 * Passing configs explicitly via SDKSessionOptions.mcpServers ensures the SDK
 * connects to MCP servers directly, rather than relying on the CLI subprocess
 * to auto-discover and approve .mcp.json — which fails silently in containers.
 */
function loadMcpConfig(): {
  toolPatterns: string[];
} {
  try {
    if (!fs.existsSync(MCP_CONFIG_FILE)) return { toolPatterns: [] };
    const config = JSON.parse(fs.readFileSync(MCP_CONFIG_FILE, 'utf-8'));
    const servers: Record<string, Record<string, unknown>> = config.mcpServers || {};
    const names = Object.keys(servers);
    if (names.length > 0) {
      log(`[mcp] Found ${names.length} customer MCP servers: ${names.join(', ')}`);
      for (const name of names) {
        const s = servers[name] as Record<string, unknown>;
        log(`[mcp]   ${name}: type=${s.type ?? 'stdio'}, ${s.url ? `url=${s.url}` : `cmd=${s.command}`}`);
      }
    }
    return {
      toolPatterns: names.map(name => `mcp__${name}__*`),
    };
  } catch (err) {
    log(`[mcp] Failed to read ${MCP_CONFIG_FILE}: ${err instanceof Error ? err.message : err}`);
    return { toolPatterns: [] };
  }
}

// ─── Public Interfaces ───────────────────────────────────

export interface MessageParams {
  message: string;
  sessionId?: string;
  isScheduledTask?: boolean;
  assistantName?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  mode?: 'agent' | 'plan';
  model?: string;
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


// ─── Persistent State ────────────────────────────────────
// Global state shared across all conversations.
// Per-conversation state (session, locks, trackers) lives in SessionManager.

let activityPoster: ActivityPoster | null = null;

// Mutable cancel ref — updated per-message, checked by PreToolUse hook
// to abort before starting long tool executions (e.g., Bash commands).
const activeCancelRef: { current: { cancelled: boolean } | null } = { current: null };

// Session manager — handles multiple conversations per container
const sessionManager = new SessionManager({
  workspaceDir: WORKSPACE_DIR,
  maxSessions: 5,
  defaultContextWindow: getDefaultContextWindow(MODEL),
  defaultModel: MODEL,
  buildOptions: (loopTracker, contextTracker, assistantName, mode, model) => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const mcp = loadMcpConfig();
    // Note: V2 sessions (unstable_v2_createSession) ignore mcpServers option —
    // the CLI subprocess auto-loads .mcp.json from cwd (project root).
    // We still need toolPatterns in allowedTools so the SDK permits MCP tool calls.
    return {
      model: model || MODEL,
      pathToClaudeCodeExecutable: path.join(__dirname, 'cli.js'),
      env: { ...process.env },
      allowedTools: [
        'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'Task', 'TaskOutput', 'TaskStop',
        'NotebookEdit',
        ...mcp.toolPatterns,
      ],
      permissionMode: mode === 'plan' ? 'plan' : 'acceptEdits',
      // Capture CLI subprocess stderr — SDK defaults to "ignore" which swallows all MCP errors
      stderr: (data: string) => {
        const line = data.trim();
        if (line) log(`[sdk-stderr] ${line}`);
      },
      includePartialMessages: true,
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook(WORKSPACE_DIR, assistantName, log)] }],
        PreToolUse: [
          // Cancel check — abort before starting tool execution if user cancelled
          { hooks: [async () => {
            if (activeCancelRef.current?.cancelled) {
              return { decision: 'block' as const, reason: 'Cancelled by user' };
            }
            return {};
          }] },
          { matcher: 'Bash', hooks: [createSanitizeBashHook()] },
          { hooks: [createLoopDetectionHook(loopTracker, log)] },
          { hooks: [createContextSafetyHook(contextTracker, activityPoster, log, WORKSPACE_DIR)] },
        ],
      },
    };
  },
});

// Migrate legacy single-session file on startup
sessionManager.migrateFromLegacy();

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

// ─── Core Message Processing ─────────────────────────────

export async function processMessage(
  params: MessageParams,
  writer?: UIStreamWriter,
  cancelSignal?: { cancelled: boolean },
): Promise<MessageResult> {
  const conversationId = params.sessionId || 'default';

  // Get or create conversation context (session, trackers, etc.)
  const ctx = sessionManager.getOrCreate(conversationId, params.assistantName, params.mode, params.model);

  // Per-conversation lock — serialize send/stream cycles for THIS conversation
  // Other conversations can process in parallel
  const releaseLock = await sessionManager.acquireLock(conversationId);

  try {
    return await processMessageInner(params, writer, cancelSignal, ctx);
  } finally {
    activeCancelRef.current = null;
    releaseLock();
  }
}

async function processMessageInner(
  params: MessageParams,
  writer?: UIStreamWriter,
  cancelSignal?: { cancelled: boolean },
  ctx?: ConversationContext,
): Promise<MessageResult> {
  const { message, isScheduledTask, assistantName } = params;
  const conversationId = params.sessionId || 'default';
  // Initialize activity poster before session creation (hooks reference it)
  const agentId = process.env.AGENT_ID || assistantName || 'unknown';
  ensureActivityPoster(agentId);
  activityPoster!.post('status', 'Processing message');

  // Set cancel ref so PreToolUse hook can abort before starting tool execution
  activeCancelRef.current = cancelSignal ?? null;

  // Build prompt with timezone context
  const tz = process.env.AGENT_TIMEZONE || 'UTC';
  const localTime = new Date().toLocaleString('en-US', {
    timeZone: tz,
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
  // Validate message size
  if (message.length > 500_000) {
    throw new Error('Message too large (max 500KB)');
  }

  // ─── Dynamic workspace state (injected per-turn) ───────
  let workspaceState = '';
  const convexUrl = process.env.GALLERY_CONVEX_URL;
  const gwToken = process.env.GALLERY_GATEWAY_TOKEN;
  if (convexUrl && gwToken) {
    try {
      const [tasksRes, agentsRes, reviewsRes] = await Promise.allSettled([
        fetch(`${convexUrl}/api/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: 'mcpInternal:listTasks', args: { token: gwToken } }),
          signal: AbortSignal.timeout(5_000),
        }).then(r => r.ok ? r.json() : null),
        fetch(`${convexUrl}/api/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: 'mcpInternal:listAgents', args: { token: gwToken } }),
          signal: AbortSignal.timeout(5_000),
        }).then(r => r.ok ? r.json() : null),
        fetch(`${convexUrl}/api/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: 'mcpInternal:listReviews', args: { token: gwToken, status: 'pending' } }),
          signal: AbortSignal.timeout(5_000),
        }).then(r => r.ok ? r.json() : null),
      ]);

      const tasks = tasksRes.status === 'fulfilled' ? (tasksRes.value?.value ?? tasksRes.value ?? []) : [];
      const agents = agentsRes.status === 'fulfilled' ? (agentsRes.value?.value ?? agentsRes.value ?? []) : [];
      const reviews = reviewsRes.status === 'fulfilled' ? (reviewsRes.value?.value ?? reviewsRes.value ?? []) : [];

      if (Array.isArray(tasks) || Array.isArray(agents) || Array.isArray(reviews)) {
        const parts: string[] = [];
        if (Array.isArray(agents) && agents.length > 0) {
          const active = agents.filter((a: any) => a.status === 'active');
          const unhealthy = agents.filter((a: any) => (a.healthFailures ?? 0) > 2);
          parts.push(`Agents: ${active.length} active${unhealthy.length > 0 ? `, ${unhealthy.length} UNHEALTHY (${unhealthy.map((a: any) => a.name).join(', ')})` : ''}`);
        }
        if (Array.isArray(tasks) && tasks.length > 0) {
          const inProgress = tasks.filter((t: any) => t.status === 'in_progress').length;
          const blocked = tasks.filter((t: any) => t.status === 'blocked' || t.status === 'in_review').length;
          parts.push(`Tasks: ${tasks.length} total, ${inProgress} in progress${blocked > 0 ? `, ${blocked} blocked/in-review` : ''}`);
        }
        if (Array.isArray(reviews) && reviews.length > 0) {
          parts.push(`Pending reviews: ${reviews.length}`);
        }
        if (parts.length > 0) {
          workspaceState = `<workspace-state>\n${parts.join('\n')}\n</workspace-state>\n\n`;
        }
      }
    } catch {
      // Non-fatal — workspace state is nice-to-have
    }
  }

  let prompt = `<context timezone="${tz}" localTime="${localTime}" />\n\n${workspaceState}`;
  if (isScheduledTask) {
    prompt += `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user.]\n\n`;
  }
  prompt += message;

  let currentSessionId = ctx?.sessionId || '';
  const resultTexts: string[] = [];
  let messageCount = 0;
  let streamEventCount = 0;
  let usageInfo: UsageInfo | undefined;

  // AI SDK state tracking
  let lastEmittedToolOutput = false;

  // Budget/turn limit tracking
  const maxTurns = params.maxTurns ?? 200;
  const maxBudgetUsd = params.maxBudgetUsd ?? 10.00;
  let turnCount = 0;
  let accumulatedCostUsd = 0;
  let limitHit = false;

  // Emit AI SDK message start
  if (writer) {
    await writer.start(generateMessageId());
    await writer.startStep();
  }

  try {
    if (!ctx) throw new Error('No conversation context');
    const sess = ctx.session;
    sessionManager.touchSession(conversationId);
    await sess.send(prompt);

    for await (const msg of sess.stream()) {
      // Check for cancel
      if (cancelSignal?.cancelled) {
        log('[cancel] Stream cancelled by user');
        if (writer) {
          await writer.abort('User cancelled');
          writer.done();
        }
        break;
      }

      messageCount++;
      const msgType = msg.type === 'system' ? `system/${(msg as { subtype?: string }).subtype}` : msg.type;
      if (msgType !== 'stream_event') log(`[msg #${messageCount}] type=${msgType}`);

      // ─── Stream events (token-by-token) ───────────
      if (msg.type === 'stream_event') {
        streamEventCount++;
        const event = (msg as any).event;
        if (event?.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta?.type === 'text_delta' && delta.text && writer) {
            if (lastEmittedToolOutput) {
              await writer.emitStepBoundary();
              lastEmittedToolOutput = false;
            }
            await writer.textDelta(delta.text);
          } else if (delta?.type === 'thinking_delta' && delta.thinking && writer) {
            if (lastEmittedToolOutput) {
              await writer.emitStepBoundary();
              lastEmittedToolOutput = false;
            }
            await writer.reasoningDelta(delta.thinking);
          }
          // input_json_delta — ignored, full input emitted on complete message
        } else if (event?.type === 'content_block_start') {
          const block = event.content_block;
          if (block?.type === 'tool_use' && writer) {
            await writer.closeOpenBlocks();
            await writer.toolInputStart(block.id, block.name);
          }
        } else if (event?.type === 'content_block_stop' && writer) {
          await writer.closeOpenBlocks();
        }
        continue;
      }

      // ─── Assistant messages (complete) ─────────────
      if (msg.type === 'assistant') {
        const msgUsage = (msg as any).message?.usage;
        if (msgUsage && ctx) {
          ctx.contextTracker.update(
            msgUsage.input_tokens ?? 0,
            msgUsage.output_tokens ?? 0,
            undefined,
            msgUsage.cache_read_input_tokens ?? 0,
            msgUsage.cache_creation_input_tokens ?? 0,
          );
          // Write context usage to file for MCP tools
          writeContextUsage(WORKSPACE_DIR, ctx.contextTracker);
        }

        // Track whether we got stream_events (partial messages) for this turn
        // If so, don't re-emit text/thinking — they were already streamed token-by-token
        const hadStreamEvents = streamEventCount > 0;

        const content = (msg as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              activityPoster!.post('output', block.text);
              if (!hadStreamEvents && writer) {
                await writer.textStart();
                await writer.textDelta(block.text);
                await writer.textEnd();
              }
            } else if (block.type === 'tool_use') {
              activityPoster!.post('tool_use', `${block.name}(${JSON.stringify(block.input).slice(0, 200)})`);
              if (writer) {
                await writer.toolInputAvailable(block.id, block.name, block.input);
              }
            } else if (block.type === 'tool_result') {
              const rawContent = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
              const injections = scanForInjection(rawContent);
              if (injections.length > 0) {
                activityPoster!.post('error', `⚠ Prompt injection detected in tool output: ${injections.join(', ')}`);
                log?.(`WARNING: Prompt injection patterns detected in tool result: ${injections.join(', ')}`);
              }
              const resultContent = redactSecretsFromOutput(rawContent);
              if (writer) {
                if (block.is_error) {
                  await writer.toolOutputError(block.tool_use_id, resultContent);
                } else {
                  await writer.toolOutputAvailable(block.tool_use_id, resultContent);
                }
                lastEmittedToolOutput = true;
              }
            } else if (block.type === 'thinking' && block.thinking) {
              activityPoster!.post('thinking', block.thinking.slice(0, 500));
              if (!hadStreamEvents && writer) {
                await writer.reasoningStart();
                await writer.reasoningDelta(block.thinking);
                await writer.reasoningEnd();
              }
            }
          }

          // ─── Budget/turn limit enforcement ───────────
          const hasToolUse = content.some((b: any) => b.type === 'tool_use');
          if (hasToolUse) turnCount++;

          // Accumulate cost from this turn's usage (cache-aware, includes billing markup)
          if (msgUsage) {
            accumulatedCostUsd += estimateCostUsd(
              msgUsage.input_tokens ?? 0,
              msgUsage.output_tokens ?? 0,
              MODEL,
              msgUsage.cache_read_input_tokens ?? 0,
              msgUsage.cache_creation_input_tokens ?? 0,
            );
          }

          // Check turn limit
          if (turnCount >= maxTurns) {
            log(`[limits] Turn limit hit: ${turnCount}/${maxTurns}`);
            if (writer) {
              await writer.finish('max_turns');
              writer.done();
            }
            limitHit = true;
            break;
          }

          // Check budget limit
          if (accumulatedCostUsd >= maxBudgetUsd) {
            log(`[limits] Budget limit hit: $${accumulatedCostUsd.toFixed(4)} >= $${maxBudgetUsd}`);
            if (writer) {
              await writer.finish('budget_exceeded');
              writer.done();
            }
            limitHit = true;
            break;
          }

          // Reset stream event counter for next turn so hadStreamEvents is accurate per-turn
          streamEventCount = 0;
        }
      }

      // ─── System messages ──────────────────────────
      if (msg.type === 'system' && msg.subtype === 'init') {
        currentSessionId = msg.session_id;
        log(`Session initialized: ${currentSessionId} (conversation: ${conversationId})`);
        // Log full init message keys + MCP status for debugging
        const initKeys = Object.keys(msg).filter(k => k !== 'type' && k !== 'subtype');
        log(`[init] keys: ${initKeys.join(', ')}`);
        const mcpServers = (msg as any).mcp_servers;
        if (mcpServers && Array.isArray(mcpServers)) {
          if (mcpServers.length > 0) {
            const mcpStatus = mcpServers.map((s: any) => `${s.name}:${s.status}`).join(', ');
            log(`[mcp] Server status: ${mcpStatus}`);
          } else {
            log(`[mcp] WARNING: mcp_servers array is empty — no MCP servers connected`);
          }
        } else {
          log(`[mcp] WARNING: no mcp_servers field in init message (mcpServers=${typeof mcpServers})`);
        }
        // Log available tools from init message
        const tools = (msg as any).tools;
        if (tools && Array.isArray(tools)) {
          const mcpTools = tools.filter((t: any) => typeof t === 'string' && t.startsWith('mcp__'));
          const builtinTools = tools.filter((t: any) => typeof t === 'string' && !t.startsWith('mcp__'));
          log(`[init] tools: ${builtinTools.length} built-in, ${mcpTools.length} MCP ${mcpTools.length > 0 ? `(${mcpTools.slice(0, 5).join(', ')}${mcpTools.length > 5 ? '...' : ''})` : ''}`);
        }
        activityPoster!.post('status', `Session initialized: ${currentSessionId}`);
        sessionManager.persistSessionId(conversationId, currentSessionId);
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
          const contextWindow = modelEntries[0]?.contextWindow ?? (ctx?.contextTracker.contextWindow ?? 200_000);
          if (contextWindow > 0 && ctx) ctx.contextTracker.contextWindow = contextWindow;
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

          if (writer) {
            await writer.messageMetadata({
              usage: { promptTokens: inputTokens, completionTokens: outputTokens, cacheReadTokens: usageInfo.cacheReadTokens, cacheCreationTokens: usageInfo.cacheCreationTokens },
              cost: { usd: usageInfo.totalCostUsd },
              model: MODEL,
              sessionId: currentSessionId,
            });
          }
        }

        if (writer) {
          await writer.finish('stop');
          writer.done();
        }
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const isCreditError = /CREDITS_EXHAUSTED|Credit limit reached|NO_BILLING_PROFILE|Payment Required/i.test(errorMessage);

    if (isCreditError) {
      log('Credit limit reached — stopping agent');
      activityPoster!.post('error', 'Credit limit reached. Add more credits in billing settings.');

      if (writer) {
        await writer.error('Credit limit reached. Add more credits in billing settings.');
        writer.done();
      }

      sessionManager.handleError(conversationId);

      return {
        status: 'error',
        result: null,
        sessionId: currentSessionId,
        error: 'CREDITS_EXHAUSTED',
      };
    }

    log(`Agent error: ${errorMessage}`);
    activityPoster!.post('error', errorMessage);

    if (writer) {
      await writer.error(errorMessage);
      writer.done();
    }

    // Session may have crashed — close for recovery on next message
    sessionManager.handleError(conversationId);

    return {
      status: 'error',
      result: null,
      sessionId: currentSessionId,
      error: errorMessage,
    };
  }

  // Capture sessionId from session object if we missed system/init
  if (!currentSessionId && ctx?.session) {
    try {
      currentSessionId = ctx.session.sessionId;
      sessionManager.persistSessionId(conversationId, currentSessionId);
    } catch { /* sessionId may not be available yet */ }
  }

  const resultText = resultTexts.length > 0 ? resultTexts.join('\n\n') : null;
  const statusMsg = limitHit
    ? `Query stopped (limit hit after ${turnCount} turns, $${accumulatedCostUsd.toFixed(4)})`
    : `Query done. Messages: ${messageCount}, results: ${resultTexts.length}`;
  log(`${statusMsg}, sessionId: ${currentSessionId}`);
  activityPoster!.post('status', limitHit ? statusMsg : 'Message processed');

  // Fire-and-forget memory extraction — don't block the response
  if (resultText && process.env.CLAW_AUTO_MEMORY !== 'false') {
    extractMemory(message, resultText).catch((err) => {
      log(`Memory extraction failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  return {
    status: limitHit ? 'error' : 'success',
    result: resultText,
    sessionId: currentSessionId,
    error: limitHit ? (turnCount >= maxTurns ? 'max_turns' : 'budget_exceeded') : undefined,
    usage: usageInfo ?? (limitHit ? {
      inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 0,
      totalCostUsd: accumulatedCostUsd,
      numTurns: turnCount, durationMs: 0,
      contextWindow: ctx?.contextTracker.contextWindow ?? 200_000,
      contextPercentage: 0,
    } : undefined),
  };
}

// ─── Automatic Memory Extraction ────────────────────────

/**
 * Post-conversation memory extraction. Sends a summary of the conversation
 * to a cheap/fast model and appends extracted facts to MEMORY.md.
 * Runs fire-and-forget — never blocks the response.
 */
let memoryWriteLock: Promise<void> = Promise.resolve();

async function extractMemory(userMessage: string, assistantResult: string): Promise<void> {
  // Serialize concurrent writes to MEMORY.md to prevent race conditions
  const prev = memoryWriteLock;
  let release: () => void;
  memoryWriteLock = new Promise<void>((resolve) => { release = resolve; });
  await prev;

  try {
    await extractMemoryInner(userMessage, assistantResult);
  } finally {
    release!();
  }
}

async function extractMemoryInner(userMessage: string, assistantResult: string): Promise<void> {
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
        'x-gallery-agent-id': process.env.AGENT_ID || '',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: `Extract information worth remembering from this conversation. Be selective — only extract genuinely useful facts, not routine exchanges.

EXISTING MEMORY (do NOT repeat what's already here):
${existing.slice(0, 2000)}

CONVERSATION:
User: ${userMessage.slice(0, 3000)}
Assistant: ${assistantResult.slice(0, 3000)}

Extract into these categories (skip empty categories, skip if nothing new):

**User preferences/habits:** Communication style, working hours, tool preferences, aesthetic preferences, things they dislike
**Decisions made:** What was decided, why, any tradeoffs noted
**Key facts:** Important project details, agent configurations, codebase facts, user context
**Things that didn't work:** Approaches tried that failed (so they're not repeated)

Respond ONLY with bullet points under category headers, or "NONE" if nothing worth remembering.
No timestamps. No headers beyond the category names. Just bullet points.`,
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
  sessionManager.closeAll();
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
  workspaceDir: string;
  memoryFiles: string[];
  uptime: number;
  activeConversations: number;
  conversationIds: string[];
} {
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
    workspaceDir: WORKSPACE_DIR,
    memoryFiles,
    uptime: process.uptime(),
    activeConversations: sessionManager.activeCount,
    conversationIds: sessionManager.getConversationIds(),
  };
}
