// Claw Agent Runner — bundled with esbuild

// src/server.ts
import http from "http";

// src/agent.ts
import fs3 from "fs";
import path3 from "path";
import { fileURLToPath } from "url";

// src/shared.ts
import fs from "fs";
import path from "path";
var INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /ignore\s+(all\s+)?above\s+instructions/i,
  /disregard\s+(all\s+)?prior\s+(instructions|context)/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /new\s+instructions?\s*:/i,
  /system\s*:\s*you\s+(are|must|should)/i,
  /<div\s+style\s*=\s*["']display:\s*none/i,
  /curl\s+.*\|\s*sh/i,
  /wget\s+.*\|\s*bash/i,
  /\u200b|\u200c|\u200d|\ufeff/
  // Zero-width characters (invisible text injection)
];
function scanForInjection(text) {
  const detected = [];
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      detected.push(pattern.source.slice(0, 60));
    }
  }
  return detected;
}
var TRANSIENT_ERROR_PATTERNS = [
  /\bnot available\b/i,
  /\bnot configured\b/i,
  /\bconnection (?:failed|refused|reset)\b/i,
  /\btimed?\s*out\b/i,
  /\b(?:429|502|503|504)\b/,
  /\brate limit/i,
  /\btemporarily\b/i,
  /\bunavailable\b/i,
  /\bdisconnect(?:ed)?\b/i,
  /\bunreachable\b/i,
  /\bMCP\b.*(?:not responding|failed to connect|disconnected)/i,
  /\bcould not connect\b/i,
  /\bservice\b.*\bdown\b/i,
  /\bnetwork error\b/i,
  /\bretry later\b/i
];
function isTransientError(text) {
  return TRANSIENT_ERROR_PATTERNS.some((p) => p.test(text));
}
function filterTransientErrors(extractedText) {
  const lines = extractedText.split("\n");
  const filtered = lines.filter((line) => {
    if (line.trimStart().startsWith("**") && line.trimEnd().endsWith("**")) return true;
    if (line.trimStart().startsWith("-") && isTransientError(line)) return false;
    return true;
  });
  const result = [];
  for (let i3 = 0; i3 < filtered.length; i3++) {
    const trimmed = filtered[i3].trimStart();
    if (trimmed.startsWith("**") && trimmed.trimEnd().endsWith("**")) {
      const hasBullets = filtered.slice(i3 + 1).some((l3) => {
        const t = l3.trimStart();
        if (t.startsWith("**") && t.trimEnd().endsWith("**")) return false;
        if (t.startsWith("-")) return true;
        return false;
      });
      if (!hasBullets) continue;
    }
    result.push(filtered[i3]);
  }
  return result.join("\n").trim();
}
function parseTranscript(content) {
  const messages = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "user" && entry.message?.content) {
        const text = typeof entry.message.content === "string" ? entry.message.content : entry.message.content.map((c) => c.text || "").join("");
        if (text) messages.push({ role: "user", content: text });
      } else if (entry.type === "assistant" && entry.message?.content) {
        const textParts = entry.message.content.filter((c) => c.type === "text").map((c) => c.text);
        const text = textParts.join("");
        if (text) messages.push({ role: "assistant", content: text });
      }
    } catch {
    }
  }
  return messages;
}
function sanitizeFilename(summary) {
  return summary.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
}
function generateFallbackName() {
  const time = /* @__PURE__ */ new Date();
  return `conversation-${time.getHours().toString().padStart(2, "0")}${time.getMinutes().toString().padStart(2, "0")}`;
}
function formatTranscriptMarkdown(messages, title, assistantName) {
  const now = /* @__PURE__ */ new Date();
  const formatDateTime = (d) => d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  });
  const lines = [];
  lines.push(`# ${title || "Conversation"}`);
  lines.push("");
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  for (const msg of messages) {
    const sender = msg.role === "user" ? "User" : assistantName || "Assistant";
    const content = msg.content.length > 2e3 ? msg.content.slice(0, 2e3) + "..." : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push("");
  }
  return lines.join("\n");
}
function getSessionSummary(sessionId, transcriptPath, log4) {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, "sessions-index.json");
  if (!fs.existsSync(indexPath)) {
    log4?.(`Sessions index not found at ${indexPath}`);
    return null;
  }
  try {
    const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    const entry = index.entries.find((e3) => e3.sessionId === sessionId);
    if (entry?.summary) return entry.summary;
  } catch (err) {
    log4?.(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}
async function callHaikuForSummary(prompt, log4) {
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!baseUrl || !apiKey) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15e3);
  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }]
      })
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.content?.[0]?.type === "text" ? data.content[0].text?.trim() ?? null : null;
  } catch (err) {
    log4?.(`[haiku-summary] Failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
function createPreCompactHook(workspaceDir, assistantName, log4) {
  return async (input, _toolUseId, _context) => {
    const preCompact = input;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log4?.("No transcript found for archiving");
      return {};
    }
    try {
      const content = fs.readFileSync(transcriptPath, "utf-8");
      const messages = parseTranscript(content);
      if (messages.length === 0) {
        log4?.("No messages to archive");
        return {};
      }
      const summary = getSessionSummary(sessionId, transcriptPath, log4);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();
      const conversationsDir = path.join(workspaceDir, "conversations");
      fs.mkdirSync(conversationsDir, { recursive: true });
      const date = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);
      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
      fs.writeFileSync(filePath, markdown);
      log4?.(`Archived conversation to ${filePath}`);
      const memoryDir = path.join(workspaceDir, "memory");
      fs.mkdirSync(memoryDir, { recursive: true });
      const dailyFile = path.join(memoryDir, `${date}.md`);
      const timestamp = (/* @__PURE__ */ new Date()).toISOString().split("T")[1].replace(/\.\d+Z$/, "");
      const existingSummary = fs.existsSync(dailyFile) ? fs.readFileSync(dailyFile, "utf-8") : "";
      const transcriptSnippet = messages.map((m3) => `${m3.role === "user" ? "User" : assistantName || "Assistant"}: ${m3.content.slice(0, 500)}`).join("\n").slice(0, 6e3);
      const summaryPrompt = existingSummary.length > 100 ? `Update this existing session summary with new information from the latest conversation segment.

EXISTING SUMMARY:
${existingSummary.slice(-3e3)}

NEW CONVERSATION:
${transcriptSnippet}

Merge the new information into the existing structure. Update sections \u2014 don't duplicate. Move completed items from "In Progress" to "Accomplished". Add new decisions and next steps.

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
[Updated next steps after this segment]` : `Summarize this conversation in structured format for future reference.

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
      const structuredSummary = await callHaikuForSummary(summaryPrompt, log4);
      const marker = structuredSummary ? `
## Session Summary (${timestamp})

Archived: \`conversations/${filename}\`${summary ? `
Session: ${summary}` : ""}

${structuredSummary}
` : `
## Context compacted at ${timestamp}

Conversation archived to \`conversations/${filename}\`${summary ? `
Summary: ${summary}` : ""}
`;
      fs.appendFileSync(dailyFile, marker);
      log4?.(`Wrote ${structuredSummary ? "structured summary" : "compaction marker"} to memory/${date}.md`);
    } catch (err) {
      log4?.(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {};
  };
}
var SECRET_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "GITHUB_PAT",
  "SLACK_BOT_TOKEN",
  "STRIPE_SECRET_KEY",
  "SENDGRID_API_KEY",
  "HUGGINGFACE_TOKEN",
  "DATABASE_URL",
  "POSTGRES_URL",
  "MYSQL_URL",
  "REDIS_URL",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_ACCESS_KEY_ID",
  "GOOGLE_API_KEY",
  "REPLICATE_API_TOKEN",
  "GALLERY_GATEWAY_TOKEN",
  "GALLERY_TOKEN"
];
function redactSecretsFromCommand(command) {
  return command.replace(/\b(sk-[A-Za-z0-9]{20,})/g, "sk-***REDACTED***").replace(/\b(ghp_[A-Za-z0-9]{36,})/g, "ghp_***REDACTED***").replace(/\b(github_pat_[A-Za-z0-9_]{82,})/g, "github_pat_***REDACTED***").replace(/\b(xox[bpoa]-[A-Za-z0-9-]+)/g, "xox***REDACTED***").replace(/\b(AIza[A-Za-z0-9_-]{35})/g, "AIza***REDACTED***").replace(/\b(AKIA[A-Z0-9]{16})/g, "AKIA***REDACTED***").replace(/\b(sk_live_[A-Za-z0-9]{24,})/g, "sk_live_***REDACTED***").replace(/\b(r8_[A-Za-z0-9]{37})/g, "r8_***REDACTED***").replace(/\b(gho_[A-Za-z0-9]{36,})/g, "gho_***REDACTED***").replace(/\b(ghs_[A-Za-z0-9]{36,})/g, "ghs_***REDACTED***").replace(/\b(ghr_[A-Za-z0-9]{36,})/g, "ghr_***REDACTED***").replace(/\b(xoxe-[A-Za-z0-9-]+)/g, "xoxe-***REDACTED***").replace(/\b(whsec_[A-Za-z0-9]{32,})/g, "whsec_***REDACTED***").replace(/\b(SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})/g, "SG.***REDACTED***").replace(/\b(ABIA[A-Z0-9]{16})/g, "ABIA***REDACTED***").replace(/\b(ASIA[A-Z0-9]{16})/g, "ASIA***REDACTED***").replace(/(password|secret|token|key|apikey)=["']?[A-Za-z0-9_\-\.]{8,}["']?/gi, "$1=***REDACTED***").replace(/Authorization:\s*Bearer\s+[A-Za-z0-9_\-\.]+/gi, "Authorization: Bearer ***REDACTED***").replace(/-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g, "***PRIVATE_KEY_REDACTED***").replace(/\b(postgres|mysql|mongodb|redis|amqp)(:\/\/)[^\s"']+/gi, "$1$2***REDACTED***");
}
function createSanitizeBashHook() {
  return async (input, _toolUseId, _context) => {
    const preInput = input;
    const command = preInput.tool_input?.command;
    if (!command) return {};
    const redacted = redactSecretsFromCommand(command);
    const unsetPrefix = `unset ${SECRET_ENV_VARS.join(" ")} 2>/dev/null; `;
    const procGuard = `chmod 000 /proc/self/environ 2>/dev/null; `;
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: {
          ...preInput.tool_input,
          command: procGuard + unsetPrefix + redacted
        }
      }
    };
  };
}
function redactSecretsFromOutput(text) {
  let redacted = redactSecretsFromCommand(text);
  redacted = redacted.replace(
    /("(?:api[_-]?key|secret|token|password|credential|auth)[^"]*"\s*:\s*")([^"]{8,})"/gi,
    '$1***REDACTED***"'
  );
  redacted = redacted.replace(
    /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
    (match) => {
      if (/^[0-9a-f-]+$/i.test(match)) return match;
      if (match.length > 60) return "***BASE64_REDACTED***";
      return match;
    }
  );
  redacted = redacted.replace(
    /\b(ANTHROPIC_API_KEY|GALLERY_GATEWAY_TOKEN|GALLERY_TOKEN|AWS_SECRET_ACCESS_KEY|OPENAI_API_KEY|STRIPE_SECRET_KEY|DATABASE_URL|GITHUB_TOKEN)=([^\s\0]+)/gi,
    "$1=***REDACTED***"
  );
  return redacted;
}
var CONTEXT_USAGE_FILE = ".context-usage.json";
function writeContextUsage(workspaceDir, tracker) {
  try {
    const data = {
      percentage: Math.round(tracker.getPercentage() * 100),
      inputTokens: tracker.lastInputTokens,
      outputTokens: tracker.lastOutputTokens,
      cacheReadTokens: tracker.lastCacheReadTokens,
      cacheCreationTokens: tracker.lastCacheCreationTokens,
      contextWindow: tracker.contextWindow,
      updatedAt: Date.now()
    };
    fs.writeFileSync(path.join(workspaceDir, CONTEXT_USAGE_FILE), JSON.stringify(data));
  } catch {
  }
}
var LOOP_SAME_CALL_THRESHOLD = parseInt(process.env.LOOP_SAME_CALL_THRESHOLD || "3", 10);
var LOOP_FORCE_STOP_THRESHOLD = parseInt(process.env.LOOP_FORCE_STOP_THRESHOLD || "6", 10);
var LOOP_CYCLE_THRESHOLD = parseInt(process.env.LOOP_CYCLE_THRESHOLD || "3", 10);
var LOOP_SAME_TOOL_THRESHOLD = parseInt(process.env.LOOP_SAME_TOOL_THRESHOLD || "5", 10);
var SAME_TOOL_EXEMPT = /* @__PURE__ */ new Set(["Read", "Grep", "Glob", "WebSearch", "WebFetch", "ToolSearch"]);
var LOOP_HISTORY_SIZE = 20;
var ToolCallTracker = class {
  history = [];
  warningIssued = false;
  hashInput(input) {
    const str = JSON.stringify(input);
    let hash = 5381;
    for (let i3 = 0; i3 < str.length; i3++) {
      hash = (hash << 5) + hash + str.charCodeAt(i3) | 0;
    }
    return (hash >>> 0).toString(36);
  }
  track(toolName, toolInput) {
    this.history.push({ toolName, inputHash: this.hashInput(toolInput) });
    if (this.history.length > LOOP_HISTORY_SIZE) {
      this.history.shift();
    }
    const sameCallCount = this.countConsecutiveSame();
    if (sameCallCount >= LOOP_FORCE_STOP_THRESHOLD) {
      return { loopDetected: true, shouldStop: true };
    }
    if (sameCallCount >= LOOP_SAME_CALL_THRESHOLD) {
      return { loopDetected: true, shouldStop: false };
    }
    const cycles2 = this.detectCycle(2);
    const cycles3 = this.detectCycle(3);
    if (cycles2 >= LOOP_CYCLE_THRESHOLD || cycles3 >= LOOP_CYCLE_THRESHOLD) {
      const totalRepeats = Math.max(cycles2, cycles3);
      return { loopDetected: true, shouldStop: totalRepeats >= LOOP_FORCE_STOP_THRESHOLD };
    }
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
  countConsecutiveSame() {
    if (this.history.length === 0) return 0;
    const last = this.history[this.history.length - 1];
    let count = 0;
    for (let i3 = this.history.length - 1; i3 >= 0; i3--) {
      if (this.history[i3].toolName === last.toolName && this.history[i3].inputHash === last.inputHash) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }
  countConsecutiveSameTool() {
    if (this.history.length === 0) return 0;
    const last = this.history[this.history.length - 1];
    let count = 0;
    for (let i3 = this.history.length - 1; i3 >= 0; i3--) {
      if (this.history[i3].toolName === last.toolName) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }
  detectCycle(cycleLength) {
    if (this.history.length < cycleLength * 2) return 0;
    const recent = this.history.slice(-cycleLength);
    let repetitions = 1;
    for (let offset = cycleLength; offset <= this.history.length - cycleLength; offset += cycleLength) {
      const segment = this.history.slice(-(offset + cycleLength), -offset);
      if (segment.length !== cycleLength) break;
      const matches = segment.every(
        (rec, i3) => rec.toolName === recent[i3].toolName && rec.inputHash === recent[i3].inputHash
      );
      if (matches) repetitions++;
      else break;
    }
    return repetitions;
  }
  resetWarning() {
    this.warningIssued = false;
  }
  hasIssuedWarning() {
    return this.warningIssued;
  }
  markWarningIssued() {
    this.warningIssued = true;
  }
};
function createLoopDetectionHook(tracker, log4) {
  return async (input, _toolUseId, _context) => {
    const preInput = input;
    const toolName = preInput.tool_name || "unknown";
    const toolInput = preInput.tool_input;
    const { loopDetected, shouldStop } = tracker.track(toolName, toolInput);
    if (shouldStop) {
      log4?.(`[loop-detect] FORCE STOP: Tool ${toolName} in terminal loop`);
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          decision: "block",
          message: "LOOP DETECTED: You have been calling the same tool with the same input repeatedly. This call is blocked. Try a completely different approach."
        }
      };
    }
    if (loopDetected && !tracker.hasIssuedWarning()) {
      log4?.(`[loop-detect] WARNING: Repetitive tool use detected for ${toolName}`);
      tracker.markWarningIssued();
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          message: "WARNING: You appear to be repeating the same tool calls. Consider trying a different approach before this call gets blocked."
        }
      };
    }
    if (!loopDetected) {
      tracker.resetWarning();
    }
    return {};
  };
}
var CONTEXT_WARN_THRESHOLD = parseFloat(process.env.CLAW_CONTEXT_WARN_THRESHOLD || "0.70");
var CONTEXT_CHECKPOINT_THRESHOLD = parseFloat(process.env.CLAW_CONTEXT_CHECKPOINT_THRESHOLD || "0.80");
var ContextWindowTracker = class {
  /** Last known input_tokens from the most recent assistant message (cumulative per API) */
  lastInputTokens = 0;
  lastOutputTokens = 0;
  lastCacheReadTokens = 0;
  lastCacheCreationTokens = 0;
  contextWindow = 0;
  warnedAt70 = false;
  checkpointedAt80 = false;
  update(inputTokens, outputTokens, contextWindow, cacheReadTokens, cacheCreationTokens) {
    this.lastInputTokens = inputTokens;
    this.lastOutputTokens = outputTokens;
    if (contextWindow && contextWindow > 0) this.contextWindow = contextWindow;
    if (cacheReadTokens !== void 0) this.lastCacheReadTokens = cacheReadTokens;
    if (cacheCreationTokens !== void 0) this.lastCacheCreationTokens = cacheCreationTokens;
    const pct = this.getPercentage();
    if (pct < CONTEXT_WARN_THRESHOLD && this.warnedAt70) this.warnedAt70 = false;
    if (pct < CONTEXT_CHECKPOINT_THRESHOLD && this.checkpointedAt80) this.checkpointedAt80 = false;
  }
  getPercentage() {
    if (this.contextWindow <= 0) return 0;
    const effectiveTokens = this.lastInputTokens + this.lastCacheReadTokens;
    return effectiveTokens / this.contextWindow;
  }
  shouldWarn() {
    if (this.warnedAt70) return false;
    if (this.getPercentage() >= CONTEXT_WARN_THRESHOLD) {
      this.warnedAt70 = true;
      return true;
    }
    return false;
  }
  shouldCheckpoint() {
    if (this.checkpointedAt80) return false;
    if (this.getPercentage() >= CONTEXT_CHECKPOINT_THRESHOLD) {
      this.checkpointedAt80 = true;
      return true;
    }
    return false;
  }
  reset() {
    this.warnedAt70 = false;
    this.checkpointedAt80 = false;
  }
};
function createContextSafetyHook(tracker, activityPoster2, log4, workspaceDir) {
  return async (_input, _toolUseId, _context) => {
    if (workspaceDir) writeContextUsage(workspaceDir, tracker);
    const pct = tracker.getPercentage();
    if (tracker.shouldCheckpoint()) {
      const pctStr = Math.round(pct * 100);
      log4?.(`[context-safety] CHECKPOINT: Context at ${pctStr}% \u2014 advising agent to save progress`);
      activityPoster2?.post("status", `Context window at ${pctStr}% \u2014 checkpoint recommended`, {
        contextPercentage: pctStr,
        inputTokens: tracker.lastInputTokens,
        contextWindow: tracker.contextWindow
      });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          message: `WARNING: Your context window is ${pctStr}% full (${tracker.lastInputTokens.toLocaleString()} / ${tracker.contextWindow.toLocaleString()} tokens). Save your progress now: write important findings to MEMORY.md or files before context compaction occurs. Summarize your current state and next steps. Do NOT save transient error states (tool timeouts, connection failures, service outages) to MEMORY.md \u2014 those go to daily notes (memory/YYYY-MM-DD.md) only.`
        }
      };
    }
    if (tracker.shouldWarn()) {
      const pctStr = Math.round(pct * 100);
      log4?.(`[context-safety] WARNING: Context at ${pctStr}%`);
      activityPoster2?.post("status", `Context window at ${pctStr}%`, {
        contextPercentage: pctStr,
        inputTokens: tracker.lastInputTokens,
        contextWindow: tracker.contextWindow
      });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          message: `Note: Your context window is ${pctStr}% full. Be concise in your remaining tool calls and consider wrapping up soon.`
        }
      };
    }
    return {};
  };
}
async function postConvexActivity(convexUrl, token, agentId, type, content, metadata, taskId) {
  try {
    await fetch(`${convexUrl}/api/mutation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "agentActivity:push",
        args: { token, agentId, taskId, type, content: content.slice(0, 4e3), metadata }
      })
    });
  } catch {
  }
}
var ActivityPoster = class _ActivityPoster {
  static MAX_QUEUE = 500;
  convexUrl;
  token;
  agentId;
  queue = [];
  timer = null;
  droppedCount = 0;
  flushing = false;
  currentTaskId;
  constructor(convexUrl, token, agentId) {
    this.convexUrl = convexUrl;
    this.token = token;
    this.agentId = agentId;
    if (this.convexUrl && this.token) {
      this.timer = setInterval(() => this.flush(), 2e3);
    }
  }
  setTaskId(taskId) {
    this.currentTaskId = taskId;
  }
  post(type, content, metadata) {
    if (!this.convexUrl || !this.token) return;
    this.queue.push({ type, content: content.slice(0, 4e3), metadata, taskId: this.currentTaskId });
    while (this.queue.length > _ActivityPoster.MAX_QUEUE) {
      this.queue.shift();
      this.droppedCount++;
    }
  }
  getQueueSize() {
    return this.queue.length;
  }
  getDroppedCount() {
    return this.droppedCount;
  }
  async flush() {
    if (this.flushing || this.queue.length === 0 || !this.convexUrl || !this.token) return;
    this.flushing = true;
    try {
      const batch = this.queue.splice(0, 25);
      const results = await Promise.allSettled(
        batch.map(
          (event) => Promise.race([
            postConvexActivity(this.convexUrl, this.token, this.agentId, event.type, event.content, event.metadata, event.taskId),
            new Promise((_3, reject) => setTimeout(() => reject(new Error("Activity post timeout")), 1e4))
          ])
        )
      );
      const failed = results.filter((r3) => r3.status === "rejected").length;
      if (failed > 0) {
        console.error(`[activity-poster] ${failed}/${batch.length} events failed to post`);
      }
    } finally {
      this.flushing = false;
    }
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const deadline = Date.now() + 15e3;
    while (this.queue.length > 0 && Date.now() < deadline) {
      await this.flush();
    }
    if (this.queue.length > 0) {
      console.error(`[activity-poster] Shutdown: dropped ${this.queue.length} events (deadline exceeded)`);
    }
  }
};

// src/ui-stream.ts
import crypto from "crypto";
var UIStreamWriter = class {
  res;
  ended = false;
  textIdCounter = 0;
  reasoningIdCounter = 0;
  _currentTextId = null;
  _currentReasoningId = null;
  stepOpen = false;
  constructor(res) {
    this.res = res;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Vercel-AI-UI-Message-Stream": "v1",
      "X-Accel-Buffering": "no"
    });
  }
  // ─── Low-level ──────────────────────────────────────
  backpressureWarned = false;
  async write(chunk) {
    if (this.ended || this.res.destroyed) return;
    const ok = this.res.write(`data: ${JSON.stringify(chunk)}

`);
    if (!ok) {
      if (!this.backpressureWarned) {
        this.backpressureWarned = true;
        console.error("[ui-stream] Backpressure detected \u2014 pausing until drain");
      }
      await new Promise((resolve) => {
        const cleanup = () => {
          this.res.off("drain", onDrain);
          this.res.off("close", onClose);
          this.res.off("error", onClose);
        };
        const onDrain = () => {
          cleanup();
          resolve();
        };
        const onClose = () => {
          cleanup();
          resolve();
        };
        this.res.once("drain", onDrain);
        this.res.once("close", onClose);
        this.res.once("error", onClose);
      });
    }
  }
  // ─── Message Lifecycle ──────────────────────────────
  async start(messageId) {
    await this.write({
      type: "start",
      ...messageId ? { messageId } : {}
    });
  }
  async finish(finishReason = "stop", metadata) {
    await this.closeOpenBlocks();
    if (this.stepOpen) {
      await this.finishStep();
    }
    await this.write({
      type: "finish",
      finishReason,
      ...metadata ? { messageMetadata: metadata } : {}
    });
  }
  async startStep() {
    await this.write({ type: "start-step" });
    this.stepOpen = true;
  }
  async finishStep() {
    await this.closeOpenBlocks();
    await this.write({ type: "finish-step" });
    this.stepOpen = false;
  }
  // ─── Text Content ───────────────────────────────────
  get currentTextId() {
    return this._currentTextId;
  }
  async textStart(id) {
    const blockId = id ?? `text-${++this.textIdCounter}`;
    this._currentTextId = blockId;
    await this.write({ type: "text-start", id: blockId });
    return blockId;
  }
  async textDelta(delta, id) {
    if (!this._currentTextId) {
      await this.textStart(id);
    }
    await this.write({ type: "text-delta", id: this._currentTextId, delta });
  }
  async textEnd(id) {
    const blockId = id ?? this._currentTextId;
    if (!blockId) return;
    await this.write({ type: "text-end", id: blockId });
    this._currentTextId = null;
  }
  // ─── Reasoning/Thinking ─────────────────────────────
  get currentReasoningId() {
    return this._currentReasoningId;
  }
  async reasoningStart(id) {
    const blockId = id ?? `reasoning-${++this.reasoningIdCounter}`;
    this._currentReasoningId = blockId;
    await this.write({ type: "reasoning-start", id: blockId });
    return blockId;
  }
  async reasoningDelta(delta, id) {
    if (!this._currentReasoningId) {
      await this.reasoningStart(id);
    }
    await this.write({ type: "reasoning-delta", id: this._currentReasoningId, delta });
  }
  async reasoningEnd(id) {
    const blockId = id ?? this._currentReasoningId;
    if (!blockId) return;
    await this.write({ type: "reasoning-end", id: blockId });
    this._currentReasoningId = null;
  }
  // ─── Tool Calls ─────────────────────────────────────
  async toolInputStart(toolCallId, toolName) {
    await this.closeOpenBlocks();
    await this.write({ type: "tool-input-start", toolCallId, toolName });
  }
  async toolInputAvailable(toolCallId, toolName, input) {
    await this.write({ type: "tool-input-available", toolCallId, toolName, input });
  }
  async toolOutputAvailable(toolCallId, output) {
    await this.write({ type: "tool-output-available", toolCallId, output });
  }
  async toolOutputError(toolCallId, errorText) {
    await this.write({ type: "tool-output-error", toolCallId, errorText });
  }
  // ─── Custom Gallery Data ────────────────────────────
  async galleryData(name, data) {
    await this.write({ type: `data-gallery-${name}`, data });
  }
  async galleryStreamId(streamId) {
    await this.galleryData("stream-id", { streamId });
  }
  async galleryProgress(data) {
    await this.galleryData("progress", data);
  }
  async galleryCompacting(status) {
    await this.galleryData("compacting", { status });
  }
  async galleryReview(data) {
    await this.galleryData("review", data);
  }
  // ─── Metadata ───────────────────────────────────────
  async messageMetadata(metadata) {
    await this.write({ type: "message-metadata", messageMetadata: metadata });
  }
  // ─── Error / Abort ──────────────────────────────────
  async error(errorText) {
    await this.closeOpenBlocks();
    await this.write({ type: "error", errorText });
  }
  async abort(reason) {
    await this.closeOpenBlocks();
    await this.write({ type: "abort", ...reason ? { reason } : {} });
  }
  // ─── Stream Termination ─────────────────────────────
  done() {
    if (this.ended) return;
    this.ended = true;
    if (!this.res.destroyed) {
      this.res.write("data: [DONE]\n\n");
      this.res.end();
    }
  }
  get isEnded() {
    return this.ended;
  }
  // ─── Helpers ────────────────────────────────────────
  /** Close any open text or reasoning blocks. */
  async closeOpenBlocks() {
    if (this._currentTextId) await this.textEnd();
    if (this._currentReasoningId) await this.reasoningEnd();
  }
  /** Whether a step boundary is needed before the next content. */
  needsStepBoundary(lastEmittedToolOutput) {
    return lastEmittedToolOutput && this.stepOpen;
  }
  /** Emit step boundary (finish current step, start new one). */
  async emitStepBoundary() {
    await this.finishStep();
    await this.startStep();
  }
};
function generateMessageId() {
  return `msg_${crypto.randomBytes(8).toString("hex")}`;
}
function generateStreamId() {
  return `stream_${crypto.randomBytes(8).toString("hex")}`;
}

// src/session-manager.ts
import fs2 from "fs";
import path2 from "path";

// node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs
import { join as sD } from "path";
import { fileURLToPath as Mx } from "url";
import { setMaxListeners as ML } from "events";
import { spawn as YI } from "child_process";
import { createInterface as QI } from "readline";
import { randomUUID as fj } from "crypto";
import { appendFile as hj, mkdir as uj } from "fs/promises";
import { join as VH } from "path";
import { join as yj } from "path";
import { homedir as gj } from "os";
import { appendFile as lF, mkdir as cF, unlink as iF, symlink as pF } from "fs/promises";
import { dirname as DK, join as LK } from "path";
import { cwd as lj } from "process";
import { realpathSync as OH } from "fs";
import { randomUUID as t9 } from "crypto";
import * as r from "fs";
import { stat as CF, readdir as kF, readFile as BK, unlink as _F, rmdir as xF, rm as TF, mkdir as yF, rename as gF, open as fF } from "fs/promises";
import { join as bK } from "path";
import { fileURLToPath as GI } from "url";
import { readFile as SI } from "fs/promises";
import { open as EK, readdir as hz, realpath as VI, stat as fz } from "fs/promises";
import { join as Y0 } from "path";
import { execFile as HI } from "child_process";
import { promisify as KI } from "util";
import { basename as gI, join as mz } from "path";
import { readdir as lz, stat as fI } from "fs/promises";
import { constants as yK } from "fs";
import { readdir as nI, open as dI } from "fs/promises";
import { join as iz } from "path";
import { readFile as rI, writeFile as oI, readdir as tI } from "fs/promises";
import { join as nz } from "path";
import { randomUUID as uK } from "crypto";
var NL = Object.create;
var { getPrototypeOf: VL, defineProperty: s7, getOwnPropertyNames: OL } = Object;
var wL = Object.prototype.hasOwnProperty;
function BL($) {
  return this[$];
}
var qL;
var DL;
var xU = ($, X, J) => {
  var Q = $ != null && typeof $ === "object";
  if (Q) {
    var Y = X ? qL ??= /* @__PURE__ */ new WeakMap() : DL ??= /* @__PURE__ */ new WeakMap(), z = Y.get($);
    if (z) return z;
  }
  J = $ != null ? NL(VL($)) : {};
  let W = X || !$ || !$.__esModule ? s7(J, "default", { value: $, enumerable: true }) : J;
  for (let G of OL($)) if (!wL.call(W, G)) s7(W, G, { get: BL.bind($, G), enumerable: true });
  if (Q) Y.set($, W);
  return W;
};
var k = ($, X) => () => (X || $((X = { exports: {} }).exports, X), X.exports);
var LL = ($) => $;
function jL($, X) {
  this[$] = LL.bind(null, X);
}
var e4 = ($, X) => {
  for (var J in X) s7($, J, { get: X[J], enumerable: true, configurable: true, set: jL.bind(X, J) });
};
var FL = Symbol.dispose || /* @__PURE__ */ Symbol.for("Symbol.dispose");
var IL = Symbol.asyncDispose || /* @__PURE__ */ Symbol.for("Symbol.asyncDispose");
var N$ = ($, X, J) => {
  if (X != null) {
    if (typeof X !== "object" && typeof X !== "function") throw TypeError('Object expected to be assigned to "using" declaration');
    var Q;
    if (J) Q = X[IL];
    if (Q === void 0) Q = X[FL];
    if (typeof Q !== "function") throw TypeError("Object not disposable");
    $.push([J, Q, X]);
  } else if (J) $.push([J]);
  return X;
};
var V$ = ($, X, J) => {
  var Q = typeof SuppressedError === "function" ? SuppressedError : function(W, G, U, H) {
    return H = Error(U), H.name = "SuppressedError", H.error = W, H.suppressed = G, H;
  }, Y = (W) => X = J ? new Q(W, X, "An error was suppressed during disposal") : (J = true, W), z = (W) => {
    while (W = $.pop()) try {
      var G = W[1] && W[1].call(W[2]);
      if (W[0]) return Promise.resolve(G).then(z, (U) => (Y(U), z()));
    } catch (U) {
      Y(U);
    }
    if (J) throw X;
  };
  return z();
};
var M9 = k((QO) => {
  Object.defineProperty(QO, "__esModule", { value: true });
  QO.regexpCode = QO.getEsmExportName = QO.getProperty = QO.safeStringify = QO.stringify = QO.strConcat = QO.addCodeArg = QO.str = QO._ = QO.nil = QO._Code = QO.Name = QO.IDENTIFIER = QO._CodeOrName = void 0;
  class w7 {
  }
  QO._CodeOrName = w7;
  QO.IDENTIFIER = /^[a-z$_][a-z$_0-9]*$/i;
  class y0 extends w7 {
    constructor($) {
      super();
      if (!QO.IDENTIFIER.test($)) throw Error("CodeGen: name must be a valid identifier");
      this.str = $;
    }
    toString() {
      return this.str;
    }
    emptyStr() {
      return false;
    }
    get names() {
      return { [this.str]: 1 };
    }
  }
  QO.Name = y0;
  class C6 extends w7 {
    constructor($) {
      super();
      this._items = typeof $ === "string" ? [$] : $;
    }
    toString() {
      return this.str;
    }
    emptyStr() {
      if (this._items.length > 1) return false;
      let $ = this._items[0];
      return $ === "" || $ === '""';
    }
    get str() {
      var $;
      return ($ = this._str) !== null && $ !== void 0 ? $ : this._str = this._items.reduce((X, J) => `${X}${J}`, "");
    }
    get names() {
      var $;
      return ($ = this._names) !== null && $ !== void 0 ? $ : this._names = this._items.reduce((X, J) => {
        if (J instanceof y0) X[J.str] = (X[J.str] || 0) + 1;
        return X;
      }, {});
    }
  }
  QO._Code = C6;
  QO.nil = new C6("");
  function JO($, ...X) {
    let J = [$[0]], Q = 0;
    while (Q < X.length) j3(J, X[Q]), J.push($[++Q]);
    return new C6(J);
  }
  QO._ = JO;
  var L3 = new C6("+");
  function YO($, ...X) {
    let J = [I9($[0])], Q = 0;
    while (Q < X.length) J.push(L3), j3(J, X[Q]), J.push(L3, I9($[++Q]));
    return JZ(J), new C6(J);
  }
  QO.str = YO;
  function j3($, X) {
    if (X instanceof C6) $.push(...X._items);
    else if (X instanceof y0) $.push(X);
    else $.push(zZ(X));
  }
  QO.addCodeArg = j3;
  function JZ($) {
    let X = 1;
    while (X < $.length - 1) {
      if ($[X] === L3) {
        let J = YZ($[X - 1], $[X + 1]);
        if (J !== void 0) {
          $.splice(X - 1, 3, J);
          continue;
        }
        $[X++] = "+";
      }
      X++;
    }
  }
  function YZ($, X) {
    if (X === '""') return $;
    if ($ === '""') return X;
    if (typeof $ == "string") {
      if (X instanceof y0 || $[$.length - 1] !== '"') return;
      if (typeof X != "string") return `${$.slice(0, -1)}${X}"`;
      if (X[0] === '"') return $.slice(0, -1) + X.slice(1);
      return;
    }
    if (typeof X == "string" && X[0] === '"' && !($ instanceof y0)) return `"${$}${X.slice(1)}`;
    return;
  }
  function QZ($, X) {
    return X.emptyStr() ? $ : $.emptyStr() ? X : YO`${$}${X}`;
  }
  QO.strConcat = QZ;
  function zZ($) {
    return typeof $ == "number" || typeof $ == "boolean" || $ === null ? $ : I9(Array.isArray($) ? $.join(",") : $);
  }
  function WZ($) {
    return new C6(I9($));
  }
  QO.stringify = WZ;
  function I9($) {
    return JSON.stringify($).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  }
  QO.safeStringify = I9;
  function GZ($) {
    return typeof $ == "string" && QO.IDENTIFIER.test($) ? new C6(`.${$}`) : JO`[${$}]`;
  }
  QO.getProperty = GZ;
  function UZ($) {
    if (typeof $ == "string" && QO.IDENTIFIER.test($)) return new C6(`${$}`);
    throw Error(`CodeGen: invalid export name: ${$}, use explicit $id name mapping`);
  }
  QO.getEsmExportName = UZ;
  function HZ($) {
    return new C6($.toString());
  }
  QO.regexpCode = HZ;
});
var A3 = k((UO) => {
  Object.defineProperty(UO, "__esModule", { value: true });
  UO.ValueScope = UO.ValueScopeName = UO.Scope = UO.varKinds = UO.UsedValueState = void 0;
  var $6 = M9();
  class WO extends Error {
    constructor($) {
      super(`CodeGen: "code" for ${$} not defined`);
      this.value = $.value;
    }
  }
  var q7;
  (function($) {
    $[$.Started = 0] = "Started", $[$.Completed = 1] = "Completed";
  })(q7 || (UO.UsedValueState = q7 = {}));
  UO.varKinds = { const: new $6.Name("const"), let: new $6.Name("let"), var: new $6.Name("var") };
  class I3 {
    constructor({ prefixes: $, parent: X } = {}) {
      this._names = {}, this._prefixes = $, this._parent = X;
    }
    toName($) {
      return $ instanceof $6.Name ? $ : this.name($);
    }
    name($) {
      return new $6.Name(this._newName($));
    }
    _newName($) {
      let X = this._names[$] || this._nameGroup($);
      return `${$}${X.index++}`;
    }
    _nameGroup($) {
      var X, J;
      if (((J = (X = this._parent) === null || X === void 0 ? void 0 : X._prefixes) === null || J === void 0 ? void 0 : J.has($)) || this._prefixes && !this._prefixes.has($)) throw Error(`CodeGen: prefix "${$}" is not allowed in this scope`);
      return this._names[$] = { prefix: $, index: 0 };
    }
  }
  UO.Scope = I3;
  class M3 extends $6.Name {
    constructor($, X) {
      super(X);
      this.prefix = $;
    }
    setValue($, { property: X, itemIndex: J }) {
      this.value = $, this.scopePath = $6._`.${new $6.Name(X)}[${J}]`;
    }
  }
  UO.ValueScopeName = M3;
  var MZ = $6._`\n`;
  class GO extends I3 {
    constructor($) {
      super($);
      this._values = {}, this._scope = $.scope, this.opts = { ...$, _n: $.lines ? MZ : $6.nil };
    }
    get() {
      return this._scope;
    }
    name($) {
      return new M3($, this._newName($));
    }
    value($, X) {
      var J;
      if (X.ref === void 0) throw Error("CodeGen: ref must be passed in value");
      let Q = this.toName($), { prefix: Y } = Q, z = (J = X.key) !== null && J !== void 0 ? J : X.ref, W = this._values[Y];
      if (W) {
        let H = W.get(z);
        if (H) return H;
      } else W = this._values[Y] = /* @__PURE__ */ new Map();
      W.set(z, Q);
      let G = this._scope[Y] || (this._scope[Y] = []), U = G.length;
      return G[U] = X.ref, Q.setValue(X, { property: Y, itemIndex: U }), Q;
    }
    getValue($, X) {
      let J = this._values[$];
      if (!J) return;
      return J.get(X);
    }
    scopeRefs($, X = this._values) {
      return this._reduceValues(X, (J) => {
        if (J.scopePath === void 0) throw Error(`CodeGen: name "${J}" has no value`);
        return $6._`${$}${J.scopePath}`;
      });
    }
    scopeCode($ = this._values, X, J) {
      return this._reduceValues($, (Q) => {
        if (Q.value === void 0) throw Error(`CodeGen: name "${Q}" has no value`);
        return Q.value.code;
      }, X, J);
    }
    _reduceValues($, X, J = {}, Q) {
      let Y = $6.nil;
      for (let z in $) {
        let W = $[z];
        if (!W) continue;
        let G = J[z] = J[z] || /* @__PURE__ */ new Map();
        W.forEach((U) => {
          if (G.has(U)) return;
          G.set(U, q7.Started);
          let H = X(U);
          if (H) {
            let K = this.opts.es5 ? UO.varKinds.var : UO.varKinds.const;
            Y = $6._`${Y}${K} ${U} = ${H};${this.opts._n}`;
          } else if (H = Q === null || Q === void 0 ? void 0 : Q(U)) Y = $6._`${Y}${H}${this.opts._n}`;
          else throw new WO(U);
          G.set(U, q7.Completed);
        });
      }
      return Y;
    }
  }
  UO.ValueScope = GO;
});
var a = k((X6) => {
  Object.defineProperty(X6, "__esModule", { value: true });
  X6.or = X6.and = X6.not = X6.CodeGen = X6.operators = X6.varKinds = X6.ValueScopeName = X6.ValueScope = X6.Scope = X6.Name = X6.regexpCode = X6.stringify = X6.getProperty = X6.nil = X6.strConcat = X6.str = X6._ = void 0;
  var Y$ = M9(), k6 = A3(), l4 = M9();
  Object.defineProperty(X6, "_", { enumerable: true, get: function() {
    return l4._;
  } });
  Object.defineProperty(X6, "str", { enumerable: true, get: function() {
    return l4.str;
  } });
  Object.defineProperty(X6, "strConcat", { enumerable: true, get: function() {
    return l4.strConcat;
  } });
  Object.defineProperty(X6, "nil", { enumerable: true, get: function() {
    return l4.nil;
  } });
  Object.defineProperty(X6, "getProperty", { enumerable: true, get: function() {
    return l4.getProperty;
  } });
  Object.defineProperty(X6, "stringify", { enumerable: true, get: function() {
    return l4.stringify;
  } });
  Object.defineProperty(X6, "regexpCode", { enumerable: true, get: function() {
    return l4.regexpCode;
  } });
  Object.defineProperty(X6, "Name", { enumerable: true, get: function() {
    return l4.Name;
  } });
  var M7 = A3();
  Object.defineProperty(X6, "Scope", { enumerable: true, get: function() {
    return M7.Scope;
  } });
  Object.defineProperty(X6, "ValueScope", { enumerable: true, get: function() {
    return M7.ValueScope;
  } });
  Object.defineProperty(X6, "ValueScopeName", { enumerable: true, get: function() {
    return M7.ValueScopeName;
  } });
  Object.defineProperty(X6, "varKinds", { enumerable: true, get: function() {
    return M7.varKinds;
  } });
  X6.operators = { GT: new Y$._Code(">"), GTE: new Y$._Code(">="), LT: new Y$._Code("<"), LTE: new Y$._Code("<="), EQ: new Y$._Code("==="), NEQ: new Y$._Code("!=="), NOT: new Y$._Code("!"), OR: new Y$._Code("||"), AND: new Y$._Code("&&"), ADD: new Y$._Code("+") };
  class c4 {
    optimizeNodes() {
      return this;
    }
    optimizeNames($, X) {
      return this;
    }
  }
  class KO extends c4 {
    constructor($, X, J) {
      super();
      this.varKind = $, this.name = X, this.rhs = J;
    }
    render({ es5: $, _n: X }) {
      let J = $ ? k6.varKinds.var : this.varKind, Q = this.rhs === void 0 ? "" : ` = ${this.rhs}`;
      return `${J} ${this.name}${Q};` + X;
    }
    optimizeNames($, X) {
      if (!$[this.name.str]) return;
      if (this.rhs) this.rhs = f0(this.rhs, $, X);
      return this;
    }
    get names() {
      return this.rhs instanceof Y$._CodeOrName ? this.rhs.names : {};
    }
  }
  class Z3 extends c4 {
    constructor($, X, J) {
      super();
      this.lhs = $, this.rhs = X, this.sideEffects = J;
    }
    render({ _n: $ }) {
      return `${this.lhs} = ${this.rhs};` + $;
    }
    optimizeNames($, X) {
      if (this.lhs instanceof Y$.Name && !$[this.lhs.str] && !this.sideEffects) return;
      return this.rhs = f0(this.rhs, $, X), this;
    }
    get names() {
      let $ = this.lhs instanceof Y$.Name ? {} : { ...this.lhs.names };
      return I7($, this.rhs);
    }
  }
  class NO extends Z3 {
    constructor($, X, J, Q) {
      super($, J, Q);
      this.op = X;
    }
    render({ _n: $ }) {
      return `${this.lhs} ${this.op}= ${this.rhs};` + $;
    }
  }
  class VO extends c4 {
    constructor($) {
      super();
      this.label = $, this.names = {};
    }
    render({ _n: $ }) {
      return `${this.label}:` + $;
    }
  }
  class OO extends c4 {
    constructor($) {
      super();
      this.label = $, this.names = {};
    }
    render({ _n: $ }) {
      return `break${this.label ? ` ${this.label}` : ""};` + $;
    }
  }
  class wO extends c4 {
    constructor($) {
      super();
      this.error = $;
    }
    render({ _n: $ }) {
      return `throw ${this.error};` + $;
    }
    get names() {
      return this.error.names;
    }
  }
  class BO extends c4 {
    constructor($) {
      super();
      this.code = $;
    }
    render({ _n: $ }) {
      return `${this.code};` + $;
    }
    optimizeNodes() {
      return `${this.code}` ? this : void 0;
    }
    optimizeNames($, X) {
      return this.code = f0(this.code, $, X), this;
    }
    get names() {
      return this.code instanceof Y$._CodeOrName ? this.code.names : {};
    }
  }
  class A7 extends c4 {
    constructor($ = []) {
      super();
      this.nodes = $;
    }
    render($) {
      return this.nodes.reduce((X, J) => X + J.render($), "");
    }
    optimizeNodes() {
      let { nodes: $ } = this, X = $.length;
      while (X--) {
        let J = $[X].optimizeNodes();
        if (Array.isArray(J)) $.splice(X, 1, ...J);
        else if (J) $[X] = J;
        else $.splice(X, 1);
      }
      return $.length > 0 ? this : void 0;
    }
    optimizeNames($, X) {
      let { nodes: J } = this, Q = J.length;
      while (Q--) {
        let Y = J[Q];
        if (Y.optimizeNames($, X)) continue;
        ZZ($, Y.names), J.splice(Q, 1);
      }
      return J.length > 0 ? this : void 0;
    }
    get names() {
      return this.nodes.reduce(($, X) => Z1($, X.names), {});
    }
  }
  class i4 extends A7 {
    render($) {
      return "{" + $._n + super.render($) + "}" + $._n;
    }
  }
  class qO extends A7 {
  }
  class A9 extends i4 {
  }
  A9.kind = "else";
  class O4 extends i4 {
    constructor($, X) {
      super(X);
      this.condition = $;
    }
    render($) {
      let X = `if(${this.condition})` + super.render($);
      if (this.else) X += "else " + this.else.render($);
      return X;
    }
    optimizeNodes() {
      super.optimizeNodes();
      let $ = this.condition;
      if ($ === true) return this.nodes;
      let X = this.else;
      if (X) {
        let J = X.optimizeNodes();
        X = this.else = Array.isArray(J) ? new A9(J) : J;
      }
      if (X) {
        if ($ === false) return X instanceof O4 ? X : X.nodes;
        if (this.nodes.length) return this;
        return new O4(IO($), X instanceof O4 ? [X] : X.nodes);
      }
      if ($ === false || !this.nodes.length) return;
      return this;
    }
    optimizeNames($, X) {
      var J;
      if (this.else = (J = this.else) === null || J === void 0 ? void 0 : J.optimizeNames($, X), !(super.optimizeNames($, X) || this.else)) return;
      return this.condition = f0(this.condition, $, X), this;
    }
    get names() {
      let $ = super.names;
      if (I7($, this.condition), this.else) Z1($, this.else.names);
      return $;
    }
  }
  O4.kind = "if";
  class g0 extends i4 {
  }
  g0.kind = "for";
  class DO extends g0 {
    constructor($) {
      super();
      this.iteration = $;
    }
    render($) {
      return `for(${this.iteration})` + super.render($);
    }
    optimizeNames($, X) {
      if (!super.optimizeNames($, X)) return;
      return this.iteration = f0(this.iteration, $, X), this;
    }
    get names() {
      return Z1(super.names, this.iteration.names);
    }
  }
  class LO extends g0 {
    constructor($, X, J, Q) {
      super();
      this.varKind = $, this.name = X, this.from = J, this.to = Q;
    }
    render($) {
      let X = $.es5 ? k6.varKinds.var : this.varKind, { name: J, from: Q, to: Y } = this;
      return `for(${X} ${J}=${Q}; ${J}<${Y}; ${J}++)` + super.render($);
    }
    get names() {
      let $ = I7(super.names, this.from);
      return I7($, this.to);
    }
  }
  class b3 extends g0 {
    constructor($, X, J, Q) {
      super();
      this.loop = $, this.varKind = X, this.name = J, this.iterable = Q;
    }
    render($) {
      return `for(${this.varKind} ${this.name} ${this.loop} ${this.iterable})` + super.render($);
    }
    optimizeNames($, X) {
      if (!super.optimizeNames($, X)) return;
      return this.iterable = f0(this.iterable, $, X), this;
    }
    get names() {
      return Z1(super.names, this.iterable.names);
    }
  }
  class D7 extends i4 {
    constructor($, X, J) {
      super();
      this.name = $, this.args = X, this.async = J;
    }
    render($) {
      return `${this.async ? "async " : ""}function ${this.name}(${this.args})` + super.render($);
    }
  }
  D7.kind = "func";
  class L7 extends A7 {
    render($) {
      return "return " + super.render($);
    }
  }
  L7.kind = "return";
  class jO extends i4 {
    render($) {
      let X = "try" + super.render($);
      if (this.catch) X += this.catch.render($);
      if (this.finally) X += this.finally.render($);
      return X;
    }
    optimizeNodes() {
      var $, X;
      return super.optimizeNodes(), ($ = this.catch) === null || $ === void 0 || $.optimizeNodes(), (X = this.finally) === null || X === void 0 || X.optimizeNodes(), this;
    }
    optimizeNames($, X) {
      var J, Q;
      return super.optimizeNames($, X), (J = this.catch) === null || J === void 0 || J.optimizeNames($, X), (Q = this.finally) === null || Q === void 0 || Q.optimizeNames($, X), this;
    }
    get names() {
      let $ = super.names;
      if (this.catch) Z1($, this.catch.names);
      if (this.finally) Z1($, this.finally.names);
      return $;
    }
  }
  class j7 extends i4 {
    constructor($) {
      super();
      this.error = $;
    }
    render($) {
      return `catch(${this.error})` + super.render($);
    }
  }
  j7.kind = "catch";
  class F7 extends i4 {
    render($) {
      return "finally" + super.render($);
    }
  }
  F7.kind = "finally";
  class FO {
    constructor($, X = {}) {
      this._values = {}, this._blockStarts = [], this._constants = {}, this.opts = { ...X, _n: X.lines ? `
` : "" }, this._extScope = $, this._scope = new k6.Scope({ parent: $ }), this._nodes = [new qO()];
    }
    toString() {
      return this._root.render(this.opts);
    }
    name($) {
      return this._scope.name($);
    }
    scopeName($) {
      return this._extScope.name($);
    }
    scopeValue($, X) {
      let J = this._extScope.value($, X);
      return (this._values[J.prefix] || (this._values[J.prefix] = /* @__PURE__ */ new Set())).add(J), J;
    }
    getScopeValue($, X) {
      return this._extScope.getValue($, X);
    }
    scopeRefs($) {
      return this._extScope.scopeRefs($, this._values);
    }
    scopeCode() {
      return this._extScope.scopeCode(this._values);
    }
    _def($, X, J, Q) {
      let Y = this._scope.toName(X);
      if (J !== void 0 && Q) this._constants[Y.str] = J;
      return this._leafNode(new KO($, Y, J)), Y;
    }
    const($, X, J) {
      return this._def(k6.varKinds.const, $, X, J);
    }
    let($, X, J) {
      return this._def(k6.varKinds.let, $, X, J);
    }
    var($, X, J) {
      return this._def(k6.varKinds.var, $, X, J);
    }
    assign($, X, J) {
      return this._leafNode(new Z3($, X, J));
    }
    add($, X) {
      return this._leafNode(new NO($, X6.operators.ADD, X));
    }
    code($) {
      if (typeof $ == "function") $();
      else if ($ !== Y$.nil) this._leafNode(new BO($));
      return this;
    }
    object(...$) {
      let X = ["{"];
      for (let [J, Q] of $) {
        if (X.length > 1) X.push(",");
        if (X.push(J), J !== Q || this.opts.es5) X.push(":"), (0, Y$.addCodeArg)(X, Q);
      }
      return X.push("}"), new Y$._Code(X);
    }
    if($, X, J) {
      if (this._blockNode(new O4($)), X && J) this.code(X).else().code(J).endIf();
      else if (X) this.code(X).endIf();
      else if (J) throw Error('CodeGen: "else" body without "then" body');
      return this;
    }
    elseIf($) {
      return this._elseNode(new O4($));
    }
    else() {
      return this._elseNode(new A9());
    }
    endIf() {
      return this._endBlockNode(O4, A9);
    }
    _for($, X) {
      if (this._blockNode($), X) this.code(X).endFor();
      return this;
    }
    for($, X) {
      return this._for(new DO($), X);
    }
    forRange($, X, J, Q, Y = this.opts.es5 ? k6.varKinds.var : k6.varKinds.let) {
      let z = this._scope.toName($);
      return this._for(new LO(Y, z, X, J), () => Q(z));
    }
    forOf($, X, J, Q = k6.varKinds.const) {
      let Y = this._scope.toName($);
      if (this.opts.es5) {
        let z = X instanceof Y$.Name ? X : this.var("_arr", X);
        return this.forRange("_i", 0, Y$._`${z}.length`, (W) => {
          this.var(Y, Y$._`${z}[${W}]`), J(Y);
        });
      }
      return this._for(new b3("of", Q, Y, X), () => J(Y));
    }
    forIn($, X, J, Q = this.opts.es5 ? k6.varKinds.var : k6.varKinds.const) {
      if (this.opts.ownProperties) return this.forOf($, Y$._`Object.keys(${X})`, J);
      let Y = this._scope.toName($);
      return this._for(new b3("in", Q, Y, X), () => J(Y));
    }
    endFor() {
      return this._endBlockNode(g0);
    }
    label($) {
      return this._leafNode(new VO($));
    }
    break($) {
      return this._leafNode(new OO($));
    }
    return($) {
      let X = new L7();
      if (this._blockNode(X), this.code($), X.nodes.length !== 1) throw Error('CodeGen: "return" should have one node');
      return this._endBlockNode(L7);
    }
    try($, X, J) {
      if (!X && !J) throw Error('CodeGen: "try" without "catch" and "finally"');
      let Q = new jO();
      if (this._blockNode(Q), this.code($), X) {
        let Y = this.name("e");
        this._currNode = Q.catch = new j7(Y), X(Y);
      }
      if (J) this._currNode = Q.finally = new F7(), this.code(J);
      return this._endBlockNode(j7, F7);
    }
    throw($) {
      return this._leafNode(new wO($));
    }
    block($, X) {
      if (this._blockStarts.push(this._nodes.length), $) this.code($).endBlock(X);
      return this;
    }
    endBlock($) {
      let X = this._blockStarts.pop();
      if (X === void 0) throw Error("CodeGen: not in self-balancing block");
      let J = this._nodes.length - X;
      if (J < 0 || $ !== void 0 && J !== $) throw Error(`CodeGen: wrong number of nodes: ${J} vs ${$} expected`);
      return this._nodes.length = X, this;
    }
    func($, X = Y$.nil, J, Q) {
      if (this._blockNode(new D7($, X, J)), Q) this.code(Q).endFunc();
      return this;
    }
    endFunc() {
      return this._endBlockNode(D7);
    }
    optimize($ = 1) {
      while ($-- > 0) this._root.optimizeNodes(), this._root.optimizeNames(this._root.names, this._constants);
    }
    _leafNode($) {
      return this._currNode.nodes.push($), this;
    }
    _blockNode($) {
      this._currNode.nodes.push($), this._nodes.push($);
    }
    _endBlockNode($, X) {
      let J = this._currNode;
      if (J instanceof $ || X && J instanceof X) return this._nodes.pop(), this;
      throw Error(`CodeGen: not in block "${X ? `${$.kind}/${X.kind}` : $.kind}"`);
    }
    _elseNode($) {
      let X = this._currNode;
      if (!(X instanceof O4)) throw Error('CodeGen: "else" without "if"');
      return this._currNode = X.else = $, this;
    }
    get _root() {
      return this._nodes[0];
    }
    get _currNode() {
      let $ = this._nodes;
      return $[$.length - 1];
    }
    set _currNode($) {
      let X = this._nodes;
      X[X.length - 1] = $;
    }
  }
  X6.CodeGen = FO;
  function Z1($, X) {
    for (let J in X) $[J] = ($[J] || 0) + (X[J] || 0);
    return $;
  }
  function I7($, X) {
    return X instanceof Y$._CodeOrName ? Z1($, X.names) : $;
  }
  function f0($, X, J) {
    if ($ instanceof Y$.Name) return Q($);
    if (!Y($)) return $;
    return new Y$._Code($._items.reduce((z, W) => {
      if (W instanceof Y$.Name) W = Q(W);
      if (W instanceof Y$._Code) z.push(...W._items);
      else z.push(W);
      return z;
    }, []));
    function Q(z) {
      let W = J[z.str];
      if (W === void 0 || X[z.str] !== 1) return z;
      return delete X[z.str], W;
    }
    function Y(z) {
      return z instanceof Y$._Code && z._items.some((W) => W instanceof Y$.Name && X[W.str] === 1 && J[W.str] !== void 0);
    }
  }
  function ZZ($, X) {
    for (let J in X) $[J] = ($[J] || 0) - (X[J] || 0);
  }
  function IO($) {
    return typeof $ == "boolean" || typeof $ == "number" || $ === null ? !$ : Y$._`!${P3($)}`;
  }
  X6.not = IO;
  var EZ = MO(X6.operators.AND);
  function RZ(...$) {
    return $.reduce(EZ);
  }
  X6.and = RZ;
  var SZ = MO(X6.operators.OR);
  function vZ(...$) {
    return $.reduce(SZ);
  }
  X6.or = vZ;
  function MO($) {
    return (X, J) => X === Y$.nil ? J : J === Y$.nil ? X : Y$._`${P3(X)} ${$} ${P3(J)}`;
  }
  function P3($) {
    return $ instanceof Y$.Name ? $ : Y$._`(${$})`;
  }
});
var Q$ = k((CO) => {
  Object.defineProperty(CO, "__esModule", { value: true });
  CO.checkStrictMode = CO.getErrorPath = CO.Type = CO.useFunc = CO.setEvaluated = CO.evaluatedPropsToName = CO.mergeEvaluated = CO.eachItem = CO.unescapeJsonPointer = CO.escapeJsonPointer = CO.escapeFragment = CO.unescapeFragment = CO.schemaRefOrVal = CO.schemaHasRulesButRef = CO.schemaHasRules = CO.checkUnknownRules = CO.alwaysValidSchema = CO.toHash = void 0;
  var K$ = a(), xZ = M9();
  function TZ($) {
    let X = {};
    for (let J of $) X[J] = true;
    return X;
  }
  CO.toHash = TZ;
  function yZ($, X) {
    if (typeof X == "boolean") return X;
    if (Object.keys(X).length === 0) return true;
    return ZO($, X), !EO(X, $.self.RULES.all);
  }
  CO.alwaysValidSchema = yZ;
  function ZO($, X = $.schema) {
    let { opts: J, self: Q } = $;
    if (!J.strictSchema) return;
    if (typeof X === "boolean") return;
    let Y = Q.RULES.keywords;
    for (let z in X) if (!Y[z]) vO($, `unknown keyword: "${z}"`);
  }
  CO.checkUnknownRules = ZO;
  function EO($, X) {
    if (typeof $ == "boolean") return !$;
    for (let J in $) if (X[J]) return true;
    return false;
  }
  CO.schemaHasRules = EO;
  function gZ($, X) {
    if (typeof $ == "boolean") return !$;
    for (let J in $) if (J !== "$ref" && X.all[J]) return true;
    return false;
  }
  CO.schemaHasRulesButRef = gZ;
  function fZ({ topSchemaRef: $, schemaPath: X }, J, Q, Y) {
    if (!Y) {
      if (typeof J == "number" || typeof J == "boolean") return J;
      if (typeof J == "string") return K$._`${J}`;
    }
    return K$._`${$}${X}${(0, K$.getProperty)(Q)}`;
  }
  CO.schemaRefOrVal = fZ;
  function hZ($) {
    return RO(decodeURIComponent($));
  }
  CO.unescapeFragment = hZ;
  function uZ($) {
    return encodeURIComponent(R3($));
  }
  CO.escapeFragment = uZ;
  function R3($) {
    if (typeof $ == "number") return `${$}`;
    return $.replace(/~/g, "~0").replace(/\//g, "~1");
  }
  CO.escapeJsonPointer = R3;
  function RO($) {
    return $.replace(/~1/g, "/").replace(/~0/g, "~");
  }
  CO.unescapeJsonPointer = RO;
  function mZ($, X) {
    if (Array.isArray($)) for (let J of $) X(J);
    else X($);
  }
  CO.eachItem = mZ;
  function bO({ mergeNames: $, mergeToName: X, mergeValues: J, resultToName: Q }) {
    return (Y, z, W, G) => {
      let U = W === void 0 ? z : W instanceof K$.Name ? (z instanceof K$.Name ? $(Y, z, W) : X(Y, z, W), W) : z instanceof K$.Name ? (X(Y, W, z), z) : J(z, W);
      return G === K$.Name && !(U instanceof K$.Name) ? Q(Y, U) : U;
    };
  }
  CO.mergeEvaluated = { props: bO({ mergeNames: ($, X, J) => $.if(K$._`${J} !== true && ${X} !== undefined`, () => {
    $.if(K$._`${X} === true`, () => $.assign(J, true), () => $.assign(J, K$._`${J} || {}`).code(K$._`Object.assign(${J}, ${X})`));
  }), mergeToName: ($, X, J) => $.if(K$._`${J} !== true`, () => {
    if (X === true) $.assign(J, true);
    else $.assign(J, K$._`${J} || {}`), S3($, J, X);
  }), mergeValues: ($, X) => $ === true ? true : { ...$, ...X }, resultToName: SO }), items: bO({ mergeNames: ($, X, J) => $.if(K$._`${J} !== true && ${X} !== undefined`, () => $.assign(J, K$._`${X} === true ? true : ${J} > ${X} ? ${J} : ${X}`)), mergeToName: ($, X, J) => $.if(K$._`${J} !== true`, () => $.assign(J, X === true ? true : K$._`${J} > ${X} ? ${J} : ${X}`)), mergeValues: ($, X) => $ === true ? true : Math.max($, X), resultToName: ($, X) => $.var("items", X) }) };
  function SO($, X) {
    if (X === true) return $.var("props", true);
    let J = $.var("props", K$._`{}`);
    if (X !== void 0) S3($, J, X);
    return J;
  }
  CO.evaluatedPropsToName = SO;
  function S3($, X, J) {
    Object.keys(J).forEach((Q) => $.assign(K$._`${X}${(0, K$.getProperty)(Q)}`, true));
  }
  CO.setEvaluated = S3;
  var PO = {};
  function lZ($, X) {
    return $.scopeValue("func", { ref: X, code: PO[X.code] || (PO[X.code] = new xZ._Code(X.code)) });
  }
  CO.useFunc = lZ;
  var E3;
  (function($) {
    $[$.Num = 0] = "Num", $[$.Str = 1] = "Str";
  })(E3 || (CO.Type = E3 = {}));
  function cZ($, X, J) {
    if ($ instanceof K$.Name) {
      let Q = X === E3.Num;
      return J ? Q ? K$._`"[" + ${$} + "]"` : K$._`"['" + ${$} + "']"` : Q ? K$._`"/" + ${$}` : K$._`"/" + ${$}.replace(/~/g, "~0").replace(/\\//g, "~1")`;
    }
    return J ? (0, K$.getProperty)($).toString() : "/" + R3($);
  }
  CO.getErrorPath = cZ;
  function vO($, X, J = $.opts.strictSchema) {
    if (!J) return;
    if (X = `strict mode: ${X}`, J === true) throw Error(X);
    $.self.logger.warn(X);
  }
  CO.checkStrictMode = vO;
});
var w4 = k((_O) => {
  Object.defineProperty(_O, "__esModule", { value: true });
  var c$ = a(), GE = { data: new c$.Name("data"), valCxt: new c$.Name("valCxt"), instancePath: new c$.Name("instancePath"), parentData: new c$.Name("parentData"), parentDataProperty: new c$.Name("parentDataProperty"), rootData: new c$.Name("rootData"), dynamicAnchors: new c$.Name("dynamicAnchors"), vErrors: new c$.Name("vErrors"), errors: new c$.Name("errors"), this: new c$.Name("this"), self: new c$.Name("self"), scope: new c$.Name("scope"), json: new c$.Name("json"), jsonPos: new c$.Name("jsonPos"), jsonLen: new c$.Name("jsonLen"), jsonPart: new c$.Name("jsonPart") };
  _O.default = GE;
});
var b9 = k((gO) => {
  Object.defineProperty(gO, "__esModule", { value: true });
  gO.extendErrors = gO.resetErrorsCount = gO.reportExtraError = gO.reportError = gO.keyword$DataError = gO.keywordError = void 0;
  var z$ = a(), P7 = Q$(), r$ = w4();
  gO.keywordError = { message: ({ keyword: $ }) => z$.str`must pass "${$}" keyword validation` };
  gO.keyword$DataError = { message: ({ keyword: $, schemaType: X }) => X ? z$.str`"${$}" keyword must be ${X} ($data)` : z$.str`"${$}" keyword is invalid ($data)` };
  function HE($, X = gO.keywordError, J, Q) {
    let { it: Y } = $, { gen: z, compositeRule: W, allErrors: G } = Y, U = yO($, X, J);
    if (Q !== null && Q !== void 0 ? Q : W || G) xO(z, U);
    else TO(Y, z$._`[${U}]`);
  }
  gO.reportError = HE;
  function KE($, X = gO.keywordError, J) {
    let { it: Q } = $, { gen: Y, compositeRule: z, allErrors: W } = Q, G = yO($, X, J);
    if (xO(Y, G), !(z || W)) TO(Q, r$.default.vErrors);
  }
  gO.reportExtraError = KE;
  function NE($, X) {
    $.assign(r$.default.errors, X), $.if(z$._`${r$.default.vErrors} !== null`, () => $.if(X, () => $.assign(z$._`${r$.default.vErrors}.length`, X), () => $.assign(r$.default.vErrors, null)));
  }
  gO.resetErrorsCount = NE;
  function VE({ gen: $, keyword: X, schemaValue: J, data: Q, errsCount: Y, it: z }) {
    if (Y === void 0) throw Error("ajv implementation error");
    let W = $.name("err");
    $.forRange("i", Y, r$.default.errors, (G) => {
      if ($.const(W, z$._`${r$.default.vErrors}[${G}]`), $.if(z$._`${W}.instancePath === undefined`, () => $.assign(z$._`${W}.instancePath`, (0, z$.strConcat)(r$.default.instancePath, z.errorPath))), $.assign(z$._`${W}.schemaPath`, z$.str`${z.errSchemaPath}/${X}`), z.opts.verbose) $.assign(z$._`${W}.schema`, J), $.assign(z$._`${W}.data`, Q);
    });
  }
  gO.extendErrors = VE;
  function xO($, X) {
    let J = $.const("err", X);
    $.if(z$._`${r$.default.vErrors} === null`, () => $.assign(r$.default.vErrors, z$._`[${J}]`), z$._`${r$.default.vErrors}.push(${J})`), $.code(z$._`${r$.default.errors}++`);
  }
  function TO($, X) {
    let { gen: J, validateName: Q, schemaEnv: Y } = $;
    if (Y.$async) J.throw(z$._`new ${$.ValidationError}(${X})`);
    else J.assign(z$._`${Q}.errors`, X), J.return(false);
  }
  var E1 = { keyword: new z$.Name("keyword"), schemaPath: new z$.Name("schemaPath"), params: new z$.Name("params"), propertyName: new z$.Name("propertyName"), message: new z$.Name("message"), schema: new z$.Name("schema"), parentSchema: new z$.Name("parentSchema") };
  function yO($, X, J) {
    let { createErrors: Q } = $.it;
    if (Q === false) return z$._`{}`;
    return OE($, X, J);
  }
  function OE($, X, J = {}) {
    let { gen: Q, it: Y } = $, z = [wE(Y, J), BE($, J)];
    return qE($, X, z), Q.object(...z);
  }
  function wE({ errorPath: $ }, { instancePath: X }) {
    let J = X ? z$.str`${$}${(0, P7.getErrorPath)(X, P7.Type.Str)}` : $;
    return [r$.default.instancePath, (0, z$.strConcat)(r$.default.instancePath, J)];
  }
  function BE({ keyword: $, it: { errSchemaPath: X } }, { schemaPath: J, parentSchema: Q }) {
    let Y = Q ? X : z$.str`${X}/${$}`;
    if (J) Y = z$.str`${Y}${(0, P7.getErrorPath)(J, P7.Type.Str)}`;
    return [E1.schemaPath, Y];
  }
  function qE($, { params: X, message: J }, Q) {
    let { keyword: Y, data: z, schemaValue: W, it: G } = $, { opts: U, propertyName: H, topSchemaRef: K, schemaPath: V } = G;
    if (Q.push([E1.keyword, Y], [E1.params, typeof X == "function" ? X($) : X || z$._`{}`]), U.messages) Q.push([E1.message, typeof J == "function" ? J($) : J]);
    if (U.verbose) Q.push([E1.schema, W], [E1.parentSchema, z$._`${K}${V}`], [r$.default.data, z]);
    if (H) Q.push([E1.propertyName, H]);
  }
});
var lO = k((uO) => {
  Object.defineProperty(uO, "__esModule", { value: true });
  uO.boolOrEmptySchema = uO.topBoolOrEmptySchema = void 0;
  var IE = b9(), ME = a(), AE = w4(), bE = { message: "boolean schema is false" };
  function PE($) {
    let { gen: X, schema: J, validateName: Q } = $;
    if (J === false) hO($, false);
    else if (typeof J == "object" && J.$async === true) X.return(AE.default.data);
    else X.assign(ME._`${Q}.errors`, null), X.return(true);
  }
  uO.topBoolOrEmptySchema = PE;
  function ZE($, X) {
    let { gen: J, schema: Q } = $;
    if (Q === false) J.var(X, false), hO($);
    else J.var(X, true);
  }
  uO.boolOrEmptySchema = ZE;
  function hO($, X) {
    let { gen: J, data: Q } = $, Y = { gen: J, keyword: "false schema", data: Q, schema: false, schemaCode: false, schemaValue: false, params: {}, it: $ };
    (0, IE.reportError)(Y, bE, void 0, X);
  }
});
var C3 = k((cO) => {
  Object.defineProperty(cO, "__esModule", { value: true });
  cO.getRules = cO.isJSONType = void 0;
  var RE = ["string", "number", "integer", "boolean", "null", "object", "array"], SE = new Set(RE);
  function vE($) {
    return typeof $ == "string" && SE.has($);
  }
  cO.isJSONType = vE;
  function CE() {
    let $ = { number: { type: "number", rules: [] }, string: { type: "string", rules: [] }, array: { type: "array", rules: [] }, object: { type: "object", rules: [] } };
    return { types: { ...$, integer: true, boolean: true, null: true }, rules: [{ rules: [] }, $.number, $.string, $.array, $.object], post: { rules: [] }, all: {}, keywords: {} };
  }
  cO.getRules = CE;
});
var k3 = k((dO) => {
  Object.defineProperty(dO, "__esModule", { value: true });
  dO.shouldUseRule = dO.shouldUseGroup = dO.schemaHasRulesForType = void 0;
  function _E({ schema: $, self: X }, J) {
    let Q = X.RULES.types[J];
    return Q && Q !== true && pO($, Q);
  }
  dO.schemaHasRulesForType = _E;
  function pO($, X) {
    return X.rules.some((J) => nO($, J));
  }
  dO.shouldUseGroup = pO;
  function nO($, X) {
    var J;
    return $[X.keyword] !== void 0 || ((J = X.definition.implements) === null || J === void 0 ? void 0 : J.some((Q) => $[Q] !== void 0));
  }
  dO.shouldUseRule = nO;
});
var P9 = k((sO) => {
  Object.defineProperty(sO, "__esModule", { value: true });
  sO.reportTypeError = sO.checkDataTypes = sO.checkDataType = sO.coerceAndCheckDataType = sO.getJSONTypes = sO.getSchemaTypes = sO.DataType = void 0;
  var yE = C3(), gE = k3(), fE = b9(), t = a(), oO = Q$(), h0;
  (function($) {
    $[$.Correct = 0] = "Correct", $[$.Wrong = 1] = "Wrong";
  })(h0 || (sO.DataType = h0 = {}));
  function hE($) {
    let X = tO($.type);
    if (X.includes("null")) {
      if ($.nullable === false) throw Error("type: null contradicts nullable: false");
    } else {
      if (!X.length && $.nullable !== void 0) throw Error('"nullable" cannot be used without "type"');
      if ($.nullable === true) X.push("null");
    }
    return X;
  }
  sO.getSchemaTypes = hE;
  function tO($) {
    let X = Array.isArray($) ? $ : $ ? [$] : [];
    if (X.every(yE.isJSONType)) return X;
    throw Error("type must be JSONType or JSONType[]: " + X.join(","));
  }
  sO.getJSONTypes = tO;
  function uE($, X) {
    let { gen: J, data: Q, opts: Y } = $, z = mE(X, Y.coerceTypes), W = X.length > 0 && !(z.length === 0 && X.length === 1 && (0, gE.schemaHasRulesForType)($, X[0]));
    if (W) {
      let G = x3(X, Q, Y.strictNumbers, h0.Wrong);
      J.if(G, () => {
        if (z.length) lE($, X, z);
        else T3($);
      });
    }
    return W;
  }
  sO.coerceAndCheckDataType = uE;
  var aO = /* @__PURE__ */ new Set(["string", "number", "integer", "boolean", "null"]);
  function mE($, X) {
    return X ? $.filter((J) => aO.has(J) || X === "array" && J === "array") : [];
  }
  function lE($, X, J) {
    let { gen: Q, data: Y, opts: z } = $, W = Q.let("dataType", t._`typeof ${Y}`), G = Q.let("coerced", t._`undefined`);
    if (z.coerceTypes === "array") Q.if(t._`${W} == 'object' && Array.isArray(${Y}) && ${Y}.length == 1`, () => Q.assign(Y, t._`${Y}[0]`).assign(W, t._`typeof ${Y}`).if(x3(X, Y, z.strictNumbers), () => Q.assign(G, Y)));
    Q.if(t._`${G} !== undefined`);
    for (let H of J) if (aO.has(H) || H === "array" && z.coerceTypes === "array") U(H);
    Q.else(), T3($), Q.endIf(), Q.if(t._`${G} !== undefined`, () => {
      Q.assign(Y, G), cE($, G);
    });
    function U(H) {
      switch (H) {
        case "string":
          Q.elseIf(t._`${W} == "number" || ${W} == "boolean"`).assign(G, t._`"" + ${Y}`).elseIf(t._`${Y} === null`).assign(G, t._`""`);
          return;
        case "number":
          Q.elseIf(t._`${W} == "boolean" || ${Y} === null
              || (${W} == "string" && ${Y} && ${Y} == +${Y})`).assign(G, t._`+${Y}`);
          return;
        case "integer":
          Q.elseIf(t._`${W} === "boolean" || ${Y} === null
              || (${W} === "string" && ${Y} && ${Y} == +${Y} && !(${Y} % 1))`).assign(G, t._`+${Y}`);
          return;
        case "boolean":
          Q.elseIf(t._`${Y} === "false" || ${Y} === 0 || ${Y} === null`).assign(G, false).elseIf(t._`${Y} === "true" || ${Y} === 1`).assign(G, true);
          return;
        case "null":
          Q.elseIf(t._`${Y} === "" || ${Y} === 0 || ${Y} === false`), Q.assign(G, null);
          return;
        case "array":
          Q.elseIf(t._`${W} === "string" || ${W} === "number"
              || ${W} === "boolean" || ${Y} === null`).assign(G, t._`[${Y}]`);
      }
    }
  }
  function cE({ gen: $, parentData: X, parentDataProperty: J }, Q) {
    $.if(t._`${X} !== undefined`, () => $.assign(t._`${X}[${J}]`, Q));
  }
  function _3($, X, J, Q = h0.Correct) {
    let Y = Q === h0.Correct ? t.operators.EQ : t.operators.NEQ, z;
    switch ($) {
      case "null":
        return t._`${X} ${Y} null`;
      case "array":
        z = t._`Array.isArray(${X})`;
        break;
      case "object":
        z = t._`${X} && typeof ${X} == "object" && !Array.isArray(${X})`;
        break;
      case "integer":
        z = W(t._`!(${X} % 1) && !isNaN(${X})`);
        break;
      case "number":
        z = W();
        break;
      default:
        return t._`typeof ${X} ${Y} ${$}`;
    }
    return Q === h0.Correct ? z : (0, t.not)(z);
    function W(G = t.nil) {
      return (0, t.and)(t._`typeof ${X} == "number"`, G, J ? t._`isFinite(${X})` : t.nil);
    }
  }
  sO.checkDataType = _3;
  function x3($, X, J, Q) {
    if ($.length === 1) return _3($[0], X, J, Q);
    let Y, z = (0, oO.toHash)($);
    if (z.array && z.object) {
      let W = t._`typeof ${X} != "object"`;
      Y = z.null ? W : t._`!${X} || ${W}`, delete z.null, delete z.array, delete z.object;
    } else Y = t.nil;
    if (z.number) delete z.integer;
    for (let W in z) Y = (0, t.and)(Y, _3(W, X, J, Q));
    return Y;
  }
  sO.checkDataTypes = x3;
  var iE = { message: ({ schema: $ }) => `must be ${$}`, params: ({ schema: $, schemaValue: X }) => typeof $ == "string" ? t._`{type: ${$}}` : t._`{type: ${X}}` };
  function T3($) {
    let X = pE($);
    (0, fE.reportError)(X, iE);
  }
  sO.reportTypeError = T3;
  function pE($) {
    let { gen: X, data: J, schema: Q } = $, Y = (0, oO.schemaRefOrVal)($, Q, "type");
    return { gen: X, keyword: "type", data: J, schema: Q.type, schemaCode: Y, schemaValue: Y, parentSchema: Q, params: {}, it: $ };
  }
});
var Yw = k((Xw) => {
  Object.defineProperty(Xw, "__esModule", { value: true });
  Xw.assignDefaults = void 0;
  var u0 = a(), sE = Q$();
  function eE($, X) {
    let { properties: J, items: Q } = $.schema;
    if (X === "object" && J) for (let Y in J) $w($, Y, J[Y].default);
    else if (X === "array" && Array.isArray(Q)) Q.forEach((Y, z) => $w($, z, Y.default));
  }
  Xw.assignDefaults = eE;
  function $w($, X, J) {
    let { gen: Q, compositeRule: Y, data: z, opts: W } = $;
    if (J === void 0) return;
    let G = u0._`${z}${(0, u0.getProperty)(X)}`;
    if (Y) {
      (0, sE.checkStrictMode)($, `default is ignored for: ${G}`);
      return;
    }
    let U = u0._`${G} === undefined`;
    if (W.useDefaults === "empty") U = u0._`${U} || ${G} === null || ${G} === ""`;
    Q.if(U, u0._`${G} = ${(0, u0.stringify)(J)}`);
  }
});
var M6 = k((Ww) => {
  Object.defineProperty(Ww, "__esModule", { value: true });
  Ww.validateUnion = Ww.validateArray = Ww.usePattern = Ww.callValidateCode = Ww.schemaProperties = Ww.allSchemaProperties = Ww.noPropertyInData = Ww.propertyInData = Ww.isOwnProperty = Ww.hasPropFunc = Ww.reportMissingProp = Ww.checkMissingProp = Ww.checkReportMissingProp = void 0;
  var j$ = a(), y3 = Q$(), p4 = w4(), $R = Q$();
  function XR($, X) {
    let { gen: J, data: Q, it: Y } = $;
    J.if(f3(J, Q, X, Y.opts.ownProperties), () => {
      $.setParams({ missingProperty: j$._`${X}` }, true), $.error();
    });
  }
  Ww.checkReportMissingProp = XR;
  function JR({ gen: $, data: X, it: { opts: J } }, Q, Y) {
    return (0, j$.or)(...Q.map((z) => (0, j$.and)(f3($, X, z, J.ownProperties), j$._`${Y} = ${z}`)));
  }
  Ww.checkMissingProp = JR;
  function YR($, X) {
    $.setParams({ missingProperty: X }, true), $.error();
  }
  Ww.reportMissingProp = YR;
  function Qw($) {
    return $.scopeValue("func", { ref: Object.prototype.hasOwnProperty, code: j$._`Object.prototype.hasOwnProperty` });
  }
  Ww.hasPropFunc = Qw;
  function g3($, X, J) {
    return j$._`${Qw($)}.call(${X}, ${J})`;
  }
  Ww.isOwnProperty = g3;
  function QR($, X, J, Q) {
    let Y = j$._`${X}${(0, j$.getProperty)(J)} !== undefined`;
    return Q ? j$._`${Y} && ${g3($, X, J)}` : Y;
  }
  Ww.propertyInData = QR;
  function f3($, X, J, Q) {
    let Y = j$._`${X}${(0, j$.getProperty)(J)} === undefined`;
    return Q ? (0, j$.or)(Y, (0, j$.not)(g3($, X, J))) : Y;
  }
  Ww.noPropertyInData = f3;
  function zw($) {
    return $ ? Object.keys($).filter((X) => X !== "__proto__") : [];
  }
  Ww.allSchemaProperties = zw;
  function zR($, X) {
    return zw(X).filter((J) => !(0, y3.alwaysValidSchema)($, X[J]));
  }
  Ww.schemaProperties = zR;
  function WR({ schemaCode: $, data: X, it: { gen: J, topSchemaRef: Q, schemaPath: Y, errorPath: z }, it: W }, G, U, H) {
    let K = H ? j$._`${$}, ${X}, ${Q}${Y}` : X, V = [[p4.default.instancePath, (0, j$.strConcat)(p4.default.instancePath, z)], [p4.default.parentData, W.parentData], [p4.default.parentDataProperty, W.parentDataProperty], [p4.default.rootData, p4.default.rootData]];
    if (W.opts.dynamicRef) V.push([p4.default.dynamicAnchors, p4.default.dynamicAnchors]);
    let O = j$._`${K}, ${J.object(...V)}`;
    return U !== j$.nil ? j$._`${G}.call(${U}, ${O})` : j$._`${G}(${O})`;
  }
  Ww.callValidateCode = WR;
  var GR = j$._`new RegExp`;
  function UR({ gen: $, it: { opts: X } }, J) {
    let Q = X.unicodeRegExp ? "u" : "", { regExp: Y } = X.code, z = Y(J, Q);
    return $.scopeValue("pattern", { key: z.toString(), ref: z, code: j$._`${Y.code === "new RegExp" ? GR : (0, $R.useFunc)($, Y)}(${J}, ${Q})` });
  }
  Ww.usePattern = UR;
  function HR($) {
    let { gen: X, data: J, keyword: Q, it: Y } = $, z = X.name("valid");
    if (Y.allErrors) {
      let G = X.let("valid", true);
      return W(() => X.assign(G, false)), G;
    }
    return X.var(z, true), W(() => X.break()), z;
    function W(G) {
      let U = X.const("len", j$._`${J}.length`);
      X.forRange("i", 0, U, (H) => {
        $.subschema({ keyword: Q, dataProp: H, dataPropType: y3.Type.Num }, z), X.if((0, j$.not)(z), G);
      });
    }
  }
  Ww.validateArray = HR;
  function KR($) {
    let { gen: X, schema: J, keyword: Q, it: Y } = $;
    if (!Array.isArray(J)) throw Error("ajv implementation error");
    if (J.some((U) => (0, y3.alwaysValidSchema)(Y, U)) && !Y.opts.unevaluated) return;
    let W = X.let("valid", false), G = X.name("_valid");
    X.block(() => J.forEach((U, H) => {
      let K = $.subschema({ keyword: Q, schemaProp: H, compositeRule: true }, G);
      if (X.assign(W, j$._`${W} || ${G}`), !$.mergeValidEvaluated(K, G)) X.if((0, j$.not)(W));
    })), $.result(W, () => $.reset(), () => $.error(true));
  }
  Ww.validateUnion = KR;
});
var Vw = k((Kw) => {
  Object.defineProperty(Kw, "__esModule", { value: true });
  Kw.validateKeywordUsage = Kw.validSchemaType = Kw.funcKeywordCode = Kw.macroKeywordCode = void 0;
  var o$ = a(), R1 = w4(), AR = M6(), bR = b9();
  function PR($, X) {
    let { gen: J, keyword: Q, schema: Y, parentSchema: z, it: W } = $, G = X.macro.call(W.self, Y, z, W), U = Hw(J, Q, G);
    if (W.opts.validateSchema !== false) W.self.validateSchema(G, true);
    let H = J.name("valid");
    $.subschema({ schema: G, schemaPath: o$.nil, errSchemaPath: `${W.errSchemaPath}/${Q}`, topSchemaRef: U, compositeRule: true }, H), $.pass(H, () => $.error(true));
  }
  Kw.macroKeywordCode = PR;
  function ZR($, X) {
    var J;
    let { gen: Q, keyword: Y, schema: z, parentSchema: W, $data: G, it: U } = $;
    RR(U, X);
    let H = !G && X.compile ? X.compile.call(U.self, z, W, U) : X.validate, K = Hw(Q, Y, H), V = Q.let("valid");
    $.block$data(V, O), $.ok((J = X.valid) !== null && J !== void 0 ? J : V);
    function O() {
      if (X.errors === false) {
        if (B(), X.modifying) Uw($);
        L(() => $.error());
      } else {
        let j = X.async ? N() : w();
        if (X.modifying) Uw($);
        L(() => ER($, j));
      }
    }
    function N() {
      let j = Q.let("ruleErrs", null);
      return Q.try(() => B(o$._`await `), (M) => Q.assign(V, false).if(o$._`${M} instanceof ${U.ValidationError}`, () => Q.assign(j, o$._`${M}.errors`), () => Q.throw(M))), j;
    }
    function w() {
      let j = o$._`${K}.errors`;
      return Q.assign(j, null), B(o$.nil), j;
    }
    function B(j = X.async ? o$._`await ` : o$.nil) {
      let M = U.opts.passContext ? R1.default.this : R1.default.self, b = !("compile" in X && !G || X.schema === false);
      Q.assign(V, o$._`${j}${(0, AR.callValidateCode)($, K, M, b)}`, X.modifying);
    }
    function L(j) {
      var M;
      Q.if((0, o$.not)((M = X.valid) !== null && M !== void 0 ? M : V), j);
    }
  }
  Kw.funcKeywordCode = ZR;
  function Uw($) {
    let { gen: X, data: J, it: Q } = $;
    X.if(Q.parentData, () => X.assign(J, o$._`${Q.parentData}[${Q.parentDataProperty}]`));
  }
  function ER($, X) {
    let { gen: J } = $;
    J.if(o$._`Array.isArray(${X})`, () => {
      J.assign(R1.default.vErrors, o$._`${R1.default.vErrors} === null ? ${X} : ${R1.default.vErrors}.concat(${X})`).assign(R1.default.errors, o$._`${R1.default.vErrors}.length`), (0, bR.extendErrors)($);
    }, () => $.error());
  }
  function RR({ schemaEnv: $ }, X) {
    if (X.async && !$.$async) throw Error("async keyword in sync schema");
  }
  function Hw($, X, J) {
    if (J === void 0) throw Error(`keyword "${X}" failed to compile`);
    return $.scopeValue("keyword", typeof J == "function" ? { ref: J } : { ref: J, code: (0, o$.stringify)(J) });
  }
  function SR($, X, J = false) {
    return !X.length || X.some((Q) => Q === "array" ? Array.isArray($) : Q === "object" ? $ && typeof $ == "object" && !Array.isArray($) : typeof $ == Q || J && typeof $ > "u");
  }
  Kw.validSchemaType = SR;
  function vR({ schema: $, opts: X, self: J, errSchemaPath: Q }, Y, z) {
    if (Array.isArray(Y.keyword) ? !Y.keyword.includes(z) : Y.keyword !== z) throw Error("ajv implementation error");
    let W = Y.dependencies;
    if (W === null || W === void 0 ? void 0 : W.some((G) => !Object.prototype.hasOwnProperty.call($, G))) throw Error(`parent schema must have dependencies of ${z}: ${W.join(",")}`);
    if (Y.validateSchema) {
      if (!Y.validateSchema($[z])) {
        let U = `keyword "${z}" value is invalid at path "${Q}": ` + J.errorsText(Y.validateSchema.errors);
        if (X.validateSchema === "log") J.logger.error(U);
        else throw Error(U);
      }
    }
  }
  Kw.validateKeywordUsage = vR;
});
var qw = k((ww) => {
  Object.defineProperty(ww, "__esModule", { value: true });
  ww.extendSubschemaMode = ww.extendSubschemaData = ww.getSubschema = void 0;
  var i6 = a(), Ow = Q$();
  function xR($, { keyword: X, schemaProp: J, schema: Q, schemaPath: Y, errSchemaPath: z, topSchemaRef: W }) {
    if (X !== void 0 && Q !== void 0) throw Error('both "keyword" and "schema" passed, only one allowed');
    if (X !== void 0) {
      let G = $.schema[X];
      return J === void 0 ? { schema: G, schemaPath: i6._`${$.schemaPath}${(0, i6.getProperty)(X)}`, errSchemaPath: `${$.errSchemaPath}/${X}` } : { schema: G[J], schemaPath: i6._`${$.schemaPath}${(0, i6.getProperty)(X)}${(0, i6.getProperty)(J)}`, errSchemaPath: `${$.errSchemaPath}/${X}/${(0, Ow.escapeFragment)(J)}` };
    }
    if (Q !== void 0) {
      if (Y === void 0 || z === void 0 || W === void 0) throw Error('"schemaPath", "errSchemaPath" and "topSchemaRef" are required with "schema"');
      return { schema: Q, schemaPath: Y, topSchemaRef: W, errSchemaPath: z };
    }
    throw Error('either "keyword" or "schema" must be passed');
  }
  ww.getSubschema = xR;
  function TR($, X, { dataProp: J, dataPropType: Q, data: Y, dataTypes: z, propertyName: W }) {
    if (Y !== void 0 && J !== void 0) throw Error('both "data" and "dataProp" passed, only one allowed');
    let { gen: G } = X;
    if (J !== void 0) {
      let { errorPath: H, dataPathArr: K, opts: V } = X, O = G.let("data", i6._`${X.data}${(0, i6.getProperty)(J)}`, true);
      U(O), $.errorPath = i6.str`${H}${(0, Ow.getErrorPath)(J, Q, V.jsPropertySyntax)}`, $.parentDataProperty = i6._`${J}`, $.dataPathArr = [...K, $.parentDataProperty];
    }
    if (Y !== void 0) {
      let H = Y instanceof i6.Name ? Y : G.let("data", Y, true);
      if (U(H), W !== void 0) $.propertyName = W;
    }
    if (z) $.dataTypes = z;
    function U(H) {
      $.data = H, $.dataLevel = X.dataLevel + 1, $.dataTypes = [], X.definedProperties = /* @__PURE__ */ new Set(), $.parentData = X.data, $.dataNames = [...X.dataNames, H];
    }
  }
  ww.extendSubschemaData = TR;
  function yR($, { jtdDiscriminator: X, jtdMetadata: J, compositeRule: Q, createErrors: Y, allErrors: z }) {
    if (Q !== void 0) $.compositeRule = Q;
    if (Y !== void 0) $.createErrors = Y;
    if (z !== void 0) $.allErrors = z;
    $.jtdDiscriminator = X, $.jtdMetadata = J;
  }
  ww.extendSubschemaMode = yR;
});
var h3 = k((Ko, Dw) => {
  Dw.exports = function $(X, J) {
    if (X === J) return true;
    if (X && J && typeof X == "object" && typeof J == "object") {
      if (X.constructor !== J.constructor) return false;
      var Q, Y, z;
      if (Array.isArray(X)) {
        if (Q = X.length, Q != J.length) return false;
        for (Y = Q; Y-- !== 0; ) if (!$(X[Y], J[Y])) return false;
        return true;
      }
      if (X.constructor === RegExp) return X.source === J.source && X.flags === J.flags;
      if (X.valueOf !== Object.prototype.valueOf) return X.valueOf() === J.valueOf();
      if (X.toString !== Object.prototype.toString) return X.toString() === J.toString();
      if (z = Object.keys(X), Q = z.length, Q !== Object.keys(J).length) return false;
      for (Y = Q; Y-- !== 0; ) if (!Object.prototype.hasOwnProperty.call(J, z[Y])) return false;
      for (Y = Q; Y-- !== 0; ) {
        var W = z[Y];
        if (!$(X[W], J[W])) return false;
      }
      return true;
    }
    return X !== X && J !== J;
  };
});
var jw = k((No, Lw) => {
  var n4 = Lw.exports = function($, X, J) {
    if (typeof X == "function") J = X, X = {};
    J = X.cb || J;
    var Q = typeof J == "function" ? J : J.pre || function() {
    }, Y = J.post || function() {
    };
    Z7(X, Q, Y, $, "", $);
  };
  n4.keywords = { additionalItems: true, items: true, contains: true, additionalProperties: true, propertyNames: true, not: true, if: true, then: true, else: true };
  n4.arrayKeywords = { items: true, allOf: true, anyOf: true, oneOf: true };
  n4.propsKeywords = { $defs: true, definitions: true, properties: true, patternProperties: true, dependencies: true };
  n4.skipKeywords = { default: true, enum: true, const: true, required: true, maximum: true, minimum: true, exclusiveMaximum: true, exclusiveMinimum: true, multipleOf: true, maxLength: true, minLength: true, pattern: true, format: true, maxItems: true, minItems: true, uniqueItems: true, maxProperties: true, minProperties: true };
  function Z7($, X, J, Q, Y, z, W, G, U, H) {
    if (Q && typeof Q == "object" && !Array.isArray(Q)) {
      X(Q, Y, z, W, G, U, H);
      for (var K in Q) {
        var V = Q[K];
        if (Array.isArray(V)) {
          if (K in n4.arrayKeywords) for (var O = 0; O < V.length; O++) Z7($, X, J, V[O], Y + "/" + K + "/" + O, z, Y, K, Q, O);
        } else if (K in n4.propsKeywords) {
          if (V && typeof V == "object") for (var N in V) Z7($, X, J, V[N], Y + "/" + K + "/" + hR(N), z, Y, K, Q, N);
        } else if (K in n4.keywords || $.allKeys && !(K in n4.skipKeywords)) Z7($, X, J, V, Y + "/" + K, z, Y, K, Q);
      }
      J(Q, Y, z, W, G, U, H);
    }
  }
  function hR($) {
    return $.replace(/~/g, "~0").replace(/\//g, "~1");
  }
});
var Z9 = k((Aw) => {
  Object.defineProperty(Aw, "__esModule", { value: true });
  Aw.getSchemaRefs = Aw.resolveUrl = Aw.normalizeId = Aw._getFullPath = Aw.getFullPath = Aw.inlineRef = void 0;
  var uR = Q$(), mR = h3(), lR = jw(), cR = /* @__PURE__ */ new Set(["type", "format", "pattern", "maxLength", "minLength", "maxProperties", "minProperties", "maxItems", "minItems", "maximum", "minimum", "uniqueItems", "multipleOf", "required", "enum", "const"]);
  function iR($, X = true) {
    if (typeof $ == "boolean") return true;
    if (X === true) return !u3($);
    if (!X) return false;
    return Fw($) <= X;
  }
  Aw.inlineRef = iR;
  var pR = /* @__PURE__ */ new Set(["$ref", "$recursiveRef", "$recursiveAnchor", "$dynamicRef", "$dynamicAnchor"]);
  function u3($) {
    for (let X in $) {
      if (pR.has(X)) return true;
      let J = $[X];
      if (Array.isArray(J) && J.some(u3)) return true;
      if (typeof J == "object" && u3(J)) return true;
    }
    return false;
  }
  function Fw($) {
    let X = 0;
    for (let J in $) {
      if (J === "$ref") return 1 / 0;
      if (X++, cR.has(J)) continue;
      if (typeof $[J] == "object") (0, uR.eachItem)($[J], (Q) => X += Fw(Q));
      if (X === 1 / 0) return 1 / 0;
    }
    return X;
  }
  function Iw($, X = "", J) {
    if (J !== false) X = m0(X);
    let Q = $.parse(X);
    return Mw($, Q);
  }
  Aw.getFullPath = Iw;
  function Mw($, X) {
    return $.serialize(X).split("#")[0] + "#";
  }
  Aw._getFullPath = Mw;
  var nR = /#\/?$/;
  function m0($) {
    return $ ? $.replace(nR, "") : "";
  }
  Aw.normalizeId = m0;
  function dR($, X, J) {
    return J = m0(J), $.resolve(X, J);
  }
  Aw.resolveUrl = dR;
  var rR = /^[a-z_][-a-z0-9._]*$/i;
  function oR($, X) {
    if (typeof $ == "boolean") return {};
    let { schemaId: J, uriResolver: Q } = this.opts, Y = m0($[J] || X), z = { "": Y }, W = Iw(Q, Y, false), G = {}, U = /* @__PURE__ */ new Set();
    return lR($, { allKeys: true }, (V, O, N, w) => {
      if (w === void 0) return;
      let B = W + O, L = z[w];
      if (typeof V[J] == "string") L = j.call(this, V[J]);
      M.call(this, V.$anchor), M.call(this, V.$dynamicAnchor), z[O] = L;
      function j(b) {
        let x = this.opts.uriResolver.resolve;
        if (b = m0(L ? x(L, b) : b), U.has(b)) throw K(b);
        U.add(b);
        let h = this.refs[b];
        if (typeof h == "string") h = this.refs[h];
        if (typeof h == "object") H(V, h.schema, b);
        else if (b !== m0(B)) if (b[0] === "#") H(V, G[b], b), G[b] = V;
        else this.refs[b] = B;
        return b;
      }
      function M(b) {
        if (typeof b == "string") {
          if (!rR.test(b)) throw Error(`invalid anchor "${b}"`);
          j.call(this, `#${b}`);
        }
      }
    }), G;
    function H(V, O, N) {
      if (O !== void 0 && !mR(V, O)) throw K(N);
    }
    function K(V) {
      return Error(`reference "${V}" resolves to more than one schema`);
    }
  }
  Aw.getSchemaRefs = oR;
});
var S9 = k((hw) => {
  Object.defineProperty(hw, "__esModule", { value: true });
  hw.getData = hw.KeywordCxt = hw.validateFunctionCode = void 0;
  var Sw = lO(), Pw = P9(), l3 = k3(), E7 = P9(), XS = Yw(), R9 = Vw(), m3 = qw(), u = a(), d = w4(), JS = Z9(), B4 = Q$(), E9 = b9();
  function YS($) {
    if (kw($)) {
      if (_w($), Cw($)) {
        WS($);
        return;
      }
    }
    vw($, () => (0, Sw.topBoolOrEmptySchema)($));
  }
  hw.validateFunctionCode = YS;
  function vw({ gen: $, validateName: X, schema: J, schemaEnv: Q, opts: Y }, z) {
    if (Y.code.es5) $.func(X, u._`${d.default.data}, ${d.default.valCxt}`, Q.$async, () => {
      $.code(u._`"use strict"; ${Zw(J, Y)}`), zS($, Y), $.code(z);
    });
    else $.func(X, u._`${d.default.data}, ${QS(Y)}`, Q.$async, () => $.code(Zw(J, Y)).code(z));
  }
  function QS($) {
    return u._`{${d.default.instancePath}="", ${d.default.parentData}, ${d.default.parentDataProperty}, ${d.default.rootData}=${d.default.data}${$.dynamicRef ? u._`, ${d.default.dynamicAnchors}={}` : u.nil}}={}`;
  }
  function zS($, X) {
    $.if(d.default.valCxt, () => {
      if ($.var(d.default.instancePath, u._`${d.default.valCxt}.${d.default.instancePath}`), $.var(d.default.parentData, u._`${d.default.valCxt}.${d.default.parentData}`), $.var(d.default.parentDataProperty, u._`${d.default.valCxt}.${d.default.parentDataProperty}`), $.var(d.default.rootData, u._`${d.default.valCxt}.${d.default.rootData}`), X.dynamicRef) $.var(d.default.dynamicAnchors, u._`${d.default.valCxt}.${d.default.dynamicAnchors}`);
    }, () => {
      if ($.var(d.default.instancePath, u._`""`), $.var(d.default.parentData, u._`undefined`), $.var(d.default.parentDataProperty, u._`undefined`), $.var(d.default.rootData, d.default.data), X.dynamicRef) $.var(d.default.dynamicAnchors, u._`{}`);
    });
  }
  function WS($) {
    let { schema: X, opts: J, gen: Q } = $;
    vw($, () => {
      if (J.$comment && X.$comment) Tw($);
      if (NS($), Q.let(d.default.vErrors, null), Q.let(d.default.errors, 0), J.unevaluated) GS($);
      xw($), wS($);
    });
    return;
  }
  function GS($) {
    let { gen: X, validateName: J } = $;
    $.evaluated = X.const("evaluated", u._`${J}.evaluated`), X.if(u._`${$.evaluated}.dynamicProps`, () => X.assign(u._`${$.evaluated}.props`, u._`undefined`)), X.if(u._`${$.evaluated}.dynamicItems`, () => X.assign(u._`${$.evaluated}.items`, u._`undefined`));
  }
  function Zw($, X) {
    let J = typeof $ == "object" && $[X.schemaId];
    return J && (X.code.source || X.code.process) ? u._`/*# sourceURL=${J} */` : u.nil;
  }
  function US($, X) {
    if (kw($)) {
      if (_w($), Cw($)) {
        HS($, X);
        return;
      }
    }
    (0, Sw.boolOrEmptySchema)($, X);
  }
  function Cw({ schema: $, self: X }) {
    if (typeof $ == "boolean") return !$;
    for (let J in $) if (X.RULES.all[J]) return true;
    return false;
  }
  function kw($) {
    return typeof $.schema != "boolean";
  }
  function HS($, X) {
    let { schema: J, gen: Q, opts: Y } = $;
    if (Y.$comment && J.$comment) Tw($);
    VS($), OS($);
    let z = Q.const("_errs", d.default.errors);
    xw($, z), Q.var(X, u._`${z} === ${d.default.errors}`);
  }
  function _w($) {
    (0, B4.checkUnknownRules)($), KS($);
  }
  function xw($, X) {
    if ($.opts.jtd) return Ew($, [], false, X);
    let J = (0, Pw.getSchemaTypes)($.schema), Q = (0, Pw.coerceAndCheckDataType)($, J);
    Ew($, J, !Q, X);
  }
  function KS($) {
    let { schema: X, errSchemaPath: J, opts: Q, self: Y } = $;
    if (X.$ref && Q.ignoreKeywordsWithRef && (0, B4.schemaHasRulesButRef)(X, Y.RULES)) Y.logger.warn(`$ref: keywords ignored in schema at path "${J}"`);
  }
  function NS($) {
    let { schema: X, opts: J } = $;
    if (X.default !== void 0 && J.useDefaults && J.strictSchema) (0, B4.checkStrictMode)($, "default is ignored in the schema root");
  }
  function VS($) {
    let X = $.schema[$.opts.schemaId];
    if (X) $.baseId = (0, JS.resolveUrl)($.opts.uriResolver, $.baseId, X);
  }
  function OS($) {
    if ($.schema.$async && !$.schemaEnv.$async) throw Error("async schema in sync schema");
  }
  function Tw({ gen: $, schemaEnv: X, schema: J, errSchemaPath: Q, opts: Y }) {
    let z = J.$comment;
    if (Y.$comment === true) $.code(u._`${d.default.self}.logger.log(${z})`);
    else if (typeof Y.$comment == "function") {
      let W = u.str`${Q}/$comment`, G = $.scopeValue("root", { ref: X.root });
      $.code(u._`${d.default.self}.opts.$comment(${z}, ${W}, ${G}.schema)`);
    }
  }
  function wS($) {
    let { gen: X, schemaEnv: J, validateName: Q, ValidationError: Y, opts: z } = $;
    if (J.$async) X.if(u._`${d.default.errors} === 0`, () => X.return(d.default.data), () => X.throw(u._`new ${Y}(${d.default.vErrors})`));
    else {
      if (X.assign(u._`${Q}.errors`, d.default.vErrors), z.unevaluated) BS($);
      X.return(u._`${d.default.errors} === 0`);
    }
  }
  function BS({ gen: $, evaluated: X, props: J, items: Q }) {
    if (J instanceof u.Name) $.assign(u._`${X}.props`, J);
    if (Q instanceof u.Name) $.assign(u._`${X}.items`, Q);
  }
  function Ew($, X, J, Q) {
    let { gen: Y, schema: z, data: W, allErrors: G, opts: U, self: H } = $, { RULES: K } = H;
    if (z.$ref && (U.ignoreKeywordsWithRef || !(0, B4.schemaHasRulesButRef)(z, K))) {
      Y.block(() => gw($, "$ref", K.all.$ref.definition));
      return;
    }
    if (!U.jtd) qS($, X);
    Y.block(() => {
      for (let O of K.rules) V(O);
      V(K.post);
    });
    function V(O) {
      if (!(0, l3.shouldUseGroup)(z, O)) return;
      if (O.type) {
        if (Y.if((0, E7.checkDataType)(O.type, W, U.strictNumbers)), Rw($, O), X.length === 1 && X[0] === O.type && J) Y.else(), (0, E7.reportTypeError)($);
        Y.endIf();
      } else Rw($, O);
      if (!G) Y.if(u._`${d.default.errors} === ${Q || 0}`);
    }
  }
  function Rw($, X) {
    let { gen: J, schema: Q, opts: { useDefaults: Y } } = $;
    if (Y) (0, XS.assignDefaults)($, X.type);
    J.block(() => {
      for (let z of X.rules) if ((0, l3.shouldUseRule)(Q, z)) gw($, z.keyword, z.definition, X.type);
    });
  }
  function qS($, X) {
    if ($.schemaEnv.meta || !$.opts.strictTypes) return;
    if (DS($, X), !$.opts.allowUnionTypes) LS($, X);
    jS($, $.dataTypes);
  }
  function DS($, X) {
    if (!X.length) return;
    if (!$.dataTypes.length) {
      $.dataTypes = X;
      return;
    }
    X.forEach((J) => {
      if (!yw($.dataTypes, J)) c3($, `type "${J}" not allowed by context "${$.dataTypes.join(",")}"`);
    }), IS($, X);
  }
  function LS($, X) {
    if (X.length > 1 && !(X.length === 2 && X.includes("null"))) c3($, "use allowUnionTypes to allow union type keyword");
  }
  function jS($, X) {
    let J = $.self.RULES.all;
    for (let Q in J) {
      let Y = J[Q];
      if (typeof Y == "object" && (0, l3.shouldUseRule)($.schema, Y)) {
        let { type: z } = Y.definition;
        if (z.length && !z.some((W) => FS(X, W))) c3($, `missing type "${z.join(",")}" for keyword "${Q}"`);
      }
    }
  }
  function FS($, X) {
    return $.includes(X) || X === "number" && $.includes("integer");
  }
  function yw($, X) {
    return $.includes(X) || X === "integer" && $.includes("number");
  }
  function IS($, X) {
    let J = [];
    for (let Q of $.dataTypes) if (yw(X, Q)) J.push(Q);
    else if (X.includes("integer") && Q === "number") J.push("integer");
    $.dataTypes = J;
  }
  function c3($, X) {
    let J = $.schemaEnv.baseId + $.errSchemaPath;
    X += ` at "${J}" (strictTypes)`, (0, B4.checkStrictMode)($, X, $.opts.strictTypes);
  }
  class i3 {
    constructor($, X, J) {
      if ((0, R9.validateKeywordUsage)($, X, J), this.gen = $.gen, this.allErrors = $.allErrors, this.keyword = J, this.data = $.data, this.schema = $.schema[J], this.$data = X.$data && $.opts.$data && this.schema && this.schema.$data, this.schemaValue = (0, B4.schemaRefOrVal)($, this.schema, J, this.$data), this.schemaType = X.schemaType, this.parentSchema = $.schema, this.params = {}, this.it = $, this.def = X, this.$data) this.schemaCode = $.gen.const("vSchema", fw(this.$data, $));
      else if (this.schemaCode = this.schemaValue, !(0, R9.validSchemaType)(this.schema, X.schemaType, X.allowUndefined)) throw Error(`${J} value must be ${JSON.stringify(X.schemaType)}`);
      if ("code" in X ? X.trackErrors : X.errors !== false) this.errsCount = $.gen.const("_errs", d.default.errors);
    }
    result($, X, J) {
      this.failResult((0, u.not)($), X, J);
    }
    failResult($, X, J) {
      if (this.gen.if($), J) J();
      else this.error();
      if (X) {
        if (this.gen.else(), X(), this.allErrors) this.gen.endIf();
      } else if (this.allErrors) this.gen.endIf();
      else this.gen.else();
    }
    pass($, X) {
      this.failResult((0, u.not)($), void 0, X);
    }
    fail($) {
      if ($ === void 0) {
        if (this.error(), !this.allErrors) this.gen.if(false);
        return;
      }
      if (this.gen.if($), this.error(), this.allErrors) this.gen.endIf();
      else this.gen.else();
    }
    fail$data($) {
      if (!this.$data) return this.fail($);
      let { schemaCode: X } = this;
      this.fail(u._`${X} !== undefined && (${(0, u.or)(this.invalid$data(), $)})`);
    }
    error($, X, J) {
      if (X) {
        this.setParams(X), this._error($, J), this.setParams({});
        return;
      }
      this._error($, J);
    }
    _error($, X) {
      ($ ? E9.reportExtraError : E9.reportError)(this, this.def.error, X);
    }
    $dataError() {
      (0, E9.reportError)(this, this.def.$dataError || E9.keyword$DataError);
    }
    reset() {
      if (this.errsCount === void 0) throw Error('add "trackErrors" to keyword definition');
      (0, E9.resetErrorsCount)(this.gen, this.errsCount);
    }
    ok($) {
      if (!this.allErrors) this.gen.if($);
    }
    setParams($, X) {
      if (X) Object.assign(this.params, $);
      else this.params = $;
    }
    block$data($, X, J = u.nil) {
      this.gen.block(() => {
        this.check$data($, J), X();
      });
    }
    check$data($ = u.nil, X = u.nil) {
      if (!this.$data) return;
      let { gen: J, schemaCode: Q, schemaType: Y, def: z } = this;
      if (J.if((0, u.or)(u._`${Q} === undefined`, X)), $ !== u.nil) J.assign($, true);
      if (Y.length || z.validateSchema) {
        if (J.elseIf(this.invalid$data()), this.$dataError(), $ !== u.nil) J.assign($, false);
      }
      J.else();
    }
    invalid$data() {
      let { gen: $, schemaCode: X, schemaType: J, def: Q, it: Y } = this;
      return (0, u.or)(z(), W());
      function z() {
        if (J.length) {
          if (!(X instanceof u.Name)) throw Error("ajv implementation error");
          let G = Array.isArray(J) ? J : [J];
          return u._`${(0, E7.checkDataTypes)(G, X, Y.opts.strictNumbers, E7.DataType.Wrong)}`;
        }
        return u.nil;
      }
      function W() {
        if (Q.validateSchema) {
          let G = $.scopeValue("validate$data", { ref: Q.validateSchema });
          return u._`!${G}(${X})`;
        }
        return u.nil;
      }
    }
    subschema($, X) {
      let J = (0, m3.getSubschema)(this.it, $);
      (0, m3.extendSubschemaData)(J, this.it, $), (0, m3.extendSubschemaMode)(J, $);
      let Q = { ...this.it, ...J, items: void 0, props: void 0 };
      return US(Q, X), Q;
    }
    mergeEvaluated($, X) {
      let { it: J, gen: Q } = this;
      if (!J.opts.unevaluated) return;
      if (J.props !== true && $.props !== void 0) J.props = B4.mergeEvaluated.props(Q, $.props, J.props, X);
      if (J.items !== true && $.items !== void 0) J.items = B4.mergeEvaluated.items(Q, $.items, J.items, X);
    }
    mergeValidEvaluated($, X) {
      let { it: J, gen: Q } = this;
      if (J.opts.unevaluated && (J.props !== true || J.items !== true)) return Q.if(X, () => this.mergeEvaluated($, u.Name)), true;
    }
  }
  hw.KeywordCxt = i3;
  function gw($, X, J, Q) {
    let Y = new i3($, J, X);
    if ("code" in J) J.code(Y, Q);
    else if (Y.$data && J.validate) (0, R9.funcKeywordCode)(Y, J);
    else if ("macro" in J) (0, R9.macroKeywordCode)(Y, J);
    else if (J.compile || J.validate) (0, R9.funcKeywordCode)(Y, J);
  }
  var MS = /^\/(?:[^~]|~0|~1)*$/, AS = /^([0-9]+)(#|\/(?:[^~]|~0|~1)*)?$/;
  function fw($, { dataLevel: X, dataNames: J, dataPathArr: Q }) {
    let Y, z;
    if ($ === "") return d.default.rootData;
    if ($[0] === "/") {
      if (!MS.test($)) throw Error(`Invalid JSON-pointer: ${$}`);
      Y = $, z = d.default.rootData;
    } else {
      let H = AS.exec($);
      if (!H) throw Error(`Invalid JSON-pointer: ${$}`);
      let K = +H[1];
      if (Y = H[2], Y === "#") {
        if (K >= X) throw Error(U("property/index", K));
        return Q[X - K];
      }
      if (K > X) throw Error(U("data", K));
      if (z = J[X - K], !Y) return z;
    }
    let W = z, G = Y.split("/");
    for (let H of G) if (H) z = u._`${z}${(0, u.getProperty)((0, B4.unescapeJsonPointer)(H))}`, W = u._`${W} && ${z}`;
    return W;
    function U(H, K) {
      return `Cannot access ${H} ${K} levels up, current level is ${X}`;
    }
  }
  hw.getData = fw;
});
var R7 = k((lw) => {
  Object.defineProperty(lw, "__esModule", { value: true });
  class mw extends Error {
    constructor($) {
      super("validation failed");
      this.errors = $, this.ajv = this.validation = true;
    }
  }
  lw.default = mw;
});
var v9 = k((iw) => {
  Object.defineProperty(iw, "__esModule", { value: true });
  var p3 = Z9();
  class cw extends Error {
    constructor($, X, J, Q) {
      super(Q || `can't resolve reference ${J} from id ${X}`);
      this.missingRef = (0, p3.resolveUrl)($, X, J), this.missingSchema = (0, p3.normalizeId)((0, p3.getFullPath)($, this.missingRef));
    }
  }
  iw.default = cw;
});
var v7 = k((dw) => {
  Object.defineProperty(dw, "__esModule", { value: true });
  dw.resolveSchema = dw.getCompilingSchema = dw.resolveRef = dw.compileSchema = dw.SchemaEnv = void 0;
  var _6 = a(), RS = R7(), S1 = w4(), x6 = Z9(), pw = Q$(), SS = S9();
  class C9 {
    constructor($) {
      var X;
      this.refs = {}, this.dynamicAnchors = {};
      let J;
      if (typeof $.schema == "object") J = $.schema;
      this.schema = $.schema, this.schemaId = $.schemaId, this.root = $.root || this, this.baseId = (X = $.baseId) !== null && X !== void 0 ? X : (0, x6.normalizeId)(J === null || J === void 0 ? void 0 : J[$.schemaId || "$id"]), this.schemaPath = $.schemaPath, this.localRefs = $.localRefs, this.meta = $.meta, this.$async = J === null || J === void 0 ? void 0 : J.$async, this.refs = {};
    }
  }
  dw.SchemaEnv = C9;
  function d3($) {
    let X = nw.call(this, $);
    if (X) return X;
    let J = (0, x6.getFullPath)(this.opts.uriResolver, $.root.baseId), { es5: Q, lines: Y } = this.opts.code, { ownProperties: z } = this.opts, W = new _6.CodeGen(this.scope, { es5: Q, lines: Y, ownProperties: z }), G;
    if ($.$async) G = W.scopeValue("Error", { ref: RS.default, code: _6._`require("ajv/dist/runtime/validation_error").default` });
    let U = W.scopeName("validate");
    $.validateName = U;
    let H = { gen: W, allErrors: this.opts.allErrors, data: S1.default.data, parentData: S1.default.parentData, parentDataProperty: S1.default.parentDataProperty, dataNames: [S1.default.data], dataPathArr: [_6.nil], dataLevel: 0, dataTypes: [], definedProperties: /* @__PURE__ */ new Set(), topSchemaRef: W.scopeValue("schema", this.opts.code.source === true ? { ref: $.schema, code: (0, _6.stringify)($.schema) } : { ref: $.schema }), validateName: U, ValidationError: G, schema: $.schema, schemaEnv: $, rootId: J, baseId: $.baseId || J, schemaPath: _6.nil, errSchemaPath: $.schemaPath || (this.opts.jtd ? "" : "#"), errorPath: _6._`""`, opts: this.opts, self: this }, K;
    try {
      this._compilations.add($), (0, SS.validateFunctionCode)(H), W.optimize(this.opts.code.optimize);
      let V = W.toString();
      if (K = `${W.scopeRefs(S1.default.scope)}return ${V}`, this.opts.code.process) K = this.opts.code.process(K, $);
      let N = Function(`${S1.default.self}`, `${S1.default.scope}`, K)(this, this.scope.get());
      if (this.scope.value(U, { ref: N }), N.errors = null, N.schema = $.schema, N.schemaEnv = $, $.$async) N.$async = true;
      if (this.opts.code.source === true) N.source = { validateName: U, validateCode: V, scopeValues: W._values };
      if (this.opts.unevaluated) {
        let { props: w, items: B } = H;
        if (N.evaluated = { props: w instanceof _6.Name ? void 0 : w, items: B instanceof _6.Name ? void 0 : B, dynamicProps: w instanceof _6.Name, dynamicItems: B instanceof _6.Name }, N.source) N.source.evaluated = (0, _6.stringify)(N.evaluated);
      }
      return $.validate = N, $;
    } catch (V) {
      if (delete $.validate, delete $.validateName, K) this.logger.error("Error compiling schema, function code:", K);
      throw V;
    } finally {
      this._compilations.delete($);
    }
  }
  dw.compileSchema = d3;
  function vS($, X, J) {
    var Q;
    J = (0, x6.resolveUrl)(this.opts.uriResolver, X, J);
    let Y = $.refs[J];
    if (Y) return Y;
    let z = _S.call(this, $, J);
    if (z === void 0) {
      let W = (Q = $.localRefs) === null || Q === void 0 ? void 0 : Q[J], { schemaId: G } = this.opts;
      if (W) z = new C9({ schema: W, schemaId: G, root: $, baseId: X });
    }
    if (z === void 0) return;
    return $.refs[J] = CS.call(this, z);
  }
  dw.resolveRef = vS;
  function CS($) {
    if ((0, x6.inlineRef)($.schema, this.opts.inlineRefs)) return $.schema;
    return $.validate ? $ : d3.call(this, $);
  }
  function nw($) {
    for (let X of this._compilations) if (kS(X, $)) return X;
  }
  dw.getCompilingSchema = nw;
  function kS($, X) {
    return $.schema === X.schema && $.root === X.root && $.baseId === X.baseId;
  }
  function _S($, X) {
    let J;
    while (typeof (J = this.refs[X]) == "string") X = J;
    return J || this.schemas[X] || S7.call(this, $, X);
  }
  function S7($, X) {
    let J = this.opts.uriResolver.parse(X), Q = (0, x6._getFullPath)(this.opts.uriResolver, J), Y = (0, x6.getFullPath)(this.opts.uriResolver, $.baseId, void 0);
    if (Object.keys($.schema).length > 0 && Q === Y) return n3.call(this, J, $);
    let z = (0, x6.normalizeId)(Q), W = this.refs[z] || this.schemas[z];
    if (typeof W == "string") {
      let G = S7.call(this, $, W);
      if (typeof (G === null || G === void 0 ? void 0 : G.schema) !== "object") return;
      return n3.call(this, J, G);
    }
    if (typeof (W === null || W === void 0 ? void 0 : W.schema) !== "object") return;
    if (!W.validate) d3.call(this, W);
    if (z === (0, x6.normalizeId)(X)) {
      let { schema: G } = W, { schemaId: U } = this.opts, H = G[U];
      if (H) Y = (0, x6.resolveUrl)(this.opts.uriResolver, Y, H);
      return new C9({ schema: G, schemaId: U, root: $, baseId: Y });
    }
    return n3.call(this, J, W);
  }
  dw.resolveSchema = S7;
  var xS = /* @__PURE__ */ new Set(["properties", "patternProperties", "enum", "dependencies", "definitions"]);
  function n3($, { baseId: X, schema: J, root: Q }) {
    var Y;
    if (((Y = $.fragment) === null || Y === void 0 ? void 0 : Y[0]) !== "/") return;
    for (let G of $.fragment.slice(1).split("/")) {
      if (typeof J === "boolean") return;
      let U = J[(0, pw.unescapeFragment)(G)];
      if (U === void 0) return;
      J = U;
      let H = typeof J === "object" && J[this.opts.schemaId];
      if (!xS.has(G) && H) X = (0, x6.resolveUrl)(this.opts.uriResolver, X, H);
    }
    let z;
    if (typeof J != "boolean" && J.$ref && !(0, pw.schemaHasRulesButRef)(J, this.RULES)) {
      let G = (0, x6.resolveUrl)(this.opts.uriResolver, X, J.$ref);
      z = S7.call(this, Q, G);
    }
    let { schemaId: W } = this.opts;
    if (z = z || new C9({ schema: J, schemaId: W, root: Q, baseId: X }), z.schema !== z.root.schema) return z;
    return;
  }
});
var ow = k((Do, hS) => {
  hS.exports = { $id: "https://raw.githubusercontent.com/ajv-validator/ajv/master/lib/refs/data.json#", description: "Meta-schema for $data reference (JSON AnySchema extension proposal)", type: "object", required: ["$data"], properties: { $data: { type: "string", anyOf: [{ format: "relative-json-pointer" }, { format: "json-pointer" }] } }, additionalProperties: false };
});
var aw = k((Lo, tw) => {
  var uS = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, a: 10, A: 10, b: 11, B: 11, c: 12, C: 12, d: 13, D: 13, e: 14, E: 14, f: 15, F: 15 };
  tw.exports = { HEX: uS };
});
var zB = k((jo, QB) => {
  var { HEX: mS } = aw(), lS = /^(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)$/u;
  function XB($) {
    if (YB($, ".") < 3) return { host: $, isIPV4: false };
    let X = $.match(lS) || [], [J] = X;
    if (J) return { host: iS(J, "."), isIPV4: true };
    else return { host: $, isIPV4: false };
  }
  function r3($, X = false) {
    let J = "", Q = true;
    for (let Y of $) {
      if (mS[Y] === void 0) return;
      if (Y !== "0" && Q === true) Q = false;
      if (!Q) J += Y;
    }
    if (X && J.length === 0) J = "0";
    return J;
  }
  function cS($) {
    let X = 0, J = { error: false, address: "", zone: "" }, Q = [], Y = [], z = false, W = false, G = false;
    function U() {
      if (Y.length) {
        if (z === false) {
          let H = r3(Y);
          if (H !== void 0) Q.push(H);
          else return J.error = true, false;
        }
        Y.length = 0;
      }
      return true;
    }
    for (let H = 0; H < $.length; H++) {
      let K = $[H];
      if (K === "[" || K === "]") continue;
      if (K === ":") {
        if (W === true) G = true;
        if (!U()) break;
        if (X++, Q.push(":"), X > 7) {
          J.error = true;
          break;
        }
        if (H - 1 >= 0 && $[H - 1] === ":") W = true;
        continue;
      } else if (K === "%") {
        if (!U()) break;
        z = true;
      } else {
        Y.push(K);
        continue;
      }
    }
    if (Y.length) if (z) J.zone = Y.join("");
    else if (G) Q.push(Y.join(""));
    else Q.push(r3(Y));
    return J.address = Q.join(""), J;
  }
  function JB($) {
    if (YB($, ":") < 2) return { host: $, isIPV6: false };
    let X = cS($);
    if (!X.error) {
      let { address: J, address: Q } = X;
      if (X.zone) J += "%" + X.zone, Q += "%25" + X.zone;
      return { host: J, escapedHost: Q, isIPV6: true };
    } else return { host: $, isIPV6: false };
  }
  function iS($, X) {
    let J = "", Q = true, Y = $.length;
    for (let z = 0; z < Y; z++) {
      let W = $[z];
      if (W === "0" && Q) {
        if (z + 1 <= Y && $[z + 1] === X || z + 1 === Y) J += W, Q = false;
      } else {
        if (W === X) Q = true;
        else Q = false;
        J += W;
      }
    }
    return J;
  }
  function YB($, X) {
    let J = 0;
    for (let Q = 0; Q < $.length; Q++) if ($[Q] === X) J++;
    return J;
  }
  var sw = /^\.\.?\//u, ew = /^\/\.(?:\/|$)/u, $B = /^\/\.\.(?:\/|$)/u, pS = /^\/?(?:.|\n)*?(?=\/|$)/u;
  function nS($) {
    let X = [];
    while ($.length) if ($.match(sw)) $ = $.replace(sw, "");
    else if ($.match(ew)) $ = $.replace(ew, "/");
    else if ($.match($B)) $ = $.replace($B, "/"), X.pop();
    else if ($ === "." || $ === "..") $ = "";
    else {
      let J = $.match(pS);
      if (J) {
        let Q = J[0];
        $ = $.slice(Q.length), X.push(Q);
      } else throw Error("Unexpected dot segment condition");
    }
    return X.join("");
  }
  function dS($, X) {
    let J = X !== true ? escape : unescape;
    if ($.scheme !== void 0) $.scheme = J($.scheme);
    if ($.userinfo !== void 0) $.userinfo = J($.userinfo);
    if ($.host !== void 0) $.host = J($.host);
    if ($.path !== void 0) $.path = J($.path);
    if ($.query !== void 0) $.query = J($.query);
    if ($.fragment !== void 0) $.fragment = J($.fragment);
    return $;
  }
  function rS($) {
    let X = [];
    if ($.userinfo !== void 0) X.push($.userinfo), X.push("@");
    if ($.host !== void 0) {
      let J = unescape($.host), Q = XB(J);
      if (Q.isIPV4) J = Q.host;
      else {
        let Y = JB(Q.host);
        if (Y.isIPV6 === true) J = `[${Y.escapedHost}]`;
        else J = $.host;
      }
      X.push(J);
    }
    if (typeof $.port === "number" || typeof $.port === "string") X.push(":"), X.push(String($.port));
    return X.length ? X.join("") : void 0;
  }
  QB.exports = { recomposeAuthority: rS, normalizeComponentEncoding: dS, removeDotSegments: nS, normalizeIPv4: XB, normalizeIPv6: JB, stringArrayToHexStripped: r3 };
});
var NB = k((Fo, KB) => {
  var oS = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu, tS = /([\da-z][\d\-a-z]{0,31}):((?:[\w!$'()*+,\-.:;=@]|%[\da-f]{2})+)/iu;
  function WB($) {
    return typeof $.secure === "boolean" ? $.secure : String($.scheme).toLowerCase() === "wss";
  }
  function GB($) {
    if (!$.host) $.error = $.error || "HTTP URIs must have a host.";
    return $;
  }
  function UB($) {
    let X = String($.scheme).toLowerCase() === "https";
    if ($.port === (X ? 443 : 80) || $.port === "") $.port = void 0;
    if (!$.path) $.path = "/";
    return $;
  }
  function aS($) {
    return $.secure = WB($), $.resourceName = ($.path || "/") + ($.query ? "?" + $.query : ""), $.path = void 0, $.query = void 0, $;
  }
  function sS($) {
    if ($.port === (WB($) ? 443 : 80) || $.port === "") $.port = void 0;
    if (typeof $.secure === "boolean") $.scheme = $.secure ? "wss" : "ws", $.secure = void 0;
    if ($.resourceName) {
      let [X, J] = $.resourceName.split("?");
      $.path = X && X !== "/" ? X : void 0, $.query = J, $.resourceName = void 0;
    }
    return $.fragment = void 0, $;
  }
  function eS($, X) {
    if (!$.path) return $.error = "URN can not be parsed", $;
    let J = $.path.match(tS);
    if (J) {
      let Q = X.scheme || $.scheme || "urn";
      $.nid = J[1].toLowerCase(), $.nss = J[2];
      let Y = `${Q}:${X.nid || $.nid}`, z = o3[Y];
      if ($.path = void 0, z) $ = z.parse($, X);
    } else $.error = $.error || "URN can not be parsed.";
    return $;
  }
  function $v($, X) {
    let J = X.scheme || $.scheme || "urn", Q = $.nid.toLowerCase(), Y = `${J}:${X.nid || Q}`, z = o3[Y];
    if (z) $ = z.serialize($, X);
    let W = $, G = $.nss;
    return W.path = `${Q || X.nid}:${G}`, X.skipEscape = true, W;
  }
  function Xv($, X) {
    let J = $;
    if (J.uuid = J.nss, J.nss = void 0, !X.tolerant && (!J.uuid || !oS.test(J.uuid))) J.error = J.error || "UUID is not valid.";
    return J;
  }
  function Jv($) {
    let X = $;
    return X.nss = ($.uuid || "").toLowerCase(), X;
  }
  var HB = { scheme: "http", domainHost: true, parse: GB, serialize: UB }, Yv = { scheme: "https", domainHost: HB.domainHost, parse: GB, serialize: UB }, C7 = { scheme: "ws", domainHost: true, parse: aS, serialize: sS }, Qv = { scheme: "wss", domainHost: C7.domainHost, parse: C7.parse, serialize: C7.serialize }, zv = { scheme: "urn", parse: eS, serialize: $v, skipNormalize: true }, Wv = { scheme: "urn:uuid", parse: Xv, serialize: Jv, skipNormalize: true }, o3 = { http: HB, https: Yv, ws: C7, wss: Qv, urn: zv, "urn:uuid": Wv };
  KB.exports = o3;
});
var OB = k((Io, _7) => {
  var { normalizeIPv6: Gv, normalizeIPv4: Uv, removeDotSegments: k9, recomposeAuthority: Hv, normalizeComponentEncoding: k7 } = zB(), t3 = NB();
  function Kv($, X) {
    if (typeof $ === "string") $ = p6(q4($, X), X);
    else if (typeof $ === "object") $ = q4(p6($, X), X);
    return $;
  }
  function Nv($, X, J) {
    let Q = Object.assign({ scheme: "null" }, J), Y = VB(q4($, Q), q4(X, Q), Q, true);
    return p6(Y, { ...Q, skipEscape: true });
  }
  function VB($, X, J, Q) {
    let Y = {};
    if (!Q) $ = q4(p6($, J), J), X = q4(p6(X, J), J);
    if (J = J || {}, !J.tolerant && X.scheme) Y.scheme = X.scheme, Y.userinfo = X.userinfo, Y.host = X.host, Y.port = X.port, Y.path = k9(X.path || ""), Y.query = X.query;
    else {
      if (X.userinfo !== void 0 || X.host !== void 0 || X.port !== void 0) Y.userinfo = X.userinfo, Y.host = X.host, Y.port = X.port, Y.path = k9(X.path || ""), Y.query = X.query;
      else {
        if (!X.path) if (Y.path = $.path, X.query !== void 0) Y.query = X.query;
        else Y.query = $.query;
        else {
          if (X.path.charAt(0) === "/") Y.path = k9(X.path);
          else {
            if (($.userinfo !== void 0 || $.host !== void 0 || $.port !== void 0) && !$.path) Y.path = "/" + X.path;
            else if (!$.path) Y.path = X.path;
            else Y.path = $.path.slice(0, $.path.lastIndexOf("/") + 1) + X.path;
            Y.path = k9(Y.path);
          }
          Y.query = X.query;
        }
        Y.userinfo = $.userinfo, Y.host = $.host, Y.port = $.port;
      }
      Y.scheme = $.scheme;
    }
    return Y.fragment = X.fragment, Y;
  }
  function Vv($, X, J) {
    if (typeof $ === "string") $ = unescape($), $ = p6(k7(q4($, J), true), { ...J, skipEscape: true });
    else if (typeof $ === "object") $ = p6(k7($, true), { ...J, skipEscape: true });
    if (typeof X === "string") X = unescape(X), X = p6(k7(q4(X, J), true), { ...J, skipEscape: true });
    else if (typeof X === "object") X = p6(k7(X, true), { ...J, skipEscape: true });
    return $.toLowerCase() === X.toLowerCase();
  }
  function p6($, X) {
    let J = { host: $.host, scheme: $.scheme, userinfo: $.userinfo, port: $.port, path: $.path, query: $.query, nid: $.nid, nss: $.nss, uuid: $.uuid, fragment: $.fragment, reference: $.reference, resourceName: $.resourceName, secure: $.secure, error: "" }, Q = Object.assign({}, X), Y = [], z = t3[(Q.scheme || J.scheme || "").toLowerCase()];
    if (z && z.serialize) z.serialize(J, Q);
    if (J.path !== void 0) if (!Q.skipEscape) {
      if (J.path = escape(J.path), J.scheme !== void 0) J.path = J.path.split("%3A").join(":");
    } else J.path = unescape(J.path);
    if (Q.reference !== "suffix" && J.scheme) Y.push(J.scheme, ":");
    let W = Hv(J);
    if (W !== void 0) {
      if (Q.reference !== "suffix") Y.push("//");
      if (Y.push(W), J.path && J.path.charAt(0) !== "/") Y.push("/");
    }
    if (J.path !== void 0) {
      let G = J.path;
      if (!Q.absolutePath && (!z || !z.absolutePath)) G = k9(G);
      if (W === void 0) G = G.replace(/^\/\//u, "/%2F");
      Y.push(G);
    }
    if (J.query !== void 0) Y.push("?", J.query);
    if (J.fragment !== void 0) Y.push("#", J.fragment);
    return Y.join("");
  }
  var Ov = Array.from({ length: 127 }, ($, X) => /[^!"$&'()*+,\-.;=_`a-z{}~]/u.test(String.fromCharCode(X)));
  function wv($) {
    let X = 0;
    for (let J = 0, Q = $.length; J < Q; ++J) if (X = $.charCodeAt(J), X > 126 || Ov[X]) return true;
    return false;
  }
  var Bv = /^(?:([^#/:?]+):)?(?:\/\/((?:([^#/?@]*)@)?(\[[^#/?\]]+\]|[^#/:?]*)(?::(\d*))?))?([^#?]*)(?:\?([^#]*))?(?:#((?:.|[\n\r])*))?/u;
  function q4($, X) {
    let J = Object.assign({}, X), Q = { scheme: void 0, userinfo: void 0, host: "", port: void 0, path: "", query: void 0, fragment: void 0 }, Y = $.indexOf("%") !== -1, z = false;
    if (J.reference === "suffix") $ = (J.scheme ? J.scheme + ":" : "") + "//" + $;
    let W = $.match(Bv);
    if (W) {
      if (Q.scheme = W[1], Q.userinfo = W[3], Q.host = W[4], Q.port = parseInt(W[5], 10), Q.path = W[6] || "", Q.query = W[7], Q.fragment = W[8], isNaN(Q.port)) Q.port = W[5];
      if (Q.host) {
        let U = Uv(Q.host);
        if (U.isIPV4 === false) {
          let H = Gv(U.host);
          Q.host = H.host.toLowerCase(), z = H.isIPV6;
        } else Q.host = U.host, z = true;
      }
      if (Q.scheme === void 0 && Q.userinfo === void 0 && Q.host === void 0 && Q.port === void 0 && Q.query === void 0 && !Q.path) Q.reference = "same-document";
      else if (Q.scheme === void 0) Q.reference = "relative";
      else if (Q.fragment === void 0) Q.reference = "absolute";
      else Q.reference = "uri";
      if (J.reference && J.reference !== "suffix" && J.reference !== Q.reference) Q.error = Q.error || "URI is not a " + J.reference + " reference.";
      let G = t3[(J.scheme || Q.scheme || "").toLowerCase()];
      if (!J.unicodeSupport && (!G || !G.unicodeSupport)) {
        if (Q.host && (J.domainHost || G && G.domainHost) && z === false && wv(Q.host)) try {
          Q.host = URL.domainToASCII(Q.host.toLowerCase());
        } catch (U) {
          Q.error = Q.error || "Host's domain name can not be converted to ASCII: " + U;
        }
      }
      if (!G || G && !G.skipNormalize) {
        if (Y && Q.scheme !== void 0) Q.scheme = unescape(Q.scheme);
        if (Y && Q.host !== void 0) Q.host = unescape(Q.host);
        if (Q.path) Q.path = escape(unescape(Q.path));
        if (Q.fragment) Q.fragment = encodeURI(decodeURIComponent(Q.fragment));
      }
      if (G && G.parse) G.parse(Q, J);
    } else Q.error = Q.error || "URI can not be parsed.";
    return Q;
  }
  var a3 = { SCHEMES: t3, normalize: Kv, resolve: Nv, resolveComponents: VB, equal: Vv, serialize: p6, parse: q4 };
  _7.exports = a3;
  _7.exports.default = a3;
  _7.exports.fastUri = a3;
});
var qB = k((BB) => {
  Object.defineProperty(BB, "__esModule", { value: true });
  var wB = OB();
  wB.code = 'require("ajv/dist/runtime/uri").default';
  BB.default = wB;
});
var bB = k((D4) => {
  Object.defineProperty(D4, "__esModule", { value: true });
  D4.CodeGen = D4.Name = D4.nil = D4.stringify = D4.str = D4._ = D4.KeywordCxt = void 0;
  var Dv = S9();
  Object.defineProperty(D4, "KeywordCxt", { enumerable: true, get: function() {
    return Dv.KeywordCxt;
  } });
  var l0 = a();
  Object.defineProperty(D4, "_", { enumerable: true, get: function() {
    return l0._;
  } });
  Object.defineProperty(D4, "str", { enumerable: true, get: function() {
    return l0.str;
  } });
  Object.defineProperty(D4, "stringify", { enumerable: true, get: function() {
    return l0.stringify;
  } });
  Object.defineProperty(D4, "nil", { enumerable: true, get: function() {
    return l0.nil;
  } });
  Object.defineProperty(D4, "Name", { enumerable: true, get: function() {
    return l0.Name;
  } });
  Object.defineProperty(D4, "CodeGen", { enumerable: true, get: function() {
    return l0.CodeGen;
  } });
  var Lv = R7(), IB = v9(), jv = C3(), _9 = v7(), Fv = a(), x9 = Z9(), x7 = P9(), e3 = Q$(), DB = ow(), Iv = qB(), MB = ($, X) => new RegExp($, X);
  MB.code = "new RegExp";
  var Mv = ["removeAdditional", "useDefaults", "coerceTypes"], Av = /* @__PURE__ */ new Set(["validate", "serialize", "parse", "wrapper", "root", "schema", "keyword", "pattern", "formats", "validate$data", "func", "obj", "Error"]), bv = { errorDataPath: "", format: "`validateFormats: false` can be used instead.", nullable: '"nullable" keyword is supported by default.', jsonPointers: "Deprecated jsPropertySyntax can be used instead.", extendRefs: "Deprecated ignoreKeywordsWithRef can be used instead.", missingRefs: "Pass empty schema with $id that should be ignored to ajv.addSchema.", processCode: "Use option `code: {process: (code, schemaEnv: object) => string}`", sourceCode: "Use option `code: {source: true}`", strictDefaults: "It is default now, see option `strict`.", strictKeywords: "It is default now, see option `strict`.", uniqueItems: '"uniqueItems" keyword is always validated.', unknownFormats: "Disable strict mode or pass `true` to `ajv.addFormat` (or `formats` option).", cache: "Map is used as cache, schema object as key.", serialize: "Map is used as cache, schema object as key.", ajvErrors: "It is default now." }, Pv = { ignoreKeywordsWithRef: "", jsPropertySyntax: "", unicode: '"minLength"/"maxLength" account for unicode characters by default.' }, LB = 200;
  function Zv($) {
    var X, J, Q, Y, z, W, G, U, H, K, V, O, N, w, B, L, j, M, b, x, h, B$, x$, Q6, r6;
    let g6 = $.strict, t4 = (X = $.code) === null || X === void 0 ? void 0 : X.optimize, k1 = t4 === true || t4 === void 0 ? 1 : t4 || 0, o6 = (Q = (J = $.code) === null || J === void 0 ? void 0 : J.regExp) !== null && Q !== void 0 ? Q : MB, r0 = (Y = $.uriResolver) !== null && Y !== void 0 ? Y : Iv.default;
    return { strictSchema: (W = (z = $.strictSchema) !== null && z !== void 0 ? z : g6) !== null && W !== void 0 ? W : true, strictNumbers: (U = (G = $.strictNumbers) !== null && G !== void 0 ? G : g6) !== null && U !== void 0 ? U : true, strictTypes: (K = (H = $.strictTypes) !== null && H !== void 0 ? H : g6) !== null && K !== void 0 ? K : "log", strictTuples: (O = (V = $.strictTuples) !== null && V !== void 0 ? V : g6) !== null && O !== void 0 ? O : "log", strictRequired: (w = (N = $.strictRequired) !== null && N !== void 0 ? N : g6) !== null && w !== void 0 ? w : false, code: $.code ? { ...$.code, optimize: k1, regExp: o6 } : { optimize: k1, regExp: o6 }, loopRequired: (B = $.loopRequired) !== null && B !== void 0 ? B : LB, loopEnum: (L = $.loopEnum) !== null && L !== void 0 ? L : LB, meta: (j = $.meta) !== null && j !== void 0 ? j : true, messages: (M = $.messages) !== null && M !== void 0 ? M : true, inlineRefs: (b = $.inlineRefs) !== null && b !== void 0 ? b : true, schemaId: (x = $.schemaId) !== null && x !== void 0 ? x : "$id", addUsedSchema: (h = $.addUsedSchema) !== null && h !== void 0 ? h : true, validateSchema: (B$ = $.validateSchema) !== null && B$ !== void 0 ? B$ : true, validateFormats: (x$ = $.validateFormats) !== null && x$ !== void 0 ? x$ : true, unicodeRegExp: (Q6 = $.unicodeRegExp) !== null && Q6 !== void 0 ? Q6 : true, int32range: (r6 = $.int32range) !== null && r6 !== void 0 ? r6 : true, uriResolver: r0 };
  }
  class T7 {
    constructor($ = {}) {
      this.schemas = {}, this.refs = {}, this.formats = {}, this._compilations = /* @__PURE__ */ new Set(), this._loading = {}, this._cache = /* @__PURE__ */ new Map(), $ = this.opts = { ...$, ...Zv($) };
      let { es5: X, lines: J } = this.opts.code;
      this.scope = new Fv.ValueScope({ scope: {}, prefixes: Av, es5: X, lines: J }), this.logger = kv($.logger);
      let Q = $.validateFormats;
      if ($.validateFormats = false, this.RULES = (0, jv.getRules)(), jB.call(this, bv, $, "NOT SUPPORTED"), jB.call(this, Pv, $, "DEPRECATED", "warn"), this._metaOpts = vv.call(this), $.formats) Rv.call(this);
      if (this._addVocabularies(), this._addDefaultMetaSchema(), $.keywords) Sv.call(this, $.keywords);
      if (typeof $.meta == "object") this.addMetaSchema($.meta);
      Ev.call(this), $.validateFormats = Q;
    }
    _addVocabularies() {
      this.addKeyword("$async");
    }
    _addDefaultMetaSchema() {
      let { $data: $, meta: X, schemaId: J } = this.opts, Q = DB;
      if (J === "id") Q = { ...DB }, Q.id = Q.$id, delete Q.$id;
      if (X && $) this.addMetaSchema(Q, Q[J], false);
    }
    defaultMeta() {
      let { meta: $, schemaId: X } = this.opts;
      return this.opts.defaultMeta = typeof $ == "object" ? $[X] || $ : void 0;
    }
    validate($, X) {
      let J;
      if (typeof $ == "string") {
        if (J = this.getSchema($), !J) throw Error(`no schema with key or ref "${$}"`);
      } else J = this.compile($);
      let Q = J(X);
      if (!("$async" in J)) this.errors = J.errors;
      return Q;
    }
    compile($, X) {
      let J = this._addSchema($, X);
      return J.validate || this._compileSchemaEnv(J);
    }
    compileAsync($, X) {
      if (typeof this.opts.loadSchema != "function") throw Error("options.loadSchema should be a function");
      let { loadSchema: J } = this.opts;
      return Q.call(this, $, X);
      async function Q(H, K) {
        await Y.call(this, H.$schema);
        let V = this._addSchema(H, K);
        return V.validate || z.call(this, V);
      }
      async function Y(H) {
        if (H && !this.getSchema(H)) await Q.call(this, { $ref: H }, true);
      }
      async function z(H) {
        try {
          return this._compileSchemaEnv(H);
        } catch (K) {
          if (!(K instanceof IB.default)) throw K;
          return W.call(this, K), await G.call(this, K.missingSchema), z.call(this, H);
        }
      }
      function W({ missingSchema: H, missingRef: K }) {
        if (this.refs[H]) throw Error(`AnySchema ${H} is loaded but ${K} cannot be resolved`);
      }
      async function G(H) {
        let K = await U.call(this, H);
        if (!this.refs[H]) await Y.call(this, K.$schema);
        if (!this.refs[H]) this.addSchema(K, H, X);
      }
      async function U(H) {
        let K = this._loading[H];
        if (K) return K;
        try {
          return await (this._loading[H] = J(H));
        } finally {
          delete this._loading[H];
        }
      }
    }
    addSchema($, X, J, Q = this.opts.validateSchema) {
      if (Array.isArray($)) {
        for (let z of $) this.addSchema(z, void 0, J, Q);
        return this;
      }
      let Y;
      if (typeof $ === "object") {
        let { schemaId: z } = this.opts;
        if (Y = $[z], Y !== void 0 && typeof Y != "string") throw Error(`schema ${z} must be string`);
      }
      return X = (0, x9.normalizeId)(X || Y), this._checkUnique(X), this.schemas[X] = this._addSchema($, J, X, Q, true), this;
    }
    addMetaSchema($, X, J = this.opts.validateSchema) {
      return this.addSchema($, X, true, J), this;
    }
    validateSchema($, X) {
      if (typeof $ == "boolean") return true;
      let J;
      if (J = $.$schema, J !== void 0 && typeof J != "string") throw Error("$schema must be a string");
      if (J = J || this.opts.defaultMeta || this.defaultMeta(), !J) return this.logger.warn("meta-schema not available"), this.errors = null, true;
      let Q = this.validate(J, $);
      if (!Q && X) {
        let Y = "schema is invalid: " + this.errorsText();
        if (this.opts.validateSchema === "log") this.logger.error(Y);
        else throw Error(Y);
      }
      return Q;
    }
    getSchema($) {
      let X;
      while (typeof (X = FB.call(this, $)) == "string") $ = X;
      if (X === void 0) {
        let { schemaId: J } = this.opts, Q = new _9.SchemaEnv({ schema: {}, schemaId: J });
        if (X = _9.resolveSchema.call(this, Q, $), !X) return;
        this.refs[$] = X;
      }
      return X.validate || this._compileSchemaEnv(X);
    }
    removeSchema($) {
      if ($ instanceof RegExp) return this._removeAllSchemas(this.schemas, $), this._removeAllSchemas(this.refs, $), this;
      switch (typeof $) {
        case "undefined":
          return this._removeAllSchemas(this.schemas), this._removeAllSchemas(this.refs), this._cache.clear(), this;
        case "string": {
          let X = FB.call(this, $);
          if (typeof X == "object") this._cache.delete(X.schema);
          return delete this.schemas[$], delete this.refs[$], this;
        }
        case "object": {
          let X = $;
          this._cache.delete(X);
          let J = $[this.opts.schemaId];
          if (J) J = (0, x9.normalizeId)(J), delete this.schemas[J], delete this.refs[J];
          return this;
        }
        default:
          throw Error("ajv.removeSchema: invalid parameter");
      }
    }
    addVocabulary($) {
      for (let X of $) this.addKeyword(X);
      return this;
    }
    addKeyword($, X) {
      let J;
      if (typeof $ == "string") {
        if (J = $, typeof X == "object") this.logger.warn("these parameters are deprecated, see docs for addKeyword"), X.keyword = J;
      } else if (typeof $ == "object" && X === void 0) {
        if (X = $, J = X.keyword, Array.isArray(J) && !J.length) throw Error("addKeywords: keyword must be string or non-empty array");
      } else throw Error("invalid addKeywords parameters");
      if (xv.call(this, J, X), !X) return (0, e3.eachItem)(J, (Y) => s3.call(this, Y)), this;
      yv.call(this, X);
      let Q = { ...X, type: (0, x7.getJSONTypes)(X.type), schemaType: (0, x7.getJSONTypes)(X.schemaType) };
      return (0, e3.eachItem)(J, Q.type.length === 0 ? (Y) => s3.call(this, Y, Q) : (Y) => Q.type.forEach((z) => s3.call(this, Y, Q, z))), this;
    }
    getKeyword($) {
      let X = this.RULES.all[$];
      return typeof X == "object" ? X.definition : !!X;
    }
    removeKeyword($) {
      let { RULES: X } = this;
      delete X.keywords[$], delete X.all[$];
      for (let J of X.rules) {
        let Q = J.rules.findIndex((Y) => Y.keyword === $);
        if (Q >= 0) J.rules.splice(Q, 1);
      }
      return this;
    }
    addFormat($, X) {
      if (typeof X == "string") X = new RegExp(X);
      return this.formats[$] = X, this;
    }
    errorsText($ = this.errors, { separator: X = ", ", dataVar: J = "data" } = {}) {
      if (!$ || $.length === 0) return "No errors";
      return $.map((Q) => `${J}${Q.instancePath} ${Q.message}`).reduce((Q, Y) => Q + X + Y);
    }
    $dataMetaSchema($, X) {
      let J = this.RULES.all;
      $ = JSON.parse(JSON.stringify($));
      for (let Q of X) {
        let Y = Q.split("/").slice(1), z = $;
        for (let W of Y) z = z[W];
        for (let W in J) {
          let G = J[W];
          if (typeof G != "object") continue;
          let { $data: U } = G.definition, H = z[W];
          if (U && H) z[W] = AB(H);
        }
      }
      return $;
    }
    _removeAllSchemas($, X) {
      for (let J in $) {
        let Q = $[J];
        if (!X || X.test(J)) {
          if (typeof Q == "string") delete $[J];
          else if (Q && !Q.meta) this._cache.delete(Q.schema), delete $[J];
        }
      }
    }
    _addSchema($, X, J, Q = this.opts.validateSchema, Y = this.opts.addUsedSchema) {
      let z, { schemaId: W } = this.opts;
      if (typeof $ == "object") z = $[W];
      else if (this.opts.jtd) throw Error("schema must be object");
      else if (typeof $ != "boolean") throw Error("schema must be object or boolean");
      let G = this._cache.get($);
      if (G !== void 0) return G;
      J = (0, x9.normalizeId)(z || J);
      let U = x9.getSchemaRefs.call(this, $, J);
      if (G = new _9.SchemaEnv({ schema: $, schemaId: W, meta: X, baseId: J, localRefs: U }), this._cache.set(G.schema, G), Y && !J.startsWith("#")) {
        if (J) this._checkUnique(J);
        this.refs[J] = G;
      }
      if (Q) this.validateSchema($, true);
      return G;
    }
    _checkUnique($) {
      if (this.schemas[$] || this.refs[$]) throw Error(`schema with key or id "${$}" already exists`);
    }
    _compileSchemaEnv($) {
      if ($.meta) this._compileMetaSchema($);
      else _9.compileSchema.call(this, $);
      if (!$.validate) throw Error("ajv implementation error");
      return $.validate;
    }
    _compileMetaSchema($) {
      let X = this.opts;
      this.opts = this._metaOpts;
      try {
        _9.compileSchema.call(this, $);
      } finally {
        this.opts = X;
      }
    }
  }
  T7.ValidationError = Lv.default;
  T7.MissingRefError = IB.default;
  D4.default = T7;
  function jB($, X, J, Q = "error") {
    for (let Y in $) {
      let z = Y;
      if (z in X) this.logger[Q](`${J}: option ${Y}. ${$[z]}`);
    }
  }
  function FB($) {
    return $ = (0, x9.normalizeId)($), this.schemas[$] || this.refs[$];
  }
  function Ev() {
    let $ = this.opts.schemas;
    if (!$) return;
    if (Array.isArray($)) this.addSchema($);
    else for (let X in $) this.addSchema($[X], X);
  }
  function Rv() {
    for (let $ in this.opts.formats) {
      let X = this.opts.formats[$];
      if (X) this.addFormat($, X);
    }
  }
  function Sv($) {
    if (Array.isArray($)) {
      this.addVocabulary($);
      return;
    }
    this.logger.warn("keywords option as map is deprecated, pass array");
    for (let X in $) {
      let J = $[X];
      if (!J.keyword) J.keyword = X;
      this.addKeyword(J);
    }
  }
  function vv() {
    let $ = { ...this.opts };
    for (let X of Mv) delete $[X];
    return $;
  }
  var Cv = { log() {
  }, warn() {
  }, error() {
  } };
  function kv($) {
    if ($ === false) return Cv;
    if ($ === void 0) return console;
    if ($.log && $.warn && $.error) return $;
    throw Error("logger must implement log, warn and error methods");
  }
  var _v = /^[a-z_$][a-z0-9_$:-]*$/i;
  function xv($, X) {
    let { RULES: J } = this;
    if ((0, e3.eachItem)($, (Q) => {
      if (J.keywords[Q]) throw Error(`Keyword ${Q} is already defined`);
      if (!_v.test(Q)) throw Error(`Keyword ${Q} has invalid name`);
    }), !X) return;
    if (X.$data && !("code" in X || "validate" in X)) throw Error('$data keyword must have "code" or "validate" function');
  }
  function s3($, X, J) {
    var Q;
    let Y = X === null || X === void 0 ? void 0 : X.post;
    if (J && Y) throw Error('keyword with "post" flag cannot have "type"');
    let { RULES: z } = this, W = Y ? z.post : z.rules.find(({ type: U }) => U === J);
    if (!W) W = { type: J, rules: [] }, z.rules.push(W);
    if (z.keywords[$] = true, !X) return;
    let G = { keyword: $, definition: { ...X, type: (0, x7.getJSONTypes)(X.type), schemaType: (0, x7.getJSONTypes)(X.schemaType) } };
    if (X.before) Tv.call(this, W, G, X.before);
    else W.rules.push(G);
    z.all[$] = G, (Q = X.implements) === null || Q === void 0 || Q.forEach((U) => this.addKeyword(U));
  }
  function Tv($, X, J) {
    let Q = $.rules.findIndex((Y) => Y.keyword === J);
    if (Q >= 0) $.rules.splice(Q, 0, X);
    else $.rules.push(X), this.logger.warn(`rule ${J} is not defined`);
  }
  function yv($) {
    let { metaSchema: X } = $;
    if (X === void 0) return;
    if ($.$data && this.opts.$data) X = AB(X);
    $.validateSchema = this.compile(X, true);
  }
  var gv = { $ref: "https://raw.githubusercontent.com/ajv-validator/ajv/master/lib/refs/data.json#" };
  function AB($) {
    return { anyOf: [$, gv] };
  }
});
var ZB = k((PB) => {
  Object.defineProperty(PB, "__esModule", { value: true });
  var uv = { keyword: "id", code() {
    throw Error('NOT SUPPORTED: keyword "id", use "$id" for schema ID');
  } };
  PB.default = uv;
});
var kB = k((vB) => {
  Object.defineProperty(vB, "__esModule", { value: true });
  vB.callRef = vB.getValidate = void 0;
  var lv = v9(), EB = M6(), J6 = a(), c0 = w4(), RB = v7(), y7 = Q$(), cv = { keyword: "$ref", schemaType: "string", code($) {
    let { gen: X, schema: J, it: Q } = $, { baseId: Y, schemaEnv: z, validateName: W, opts: G, self: U } = Q, { root: H } = z;
    if ((J === "#" || J === "#/") && Y === H.baseId) return V();
    let K = RB.resolveRef.call(U, H, Y, J);
    if (K === void 0) throw new lv.default(Q.opts.uriResolver, Y, J);
    if (K instanceof RB.SchemaEnv) return O(K);
    return N(K);
    function V() {
      if (z === H) return g7($, W, z, z.$async);
      let w = X.scopeValue("root", { ref: H });
      return g7($, J6._`${w}.validate`, H, H.$async);
    }
    function O(w) {
      let B = SB($, w);
      g7($, B, w, w.$async);
    }
    function N(w) {
      let B = X.scopeValue("schema", G.code.source === true ? { ref: w, code: (0, J6.stringify)(w) } : { ref: w }), L = X.name("valid"), j = $.subschema({ schema: w, dataTypes: [], schemaPath: J6.nil, topSchemaRef: B, errSchemaPath: J }, L);
      $.mergeEvaluated(j), $.ok(L);
    }
  } };
  function SB($, X) {
    let { gen: J } = $;
    return X.validate ? J.scopeValue("validate", { ref: X.validate }) : J6._`${J.scopeValue("wrapper", { ref: X })}.validate`;
  }
  vB.getValidate = SB;
  function g7($, X, J, Q) {
    let { gen: Y, it: z } = $, { allErrors: W, schemaEnv: G, opts: U } = z, H = U.passContext ? c0.default.this : J6.nil;
    if (Q) K();
    else V();
    function K() {
      if (!G.$async) throw Error("async schema referenced by sync schema");
      let w = Y.let("valid");
      Y.try(() => {
        if (Y.code(J6._`await ${(0, EB.callValidateCode)($, X, H)}`), N(X), !W) Y.assign(w, true);
      }, (B) => {
        if (Y.if(J6._`!(${B} instanceof ${z.ValidationError})`, () => Y.throw(B)), O(B), !W) Y.assign(w, false);
      }), $.ok(w);
    }
    function V() {
      $.result((0, EB.callValidateCode)($, X, H), () => N(X), () => O(X));
    }
    function O(w) {
      let B = J6._`${w}.errors`;
      Y.assign(c0.default.vErrors, J6._`${c0.default.vErrors} === null ? ${B} : ${c0.default.vErrors}.concat(${B})`), Y.assign(c0.default.errors, J6._`${c0.default.vErrors}.length`);
    }
    function N(w) {
      var B;
      if (!z.opts.unevaluated) return;
      let L = (B = J === null || J === void 0 ? void 0 : J.validate) === null || B === void 0 ? void 0 : B.evaluated;
      if (z.props !== true) if (L && !L.dynamicProps) {
        if (L.props !== void 0) z.props = y7.mergeEvaluated.props(Y, L.props, z.props);
      } else {
        let j = Y.var("props", J6._`${w}.evaluated.props`);
        z.props = y7.mergeEvaluated.props(Y, j, z.props, J6.Name);
      }
      if (z.items !== true) if (L && !L.dynamicItems) {
        if (L.items !== void 0) z.items = y7.mergeEvaluated.items(Y, L.items, z.items);
      } else {
        let j = Y.var("items", J6._`${w}.evaluated.items`);
        z.items = y7.mergeEvaluated.items(Y, j, z.items, J6.Name);
      }
    }
  }
  vB.callRef = g7;
  vB.default = cv;
});
var xB = k((_B) => {
  Object.defineProperty(_B, "__esModule", { value: true });
  var nv = ZB(), dv = kB(), rv = ["$schema", "$id", "$defs", "$vocabulary", { keyword: "$comment" }, "definitions", nv.default, dv.default];
  _B.default = rv;
});
var yB = k((TB) => {
  Object.defineProperty(TB, "__esModule", { value: true });
  var f7 = a(), d4 = f7.operators, h7 = { maximum: { okStr: "<=", ok: d4.LTE, fail: d4.GT }, minimum: { okStr: ">=", ok: d4.GTE, fail: d4.LT }, exclusiveMaximum: { okStr: "<", ok: d4.LT, fail: d4.GTE }, exclusiveMinimum: { okStr: ">", ok: d4.GT, fail: d4.LTE } }, tv = { message: ({ keyword: $, schemaCode: X }) => f7.str`must be ${h7[$].okStr} ${X}`, params: ({ keyword: $, schemaCode: X }) => f7._`{comparison: ${h7[$].okStr}, limit: ${X}}` }, av = { keyword: Object.keys(h7), type: "number", schemaType: "number", $data: true, error: tv, code($) {
    let { keyword: X, data: J, schemaCode: Q } = $;
    $.fail$data(f7._`${J} ${h7[X].fail} ${Q} || isNaN(${J})`);
  } };
  TB.default = av;
});
var fB = k((gB) => {
  Object.defineProperty(gB, "__esModule", { value: true });
  var T9 = a(), ev = { message: ({ schemaCode: $ }) => T9.str`must be multiple of ${$}`, params: ({ schemaCode: $ }) => T9._`{multipleOf: ${$}}` }, $C = { keyword: "multipleOf", type: "number", schemaType: "number", $data: true, error: ev, code($) {
    let { gen: X, data: J, schemaCode: Q, it: Y } = $, z = Y.opts.multipleOfPrecision, W = X.let("res"), G = z ? T9._`Math.abs(Math.round(${W}) - ${W}) > 1e-${z}` : T9._`${W} !== parseInt(${W})`;
    $.fail$data(T9._`(${Q} === 0 || (${W} = ${J}/${Q}, ${G}))`);
  } };
  gB.default = $C;
});
var mB = k((uB) => {
  Object.defineProperty(uB, "__esModule", { value: true });
  function hB($) {
    let X = $.length, J = 0, Q = 0, Y;
    while (Q < X) if (J++, Y = $.charCodeAt(Q++), Y >= 55296 && Y <= 56319 && Q < X) {
      if (Y = $.charCodeAt(Q), (Y & 64512) === 56320) Q++;
    }
    return J;
  }
  uB.default = hB;
  hB.code = 'require("ajv/dist/runtime/ucs2length").default';
});
var cB = k((lB) => {
  Object.defineProperty(lB, "__esModule", { value: true });
  var v1 = a(), YC = Q$(), QC = mB(), zC = { message({ keyword: $, schemaCode: X }) {
    let J = $ === "maxLength" ? "more" : "fewer";
    return v1.str`must NOT have ${J} than ${X} characters`;
  }, params: ({ schemaCode: $ }) => v1._`{limit: ${$}}` }, WC = { keyword: ["maxLength", "minLength"], type: "string", schemaType: "number", $data: true, error: zC, code($) {
    let { keyword: X, data: J, schemaCode: Q, it: Y } = $, z = X === "maxLength" ? v1.operators.GT : v1.operators.LT, W = Y.opts.unicode === false ? v1._`${J}.length` : v1._`${(0, YC.useFunc)($.gen, QC.default)}(${J})`;
    $.fail$data(v1._`${W} ${z} ${Q}`);
  } };
  lB.default = WC;
});
var pB = k((iB) => {
  Object.defineProperty(iB, "__esModule", { value: true });
  var UC = M6(), HC = Q$(), i0 = a(), KC = { message: ({ schemaCode: $ }) => i0.str`must match pattern "${$}"`, params: ({ schemaCode: $ }) => i0._`{pattern: ${$}}` }, NC = { keyword: "pattern", type: "string", schemaType: "string", $data: true, error: KC, code($) {
    let { gen: X, data: J, $data: Q, schema: Y, schemaCode: z, it: W } = $, G = W.opts.unicodeRegExp ? "u" : "";
    if (Q) {
      let { regExp: U } = W.opts.code, H = U.code === "new RegExp" ? i0._`new RegExp` : (0, HC.useFunc)(X, U), K = X.let("valid");
      X.try(() => X.assign(K, i0._`${H}(${z}, ${G}).test(${J})`), () => X.assign(K, false)), $.fail$data(i0._`!${K}`);
    } else {
      let U = (0, UC.usePattern)($, Y);
      $.fail$data(i0._`!${U}.test(${J})`);
    }
  } };
  iB.default = NC;
});
var dB = k((nB) => {
  Object.defineProperty(nB, "__esModule", { value: true });
  var y9 = a(), OC = { message({ keyword: $, schemaCode: X }) {
    let J = $ === "maxProperties" ? "more" : "fewer";
    return y9.str`must NOT have ${J} than ${X} properties`;
  }, params: ({ schemaCode: $ }) => y9._`{limit: ${$}}` }, wC = { keyword: ["maxProperties", "minProperties"], type: "object", schemaType: "number", $data: true, error: OC, code($) {
    let { keyword: X, data: J, schemaCode: Q } = $, Y = X === "maxProperties" ? y9.operators.GT : y9.operators.LT;
    $.fail$data(y9._`Object.keys(${J}).length ${Y} ${Q}`);
  } };
  nB.default = wC;
});
var oB = k((rB) => {
  Object.defineProperty(rB, "__esModule", { value: true });
  var g9 = M6(), f9 = a(), qC = Q$(), DC = { message: ({ params: { missingProperty: $ } }) => f9.str`must have required property '${$}'`, params: ({ params: { missingProperty: $ } }) => f9._`{missingProperty: ${$}}` }, LC = { keyword: "required", type: "object", schemaType: "array", $data: true, error: DC, code($) {
    let { gen: X, schema: J, schemaCode: Q, data: Y, $data: z, it: W } = $, { opts: G } = W;
    if (!z && J.length === 0) return;
    let U = J.length >= G.loopRequired;
    if (W.allErrors) H();
    else K();
    if (G.strictRequired) {
      let N = $.parentSchema.properties, { definedProperties: w } = $.it;
      for (let B of J) if ((N === null || N === void 0 ? void 0 : N[B]) === void 0 && !w.has(B)) {
        let L = W.schemaEnv.baseId + W.errSchemaPath, j = `required property "${B}" is not defined at "${L}" (strictRequired)`;
        (0, qC.checkStrictMode)(W, j, W.opts.strictRequired);
      }
    }
    function H() {
      if (U || z) $.block$data(f9.nil, V);
      else for (let N of J) (0, g9.checkReportMissingProp)($, N);
    }
    function K() {
      let N = X.let("missing");
      if (U || z) {
        let w = X.let("valid", true);
        $.block$data(w, () => O(N, w)), $.ok(w);
      } else X.if((0, g9.checkMissingProp)($, J, N)), (0, g9.reportMissingProp)($, N), X.else();
    }
    function V() {
      X.forOf("prop", Q, (N) => {
        $.setParams({ missingProperty: N }), X.if((0, g9.noPropertyInData)(X, Y, N, G.ownProperties), () => $.error());
      });
    }
    function O(N, w) {
      $.setParams({ missingProperty: N }), X.forOf(N, Q, () => {
        X.assign(w, (0, g9.propertyInData)(X, Y, N, G.ownProperties)), X.if((0, f9.not)(w), () => {
          $.error(), X.break();
        });
      }, f9.nil);
    }
  } };
  rB.default = LC;
});
var aB = k((tB) => {
  Object.defineProperty(tB, "__esModule", { value: true });
  var h9 = a(), FC = { message({ keyword: $, schemaCode: X }) {
    let J = $ === "maxItems" ? "more" : "fewer";
    return h9.str`must NOT have ${J} than ${X} items`;
  }, params: ({ schemaCode: $ }) => h9._`{limit: ${$}}` }, IC = { keyword: ["maxItems", "minItems"], type: "array", schemaType: "number", $data: true, error: FC, code($) {
    let { keyword: X, data: J, schemaCode: Q } = $, Y = X === "maxItems" ? h9.operators.GT : h9.operators.LT;
    $.fail$data(h9._`${J}.length ${Y} ${Q}`);
  } };
  tB.default = IC;
});
var u7 = k((eB) => {
  Object.defineProperty(eB, "__esModule", { value: true });
  var sB = h3();
  sB.code = 'require("ajv/dist/runtime/equal").default';
  eB.default = sB;
});
var Xq = k(($q) => {
  Object.defineProperty($q, "__esModule", { value: true });
  var $U = P9(), h$ = a(), bC = Q$(), PC = u7(), ZC = { message: ({ params: { i: $, j: X } }) => h$.str`must NOT have duplicate items (items ## ${X} and ${$} are identical)`, params: ({ params: { i: $, j: X } }) => h$._`{i: ${$}, j: ${X}}` }, EC = { keyword: "uniqueItems", type: "array", schemaType: "boolean", $data: true, error: ZC, code($) {
    let { gen: X, data: J, $data: Q, schema: Y, parentSchema: z, schemaCode: W, it: G } = $;
    if (!Q && !Y) return;
    let U = X.let("valid"), H = z.items ? (0, $U.getSchemaTypes)(z.items) : [];
    $.block$data(U, K, h$._`${W} === false`), $.ok(U);
    function K() {
      let w = X.let("i", h$._`${J}.length`), B = X.let("j");
      $.setParams({ i: w, j: B }), X.assign(U, true), X.if(h$._`${w} > 1`, () => (V() ? O : N)(w, B));
    }
    function V() {
      return H.length > 0 && !H.some((w) => w === "object" || w === "array");
    }
    function O(w, B) {
      let L = X.name("item"), j = (0, $U.checkDataTypes)(H, L, G.opts.strictNumbers, $U.DataType.Wrong), M = X.const("indices", h$._`{}`);
      X.for(h$._`;${w}--;`, () => {
        if (X.let(L, h$._`${J}[${w}]`), X.if(j, h$._`continue`), H.length > 1) X.if(h$._`typeof ${L} == "string"`, h$._`${L} += "_"`);
        X.if(h$._`typeof ${M}[${L}] == "number"`, () => {
          X.assign(B, h$._`${M}[${L}]`), $.error(), X.assign(U, false).break();
        }).code(h$._`${M}[${L}] = ${w}`);
      });
    }
    function N(w, B) {
      let L = (0, bC.useFunc)(X, PC.default), j = X.name("outer");
      X.label(j).for(h$._`;${w}--;`, () => X.for(h$._`${B} = ${w}; ${B}--;`, () => X.if(h$._`${L}(${J}[${w}], ${J}[${B}])`, () => {
        $.error(), X.assign(U, false).break(j);
      })));
    }
  } };
  $q.default = EC;
});
var Yq = k((Jq) => {
  Object.defineProperty(Jq, "__esModule", { value: true });
  var XU = a(), SC = Q$(), vC = u7(), CC = { message: "must be equal to constant", params: ({ schemaCode: $ }) => XU._`{allowedValue: ${$}}` }, kC = { keyword: "const", $data: true, error: CC, code($) {
    let { gen: X, data: J, $data: Q, schemaCode: Y, schema: z } = $;
    if (Q || z && typeof z == "object") $.fail$data(XU._`!${(0, SC.useFunc)(X, vC.default)}(${J}, ${Y})`);
    else $.fail(XU._`${z} !== ${J}`);
  } };
  Jq.default = kC;
});
var zq = k((Qq) => {
  Object.defineProperty(Qq, "__esModule", { value: true });
  var u9 = a(), xC = Q$(), TC = u7(), yC = { message: "must be equal to one of the allowed values", params: ({ schemaCode: $ }) => u9._`{allowedValues: ${$}}` }, gC = { keyword: "enum", schemaType: "array", $data: true, error: yC, code($) {
    let { gen: X, data: J, $data: Q, schema: Y, schemaCode: z, it: W } = $;
    if (!Q && Y.length === 0) throw Error("enum must have non-empty array");
    let G = Y.length >= W.opts.loopEnum, U, H = () => U !== null && U !== void 0 ? U : U = (0, xC.useFunc)(X, TC.default), K;
    if (G || Q) K = X.let("valid"), $.block$data(K, V);
    else {
      if (!Array.isArray(Y)) throw Error("ajv implementation error");
      let N = X.const("vSchema", z);
      K = (0, u9.or)(...Y.map((w, B) => O(N, B)));
    }
    $.pass(K);
    function V() {
      X.assign(K, false), X.forOf("v", z, (N) => X.if(u9._`${H()}(${J}, ${N})`, () => X.assign(K, true).break()));
    }
    function O(N, w) {
      let B = Y[w];
      return typeof B === "object" && B !== null ? u9._`${H()}(${J}, ${N}[${w}])` : u9._`${J} === ${B}`;
    }
  } };
  Qq.default = gC;
});
var Gq = k((Wq) => {
  Object.defineProperty(Wq, "__esModule", { value: true });
  var hC = yB(), uC = fB(), mC = cB(), lC = pB(), cC = dB(), iC = oB(), pC = aB(), nC = Xq(), dC = Yq(), rC = zq(), oC = [hC.default, uC.default, mC.default, lC.default, cC.default, iC.default, pC.default, nC.default, { keyword: "type", schemaType: ["string", "array"] }, { keyword: "nullable", schemaType: "boolean" }, dC.default, rC.default];
  Wq.default = oC;
});
var YU = k((Hq) => {
  Object.defineProperty(Hq, "__esModule", { value: true });
  Hq.validateAdditionalItems = void 0;
  var C1 = a(), JU = Q$(), aC = { message: ({ params: { len: $ } }) => C1.str`must NOT have more than ${$} items`, params: ({ params: { len: $ } }) => C1._`{limit: ${$}}` }, sC = { keyword: "additionalItems", type: "array", schemaType: ["boolean", "object"], before: "uniqueItems", error: aC, code($) {
    let { parentSchema: X, it: J } = $, { items: Q } = X;
    if (!Array.isArray(Q)) {
      (0, JU.checkStrictMode)(J, '"additionalItems" is ignored when "items" is not an array of schemas');
      return;
    }
    Uq($, Q);
  } };
  function Uq($, X) {
    let { gen: J, schema: Q, data: Y, keyword: z, it: W } = $;
    W.items = true;
    let G = J.const("len", C1._`${Y}.length`);
    if (Q === false) $.setParams({ len: X.length }), $.pass(C1._`${G} <= ${X.length}`);
    else if (typeof Q == "object" && !(0, JU.alwaysValidSchema)(W, Q)) {
      let H = J.var("valid", C1._`${G} <= ${X.length}`);
      J.if((0, C1.not)(H), () => U(H)), $.ok(H);
    }
    function U(H) {
      J.forRange("i", X.length, G, (K) => {
        if ($.subschema({ keyword: z, dataProp: K, dataPropType: JU.Type.Num }, H), !W.allErrors) J.if((0, C1.not)(H), () => J.break());
      });
    }
  }
  Hq.validateAdditionalItems = Uq;
  Hq.default = sC;
});
var QU = k((Oq) => {
  Object.defineProperty(Oq, "__esModule", { value: true });
  Oq.validateTuple = void 0;
  var Nq = a(), m7 = Q$(), $k = M6(), Xk = { keyword: "items", type: "array", schemaType: ["object", "array", "boolean"], before: "uniqueItems", code($) {
    let { schema: X, it: J } = $;
    if (Array.isArray(X)) return Vq($, "additionalItems", X);
    if (J.items = true, (0, m7.alwaysValidSchema)(J, X)) return;
    $.ok((0, $k.validateArray)($));
  } };
  function Vq($, X, J = $.schema) {
    let { gen: Q, parentSchema: Y, data: z, keyword: W, it: G } = $;
    if (K(Y), G.opts.unevaluated && J.length && G.items !== true) G.items = m7.mergeEvaluated.items(Q, J.length, G.items);
    let U = Q.name("valid"), H = Q.const("len", Nq._`${z}.length`);
    J.forEach((V, O) => {
      if ((0, m7.alwaysValidSchema)(G, V)) return;
      Q.if(Nq._`${H} > ${O}`, () => $.subschema({ keyword: W, schemaProp: O, dataProp: O }, U)), $.ok(U);
    });
    function K(V) {
      let { opts: O, errSchemaPath: N } = G, w = J.length, B = w === V.minItems && (w === V.maxItems || V[X] === false);
      if (O.strictTuples && !B) {
        let L = `"${W}" is ${w}-tuple, but minItems or maxItems/${X} are not specified or different at path "${N}"`;
        (0, m7.checkStrictMode)(G, L, O.strictTuples);
      }
    }
  }
  Oq.validateTuple = Vq;
  Oq.default = Xk;
});
var qq = k((Bq) => {
  Object.defineProperty(Bq, "__esModule", { value: true });
  var Yk = QU(), Qk = { keyword: "prefixItems", type: "array", schemaType: ["array"], before: "uniqueItems", code: ($) => (0, Yk.validateTuple)($, "items") };
  Bq.default = Qk;
});
var jq = k((Lq) => {
  Object.defineProperty(Lq, "__esModule", { value: true });
  var Dq = a(), Wk = Q$(), Gk = M6(), Uk = YU(), Hk = { message: ({ params: { len: $ } }) => Dq.str`must NOT have more than ${$} items`, params: ({ params: { len: $ } }) => Dq._`{limit: ${$}}` }, Kk = { keyword: "items", type: "array", schemaType: ["object", "boolean"], before: "uniqueItems", error: Hk, code($) {
    let { schema: X, parentSchema: J, it: Q } = $, { prefixItems: Y } = J;
    if (Q.items = true, (0, Wk.alwaysValidSchema)(Q, X)) return;
    if (Y) (0, Uk.validateAdditionalItems)($, Y);
    else $.ok((0, Gk.validateArray)($));
  } };
  Lq.default = Kk;
});
var Iq = k((Fq) => {
  Object.defineProperty(Fq, "__esModule", { value: true });
  var A6 = a(), l7 = Q$(), Vk = { message: ({ params: { min: $, max: X } }) => X === void 0 ? A6.str`must contain at least ${$} valid item(s)` : A6.str`must contain at least ${$} and no more than ${X} valid item(s)`, params: ({ params: { min: $, max: X } }) => X === void 0 ? A6._`{minContains: ${$}}` : A6._`{minContains: ${$}, maxContains: ${X}}` }, Ok = { keyword: "contains", type: "array", schemaType: ["object", "boolean"], before: "uniqueItems", trackErrors: true, error: Vk, code($) {
    let { gen: X, schema: J, parentSchema: Q, data: Y, it: z } = $, W, G, { minContains: U, maxContains: H } = Q;
    if (z.opts.next) W = U === void 0 ? 1 : U, G = H;
    else W = 1;
    let K = X.const("len", A6._`${Y}.length`);
    if ($.setParams({ min: W, max: G }), G === void 0 && W === 0) {
      (0, l7.checkStrictMode)(z, '"minContains" == 0 without "maxContains": "contains" keyword ignored');
      return;
    }
    if (G !== void 0 && W > G) {
      (0, l7.checkStrictMode)(z, '"minContains" > "maxContains" is always invalid'), $.fail();
      return;
    }
    if ((0, l7.alwaysValidSchema)(z, J)) {
      let B = A6._`${K} >= ${W}`;
      if (G !== void 0) B = A6._`${B} && ${K} <= ${G}`;
      $.pass(B);
      return;
    }
    z.items = true;
    let V = X.name("valid");
    if (G === void 0 && W === 1) N(V, () => X.if(V, () => X.break()));
    else if (W === 0) {
      if (X.let(V, true), G !== void 0) X.if(A6._`${Y}.length > 0`, O);
    } else X.let(V, false), O();
    $.result(V, () => $.reset());
    function O() {
      let B = X.name("_valid"), L = X.let("count", 0);
      N(B, () => X.if(B, () => w(L)));
    }
    function N(B, L) {
      X.forRange("i", 0, K, (j) => {
        $.subschema({ keyword: "contains", dataProp: j, dataPropType: l7.Type.Num, compositeRule: true }, B), L();
      });
    }
    function w(B) {
      if (X.code(A6._`${B}++`), G === void 0) X.if(A6._`${B} >= ${W}`, () => X.assign(V, true).break());
      else if (X.if(A6._`${B} > ${G}`, () => X.assign(V, false).break()), W === 1) X.assign(V, true);
      else X.if(A6._`${B} >= ${W}`, () => X.assign(V, true));
    }
  } };
  Fq.default = Ok;
});
var Eq = k((bq) => {
  Object.defineProperty(bq, "__esModule", { value: true });
  bq.validateSchemaDeps = bq.validatePropertyDeps = bq.error = void 0;
  var zU = a(), Bk = Q$(), m9 = M6();
  bq.error = { message: ({ params: { property: $, depsCount: X, deps: J } }) => {
    let Q = X === 1 ? "property" : "properties";
    return zU.str`must have ${Q} ${J} when property ${$} is present`;
  }, params: ({ params: { property: $, depsCount: X, deps: J, missingProperty: Q } }) => zU._`{property: ${$},
    missingProperty: ${Q},
    depsCount: ${X},
    deps: ${J}}` };
  var qk = { keyword: "dependencies", type: "object", schemaType: "object", error: bq.error, code($) {
    let [X, J] = Dk($);
    Mq($, X), Aq($, J);
  } };
  function Dk({ schema: $ }) {
    let X = {}, J = {};
    for (let Q in $) {
      if (Q === "__proto__") continue;
      let Y = Array.isArray($[Q]) ? X : J;
      Y[Q] = $[Q];
    }
    return [X, J];
  }
  function Mq($, X = $.schema) {
    let { gen: J, data: Q, it: Y } = $;
    if (Object.keys(X).length === 0) return;
    let z = J.let("missing");
    for (let W in X) {
      let G = X[W];
      if (G.length === 0) continue;
      let U = (0, m9.propertyInData)(J, Q, W, Y.opts.ownProperties);
      if ($.setParams({ property: W, depsCount: G.length, deps: G.join(", ") }), Y.allErrors) J.if(U, () => {
        for (let H of G) (0, m9.checkReportMissingProp)($, H);
      });
      else J.if(zU._`${U} && (${(0, m9.checkMissingProp)($, G, z)})`), (0, m9.reportMissingProp)($, z), J.else();
    }
  }
  bq.validatePropertyDeps = Mq;
  function Aq($, X = $.schema) {
    let { gen: J, data: Q, keyword: Y, it: z } = $, W = J.name("valid");
    for (let G in X) {
      if ((0, Bk.alwaysValidSchema)(z, X[G])) continue;
      J.if((0, m9.propertyInData)(J, Q, G, z.opts.ownProperties), () => {
        let U = $.subschema({ keyword: Y, schemaProp: G }, W);
        $.mergeValidEvaluated(U, W);
      }, () => J.var(W, true)), $.ok(W);
    }
  }
  bq.validateSchemaDeps = Aq;
  bq.default = qk;
});
var vq = k((Sq) => {
  Object.defineProperty(Sq, "__esModule", { value: true });
  var Rq = a(), Fk = Q$(), Ik = { message: "property name must be valid", params: ({ params: $ }) => Rq._`{propertyName: ${$.propertyName}}` }, Mk = { keyword: "propertyNames", type: "object", schemaType: ["object", "boolean"], error: Ik, code($) {
    let { gen: X, schema: J, data: Q, it: Y } = $;
    if ((0, Fk.alwaysValidSchema)(Y, J)) return;
    let z = X.name("valid");
    X.forIn("key", Q, (W) => {
      $.setParams({ propertyName: W }), $.subschema({ keyword: "propertyNames", data: W, dataTypes: ["string"], propertyName: W, compositeRule: true }, z), X.if((0, Rq.not)(z), () => {
        if ($.error(true), !Y.allErrors) X.break();
      });
    }), $.ok(z);
  } };
  Sq.default = Mk;
});
var WU = k((Cq) => {
  Object.defineProperty(Cq, "__esModule", { value: true });
  var c7 = M6(), T6 = a(), bk = w4(), i7 = Q$(), Pk = { message: "must NOT have additional properties", params: ({ params: $ }) => T6._`{additionalProperty: ${$.additionalProperty}}` }, Zk = { keyword: "additionalProperties", type: ["object"], schemaType: ["boolean", "object"], allowUndefined: true, trackErrors: true, error: Pk, code($) {
    let { gen: X, schema: J, parentSchema: Q, data: Y, errsCount: z, it: W } = $;
    if (!z) throw Error("ajv implementation error");
    let { allErrors: G, opts: U } = W;
    if (W.props = true, U.removeAdditional !== "all" && (0, i7.alwaysValidSchema)(W, J)) return;
    let H = (0, c7.allSchemaProperties)(Q.properties), K = (0, c7.allSchemaProperties)(Q.patternProperties);
    V(), $.ok(T6._`${z} === ${bk.default.errors}`);
    function V() {
      X.forIn("key", Y, (L) => {
        if (!H.length && !K.length) w(L);
        else X.if(O(L), () => w(L));
      });
    }
    function O(L) {
      let j;
      if (H.length > 8) {
        let M = (0, i7.schemaRefOrVal)(W, Q.properties, "properties");
        j = (0, c7.isOwnProperty)(X, M, L);
      } else if (H.length) j = (0, T6.or)(...H.map((M) => T6._`${L} === ${M}`));
      else j = T6.nil;
      if (K.length) j = (0, T6.or)(j, ...K.map((M) => T6._`${(0, c7.usePattern)($, M)}.test(${L})`));
      return (0, T6.not)(j);
    }
    function N(L) {
      X.code(T6._`delete ${Y}[${L}]`);
    }
    function w(L) {
      if (U.removeAdditional === "all" || U.removeAdditional && J === false) {
        N(L);
        return;
      }
      if (J === false) {
        if ($.setParams({ additionalProperty: L }), $.error(), !G) X.break();
        return;
      }
      if (typeof J == "object" && !(0, i7.alwaysValidSchema)(W, J)) {
        let j = X.name("valid");
        if (U.removeAdditional === "failing") B(L, j, false), X.if((0, T6.not)(j), () => {
          $.reset(), N(L);
        });
        else if (B(L, j), !G) X.if((0, T6.not)(j), () => X.break());
      }
    }
    function B(L, j, M) {
      let b = { keyword: "additionalProperties", dataProp: L, dataPropType: i7.Type.Str };
      if (M === false) Object.assign(b, { compositeRule: true, createErrors: false, allErrors: false });
      $.subschema(b, j);
    }
  } };
  Cq.default = Zk;
});
var Tq = k((xq) => {
  Object.defineProperty(xq, "__esModule", { value: true });
  var Rk = S9(), kq = M6(), GU = Q$(), _q = WU(), Sk = { keyword: "properties", type: "object", schemaType: "object", code($) {
    let { gen: X, schema: J, parentSchema: Q, data: Y, it: z } = $;
    if (z.opts.removeAdditional === "all" && Q.additionalProperties === void 0) _q.default.code(new Rk.KeywordCxt(z, _q.default, "additionalProperties"));
    let W = (0, kq.allSchemaProperties)(J);
    for (let V of W) z.definedProperties.add(V);
    if (z.opts.unevaluated && W.length && z.props !== true) z.props = GU.mergeEvaluated.props(X, (0, GU.toHash)(W), z.props);
    let G = W.filter((V) => !(0, GU.alwaysValidSchema)(z, J[V]));
    if (G.length === 0) return;
    let U = X.name("valid");
    for (let V of G) {
      if (H(V)) K(V);
      else {
        if (X.if((0, kq.propertyInData)(X, Y, V, z.opts.ownProperties)), K(V), !z.allErrors) X.else().var(U, true);
        X.endIf();
      }
      $.it.definedProperties.add(V), $.ok(U);
    }
    function H(V) {
      return z.opts.useDefaults && !z.compositeRule && J[V].default !== void 0;
    }
    function K(V) {
      $.subschema({ keyword: "properties", schemaProp: V, dataProp: V }, U);
    }
  } };
  xq.default = Sk;
});
var uq = k((hq) => {
  Object.defineProperty(hq, "__esModule", { value: true });
  var yq = M6(), p7 = a(), gq = Q$(), fq = Q$(), Ck = { keyword: "patternProperties", type: "object", schemaType: "object", code($) {
    let { gen: X, schema: J, data: Q, parentSchema: Y, it: z } = $, { opts: W } = z, G = (0, yq.allSchemaProperties)(J), U = G.filter((B) => (0, gq.alwaysValidSchema)(z, J[B]));
    if (G.length === 0 || U.length === G.length && (!z.opts.unevaluated || z.props === true)) return;
    let H = W.strictSchema && !W.allowMatchingProperties && Y.properties, K = X.name("valid");
    if (z.props !== true && !(z.props instanceof p7.Name)) z.props = (0, fq.evaluatedPropsToName)(X, z.props);
    let { props: V } = z;
    O();
    function O() {
      for (let B of G) {
        if (H) N(B);
        if (z.allErrors) w(B);
        else X.var(K, true), w(B), X.if(K);
      }
    }
    function N(B) {
      for (let L in H) if (new RegExp(B).test(L)) (0, gq.checkStrictMode)(z, `property ${L} matches pattern ${B} (use allowMatchingProperties)`);
    }
    function w(B) {
      X.forIn("key", Q, (L) => {
        X.if(p7._`${(0, yq.usePattern)($, B)}.test(${L})`, () => {
          let j = U.includes(B);
          if (!j) $.subschema({ keyword: "patternProperties", schemaProp: B, dataProp: L, dataPropType: fq.Type.Str }, K);
          if (z.opts.unevaluated && V !== true) X.assign(p7._`${V}[${L}]`, true);
          else if (!j && !z.allErrors) X.if((0, p7.not)(K), () => X.break());
        });
      });
    }
  } };
  hq.default = Ck;
});
var lq = k((mq) => {
  Object.defineProperty(mq, "__esModule", { value: true });
  var _k = Q$(), xk = { keyword: "not", schemaType: ["object", "boolean"], trackErrors: true, code($) {
    let { gen: X, schema: J, it: Q } = $;
    if ((0, _k.alwaysValidSchema)(Q, J)) {
      $.fail();
      return;
    }
    let Y = X.name("valid");
    $.subschema({ keyword: "not", compositeRule: true, createErrors: false, allErrors: false }, Y), $.failResult(Y, () => $.reset(), () => $.error());
  }, error: { message: "must NOT be valid" } };
  mq.default = xk;
});
var iq = k((cq) => {
  Object.defineProperty(cq, "__esModule", { value: true });
  var yk = M6(), gk = { keyword: "anyOf", schemaType: "array", trackErrors: true, code: yk.validateUnion, error: { message: "must match a schema in anyOf" } };
  cq.default = gk;
});
var nq = k((pq) => {
  Object.defineProperty(pq, "__esModule", { value: true });
  var n7 = a(), hk = Q$(), uk = { message: "must match exactly one schema in oneOf", params: ({ params: $ }) => n7._`{passingSchemas: ${$.passing}}` }, mk = { keyword: "oneOf", schemaType: "array", trackErrors: true, error: uk, code($) {
    let { gen: X, schema: J, parentSchema: Q, it: Y } = $;
    if (!Array.isArray(J)) throw Error("ajv implementation error");
    if (Y.opts.discriminator && Q.discriminator) return;
    let z = J, W = X.let("valid", false), G = X.let("passing", null), U = X.name("_valid");
    $.setParams({ passing: G }), X.block(H), $.result(W, () => $.reset(), () => $.error(true));
    function H() {
      z.forEach((K, V) => {
        let O;
        if ((0, hk.alwaysValidSchema)(Y, K)) X.var(U, true);
        else O = $.subschema({ keyword: "oneOf", schemaProp: V, compositeRule: true }, U);
        if (V > 0) X.if(n7._`${U} && ${W}`).assign(W, false).assign(G, n7._`[${G}, ${V}]`).else();
        X.if(U, () => {
          if (X.assign(W, true), X.assign(G, V), O) $.mergeEvaluated(O, n7.Name);
        });
      });
    }
  } };
  pq.default = mk;
});
var rq = k((dq) => {
  Object.defineProperty(dq, "__esModule", { value: true });
  var ck = Q$(), ik = { keyword: "allOf", schemaType: "array", code($) {
    let { gen: X, schema: J, it: Q } = $;
    if (!Array.isArray(J)) throw Error("ajv implementation error");
    let Y = X.name("valid");
    J.forEach((z, W) => {
      if ((0, ck.alwaysValidSchema)(Q, z)) return;
      let G = $.subschema({ keyword: "allOf", schemaProp: W }, Y);
      $.ok(Y), $.mergeEvaluated(G);
    });
  } };
  dq.default = ik;
});
var sq = k((aq) => {
  Object.defineProperty(aq, "__esModule", { value: true });
  var d7 = a(), tq = Q$(), nk = { message: ({ params: $ }) => d7.str`must match "${$.ifClause}" schema`, params: ({ params: $ }) => d7._`{failingKeyword: ${$.ifClause}}` }, dk = { keyword: "if", schemaType: ["object", "boolean"], trackErrors: true, error: nk, code($) {
    let { gen: X, parentSchema: J, it: Q } = $;
    if (J.then === void 0 && J.else === void 0) (0, tq.checkStrictMode)(Q, '"if" without "then" and "else" is ignored');
    let Y = oq(Q, "then"), z = oq(Q, "else");
    if (!Y && !z) return;
    let W = X.let("valid", true), G = X.name("_valid");
    if (U(), $.reset(), Y && z) {
      let K = X.let("ifClause");
      $.setParams({ ifClause: K }), X.if(G, H("then", K), H("else", K));
    } else if (Y) X.if(G, H("then"));
    else X.if((0, d7.not)(G), H("else"));
    $.pass(W, () => $.error(true));
    function U() {
      let K = $.subschema({ keyword: "if", compositeRule: true, createErrors: false, allErrors: false }, G);
      $.mergeEvaluated(K);
    }
    function H(K, V) {
      return () => {
        let O = $.subschema({ keyword: K }, G);
        if (X.assign(W, G), $.mergeValidEvaluated(O, W), V) X.assign(V, d7._`${K}`);
        else $.setParams({ ifClause: K });
      };
    }
  } };
  function oq($, X) {
    let J = $.schema[X];
    return J !== void 0 && !(0, tq.alwaysValidSchema)($, J);
  }
  aq.default = dk;
});
var $D = k((eq) => {
  Object.defineProperty(eq, "__esModule", { value: true });
  var ok = Q$(), tk = { keyword: ["then", "else"], schemaType: ["object", "boolean"], code({ keyword: $, parentSchema: X, it: J }) {
    if (X.if === void 0) (0, ok.checkStrictMode)(J, `"${$}" without "if" is ignored`);
  } };
  eq.default = tk;
});
var JD = k((XD) => {
  Object.defineProperty(XD, "__esModule", { value: true });
  var sk = YU(), ek = qq(), $_ = QU(), X_ = jq(), J_ = Iq(), Y_ = Eq(), Q_ = vq(), z_ = WU(), W_ = Tq(), G_ = uq(), U_ = lq(), H_ = iq(), K_ = nq(), N_ = rq(), V_ = sq(), O_ = $D();
  function w_($ = false) {
    let X = [U_.default, H_.default, K_.default, N_.default, V_.default, O_.default, Q_.default, z_.default, Y_.default, W_.default, G_.default];
    if ($) X.push(ek.default, X_.default);
    else X.push(sk.default, $_.default);
    return X.push(J_.default), X;
  }
  XD.default = w_;
});
var QD = k((YD) => {
  Object.defineProperty(YD, "__esModule", { value: true });
  var R$ = a(), q_ = { message: ({ schemaCode: $ }) => R$.str`must match format "${$}"`, params: ({ schemaCode: $ }) => R$._`{format: ${$}}` }, D_ = { keyword: "format", type: ["number", "string"], schemaType: "string", $data: true, error: q_, code($, X) {
    let { gen: J, data: Q, $data: Y, schema: z, schemaCode: W, it: G } = $, { opts: U, errSchemaPath: H, schemaEnv: K, self: V } = G;
    if (!U.validateFormats) return;
    if (Y) O();
    else N();
    function O() {
      let w = J.scopeValue("formats", { ref: V.formats, code: U.code.formats }), B = J.const("fDef", R$._`${w}[${W}]`), L = J.let("fType"), j = J.let("format");
      J.if(R$._`typeof ${B} == "object" && !(${B} instanceof RegExp)`, () => J.assign(L, R$._`${B}.type || "string"`).assign(j, R$._`${B}.validate`), () => J.assign(L, R$._`"string"`).assign(j, B)), $.fail$data((0, R$.or)(M(), b()));
      function M() {
        if (U.strictSchema === false) return R$.nil;
        return R$._`${W} && !${j}`;
      }
      function b() {
        let x = K.$async ? R$._`(${B}.async ? await ${j}(${Q}) : ${j}(${Q}))` : R$._`${j}(${Q})`, h = R$._`(typeof ${j} == "function" ? ${x} : ${j}.test(${Q}))`;
        return R$._`${j} && ${j} !== true && ${L} === ${X} && !${h}`;
      }
    }
    function N() {
      let w = V.formats[z];
      if (!w) {
        M();
        return;
      }
      if (w === true) return;
      let [B, L, j] = b(w);
      if (B === X) $.pass(x());
      function M() {
        if (U.strictSchema === false) {
          V.logger.warn(h());
          return;
        }
        throw Error(h());
        function h() {
          return `unknown format "${z}" ignored in schema at path "${H}"`;
        }
      }
      function b(h) {
        let B$ = h instanceof RegExp ? (0, R$.regexpCode)(h) : U.code.formats ? R$._`${U.code.formats}${(0, R$.getProperty)(z)}` : void 0, x$ = J.scopeValue("formats", { key: z, ref: h, code: B$ });
        if (typeof h == "object" && !(h instanceof RegExp)) return [h.type || "string", h.validate, R$._`${x$}.validate`];
        return ["string", h, x$];
      }
      function x() {
        if (typeof w == "object" && !(w instanceof RegExp) && w.async) {
          if (!K.$async) throw Error("async format in sync schema");
          return R$._`await ${j}(${Q})`;
        }
        return typeof L == "function" ? R$._`${j}(${Q})` : R$._`${j}.test(${Q})`;
      }
    }
  } };
  YD.default = D_;
});
var WD = k((zD) => {
  Object.defineProperty(zD, "__esModule", { value: true });
  var j_ = QD(), F_ = [j_.default];
  zD.default = F_;
});
var HD = k((GD) => {
  Object.defineProperty(GD, "__esModule", { value: true });
  GD.contentVocabulary = GD.metadataVocabulary = void 0;
  GD.metadataVocabulary = ["title", "description", "default", "deprecated", "readOnly", "writeOnly", "examples"];
  GD.contentVocabulary = ["contentMediaType", "contentEncoding", "contentSchema"];
});
var VD = k((ND) => {
  Object.defineProperty(ND, "__esModule", { value: true });
  var A_ = xB(), b_ = Gq(), P_ = JD(), Z_ = WD(), KD = HD(), E_ = [A_.default, b_.default, (0, P_.default)(), Z_.default, KD.metadataVocabulary, KD.contentVocabulary];
  ND.default = E_;
});
var qD = k((wD) => {
  Object.defineProperty(wD, "__esModule", { value: true });
  wD.DiscrError = void 0;
  var OD;
  (function($) {
    $.Tag = "tag", $.Mapping = "mapping";
  })(OD || (wD.DiscrError = OD = {}));
});
var jD = k((LD) => {
  Object.defineProperty(LD, "__esModule", { value: true });
  var p0 = a(), UU = qD(), DD = v7(), S_ = v9(), v_ = Q$(), C_ = { message: ({ params: { discrError: $, tagName: X } }) => $ === UU.DiscrError.Tag ? `tag "${X}" must be string` : `value of tag "${X}" must be in oneOf`, params: ({ params: { discrError: $, tag: X, tagName: J } }) => p0._`{error: ${$}, tag: ${J}, tagValue: ${X}}` }, k_ = { keyword: "discriminator", type: "object", schemaType: "object", error: C_, code($) {
    let { gen: X, data: J, schema: Q, parentSchema: Y, it: z } = $, { oneOf: W } = Y;
    if (!z.opts.discriminator) throw Error("discriminator: requires discriminator option");
    let G = Q.propertyName;
    if (typeof G != "string") throw Error("discriminator: requires propertyName");
    if (Q.mapping) throw Error("discriminator: mapping is not supported");
    if (!W) throw Error("discriminator: requires oneOf keyword");
    let U = X.let("valid", false), H = X.const("tag", p0._`${J}${(0, p0.getProperty)(G)}`);
    X.if(p0._`typeof ${H} == "string"`, () => K(), () => $.error(false, { discrError: UU.DiscrError.Tag, tag: H, tagName: G })), $.ok(U);
    function K() {
      let N = O();
      X.if(false);
      for (let w in N) X.elseIf(p0._`${H} === ${w}`), X.assign(U, V(N[w]));
      X.else(), $.error(false, { discrError: UU.DiscrError.Mapping, tag: H, tagName: G }), X.endIf();
    }
    function V(N) {
      let w = X.name("valid"), B = $.subschema({ keyword: "oneOf", schemaProp: N }, w);
      return $.mergeEvaluated(B, p0.Name), w;
    }
    function O() {
      var N;
      let w = {}, B = j(Y), L = true;
      for (let x = 0; x < W.length; x++) {
        let h = W[x];
        if ((h === null || h === void 0 ? void 0 : h.$ref) && !(0, v_.schemaHasRulesButRef)(h, z.self.RULES)) {
          let x$ = h.$ref;
          if (h = DD.resolveRef.call(z.self, z.schemaEnv.root, z.baseId, x$), h instanceof DD.SchemaEnv) h = h.schema;
          if (h === void 0) throw new S_.default(z.opts.uriResolver, z.baseId, x$);
        }
        let B$ = (N = h === null || h === void 0 ? void 0 : h.properties) === null || N === void 0 ? void 0 : N[G];
        if (typeof B$ != "object") throw Error(`discriminator: oneOf subschemas (or referenced schemas) must have "properties/${G}"`);
        L = L && (B || j(h)), M(B$, x);
      }
      if (!L) throw Error(`discriminator: "${G}" must be required`);
      return w;
      function j({ required: x }) {
        return Array.isArray(x) && x.includes(G);
      }
      function M(x, h) {
        if (x.const) b(x.const, h);
        else if (x.enum) for (let B$ of x.enum) b(B$, h);
        else throw Error(`discriminator: "properties/${G}" must have "const" or "enum"`);
      }
      function b(x, h) {
        if (typeof x != "string" || x in w) throw Error(`discriminator: "${G}" values must be unique strings`);
        w[x] = h;
      }
    }
  } };
  LD.default = k_;
});
var FD = k((qt, x_) => {
  x_.exports = { $schema: "http://json-schema.org/draft-07/schema#", $id: "http://json-schema.org/draft-07/schema#", title: "Core schema meta-schema", definitions: { schemaArray: { type: "array", minItems: 1, items: { $ref: "#" } }, nonNegativeInteger: { type: "integer", minimum: 0 }, nonNegativeIntegerDefault0: { allOf: [{ $ref: "#/definitions/nonNegativeInteger" }, { default: 0 }] }, simpleTypes: { enum: ["array", "boolean", "integer", "null", "number", "object", "string"] }, stringArray: { type: "array", items: { type: "string" }, uniqueItems: true, default: [] } }, type: ["object", "boolean"], properties: { $id: { type: "string", format: "uri-reference" }, $schema: { type: "string", format: "uri" }, $ref: { type: "string", format: "uri-reference" }, $comment: { type: "string" }, title: { type: "string" }, description: { type: "string" }, default: true, readOnly: { type: "boolean", default: false }, examples: { type: "array", items: true }, multipleOf: { type: "number", exclusiveMinimum: 0 }, maximum: { type: "number" }, exclusiveMaximum: { type: "number" }, minimum: { type: "number" }, exclusiveMinimum: { type: "number" }, maxLength: { $ref: "#/definitions/nonNegativeInteger" }, minLength: { $ref: "#/definitions/nonNegativeIntegerDefault0" }, pattern: { type: "string", format: "regex" }, additionalItems: { $ref: "#" }, items: { anyOf: [{ $ref: "#" }, { $ref: "#/definitions/schemaArray" }], default: true }, maxItems: { $ref: "#/definitions/nonNegativeInteger" }, minItems: { $ref: "#/definitions/nonNegativeIntegerDefault0" }, uniqueItems: { type: "boolean", default: false }, contains: { $ref: "#" }, maxProperties: { $ref: "#/definitions/nonNegativeInteger" }, minProperties: { $ref: "#/definitions/nonNegativeIntegerDefault0" }, required: { $ref: "#/definitions/stringArray" }, additionalProperties: { $ref: "#" }, definitions: { type: "object", additionalProperties: { $ref: "#" }, default: {} }, properties: { type: "object", additionalProperties: { $ref: "#" }, default: {} }, patternProperties: { type: "object", additionalProperties: { $ref: "#" }, propertyNames: { format: "regex" }, default: {} }, dependencies: { type: "object", additionalProperties: { anyOf: [{ $ref: "#" }, { $ref: "#/definitions/stringArray" }] } }, propertyNames: { $ref: "#" }, const: true, enum: { type: "array", items: true, minItems: 1, uniqueItems: true }, type: { anyOf: [{ $ref: "#/definitions/simpleTypes" }, { type: "array", items: { $ref: "#/definitions/simpleTypes" }, minItems: 1, uniqueItems: true }] }, format: { type: "string" }, contentMediaType: { type: "string" }, contentEncoding: { type: "string" }, if: { $ref: "#" }, then: { $ref: "#" }, else: { $ref: "#" }, allOf: { $ref: "#/definitions/schemaArray" }, anyOf: { $ref: "#/definitions/schemaArray" }, oneOf: { $ref: "#/definitions/schemaArray" }, not: { $ref: "#" } }, default: true };
});
var KU = k((Y6, HU) => {
  Object.defineProperty(Y6, "__esModule", { value: true });
  Y6.MissingRefError = Y6.ValidationError = Y6.CodeGen = Y6.Name = Y6.nil = Y6.stringify = Y6.str = Y6._ = Y6.KeywordCxt = Y6.Ajv = void 0;
  var T_ = bB(), y_ = VD(), g_ = jD(), ID = FD(), f_ = ["/properties"], r7 = "http://json-schema.org/draft-07/schema";
  class l9 extends T_.default {
    _addVocabularies() {
      if (super._addVocabularies(), y_.default.forEach(($) => this.addVocabulary($)), this.opts.discriminator) this.addKeyword(g_.default);
    }
    _addDefaultMetaSchema() {
      if (super._addDefaultMetaSchema(), !this.opts.meta) return;
      let $ = this.opts.$data ? this.$dataMetaSchema(ID, f_) : ID;
      this.addMetaSchema($, r7, false), this.refs["http://json-schema.org/schema"] = r7;
    }
    defaultMeta() {
      return this.opts.defaultMeta = super.defaultMeta() || (this.getSchema(r7) ? r7 : void 0);
    }
  }
  Y6.Ajv = l9;
  HU.exports = Y6 = l9;
  HU.exports.Ajv = l9;
  Object.defineProperty(Y6, "__esModule", { value: true });
  Y6.default = l9;
  var h_ = S9();
  Object.defineProperty(Y6, "KeywordCxt", { enumerable: true, get: function() {
    return h_.KeywordCxt;
  } });
  var n0 = a();
  Object.defineProperty(Y6, "_", { enumerable: true, get: function() {
    return n0._;
  } });
  Object.defineProperty(Y6, "str", { enumerable: true, get: function() {
    return n0.str;
  } });
  Object.defineProperty(Y6, "stringify", { enumerable: true, get: function() {
    return n0.stringify;
  } });
  Object.defineProperty(Y6, "nil", { enumerable: true, get: function() {
    return n0.nil;
  } });
  Object.defineProperty(Y6, "Name", { enumerable: true, get: function() {
    return n0.Name;
  } });
  Object.defineProperty(Y6, "CodeGen", { enumerable: true, get: function() {
    return n0.CodeGen;
  } });
  var u_ = R7();
  Object.defineProperty(Y6, "ValidationError", { enumerable: true, get: function() {
    return u_.default;
  } });
  var m_ = v9();
  Object.defineProperty(Y6, "MissingRefError", { enumerable: true, get: function() {
    return m_.default;
  } });
});
var CD = k((SD) => {
  Object.defineProperty(SD, "__esModule", { value: true });
  SD.formatNames = SD.fastFormats = SD.fullFormats = void 0;
  function n6($, X) {
    return { validate: $, compare: X };
  }
  SD.fullFormats = { date: n6(PD, wU), time: n6(VU(true), BU), "date-time": n6(MD(true), ED), "iso-time": n6(VU(), ZD), "iso-date-time": n6(MD(), RD), duration: /^P(?!$)((\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?|(\d+W)?)$/, uri: o_, "uri-reference": /^(?:[a-z][a-z0-9+\-.]*:)?(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'"()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?(?:\?(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i, "uri-template": /^(?:(?:[^\x00-\x20"'<>%\\^`{|}]|%[0-9a-f]{2})|\{[+#./;?&=,!@|]?(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?(?:,(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?)*\})*$/i, url: /^(?:https?|ftp):\/\/(?:\S+(?::\S*)?@)?(?:(?!(?:10|127)(?:\.\d{1,3}){3})(?!(?:169\.254|192\.168)(?:\.\d{1,3}){2})(?!172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z0-9\u{00a1}-\u{ffff}]+-)*[a-z0-9\u{00a1}-\u{ffff}]+)(?:\.(?:[a-z0-9\u{00a1}-\u{ffff}]+-)*[a-z0-9\u{00a1}-\u{ffff}]+)*(?:\.(?:[a-z\u{00a1}-\u{ffff}]{2,})))(?::\d{2,5})?(?:\/[^\s]*)?$/iu, email: /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i, hostname: /^(?=.{1,253}\.?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-0-9a-z]{0,61}[0-9a-z])?)*\.?$/i, ipv4: /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/, ipv6: /^((([0-9a-f]{1,4}:){7}([0-9a-f]{1,4}|:))|(([0-9a-f]{1,4}:){6}(:[0-9a-f]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){5}(((:[0-9a-f]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){4}(((:[0-9a-f]{1,4}){1,3})|((:[0-9a-f]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){3}(((:[0-9a-f]{1,4}){1,4})|((:[0-9a-f]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){2}(((:[0-9a-f]{1,4}){1,5})|((:[0-9a-f]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){1}(((:[0-9a-f]{1,4}){1,6})|((:[0-9a-f]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9a-f]{1,4}){1,7})|((:[0-9a-f]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))$/i, regex: Jx, uuid: /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i, "json-pointer": /^(?:\/(?:[^~/]|~0|~1)*)*$/, "json-pointer-uri-fragment": /^#(?:\/(?:[a-z0-9_\-.!$&'()*+,;:=@]|%[0-9a-f]{2}|~0|~1)*)*$/i, "relative-json-pointer": /^(?:0|[1-9][0-9]*)(?:#|(?:\/(?:[^~/]|~0|~1)*)*)$/, byte: t_, int32: { type: "number", validate: e_ }, int64: { type: "number", validate: $x }, float: { type: "number", validate: bD }, double: { type: "number", validate: bD }, password: true, binary: true };
  SD.fastFormats = { ...SD.fullFormats, date: n6(/^\d\d\d\d-[0-1]\d-[0-3]\d$/, wU), time: n6(/^(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)$/i, BU), "date-time": n6(/^\d\d\d\d-[0-1]\d-[0-3]\dt(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)$/i, ED), "iso-time": n6(/^(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)?$/i, ZD), "iso-date-time": n6(/^\d\d\d\d-[0-1]\d-[0-3]\d[t\s](?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)?$/i, RD), uri: /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/)?[^\s]*$/i, "uri-reference": /^(?:(?:[a-z][a-z0-9+\-.]*:)?\/?\/)?(?:[^\\\s#][^\s#]*)?(?:#[^\\\s]*)?$/i, email: /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i };
  SD.formatNames = Object.keys(SD.fullFormats);
  function i_($) {
    return $ % 4 === 0 && ($ % 100 !== 0 || $ % 400 === 0);
  }
  var p_ = /^(\d\d\d\d)-(\d\d)-(\d\d)$/, n_ = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  function PD($) {
    let X = p_.exec($);
    if (!X) return false;
    let J = +X[1], Q = +X[2], Y = +X[3];
    return Q >= 1 && Q <= 12 && Y >= 1 && Y <= (Q === 2 && i_(J) ? 29 : n_[Q]);
  }
  function wU($, X) {
    if (!($ && X)) return;
    if ($ > X) return 1;
    if ($ < X) return -1;
    return 0;
  }
  var NU = /^(\d\d):(\d\d):(\d\d(?:\.\d+)?)(z|([+-])(\d\d)(?::?(\d\d))?)?$/i;
  function VU($) {
    return function(J) {
      let Q = NU.exec(J);
      if (!Q) return false;
      let Y = +Q[1], z = +Q[2], W = +Q[3], G = Q[4], U = Q[5] === "-" ? -1 : 1, H = +(Q[6] || 0), K = +(Q[7] || 0);
      if (H > 23 || K > 59 || $ && !G) return false;
      if (Y <= 23 && z <= 59 && W < 60) return true;
      let V = z - K * U, O = Y - H * U - (V < 0 ? 1 : 0);
      return (O === 23 || O === -1) && (V === 59 || V === -1) && W < 61;
    };
  }
  function BU($, X) {
    if (!($ && X)) return;
    let J = (/* @__PURE__ */ new Date("2020-01-01T" + $)).valueOf(), Q = (/* @__PURE__ */ new Date("2020-01-01T" + X)).valueOf();
    if (!(J && Q)) return;
    return J - Q;
  }
  function ZD($, X) {
    if (!($ && X)) return;
    let J = NU.exec($), Q = NU.exec(X);
    if (!(J && Q)) return;
    if ($ = J[1] + J[2] + J[3], X = Q[1] + Q[2] + Q[3], $ > X) return 1;
    if ($ < X) return -1;
    return 0;
  }
  var OU = /t|\s/i;
  function MD($) {
    let X = VU($);
    return function(Q) {
      let Y = Q.split(OU);
      return Y.length === 2 && PD(Y[0]) && X(Y[1]);
    };
  }
  function ED($, X) {
    if (!($ && X)) return;
    let J = new Date($).valueOf(), Q = new Date(X).valueOf();
    if (!(J && Q)) return;
    return J - Q;
  }
  function RD($, X) {
    if (!($ && X)) return;
    let [J, Q] = $.split(OU), [Y, z] = X.split(OU), W = wU(J, Y);
    if (W === void 0) return;
    return W || BU(Q, z);
  }
  var d_ = /\/|:/, r_ = /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)(?:\?(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i;
  function o_($) {
    return d_.test($) && r_.test($);
  }
  var AD = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/gm;
  function t_($) {
    return AD.lastIndex = 0, AD.test($);
  }
  var a_ = -2147483648, s_ = 2147483647;
  function e_($) {
    return Number.isInteger($) && $ <= s_ && $ >= a_;
  }
  function $x($) {
    return Number.isInteger($);
  }
  function bD() {
    return true;
  }
  var Xx = /[^\\]\\Z/;
  function Jx($) {
    if (Xx.test($)) return false;
    try {
      return new RegExp($), true;
    } catch (X) {
      return false;
    }
  }
});
var _D = k((kD) => {
  Object.defineProperty(kD, "__esModule", { value: true });
  kD.formatLimitDefinition = void 0;
  var Qx = KU(), y6 = a(), r4 = y6.operators, o7 = { formatMaximum: { okStr: "<=", ok: r4.LTE, fail: r4.GT }, formatMinimum: { okStr: ">=", ok: r4.GTE, fail: r4.LT }, formatExclusiveMaximum: { okStr: "<", ok: r4.LT, fail: r4.GTE }, formatExclusiveMinimum: { okStr: ">", ok: r4.GT, fail: r4.LTE } }, zx = { message: ({ keyword: $, schemaCode: X }) => y6.str`should be ${o7[$].okStr} ${X}`, params: ({ keyword: $, schemaCode: X }) => y6._`{comparison: ${o7[$].okStr}, limit: ${X}}` };
  kD.formatLimitDefinition = { keyword: Object.keys(o7), type: "string", schemaType: "string", $data: true, error: zx, code($) {
    let { gen: X, data: J, schemaCode: Q, keyword: Y, it: z } = $, { opts: W, self: G } = z;
    if (!W.validateFormats) return;
    let U = new Qx.KeywordCxt(z, G.RULES.all.format.definition, "format");
    if (U.$data) H();
    else K();
    function H() {
      let O = X.scopeValue("formats", { ref: G.formats, code: W.code.formats }), N = X.const("fmt", y6._`${O}[${U.schemaCode}]`);
      $.fail$data((0, y6.or)(y6._`typeof ${N} != "object"`, y6._`${N} instanceof RegExp`, y6._`typeof ${N}.compare != "function"`, V(N)));
    }
    function K() {
      let O = U.schema, N = G.formats[O];
      if (!N || N === true) return;
      if (typeof N != "object" || N instanceof RegExp || typeof N.compare != "function") throw Error(`"${Y}": format "${O}" does not define "compare" function`);
      let w = X.scopeValue("formats", { key: O, ref: N, code: W.code.formats ? y6._`${W.code.formats}${(0, y6.getProperty)(O)}` : void 0 });
      $.fail$data(V(w));
    }
    function V(O) {
      return y6._`${O}.compare(${J}, ${Q}) ${o7[Y].fail} 0`;
    }
  }, dependencies: ["format"] };
  var Wx = ($) => {
    return $.addKeyword(kD.formatLimitDefinition), $;
  };
  kD.default = Wx;
});
var gD = k((c9, yD) => {
  Object.defineProperty(c9, "__esModule", { value: true });
  var d0 = CD(), Ux = _D(), LU = a(), xD = new LU.Name("fullFormats"), Hx = new LU.Name("fastFormats"), jU = ($, X = { keywords: true }) => {
    if (Array.isArray(X)) return TD($, X, d0.fullFormats, xD), $;
    let [J, Q] = X.mode === "fast" ? [d0.fastFormats, Hx] : [d0.fullFormats, xD], Y = X.formats || d0.formatNames;
    if (TD($, Y, J, Q), X.keywords) (0, Ux.default)($);
    return $;
  };
  jU.get = ($, X = "full") => {
    let Q = (X === "fast" ? d0.fastFormats : d0.fullFormats)[$];
    if (!Q) throw Error(`Unknown format "${$}"`);
    return Q;
  };
  function TD($, X, J, Q) {
    var Y, z;
    (Y = (z = $.opts.code).formats) !== null && Y !== void 0 || (z.formats = LU._`require("ajv-formats/dist/formats").${Q}`);
    for (let W of X) $.addFormat(W, J[W]);
  }
  yD.exports = c9 = jU;
  Object.defineProperty(c9, "__esModule", { value: true });
  c9.default = jU;
});
var AL = 50;
function g1($ = AL) {
  let X = new AbortController();
  return ML($, X.signal), X;
}
var t$ = class extends Error {
};
function f1() {
  return process.versions.bun !== void 0;
}
var ZL = typeof global == "object" && global && global.Object === Object && global;
var TU = ZL;
var EL = typeof self == "object" && self && self.Object === Object && self;
var RL = TU || EL || Function("return this")();
var h1 = RL;
var SL = h1.Symbol;
var u1 = SL;
var yU = Object.prototype;
var vL = yU.hasOwnProperty;
var CL = yU.toString;
var s0 = u1 ? u1.toStringTag : void 0;
function kL($) {
  var X = vL.call($, s0), J = $[s0];
  try {
    $[s0] = void 0;
    var Q = true;
  } catch (z) {
  }
  var Y = CL.call($);
  if (Q) if (X) $[s0] = J;
  else delete $[s0];
  return Y;
}
var gU = kL;
var _L = Object.prototype;
var xL = _L.toString;
function TL($) {
  return xL.call($);
}
var fU = TL;
var yL = "[object Null]";
var gL = "[object Undefined]";
var hU = u1 ? u1.toStringTag : void 0;
function fL($) {
  if ($ == null) return $ === void 0 ? gL : yL;
  return hU && hU in Object($) ? gU($) : fU($);
}
var uU = fL;
function hL($) {
  var X = typeof $;
  return $ != null && (X == "object" || X == "function");
}
var d9 = hL;
var uL = "[object AsyncFunction]";
var mL = "[object Function]";
var lL = "[object GeneratorFunction]";
var cL = "[object Proxy]";
function iL($) {
  if (!d9($)) return false;
  var X = uU($);
  return X == mL || X == lL || X == uL || X == cL;
}
var mU = iL;
var pL = h1["__core-js_shared__"];
var r9 = pL;
var lU = (function() {
  var $ = /[^.]+$/.exec(r9 && r9.keys && r9.keys.IE_PROTO || "");
  return $ ? "Symbol(src)_1." + $ : "";
})();
function nL($) {
  return !!lU && lU in $;
}
var cU = nL;
var dL = Function.prototype;
var rL = dL.toString;
function oL($) {
  if ($ != null) {
    try {
      return rL.call($);
    } catch (X) {
    }
    try {
      return $ + "";
    } catch (X) {
    }
  }
  return "";
}
var iU = oL;
var tL = /[\\^$.*+?()[\]{}|]/g;
var aL = /^\[object .+?Constructor\]$/;
var sL = Function.prototype;
var eL = Object.prototype;
var $j = sL.toString;
var Xj = eL.hasOwnProperty;
var Jj = RegExp("^" + $j.call(Xj).replace(tL, "\\$&").replace(/hasOwnProperty|(function).*?(?=\\\()| for .+?(?=\\\])/g, "$1.*?") + "$");
function Yj($) {
  if (!d9($) || cU($)) return false;
  var X = mU($) ? Jj : aL;
  return X.test(iU($));
}
var pU = Yj;
function Qj($, X) {
  return $ == null ? void 0 : $[X];
}
var nU = Qj;
function zj($, X) {
  var J = nU($, X);
  return pU(J) ? J : void 0;
}
var o9 = zj;
var Wj = o9(Object, "create");
var t6 = Wj;
function Gj() {
  this.__data__ = t6 ? t6(null) : {}, this.size = 0;
}
var dU = Gj;
function Uj($) {
  var X = this.has($) && delete this.__data__[$];
  return this.size -= X ? 1 : 0, X;
}
var rU = Uj;
var Hj = "__lodash_hash_undefined__";
var Kj = Object.prototype;
var Nj = Kj.hasOwnProperty;
function Vj($) {
  var X = this.__data__;
  if (t6) {
    var J = X[$];
    return J === Hj ? void 0 : J;
  }
  return Nj.call(X, $) ? X[$] : void 0;
}
var oU = Vj;
var Oj = Object.prototype;
var wj = Oj.hasOwnProperty;
function Bj($) {
  var X = this.__data__;
  return t6 ? X[$] !== void 0 : wj.call(X, $);
}
var tU = Bj;
var qj = "__lodash_hash_undefined__";
function Dj($, X) {
  var J = this.__data__;
  return this.size += this.has($) ? 0 : 1, J[$] = t6 && X === void 0 ? qj : X, this;
}
var aU = Dj;
function m1($) {
  var X = -1, J = $ == null ? 0 : $.length;
  this.clear();
  while (++X < J) {
    var Q = $[X];
    this.set(Q[0], Q[1]);
  }
}
m1.prototype.clear = dU;
m1.prototype.delete = rU;
m1.prototype.get = oU;
m1.prototype.has = tU;
m1.prototype.set = aU;
var e7 = m1;
function Lj() {
  this.__data__ = [], this.size = 0;
}
var sU = Lj;
function jj($, X) {
  return $ === X || $ !== $ && X !== X;
}
var eU = jj;
function Fj($, X) {
  var J = $.length;
  while (J--) if (eU($[J][0], X)) return J;
  return -1;
}
var j4 = Fj;
var Ij = Array.prototype;
var Mj = Ij.splice;
function Aj($) {
  var X = this.__data__, J = j4(X, $);
  if (J < 0) return false;
  var Q = X.length - 1;
  if (J == Q) X.pop();
  else Mj.call(X, J, 1);
  return --this.size, true;
}
var $H = Aj;
function bj($) {
  var X = this.__data__, J = j4(X, $);
  return J < 0 ? void 0 : X[J][1];
}
var XH = bj;
function Pj($) {
  return j4(this.__data__, $) > -1;
}
var JH = Pj;
function Zj($, X) {
  var J = this.__data__, Q = j4(J, $);
  if (Q < 0) ++this.size, J.push([$, X]);
  else J[Q][1] = X;
  return this;
}
var YH = Zj;
function l1($) {
  var X = -1, J = $ == null ? 0 : $.length;
  this.clear();
  while (++X < J) {
    var Q = $[X];
    this.set(Q[0], Q[1]);
  }
}
l1.prototype.clear = sU;
l1.prototype.delete = $H;
l1.prototype.get = XH;
l1.prototype.has = JH;
l1.prototype.set = YH;
var QH = l1;
var Ej = o9(h1, "Map");
var zH = Ej;
function Rj() {
  this.size = 0, this.__data__ = { hash: new e7(), map: new (zH || QH)(), string: new e7() };
}
var WH = Rj;
function Sj($) {
  var X = typeof $;
  return X == "string" || X == "number" || X == "symbol" || X == "boolean" ? $ !== "__proto__" : $ === null;
}
var GH = Sj;
function vj($, X) {
  var J = $.__data__;
  return GH(X) ? J[typeof X == "string" ? "string" : "hash"] : J.map;
}
var F4 = vj;
function Cj($) {
  var X = F4(this, $).delete($);
  return this.size -= X ? 1 : 0, X;
}
var UH = Cj;
function kj($) {
  return F4(this, $).get($);
}
var HH = kj;
function _j($) {
  return F4(this, $).has($);
}
var KH = _j;
function xj($, X) {
  var J = F4(this, $), Q = J.size;
  return J.set($, X), this.size += J.size == Q ? 0 : 1, this;
}
var NH = xj;
function c1($) {
  var X = -1, J = $ == null ? 0 : $.length;
  this.clear();
  while (++X < J) {
    var Q = $[X];
    this.set(Q[0], Q[1]);
  }
}
c1.prototype.clear = WH;
c1.prototype.delete = UH;
c1.prototype.get = HH;
c1.prototype.has = KH;
c1.prototype.set = NH;
var $z = c1;
var Tj = "Expected a function";
function Xz($, X) {
  if (typeof $ != "function" || X != null && typeof X != "function") throw TypeError(Tj);
  var J = function() {
    var Q = arguments, Y = X ? X.apply(this, Q) : Q[0], z = J.cache;
    if (z.has(Y)) return z.get(Y);
    var W = $.apply(this, Q);
    return J.cache = z.set(Y, W) || z, W;
  };
  return J.cache = new (Xz.Cache || $z)(), J;
}
Xz.Cache = $z;
var b6 = Xz;
var i1 = b6(() => {
  return (process.env.CLAUDE_CONFIG_DIR ?? yj(gj(), ".claude")).normalize("NFC");
}, () => process.env.CLAUDE_CONFIG_DIR);
function e0($) {
  if (!$) return false;
  if (typeof $ === "boolean") return $;
  let X = $.toLowerCase().trim();
  return ["1", "true", "yes", "on"].includes(X);
}
var n1;
var p1 = null;
function mj() {
  if (p1) return p1;
  if (!process.env.DEBUG_CLAUDE_AGENT_SDK) return n1 = null, p1 = Promise.resolve(), p1;
  let $ = VH(i1(), "debug");
  return n1 = VH($, `sdk-${fj()}.txt`), process.stderr.write(`SDK debug logs: ${n1}
`), p1 = uj($, { recursive: true }).then(() => {
  }).catch(() => {
  }), p1;
}
function V6($) {
  if (n1 === null) return;
  let J = `${(/* @__PURE__ */ new Date()).toISOString()} ${$}
`;
  mj().then(() => {
    if (n1) hj(n1, J).catch(() => {
    });
  });
}
function cj() {
  let $ = "";
  if (typeof process < "u" && typeof process.cwd === "function" && typeof OH === "function") {
    let J = lj();
    try {
      $ = OH(J).normalize("NFC");
    } catch {
      $ = J.normalize("NFC");
    }
  }
  return { originalCwd: $, projectRoot: $, totalCostUSD: 0, totalAPIDuration: 0, totalAPIDurationWithoutRetries: 0, totalToolDuration: 0, turnHookDurationMs: 0, turnToolDurationMs: 0, turnClassifierDurationMs: 0, turnToolCount: 0, turnHookCount: 0, turnClassifierCount: 0, startTime: Date.now(), lastInteractionTime: Date.now(), totalLinesAdded: 0, totalLinesRemoved: 0, hasUnknownModelCost: false, cwd: $, modelUsage: {}, mainLoopModelOverride: void 0, initialMainLoopModel: null, modelStrings: null, isInteractive: false, kairosActive: false, sdkAgentProgressSummariesEnabled: false, userMsgOptIn: false, clientType: "cli", sessionSource: void 0, questionPreviewFormat: void 0, sessionIngressToken: void 0, oauthTokenFromFd: void 0, apiKeyFromFd: void 0, flagSettingsPath: void 0, flagSettingsInline: null, allowedSettingSources: ["userSettings", "projectSettings", "localSettings", "flagSettings", "policySettings"], meter: null, sessionCounter: null, locCounter: null, prCounter: null, commitCounter: null, costCounter: null, tokenCounter: null, codeEditToolDecisionCounter: null, activeTimeCounter: null, statsStore: null, sessionId: t9(), parentSessionId: void 0, loggerProvider: null, eventLogger: null, meterProvider: null, tracerProvider: null, agentColorMap: /* @__PURE__ */ new Map(), agentColorIndex: 0, lastAPIRequest: null, lastAPIRequestMessages: null, lastClassifierRequests: null, cachedClaudeMdContent: null, inMemoryErrorLog: [], inlinePlugins: [], chromeFlagOverride: void 0, useCoworkPlugins: false, sessionBypassPermissionsMode: false, scheduledTasksEnabled: false, sessionCronTasks: [], sessionCreatedTeams: /* @__PURE__ */ new Set(), sessionTrustAccepted: false, sessionPersistenceDisabled: false, hasExitedPlanMode: false, needsPlanModeExitAttachment: false, needsAutoModeExitAttachment: false, lspRecommendationShownThisSession: false, initJsonSchema: null, registeredHooks: null, planSlugCache: /* @__PURE__ */ new Map(), teleportedSessionInfo: null, invokedSkills: /* @__PURE__ */ new Map(), slowOperations: [], sdkBetas: void 0, mainThreadAgentType: void 0, isRemoteMode: false, ...{}, directConnectServerUrl: void 0, systemPromptSectionCache: /* @__PURE__ */ new Map(), lastEmittedDate: null, additionalDirectoriesForClaudeMd: [], allowedChannels: [], hasDevChannels: false, sessionProjectDir: null, promptCache1hAllowlist: null, promptCache1hEligible: null, promptId: null, lastMainRequestId: void 0, lastApiCompletionTimestamp: null, pendingPostCompaction: false };
}
var ij = cj();
function wH() {
  return ij.sessionId;
}
function BH({ writeFn: $, flushIntervalMs: X = 1e3, maxBufferSize: J = 100, maxBufferBytes: Q = 1 / 0, immediateMode: Y = false }) {
  let z = [], W = 0, G = null, U = null;
  function H() {
    if (G) clearTimeout(G), G = null;
  }
  function K() {
    if (U) $(U.join("")), U = null;
    if (z.length === 0) return;
    $(z.join("")), z = [], W = 0, H();
  }
  function V() {
    if (!G) G = setTimeout(K, X);
  }
  function O() {
    if (U) {
      U.push(...z), z = [], W = 0, H();
      return;
    }
    let N = z;
    z = [], W = 0, H(), U = N, setImmediate(() => {
      let w = U;
      if (U = null, w) $(w.join(""));
    });
  }
  return { write(N) {
    if (Y) {
      $(N);
      return;
    }
    if (z.push(N), W += N.length, V(), z.length >= J || W >= Q) O();
  }, flush: K, dispose() {
    K();
  } };
}
var qH = /* @__PURE__ */ new Set();
function DH($) {
  return qH.add($), () => qH.delete($);
}
var LH = b6(($) => {
  if (!$ || $.trim() === "") return null;
  let X = $.split(",").map((z) => z.trim()).filter(Boolean);
  if (X.length === 0) return null;
  let J = X.some((z) => z.startsWith("!")), Q = X.some((z) => !z.startsWith("!"));
  if (J && Q) return null;
  let Y = X.map((z) => z.replace(/^!/, "").toLowerCase());
  return { include: J ? [] : Y, exclude: J ? Y : [], isExclusive: J };
});
function pj($) {
  let X = [], J = $.match(/^MCP server ["']([^"']+)["']/);
  if (J && J[1]) X.push("mcp"), X.push(J[1].toLowerCase());
  else {
    let z = $.match(/^([^:[]+):/);
    if (z && z[1]) X.push(z[1].trim().toLowerCase());
  }
  let Q = $.match(/^\[([^\]]+)]/);
  if (Q && Q[1]) X.push(Q[1].trim().toLowerCase());
  if ($.toLowerCase().includes("1p event:")) X.push("1p");
  let Y = $.match(/:\s*([^:]+?)(?:\s+(?:type|mode|status|event))?:/);
  if (Y && Y[1]) {
    let z = Y[1].trim().toLowerCase();
    if (z.length < 30 && !z.includes(" ")) X.push(z);
  }
  return Array.from(new Set(X));
}
function nj($, X) {
  if (!X) return true;
  if ($.length === 0) return false;
  if (X.isExclusive) return !$.some((J) => X.exclude.includes(J));
  else return $.some((J) => X.include.includes(J));
}
function jH($, X) {
  if (!X) return true;
  let J = pj($);
  return nj(J, X);
}
function v($, X, J, Q, Y) {
  if (Q === "m") throw TypeError("Private method is not writable");
  if (Q === "a" && !Y) throw TypeError("Private accessor was defined without a setter");
  if (typeof X === "function" ? $ !== X || !Y : !X.has($)) throw TypeError("Cannot write private member to an object whose class did not declare it");
  return Q === "a" ? Y.call($, J) : Y ? Y.value = J : X.set($, J), J;
}
function D($, X, J, Q) {
  if (J === "a" && !Q) throw TypeError("Private accessor was defined without a getter");
  if (typeof X === "function" ? $ !== X || !Q : !X.has($)) throw TypeError("Cannot read private member from an object whose class did not declare it");
  return J === "m" ? Q : J === "a" ? Q.call($) : Q ? Q.value : X.get($);
}
var Jz = function() {
  let { crypto: $ } = globalThis;
  if ($?.randomUUID) return Jz = $.randomUUID.bind($), $.randomUUID();
  let X = new Uint8Array(1), J = $ ? () => $.getRandomValues(X)[0] : () => Math.random() * 255 & 255;
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (Q) => (+Q ^ J() & 15 >> +Q / 4).toString(16));
};
function a6($) {
  return typeof $ === "object" && $ !== null && ("name" in $ && $.name === "AbortError" || "message" in $ && String($.message).includes("FetchRequestCanceledException"));
}
var $X = ($) => {
  if ($ instanceof Error) return $;
  if (typeof $ === "object" && $ !== null) {
    try {
      if (Object.prototype.toString.call($) === "[object Error]") {
        let X = Error($.message, $.cause ? { cause: $.cause } : {});
        if ($.stack) X.stack = $.stack;
        if ($.cause && !X.cause) X.cause = $.cause;
        if ($.name) X.name = $.name;
        return X;
      }
    } catch {
    }
    try {
      return Error(JSON.stringify($));
    } catch {
    }
  }
  return Error($);
};
var T = class extends Error {
};
var v$ = class _v$ extends T {
  constructor($, X, J, Q) {
    super(`${_v$.makeMessage($, X, J)}`);
    this.status = $, this.headers = Q, this.requestID = Q?.get("request-id"), this.error = X;
  }
  static makeMessage($, X, J) {
    let Q = X?.message ? typeof X.message === "string" ? X.message : JSON.stringify(X.message) : X ? JSON.stringify(X) : J;
    if ($ && Q) return `${$} ${Q}`;
    if ($) return `${$} status code (no body)`;
    if (Q) return Q;
    return "(no status code or body)";
  }
  static generate($, X, J, Q) {
    if (!$ || !Q) return new $1({ message: J, cause: $X(X) });
    let Y = X;
    if ($ === 400) return new JX($, Y, J, Q);
    if ($ === 401) return new YX($, Y, J, Q);
    if ($ === 403) return new QX($, Y, J, Q);
    if ($ === 404) return new zX($, Y, J, Q);
    if ($ === 409) return new WX($, Y, J, Q);
    if ($ === 422) return new GX($, Y, J, Q);
    if ($ === 429) return new UX($, Y, J, Q);
    if ($ >= 500) return new HX($, Y, J, Q);
    return new _v$($, Y, J, Q);
  }
};
var T$ = class extends v$ {
  constructor({ message: $ } = {}) {
    super(void 0, void 0, $ || "Request was aborted.", void 0);
  }
};
var $1 = class extends v$ {
  constructor({ message: $, cause: X }) {
    super(void 0, void 0, $ || "Connection error.", void 0);
    if (X) this.cause = X;
  }
};
var XX = class extends $1 {
  constructor({ message: $ } = {}) {
    super({ message: $ ?? "Request timed out." });
  }
};
var JX = class extends v$ {
};
var YX = class extends v$ {
};
var QX = class extends v$ {
};
var zX = class extends v$ {
};
var WX = class extends v$ {
};
var GX = class extends v$ {
};
var UX = class extends v$ {
};
var HX = class extends v$ {
};
var rj = /^[a-z][a-z0-9+.-]*:/i;
var FH = ($) => {
  return rj.test($);
};
var Yz = ($) => (Yz = Array.isArray, Yz($));
var Qz = Yz;
function a9($) {
  if (typeof $ !== "object") return {};
  return $ ?? {};
}
function IH($) {
  if (!$) return true;
  for (let X in $) return false;
  return true;
}
function MH($, X) {
  return Object.prototype.hasOwnProperty.call($, X);
}
var AH = ($, X) => {
  if (typeof X !== "number" || !Number.isInteger(X)) throw new T(`${$} must be an integer`);
  if (X < 0) throw new T(`${$} must be a positive integer`);
  return X;
};
var s9 = ($) => {
  try {
    return JSON.parse($);
  } catch (X) {
    return;
  }
};
var bH = ($) => new Promise((X) => setTimeout(X, $));
var I4 = "0.74.0";
var RH = () => {
  return typeof window < "u" && typeof window.document < "u" && typeof navigator < "u";
};
function oj() {
  if (typeof Deno < "u" && Deno.build != null) return "deno";
  if (typeof EdgeRuntime < "u") return "edge";
  if (Object.prototype.toString.call(typeof globalThis.process < "u" ? globalThis.process : 0) === "[object process]") return "node";
  return "unknown";
}
var tj = () => {
  let $ = oj();
  if ($ === "deno") return { "X-Stainless-Lang": "js", "X-Stainless-Package-Version": I4, "X-Stainless-OS": ZH(Deno.build.os), "X-Stainless-Arch": PH(Deno.build.arch), "X-Stainless-Runtime": "deno", "X-Stainless-Runtime-Version": typeof Deno.version === "string" ? Deno.version : Deno.version?.deno ?? "unknown" };
  if (typeof EdgeRuntime < "u") return { "X-Stainless-Lang": "js", "X-Stainless-Package-Version": I4, "X-Stainless-OS": "Unknown", "X-Stainless-Arch": `other:${EdgeRuntime}`, "X-Stainless-Runtime": "edge", "X-Stainless-Runtime-Version": globalThis.process.version };
  if ($ === "node") return { "X-Stainless-Lang": "js", "X-Stainless-Package-Version": I4, "X-Stainless-OS": ZH(globalThis.process.platform ?? "unknown"), "X-Stainless-Arch": PH(globalThis.process.arch ?? "unknown"), "X-Stainless-Runtime": "node", "X-Stainless-Runtime-Version": globalThis.process.version ?? "unknown" };
  let X = aj();
  if (X) return { "X-Stainless-Lang": "js", "X-Stainless-Package-Version": I4, "X-Stainless-OS": "Unknown", "X-Stainless-Arch": "unknown", "X-Stainless-Runtime": `browser:${X.browser}`, "X-Stainless-Runtime-Version": X.version };
  return { "X-Stainless-Lang": "js", "X-Stainless-Package-Version": I4, "X-Stainless-OS": "Unknown", "X-Stainless-Arch": "unknown", "X-Stainless-Runtime": "unknown", "X-Stainless-Runtime-Version": "unknown" };
};
function aj() {
  if (typeof navigator > "u" || !navigator) return null;
  let $ = [{ key: "edge", pattern: /Edge(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ }, { key: "ie", pattern: /MSIE(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ }, { key: "ie", pattern: /Trident(?:.*rv\:(\d+)\.(\d+)(?:\.(\d+))?)?/ }, { key: "chrome", pattern: /Chrome(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ }, { key: "firefox", pattern: /Firefox(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ }, { key: "safari", pattern: /(?:Version\W+(\d+)\.(\d+)(?:\.(\d+))?)?(?:\W+Mobile\S*)?\W+Safari/ }];
  for (let { key: X, pattern: J } of $) {
    let Q = J.exec(navigator.userAgent);
    if (Q) {
      let Y = Q[1] || 0, z = Q[2] || 0, W = Q[3] || 0;
      return { browser: X, version: `${Y}.${z}.${W}` };
    }
  }
  return null;
}
var PH = ($) => {
  if ($ === "x32") return "x32";
  if ($ === "x86_64" || $ === "x64") return "x64";
  if ($ === "arm") return "arm";
  if ($ === "aarch64" || $ === "arm64") return "arm64";
  if ($) return `other:${$}`;
  return "unknown";
};
var ZH = ($) => {
  if ($ = $.toLowerCase(), $.includes("ios")) return "iOS";
  if ($ === "android") return "Android";
  if ($ === "darwin") return "MacOS";
  if ($ === "win32") return "Windows";
  if ($ === "freebsd") return "FreeBSD";
  if ($ === "openbsd") return "OpenBSD";
  if ($ === "linux") return "Linux";
  if ($) return `Other:${$}`;
  return "Unknown";
};
var EH;
var SH = () => {
  return EH ?? (EH = tj());
};
function vH() {
  if (typeof fetch < "u") return fetch;
  throw Error("`fetch` is not defined as a global; Either pass `fetch` to the client, `new Anthropic({ fetch })` or polyfill the global, `globalThis.fetch = fetch`");
}
function zz(...$) {
  let X = globalThis.ReadableStream;
  if (typeof X > "u") throw Error("`ReadableStream` is not defined as a global; You will need to polyfill it, `globalThis.ReadableStream = ReadableStream`");
  return new X(...$);
}
function e9($) {
  let X = Symbol.asyncIterator in $ ? $[Symbol.asyncIterator]() : $[Symbol.iterator]();
  return zz({ start() {
  }, async pull(J) {
    let { done: Q, value: Y } = await X.next();
    if (Q) J.close();
    else J.enqueue(Y);
  }, async cancel() {
    await X.return?.();
  } });
}
function KX($) {
  if ($[Symbol.asyncIterator]) return $;
  let X = $.getReader();
  return { async next() {
    try {
      let J = await X.read();
      if (J?.done) X.releaseLock();
      return J;
    } catch (J) {
      throw X.releaseLock(), J;
    }
  }, async return() {
    let J = X.cancel();
    return X.releaseLock(), await J, { done: true, value: void 0 };
  }, [Symbol.asyncIterator]() {
    return this;
  } };
}
async function CH($) {
  if ($ === null || typeof $ !== "object") return;
  if ($[Symbol.asyncIterator]) {
    await $[Symbol.asyncIterator]().return?.();
    return;
  }
  let X = $.getReader(), J = X.cancel();
  X.releaseLock(), await J;
}
var kH = ({ headers: $, body: X }) => {
  return { bodyHeaders: { "content-type": "application/json" }, body: JSON.stringify(X) };
};
function TH($) {
  let X = 0;
  for (let Y of $) X += Y.length;
  let J = new Uint8Array(X), Q = 0;
  for (let Y of $) J.set(Y, Q), Q += Y.length;
  return J;
}
var _H;
function NX($) {
  let X;
  return (_H ?? (X = new globalThis.TextEncoder(), _H = X.encode.bind(X)))($);
}
var xH;
function Wz($) {
  let X;
  return (xH ?? (X = new globalThis.TextDecoder(), xH = X.decode.bind(X)))($);
}
var z6;
var W6;
var M4 = class {
  constructor() {
    z6.set(this, void 0), W6.set(this, void 0), v(this, z6, new Uint8Array(), "f"), v(this, W6, null, "f");
  }
  decode($) {
    if ($ == null) return [];
    let X = $ instanceof ArrayBuffer ? new Uint8Array($) : typeof $ === "string" ? NX($) : $;
    v(this, z6, TH([D(this, z6, "f"), X]), "f");
    let J = [], Q;
    while ((Q = $F(D(this, z6, "f"), D(this, W6, "f"))) != null) {
      if (Q.carriage && D(this, W6, "f") == null) {
        v(this, W6, Q.index, "f");
        continue;
      }
      if (D(this, W6, "f") != null && (Q.index !== D(this, W6, "f") + 1 || Q.carriage)) {
        J.push(Wz(D(this, z6, "f").subarray(0, D(this, W6, "f") - 1))), v(this, z6, D(this, z6, "f").subarray(D(this, W6, "f")), "f"), v(this, W6, null, "f");
        continue;
      }
      let Y = D(this, W6, "f") !== null ? Q.preceding - 1 : Q.preceding, z = Wz(D(this, z6, "f").subarray(0, Y));
      J.push(z), v(this, z6, D(this, z6, "f").subarray(Q.index), "f"), v(this, W6, null, "f");
    }
    return J;
  }
  flush() {
    if (!D(this, z6, "f").length) return [];
    return this.decode(`
`);
  }
};
z6 = /* @__PURE__ */ new WeakMap(), W6 = /* @__PURE__ */ new WeakMap();
M4.NEWLINE_CHARS = /* @__PURE__ */ new Set([`
`, "\r"]);
M4.NEWLINE_REGEXP = /\r\n|[\n\r]/g;
function $F($, X) {
  for (let Y = X ?? 0; Y < $.length; Y++) {
    if ($[Y] === 10) return { preceding: Y, index: Y + 1, carriage: false };
    if ($[Y] === 13) return { preceding: Y, index: Y + 1, carriage: true };
  }
  return null;
}
function yH($) {
  for (let Q = 0; Q < $.length - 1; Q++) {
    if ($[Q] === 10 && $[Q + 1] === 10) return Q + 2;
    if ($[Q] === 13 && $[Q + 1] === 13) return Q + 2;
    if ($[Q] === 13 && $[Q + 1] === 10 && Q + 3 < $.length && $[Q + 2] === 13 && $[Q + 3] === 10) return Q + 4;
  }
  return -1;
}
var XJ = { off: 0, error: 200, warn: 300, info: 400, debug: 500 };
var Gz = ($, X, J) => {
  if (!$) return;
  if (MH(XJ, $)) return $;
  _$(J).warn(`${X} was set to ${JSON.stringify($)}, expected one of ${JSON.stringify(Object.keys(XJ))}`);
  return;
};
function VX() {
}
function $J($, X, J) {
  if (!X || XJ[$] > XJ[J]) return VX;
  else return X[$].bind(X);
}
var XF = { error: VX, warn: VX, info: VX, debug: VX };
var gH = /* @__PURE__ */ new WeakMap();
function _$($) {
  let X = $.logger, J = $.logLevel ?? "off";
  if (!X) return XF;
  let Q = gH.get(X);
  if (Q && Q[0] === J) return Q[1];
  let Y = { error: $J("error", X, J), warn: $J("warn", X, J), info: $J("info", X, J), debug: $J("debug", X, J) };
  return gH.set(X, [J, Y]), Y;
}
var s6 = ($) => {
  if ($.options) $.options = { ...$.options }, delete $.options.headers;
  if ($.headers) $.headers = Object.fromEntries(($.headers instanceof Headers ? [...$.headers] : Object.entries($.headers)).map(([X, J]) => [X, X.toLowerCase() === "x-api-key" || X.toLowerCase() === "authorization" || X.toLowerCase() === "cookie" || X.toLowerCase() === "set-cookie" ? "***" : J]));
  if ("retryOfRequestLogID" in $) {
    if ($.retryOfRequestLogID) $.retryOf = $.retryOfRequestLogID;
    delete $.retryOfRequestLogID;
  }
  return $;
};
var OX;
var G6 = class _G6 {
  constructor($, X, J) {
    this.iterator = $, OX.set(this, void 0), this.controller = X, v(this, OX, J, "f");
  }
  static fromSSEResponse($, X, J) {
    let Q = false, Y = J ? _$(J) : console;
    async function* z() {
      if (Q) throw new T("Cannot iterate over a consumed stream, use `.tee()` to split the stream.");
      Q = true;
      let W = false;
      try {
        for await (let G of JF($, X)) {
          if (G.event === "completion") try {
            yield JSON.parse(G.data);
          } catch (U) {
            throw Y.error("Could not parse message into JSON:", G.data), Y.error("From chunk:", G.raw), U;
          }
          if (G.event === "message_start" || G.event === "message_delta" || G.event === "message_stop" || G.event === "content_block_start" || G.event === "content_block_delta" || G.event === "content_block_stop") try {
            yield JSON.parse(G.data);
          } catch (U) {
            throw Y.error("Could not parse message into JSON:", G.data), Y.error("From chunk:", G.raw), U;
          }
          if (G.event === "ping") continue;
          if (G.event === "error") throw new v$(void 0, s9(G.data) ?? G.data, void 0, $.headers);
        }
        W = true;
      } catch (G) {
        if (a6(G)) return;
        throw G;
      } finally {
        if (!W) X.abort();
      }
    }
    return new _G6(z, X, J);
  }
  static fromReadableStream($, X, J) {
    let Q = false;
    async function* Y() {
      let W = new M4(), G = KX($);
      for await (let U of G) for (let H of W.decode(U)) yield H;
      for (let U of W.flush()) yield U;
    }
    async function* z() {
      if (Q) throw new T("Cannot iterate over a consumed stream, use `.tee()` to split the stream.");
      Q = true;
      let W = false;
      try {
        for await (let G of Y()) {
          if (W) continue;
          if (G) yield JSON.parse(G);
        }
        W = true;
      } catch (G) {
        if (a6(G)) return;
        throw G;
      } finally {
        if (!W) X.abort();
      }
    }
    return new _G6(z, X, J);
  }
  [(OX = /* @__PURE__ */ new WeakMap(), Symbol.asyncIterator)]() {
    return this.iterator();
  }
  tee() {
    let $ = [], X = [], J = this.iterator(), Q = (Y) => {
      return { next: () => {
        if (Y.length === 0) {
          let z = J.next();
          $.push(z), X.push(z);
        }
        return Y.shift();
      } };
    };
    return [new _G6(() => Q($), this.controller, D(this, OX, "f")), new _G6(() => Q(X), this.controller, D(this, OX, "f"))];
  }
  toReadableStream() {
    let $ = this, X;
    return zz({ async start() {
      X = $[Symbol.asyncIterator]();
    }, async pull(J) {
      try {
        let { value: Q, done: Y } = await X.next();
        if (Y) return J.close();
        let z = NX(JSON.stringify(Q) + `
`);
        J.enqueue(z);
      } catch (Q) {
        J.error(Q);
      }
    }, async cancel() {
      await X.return?.();
    } });
  }
};
async function* JF($, X) {
  if (!$.body) {
    if (X.abort(), typeof globalThis.navigator < "u" && globalThis.navigator.product === "ReactNative") throw new T("The default react-native fetch implementation does not support streaming. Please use expo/fetch: https://docs.expo.dev/versions/latest/sdk/expo/#expofetch-api");
    throw new T("Attempted to iterate over a response with no body");
  }
  let J = new fH(), Q = new M4(), Y = KX($.body);
  for await (let z of YF(Y)) for (let W of Q.decode(z)) {
    let G = J.decode(W);
    if (G) yield G;
  }
  for (let z of Q.flush()) {
    let W = J.decode(z);
    if (W) yield W;
  }
}
async function* YF($) {
  let X = new Uint8Array();
  for await (let J of $) {
    if (J == null) continue;
    let Q = J instanceof ArrayBuffer ? new Uint8Array(J) : typeof J === "string" ? NX(J) : J, Y = new Uint8Array(X.length + Q.length);
    Y.set(X), Y.set(Q, X.length), X = Y;
    let z;
    while ((z = yH(X)) !== -1) yield X.slice(0, z), X = X.slice(z);
  }
  if (X.length > 0) yield X;
}
var fH = class {
  constructor() {
    this.event = null, this.data = [], this.chunks = [];
  }
  decode($) {
    if ($.endsWith("\r")) $ = $.substring(0, $.length - 1);
    if (!$) {
      if (!this.event && !this.data.length) return null;
      let Y = { event: this.event, data: this.data.join(`
`), raw: this.chunks };
      return this.event = null, this.data = [], this.chunks = [], Y;
    }
    if (this.chunks.push($), $.startsWith(":")) return null;
    let [X, J, Q] = QF($, ":");
    if (Q.startsWith(" ")) Q = Q.substring(1);
    if (X === "event") this.event = Q;
    else if (X === "data") this.data.push(Q);
    return null;
  }
};
function QF($, X) {
  let J = $.indexOf(X);
  if (J !== -1) return [$.substring(0, J), X, $.substring(J + X.length)];
  return [$, "", ""];
}
async function JJ($, X) {
  let { response: J, requestLogID: Q, retryOfRequestLogID: Y, startTime: z } = X, W = await (async () => {
    if (X.options.stream) {
      if (_$($).debug("response", J.status, J.url, J.headers, J.body), X.options.__streamClass) return X.options.__streamClass.fromSSEResponse(J, X.controller);
      return G6.fromSSEResponse(J, X.controller);
    }
    if (J.status === 204) return null;
    if (X.options.__binaryResponse) return J;
    let U = J.headers.get("content-type")?.split(";")[0]?.trim();
    if (U?.includes("application/json") || U?.endsWith("+json")) {
      if (J.headers.get("content-length") === "0") return;
      let O = await J.json();
      return Uz(O, J);
    }
    return await J.text();
  })();
  return _$($).debug(`[${Q}] response parsed`, s6({ retryOfRequestLogID: Y, url: J.url, status: J.status, body: W, durationMs: Date.now() - z })), W;
}
function Uz($, X) {
  if (!$ || typeof $ !== "object" || Array.isArray($)) return $;
  return Object.defineProperty($, "_request_id", { value: X.headers.get("request-id"), enumerable: false });
}
var wX;
var X1 = class _X1 extends Promise {
  constructor($, X, J = JJ) {
    super((Q) => {
      Q(null);
    });
    this.responsePromise = X, this.parseResponse = J, wX.set(this, void 0), v(this, wX, $, "f");
  }
  _thenUnwrap($) {
    return new _X1(D(this, wX, "f"), this.responsePromise, async (X, J) => Uz($(await this.parseResponse(X, J), J), J.response));
  }
  asResponse() {
    return this.responsePromise.then(($) => $.response);
  }
  async withResponse() {
    let [$, X] = await Promise.all([this.parse(), this.asResponse()]);
    return { data: $, response: X, request_id: X.headers.get("request-id") };
  }
  parse() {
    if (!this.parsedPromise) this.parsedPromise = this.responsePromise.then(($) => this.parseResponse(D(this, wX, "f"), $));
    return this.parsedPromise;
  }
  then($, X) {
    return this.parse().then($, X);
  }
  catch($) {
    return this.parse().catch($);
  }
  finally($) {
    return this.parse().finally($);
  }
};
wX = /* @__PURE__ */ new WeakMap();
var YJ;
var Hz = class {
  constructor($, X, J, Q) {
    YJ.set(this, void 0), v(this, YJ, $, "f"), this.options = Q, this.response = X, this.body = J;
  }
  hasNextPage() {
    if (!this.getPaginatedItems().length) return false;
    return this.nextPageRequestOptions() != null;
  }
  async getNextPage() {
    let $ = this.nextPageRequestOptions();
    if (!$) throw new T("No next page expected; please check `.hasNextPage()` before calling `.getNextPage()`.");
    return await D(this, YJ, "f").requestAPIList(this.constructor, $);
  }
  async *iterPages() {
    let $ = this;
    yield $;
    while ($.hasNextPage()) $ = await $.getNextPage(), yield $;
  }
  async *[(YJ = /* @__PURE__ */ new WeakMap(), Symbol.asyncIterator)]() {
    for await (let $ of this.iterPages()) for (let X of $.getPaginatedItems()) yield X;
  }
};
var QJ = class extends X1 {
  constructor($, X, J) {
    super($, X, async (Q, Y) => new J(Q, Y.response, await JJ(Q, Y), Y.options));
  }
  async *[Symbol.asyncIterator]() {
    let $ = await this;
    for await (let X of $) yield X;
  }
};
var P6 = class extends Hz {
  constructor($, X, J, Q) {
    super($, X, J, Q);
    this.data = J.data || [], this.has_more = J.has_more || false, this.first_id = J.first_id || null, this.last_id = J.last_id || null;
  }
  getPaginatedItems() {
    return this.data ?? [];
  }
  hasNextPage() {
    if (this.has_more === false) return false;
    return super.hasNextPage();
  }
  nextPageRequestOptions() {
    if (this.options.query?.before_id) {
      let X = this.first_id;
      if (!X) return null;
      return { ...this.options, query: { ...a9(this.options.query), before_id: X } };
    }
    let $ = this.last_id;
    if (!$) return null;
    return { ...this.options, query: { ...a9(this.options.query), after_id: $ } };
  }
};
var BX = class extends Hz {
  constructor($, X, J, Q) {
    super($, X, J, Q);
    this.data = J.data || [], this.has_more = J.has_more || false, this.next_page = J.next_page || null;
  }
  getPaginatedItems() {
    return this.data ?? [];
  }
  hasNextPage() {
    if (this.has_more === false) return false;
    return super.hasNextPage();
  }
  nextPageRequestOptions() {
    let $ = this.next_page;
    if (!$) return null;
    return { ...this.options, query: { ...a9(this.options.query), page: $ } };
  }
};
var Nz = () => {
  if (typeof File > "u") {
    let { process: $ } = globalThis, X = typeof $?.versions?.node === "string" && parseInt($.versions.node.split(".")) < 20;
    throw Error("`File` is not defined as a global, which is required for file uploads." + (X ? " Update to Node 20 LTS or newer, or set `globalThis.File` to `import('node:buffer').File`." : ""));
  }
};
function J1($, X, J) {
  return Nz(), new File($, X ?? "unknown_file", J);
}
function qX($, X) {
  let J = typeof $ === "object" && $ !== null && ("name" in $ && $.name && String($.name) || "url" in $ && $.url && String($.url) || "filename" in $ && $.filename && String($.filename) || "path" in $ && $.path && String($.path)) || "";
  return X ? J.split(/[\\/]/).pop() || void 0 : J;
}
var Vz = ($) => $ != null && typeof $ === "object" && typeof $[Symbol.asyncIterator] === "function";
var d1 = async ($, X, J = true) => {
  return { ...$, body: await GF($.body, X, J) };
};
var hH = /* @__PURE__ */ new WeakMap();
function WF($) {
  let X = typeof $ === "function" ? $ : $.fetch, J = hH.get(X);
  if (J) return J;
  let Q = (async () => {
    try {
      let Y = "Response" in X ? X.Response : (await X("data:,")).constructor, z = new FormData();
      if (z.toString() === await new Y(z).text()) return false;
      return true;
    } catch {
      return true;
    }
  })();
  return hH.set(X, Q), Q;
}
var GF = async ($, X, J = true) => {
  if (!await WF(X)) throw TypeError("The provided fetch function does not support file uploads with the current global FormData class.");
  let Q = new FormData();
  return await Promise.all(Object.entries($ || {}).map(([Y, z]) => Kz(Q, Y, z, J))), Q;
};
var UF = ($) => $ instanceof Blob && "name" in $;
var Kz = async ($, X, J, Q) => {
  if (J === void 0) return;
  if (J == null) throw TypeError(`Received null for "${X}"; to pass null in FormData, you must use the string 'null'`);
  if (typeof J === "string" || typeof J === "number" || typeof J === "boolean") $.append(X, String(J));
  else if (J instanceof Response) {
    let Y = {}, z = J.headers.get("Content-Type");
    if (z) Y = { type: z };
    $.append(X, J1([await J.blob()], qX(J, Q), Y));
  } else if (Vz(J)) $.append(X, J1([await new Response(e9(J)).blob()], qX(J, Q)));
  else if (UF(J)) $.append(X, J1([J], qX(J, Q), { type: J.type }));
  else if (Array.isArray(J)) await Promise.all(J.map((Y) => Kz($, X + "[]", Y, Q)));
  else if (typeof J === "object") await Promise.all(Object.entries(J).map(([Y, z]) => Kz($, `${X}[${Y}]`, z, Q)));
  else throw TypeError(`Invalid value given to form, expected a string, number, boolean, object, Array, File or Blob but got ${J} instead`);
};
var uH = ($) => $ != null && typeof $ === "object" && typeof $.size === "number" && typeof $.type === "string" && typeof $.text === "function" && typeof $.slice === "function" && typeof $.arrayBuffer === "function";
var HF = ($) => $ != null && typeof $ === "object" && typeof $.name === "string" && typeof $.lastModified === "number" && uH($);
var KF = ($) => $ != null && typeof $ === "object" && typeof $.url === "string" && typeof $.blob === "function";
async function zJ($, X, J) {
  if (Nz(), $ = await $, X || (X = qX($, true)), HF($)) {
    if ($ instanceof File && X == null && J == null) return $;
    return J1([await $.arrayBuffer()], X ?? $.name, { type: $.type, lastModified: $.lastModified, ...J });
  }
  if (KF($)) {
    let Y = await $.blob();
    return X || (X = new URL($.url).pathname.split(/[\\/]/).pop()), J1(await Oz(Y), X, J);
  }
  let Q = await Oz($);
  if (!J?.type) {
    let Y = Q.find((z) => typeof z === "object" && "type" in z && z.type);
    if (typeof Y === "string") J = { ...J, type: Y };
  }
  return J1(Q, X, J);
}
async function Oz($) {
  let X = [];
  if (typeof $ === "string" || ArrayBuffer.isView($) || $ instanceof ArrayBuffer) X.push($);
  else if (uH($)) X.push($ instanceof Blob ? $ : await $.arrayBuffer());
  else if (Vz($)) for await (let J of $) X.push(...await Oz(J));
  else {
    let J = $?.constructor?.name;
    throw Error(`Unexpected data type: ${typeof $}${J ? `; constructor: ${J}` : ""}${NF($)}`);
  }
  return X;
}
function NF($) {
  if (typeof $ !== "object" || $ === null) return "";
  return `; props: [${Object.getOwnPropertyNames($).map((J) => `"${J}"`).join(", ")}]`;
}
var A$ = class {
  constructor($) {
    this._client = $;
  }
};
var mH = /* @__PURE__ */ Symbol.for("brand.privateNullableHeaders");
function* OF($) {
  if (!$) return;
  if (mH in $) {
    let { values: Q, nulls: Y } = $;
    yield* Q.entries();
    for (let z of Y) yield [z, null];
    return;
  }
  let X = false, J;
  if ($ instanceof Headers) J = $.entries();
  else if (Qz($)) J = $;
  else X = true, J = Object.entries($ ?? {});
  for (let Q of J) {
    let Y = Q[0];
    if (typeof Y !== "string") throw TypeError("expected header name to be a string");
    let z = Qz(Q[1]) ? Q[1] : [Q[1]], W = false;
    for (let G of z) {
      if (G === void 0) continue;
      if (X && !W) W = true, yield [Y, null];
      yield [Y, G];
    }
  }
}
var n = ($) => {
  let X = new Headers(), J = /* @__PURE__ */ new Set();
  for (let Q of $) {
    let Y = /* @__PURE__ */ new Set();
    for (let [z, W] of OF(Q)) {
      let G = z.toLowerCase();
      if (!Y.has(G)) X.delete(z), Y.add(G);
      if (W === null) X.delete(z), J.add(G);
      else X.append(z, W), J.delete(G);
    }
  }
  return { [mH]: true, values: X, nulls: J };
};
var DX = /* @__PURE__ */ Symbol("anthropic.sdk.stainlessHelper");
function WJ($) {
  return typeof $ === "object" && $ !== null && DX in $;
}
function wz($, X) {
  let J = /* @__PURE__ */ new Set();
  if ($) {
    for (let Q of $) if (WJ(Q)) J.add(Q[DX]);
  }
  if (X) for (let Q of X) {
    if (WJ(Q)) J.add(Q[DX]);
    if (Array.isArray(Q.content)) {
      for (let Y of Q.content) if (WJ(Y)) J.add(Y[DX]);
    }
  }
  return Array.from(J);
}
function GJ($, X) {
  let J = wz($, X);
  if (J.length === 0) return {};
  return { "x-stainless-helper": J.join(", ") };
}
function lH($) {
  if (WJ($)) return { "x-stainless-helper": $[DX] };
  return {};
}
function iH($) {
  return $.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@]+/g, encodeURIComponent);
}
var cH = Object.freeze(/* @__PURE__ */ Object.create(null));
var wF = ($ = iH) => function(J, ...Q) {
  if (J.length === 1) return J[0];
  let Y = false, z = [], W = J.reduce((K, V, O) => {
    if (/[?#]/.test(V)) Y = true;
    let N = Q[O], w = (Y ? encodeURIComponent : $)("" + N);
    if (O !== Q.length && (N == null || typeof N === "object" && N.toString === Object.getPrototypeOf(Object.getPrototypeOf(N.hasOwnProperty ?? cH) ?? cH)?.toString)) w = N + "", z.push({ start: K.length + V.length, length: w.length, error: `Value of type ${Object.prototype.toString.call(N).slice(8, -1)} is not a valid path parameter` });
    return K + V + (O === Q.length ? "" : w);
  }, ""), G = W.split(/[?#]/, 1)[0], U = /(?<=^|\/)(?:\.|%2e){1,2}(?=\/|$)/gi, H;
  while ((H = U.exec(G)) !== null) z.push({ start: H.index, length: H[0].length, error: `Value "${H[0]}" can't be safely passed as a path parameter` });
  if (z.sort((K, V) => K.start - V.start), z.length > 0) {
    let K = 0, V = z.reduce((O, N) => {
      let w = " ".repeat(N.start - K), B = "^".repeat(N.length);
      return K = N.start + N.length, O + w + B;
    }, "");
    throw new T(`Path parameters result in path with invalid segments:
${z.map((O) => O.error).join(`
`)}
${W}
${V}`);
  }
  return W;
};
var F$ = wF(iH);
var LX = class extends A$ {
  list($ = {}, X) {
    let { betas: J, ...Q } = $ ?? {};
    return this._client.getAPIList("/v1/files", P6, { query: Q, ...X, headers: n([{ "anthropic-beta": [...J ?? [], "files-api-2025-04-14"].toString() }, X?.headers]) });
  }
  delete($, X = {}, J) {
    let { betas: Q } = X ?? {};
    return this._client.delete(F$`/v1/files/${$}`, { ...J, headers: n([{ "anthropic-beta": [...Q ?? [], "files-api-2025-04-14"].toString() }, J?.headers]) });
  }
  download($, X = {}, J) {
    let { betas: Q } = X ?? {};
    return this._client.get(F$`/v1/files/${$}/content`, { ...J, headers: n([{ "anthropic-beta": [...Q ?? [], "files-api-2025-04-14"].toString(), Accept: "application/binary" }, J?.headers]), __binaryResponse: true });
  }
  retrieveMetadata($, X = {}, J) {
    let { betas: Q } = X ?? {};
    return this._client.get(F$`/v1/files/${$}`, { ...J, headers: n([{ "anthropic-beta": [...Q ?? [], "files-api-2025-04-14"].toString() }, J?.headers]) });
  }
  upload($, X) {
    let { betas: J, ...Q } = $;
    return this._client.post("/v1/files", d1({ body: Q, ...X, headers: n([{ "anthropic-beta": [...J ?? [], "files-api-2025-04-14"].toString() }, lH(Q.file), X?.headers]) }, this._client));
  }
};
var jX = class extends A$ {
  retrieve($, X = {}, J) {
    let { betas: Q } = X ?? {};
    return this._client.get(F$`/v1/models/${$}?beta=true`, { ...J, headers: n([{ ...Q?.toString() != null ? { "anthropic-beta": Q?.toString() } : void 0 }, J?.headers]) });
  }
  list($ = {}, X) {
    let { betas: J, ...Q } = $ ?? {};
    return this._client.getAPIList("/v1/models?beta=true", P6, { query: Q, ...X, headers: n([{ ...J?.toString() != null ? { "anthropic-beta": J?.toString() } : void 0 }, X?.headers]) });
  }
};
var UJ = { "claude-opus-4-20250514": 8192, "claude-opus-4-0": 8192, "claude-4-opus-20250514": 8192, "anthropic.claude-opus-4-20250514-v1:0": 8192, "claude-opus-4@20250514": 8192, "claude-opus-4-1-20250805": 8192, "anthropic.claude-opus-4-1-20250805-v1:0": 8192, "claude-opus-4-1@20250805": 8192 };
function pH($) {
  return $?.output_format ?? $?.output_config?.format;
}
function Bz($, X, J) {
  let Q = pH(X);
  if (!X || !("parse" in (Q ?? {}))) return { ...$, content: $.content.map((Y) => {
    if (Y.type === "text") {
      let z = Object.defineProperty({ ...Y }, "parsed_output", { value: null, enumerable: false });
      return Object.defineProperty(z, "parsed", { get() {
        return J.logger.warn("The `parsed` property on `text` blocks is deprecated, please use `parsed_output` instead."), null;
      }, enumerable: false });
    }
    return Y;
  }), parsed_output: null };
  return qz($, X, J);
}
function qz($, X, J) {
  let Q = null, Y = $.content.map((z) => {
    if (z.type === "text") {
      let W = DF(X, z.text);
      if (Q === null) Q = W;
      let G = Object.defineProperty({ ...z }, "parsed_output", { value: W, enumerable: false });
      return Object.defineProperty(G, "parsed", { get() {
        return J.logger.warn("The `parsed` property on `text` blocks is deprecated, please use `parsed_output` instead."), W;
      }, enumerable: false });
    }
    return z;
  });
  return { ...$, content: Y, parsed_output: Q };
}
function DF($, X) {
  let J = pH($);
  if (J?.type !== "json_schema") return null;
  try {
    if ("parse" in J) return J.parse(X);
    return JSON.parse(X);
  } catch (Q) {
    throw new T(`Failed to parse structured output: ${Q}`);
  }
}
var LF = ($) => {
  let X = 0, J = [];
  while (X < $.length) {
    let Q = $[X];
    if (Q === "\\") {
      X++;
      continue;
    }
    if (Q === "{") {
      J.push({ type: "brace", value: "{" }), X++;
      continue;
    }
    if (Q === "}") {
      J.push({ type: "brace", value: "}" }), X++;
      continue;
    }
    if (Q === "[") {
      J.push({ type: "paren", value: "[" }), X++;
      continue;
    }
    if (Q === "]") {
      J.push({ type: "paren", value: "]" }), X++;
      continue;
    }
    if (Q === ":") {
      J.push({ type: "separator", value: ":" }), X++;
      continue;
    }
    if (Q === ",") {
      J.push({ type: "delimiter", value: "," }), X++;
      continue;
    }
    if (Q === '"') {
      let G = "", U = false;
      Q = $[++X];
      while (Q !== '"') {
        if (X === $.length) {
          U = true;
          break;
        }
        if (Q === "\\") {
          if (X++, X === $.length) {
            U = true;
            break;
          }
          G += Q + $[X], Q = $[++X];
        } else G += Q, Q = $[++X];
      }
      if (Q = $[++X], !U) J.push({ type: "string", value: G });
      continue;
    }
    if (Q && /\s/.test(Q)) {
      X++;
      continue;
    }
    let z = /[0-9]/;
    if (Q && z.test(Q) || Q === "-" || Q === ".") {
      let G = "";
      if (Q === "-") G += Q, Q = $[++X];
      while (Q && z.test(Q) || Q === ".") G += Q, Q = $[++X];
      J.push({ type: "number", value: G });
      continue;
    }
    let W = /[a-z]/i;
    if (Q && W.test(Q)) {
      let G = "";
      while (Q && W.test(Q)) {
        if (X === $.length) break;
        G += Q, Q = $[++X];
      }
      if (G == "true" || G == "false" || G === "null") J.push({ type: "name", value: G });
      else {
        X++;
        continue;
      }
      continue;
    }
    X++;
  }
  return J;
};
var r1 = ($) => {
  if ($.length === 0) return $;
  let X = $[$.length - 1];
  switch (X.type) {
    case "separator":
      return $ = $.slice(0, $.length - 1), r1($);
      break;
    case "number":
      let J = X.value[X.value.length - 1];
      if (J === "." || J === "-") return $ = $.slice(0, $.length - 1), r1($);
    case "string":
      let Q = $[$.length - 2];
      if (Q?.type === "delimiter") return $ = $.slice(0, $.length - 1), r1($);
      else if (Q?.type === "brace" && Q.value === "{") return $ = $.slice(0, $.length - 1), r1($);
      break;
    case "delimiter":
      return $ = $.slice(0, $.length - 1), r1($);
      break;
  }
  return $;
};
var jF = ($) => {
  let X = [];
  if ($.map((J) => {
    if (J.type === "brace") if (J.value === "{") X.push("}");
    else X.splice(X.lastIndexOf("}"), 1);
    if (J.type === "paren") if (J.value === "[") X.push("]");
    else X.splice(X.lastIndexOf("]"), 1);
  }), X.length > 0) X.reverse().map((J) => {
    if (J === "}") $.push({ type: "brace", value: "}" });
    else if (J === "]") $.push({ type: "paren", value: "]" });
  });
  return $;
};
var FF = ($) => {
  let X = "";
  return $.map((J) => {
    switch (J.type) {
      case "string":
        X += '"' + J.value + '"';
        break;
      default:
        X += J.value;
        break;
    }
  }), X;
};
var HJ = ($) => JSON.parse(FF(jF(r1(LF($)))));
var O6;
var A4;
var o1;
var FX;
var KJ;
var IX;
var MX;
var NJ;
var AX;
var e6;
var bX;
var VJ;
var OJ;
var Y1;
var wJ;
var BJ;
var PX;
var Dz;
var nH;
var qJ;
var Lz;
var jz;
var Fz;
var dH;
var rH = "__json_buf";
function oH($) {
  return $.type === "tool_use" || $.type === "server_tool_use" || $.type === "mcp_tool_use";
}
var ZX = class _ZX {
  constructor($, X) {
    O6.add(this), this.messages = [], this.receivedMessages = [], A4.set(this, void 0), o1.set(this, null), this.controller = new AbortController(), FX.set(this, void 0), KJ.set(this, () => {
    }), IX.set(this, () => {
    }), MX.set(this, void 0), NJ.set(this, () => {
    }), AX.set(this, () => {
    }), e6.set(this, {}), bX.set(this, false), VJ.set(this, false), OJ.set(this, false), Y1.set(this, false), wJ.set(this, void 0), BJ.set(this, void 0), PX.set(this, void 0), qJ.set(this, (J) => {
      if (v(this, VJ, true, "f"), a6(J)) J = new T$();
      if (J instanceof T$) return v(this, OJ, true, "f"), this._emit("abort", J);
      if (J instanceof T) return this._emit("error", J);
      if (J instanceof Error) {
        let Q = new T(J.message);
        return Q.cause = J, this._emit("error", Q);
      }
      return this._emit("error", new T(String(J)));
    }), v(this, FX, new Promise((J, Q) => {
      v(this, KJ, J, "f"), v(this, IX, Q, "f");
    }), "f"), v(this, MX, new Promise((J, Q) => {
      v(this, NJ, J, "f"), v(this, AX, Q, "f");
    }), "f"), D(this, FX, "f").catch(() => {
    }), D(this, MX, "f").catch(() => {
    }), v(this, o1, $, "f"), v(this, PX, X?.logger ?? console, "f");
  }
  get response() {
    return D(this, wJ, "f");
  }
  get request_id() {
    return D(this, BJ, "f");
  }
  async withResponse() {
    v(this, Y1, true, "f");
    let $ = await D(this, FX, "f");
    if (!$) throw Error("Could not resolve a `Response` object");
    return { data: this, response: $, request_id: $.headers.get("request-id") };
  }
  static fromReadableStream($) {
    let X = new _ZX(null);
    return X._run(() => X._fromReadableStream($)), X;
  }
  static createMessage($, X, J, { logger: Q } = {}) {
    let Y = new _ZX(X, { logger: Q });
    for (let z of X.messages) Y._addMessageParam(z);
    return v(Y, o1, { ...X, stream: true }, "f"), Y._run(() => Y._createMessage($, { ...X, stream: true }, { ...J, headers: { ...J?.headers, "X-Stainless-Helper-Method": "stream" } })), Y;
  }
  _run($) {
    $().then(() => {
      this._emitFinal(), this._emit("end");
    }, D(this, qJ, "f"));
  }
  _addMessageParam($) {
    this.messages.push($);
  }
  _addMessage($, X = true) {
    if (this.receivedMessages.push($), X) this._emit("message", $);
  }
  async _createMessage($, X, J) {
    let Q = J?.signal, Y;
    if (Q) {
      if (Q.aborted) this.controller.abort();
      Y = this.controller.abort.bind(this.controller), Q.addEventListener("abort", Y);
    }
    try {
      D(this, O6, "m", Lz).call(this);
      let { response: z, data: W } = await $.create({ ...X, stream: true }, { ...J, signal: this.controller.signal }).withResponse();
      this._connected(z);
      for await (let G of W) D(this, O6, "m", jz).call(this, G);
      if (W.controller.signal?.aborted) throw new T$();
      D(this, O6, "m", Fz).call(this);
    } finally {
      if (Q && Y) Q.removeEventListener("abort", Y);
    }
  }
  _connected($) {
    if (this.ended) return;
    v(this, wJ, $, "f"), v(this, BJ, $?.headers.get("request-id"), "f"), D(this, KJ, "f").call(this, $), this._emit("connect");
  }
  get ended() {
    return D(this, bX, "f");
  }
  get errored() {
    return D(this, VJ, "f");
  }
  get aborted() {
    return D(this, OJ, "f");
  }
  abort() {
    this.controller.abort();
  }
  on($, X) {
    return (D(this, e6, "f")[$] || (D(this, e6, "f")[$] = [])).push({ listener: X }), this;
  }
  off($, X) {
    let J = D(this, e6, "f")[$];
    if (!J) return this;
    let Q = J.findIndex((Y) => Y.listener === X);
    if (Q >= 0) J.splice(Q, 1);
    return this;
  }
  once($, X) {
    return (D(this, e6, "f")[$] || (D(this, e6, "f")[$] = [])).push({ listener: X, once: true }), this;
  }
  emitted($) {
    return new Promise((X, J) => {
      if (v(this, Y1, true, "f"), $ !== "error") this.once("error", J);
      this.once($, X);
    });
  }
  async done() {
    v(this, Y1, true, "f"), await D(this, MX, "f");
  }
  get currentMessage() {
    return D(this, A4, "f");
  }
  async finalMessage() {
    return await this.done(), D(this, O6, "m", Dz).call(this);
  }
  async finalText() {
    return await this.done(), D(this, O6, "m", nH).call(this);
  }
  _emit($, ...X) {
    if (D(this, bX, "f")) return;
    if ($ === "end") v(this, bX, true, "f"), D(this, NJ, "f").call(this);
    let J = D(this, e6, "f")[$];
    if (J) D(this, e6, "f")[$] = J.filter((Q) => !Q.once), J.forEach(({ listener: Q }) => Q(...X));
    if ($ === "abort") {
      let Q = X[0];
      if (!D(this, Y1, "f") && !J?.length) Promise.reject(Q);
      D(this, IX, "f").call(this, Q), D(this, AX, "f").call(this, Q), this._emit("end");
      return;
    }
    if ($ === "error") {
      let Q = X[0];
      if (!D(this, Y1, "f") && !J?.length) Promise.reject(Q);
      D(this, IX, "f").call(this, Q), D(this, AX, "f").call(this, Q), this._emit("end");
    }
  }
  _emitFinal() {
    if (this.receivedMessages.at(-1)) this._emit("finalMessage", D(this, O6, "m", Dz).call(this));
  }
  async _fromReadableStream($, X) {
    let J = X?.signal, Q;
    if (J) {
      if (J.aborted) this.controller.abort();
      Q = this.controller.abort.bind(this.controller), J.addEventListener("abort", Q);
    }
    try {
      D(this, O6, "m", Lz).call(this), this._connected(null);
      let Y = G6.fromReadableStream($, this.controller);
      for await (let z of Y) D(this, O6, "m", jz).call(this, z);
      if (Y.controller.signal?.aborted) throw new T$();
      D(this, O6, "m", Fz).call(this);
    } finally {
      if (J && Q) J.removeEventListener("abort", Q);
    }
  }
  [(A4 = /* @__PURE__ */ new WeakMap(), o1 = /* @__PURE__ */ new WeakMap(), FX = /* @__PURE__ */ new WeakMap(), KJ = /* @__PURE__ */ new WeakMap(), IX = /* @__PURE__ */ new WeakMap(), MX = /* @__PURE__ */ new WeakMap(), NJ = /* @__PURE__ */ new WeakMap(), AX = /* @__PURE__ */ new WeakMap(), e6 = /* @__PURE__ */ new WeakMap(), bX = /* @__PURE__ */ new WeakMap(), VJ = /* @__PURE__ */ new WeakMap(), OJ = /* @__PURE__ */ new WeakMap(), Y1 = /* @__PURE__ */ new WeakMap(), wJ = /* @__PURE__ */ new WeakMap(), BJ = /* @__PURE__ */ new WeakMap(), PX = /* @__PURE__ */ new WeakMap(), qJ = /* @__PURE__ */ new WeakMap(), O6 = /* @__PURE__ */ new WeakSet(), Dz = function() {
    if (this.receivedMessages.length === 0) throw new T("stream ended without producing a Message with role=assistant");
    return this.receivedMessages.at(-1);
  }, nH = function() {
    if (this.receivedMessages.length === 0) throw new T("stream ended without producing a Message with role=assistant");
    let X = this.receivedMessages.at(-1).content.filter((J) => J.type === "text").map((J) => J.text);
    if (X.length === 0) throw new T("stream ended without producing a content block with type=text");
    return X.join(" ");
  }, Lz = function() {
    if (this.ended) return;
    v(this, A4, void 0, "f");
  }, jz = function(X) {
    if (this.ended) return;
    let J = D(this, O6, "m", dH).call(this, X);
    switch (this._emit("streamEvent", X, J), X.type) {
      case "content_block_delta": {
        let Q = J.content.at(-1);
        switch (X.delta.type) {
          case "text_delta": {
            if (Q.type === "text") this._emit("text", X.delta.text, Q.text || "");
            break;
          }
          case "citations_delta": {
            if (Q.type === "text") this._emit("citation", X.delta.citation, Q.citations ?? []);
            break;
          }
          case "input_json_delta": {
            if (oH(Q) && Q.input) this._emit("inputJson", X.delta.partial_json, Q.input);
            break;
          }
          case "thinking_delta": {
            if (Q.type === "thinking") this._emit("thinking", X.delta.thinking, Q.thinking);
            break;
          }
          case "signature_delta": {
            if (Q.type === "thinking") this._emit("signature", Q.signature);
            break;
          }
          case "compaction_delta": {
            if (Q.type === "compaction" && Q.content) this._emit("compaction", Q.content);
            break;
          }
          default:
            tH(X.delta);
        }
        break;
      }
      case "message_stop": {
        this._addMessageParam(J), this._addMessage(Bz(J, D(this, o1, "f"), { logger: D(this, PX, "f") }), true);
        break;
      }
      case "content_block_stop": {
        this._emit("contentBlock", J.content.at(-1));
        break;
      }
      case "message_start": {
        v(this, A4, J, "f");
        break;
      }
      case "content_block_start":
      case "message_delta":
        break;
    }
  }, Fz = function() {
    if (this.ended) throw new T("stream has ended, this shouldn't happen");
    let X = D(this, A4, "f");
    if (!X) throw new T("request ended without sending any chunks");
    return v(this, A4, void 0, "f"), Bz(X, D(this, o1, "f"), { logger: D(this, PX, "f") });
  }, dH = function(X) {
    let J = D(this, A4, "f");
    if (X.type === "message_start") {
      if (J) throw new T(`Unexpected event order, got ${X.type} before receiving "message_stop"`);
      return X.message;
    }
    if (!J) throw new T(`Unexpected event order, got ${X.type} before "message_start"`);
    switch (X.type) {
      case "message_stop":
        return J;
      case "message_delta":
        if (J.container = X.delta.container, J.stop_reason = X.delta.stop_reason, J.stop_sequence = X.delta.stop_sequence, J.usage.output_tokens = X.usage.output_tokens, J.context_management = X.context_management, X.usage.input_tokens != null) J.usage.input_tokens = X.usage.input_tokens;
        if (X.usage.cache_creation_input_tokens != null) J.usage.cache_creation_input_tokens = X.usage.cache_creation_input_tokens;
        if (X.usage.cache_read_input_tokens != null) J.usage.cache_read_input_tokens = X.usage.cache_read_input_tokens;
        if (X.usage.server_tool_use != null) J.usage.server_tool_use = X.usage.server_tool_use;
        if (X.usage.iterations != null) J.usage.iterations = X.usage.iterations;
        return J;
      case "content_block_start":
        return J.content.push(X.content_block), J;
      case "content_block_delta": {
        let Q = J.content.at(X.index);
        switch (X.delta.type) {
          case "text_delta": {
            if (Q?.type === "text") J.content[X.index] = { ...Q, text: (Q.text || "") + X.delta.text };
            break;
          }
          case "citations_delta": {
            if (Q?.type === "text") J.content[X.index] = { ...Q, citations: [...Q.citations ?? [], X.delta.citation] };
            break;
          }
          case "input_json_delta": {
            if (Q && oH(Q)) {
              let Y = Q[rH] || "";
              Y += X.delta.partial_json;
              let z = { ...Q };
              if (Object.defineProperty(z, rH, { value: Y, enumerable: false, writable: true }), Y) try {
                z.input = HJ(Y);
              } catch (W) {
                let G = new T(`Unable to parse tool parameter JSON from model. Please retry your request or adjust your prompt. Error: ${W}. JSON: ${Y}`);
                D(this, qJ, "f").call(this, G);
              }
              J.content[X.index] = z;
            }
            break;
          }
          case "thinking_delta": {
            if (Q?.type === "thinking") J.content[X.index] = { ...Q, thinking: Q.thinking + X.delta.thinking };
            break;
          }
          case "signature_delta": {
            if (Q?.type === "thinking") J.content[X.index] = { ...Q, signature: X.delta.signature };
            break;
          }
          case "compaction_delta": {
            if (Q?.type === "compaction") J.content[X.index] = { ...Q, content: (Q.content || "") + X.delta.content };
            break;
          }
          default:
            tH(X.delta);
        }
        return J;
      }
      case "content_block_stop":
        return J;
    }
  }, Symbol.asyncIterator)]() {
    let $ = [], X = [], J = false;
    return this.on("streamEvent", (Q) => {
      let Y = X.shift();
      if (Y) Y.resolve(Q);
      else $.push(Q);
    }), this.on("end", () => {
      J = true;
      for (let Q of X) Q.resolve(void 0);
      X.length = 0;
    }), this.on("abort", (Q) => {
      J = true;
      for (let Y of X) Y.reject(Q);
      X.length = 0;
    }), this.on("error", (Q) => {
      J = true;
      for (let Y of X) Y.reject(Q);
      X.length = 0;
    }), { next: async () => {
      if (!$.length) {
        if (J) return { value: void 0, done: true };
        return new Promise((Y, z) => X.push({ resolve: Y, reject: z })).then((Y) => Y ? { value: Y, done: false } : { value: void 0, done: true });
      }
      return { value: $.shift(), done: false };
    }, return: async () => {
      return this.abort(), { value: void 0, done: true };
    } };
  }
  toReadableStream() {
    return new G6(this[Symbol.asyncIterator].bind(this), this.controller).toReadableStream();
  }
};
function tH($) {
}
var t1 = class extends Error {
  constructor($) {
    let X = typeof $ === "string" ? $ : $.map((J) => {
      if (J.type === "text") return J.text;
      return `[${J.type}]`;
    }).join(" ");
    super(X);
    this.name = "ToolError", this.content = $;
  }
};
var aH = 1e5;
var sH = `You have been working on the task described above but have not yet completed it. Write a continuation summary that will allow you (or another instance of yourself) to resume work efficiently in a future context window where the conversation history will be replaced with this summary. Your summary should be structured, concise, and actionable. Include:
1. Task Overview
The user's core request and success criteria
Any clarifications or constraints they specified
2. Current State
What has been completed so far
Files created, modified, or analyzed (with paths if relevant)
Key outputs or artifacts produced
3. Important Discoveries
Technical constraints or requirements uncovered
Decisions made and their rationale
Errors encountered and how they were resolved
What approaches were tried that didn't work (and why)
4. Next Steps
Specific actions needed to complete the task
Any blockers or open questions to resolve
Priority order if multiple steps remain
5. Context to Preserve
User preferences or style requirements
Domain-specific details that aren't obvious
Any promises made to the user
Be concise but complete\u2014err on the side of including information that would prevent duplicate work or repeated mistakes. Write in a way that enables immediate resumption of the task.
Wrap your summary in <summary></summary> tags.`;
var EX;
var a1;
var Q1;
var C$;
var RX;
var U6;
var $4;
var b4;
var SX;
var eH;
var Iz;
function $K() {
  let $, X;
  return { promise: new Promise((Q, Y) => {
    $ = Q, X = Y;
  }), resolve: $, reject: X };
}
var vX = class {
  constructor($, X, J) {
    EX.add(this), this.client = $, a1.set(this, false), Q1.set(this, false), C$.set(this, void 0), RX.set(this, void 0), U6.set(this, void 0), $4.set(this, void 0), b4.set(this, void 0), SX.set(this, 0), v(this, C$, { params: { ...X, messages: structuredClone(X.messages) } }, "f");
    let Y = ["BetaToolRunner", ...wz(X.tools, X.messages)].join(", ");
    v(this, RX, { ...J, headers: n([{ "x-stainless-helper": Y }, J?.headers]) }, "f"), v(this, b4, $K(), "f");
  }
  async *[(a1 = /* @__PURE__ */ new WeakMap(), Q1 = /* @__PURE__ */ new WeakMap(), C$ = /* @__PURE__ */ new WeakMap(), RX = /* @__PURE__ */ new WeakMap(), U6 = /* @__PURE__ */ new WeakMap(), $4 = /* @__PURE__ */ new WeakMap(), b4 = /* @__PURE__ */ new WeakMap(), SX = /* @__PURE__ */ new WeakMap(), EX = /* @__PURE__ */ new WeakSet(), eH = async function() {
    let X = D(this, C$, "f").params.compactionControl;
    if (!X || !X.enabled) return false;
    let J = 0;
    if (D(this, U6, "f") !== void 0) try {
      let U = await D(this, U6, "f");
      J = U.usage.input_tokens + (U.usage.cache_creation_input_tokens ?? 0) + (U.usage.cache_read_input_tokens ?? 0) + U.usage.output_tokens;
    } catch {
      return false;
    }
    let Q = X.contextTokenThreshold ?? aH;
    if (J < Q) return false;
    let Y = X.model ?? D(this, C$, "f").params.model, z = X.summaryPrompt ?? sH, W = D(this, C$, "f").params.messages;
    if (W[W.length - 1].role === "assistant") {
      let U = W[W.length - 1];
      if (Array.isArray(U.content)) {
        let H = U.content.filter((K) => K.type !== "tool_use");
        if (H.length === 0) W.pop();
        else U.content = H;
      }
    }
    let G = await this.client.beta.messages.create({ model: Y, messages: [...W, { role: "user", content: [{ type: "text", text: z }] }], max_tokens: D(this, C$, "f").params.max_tokens }, { headers: { "x-stainless-helper": "compaction" } });
    if (G.content[0]?.type !== "text") throw new T("Expected text response for compaction");
    return D(this, C$, "f").params.messages = [{ role: "user", content: G.content }], true;
  }, Symbol.asyncIterator)]() {
    var $;
    if (D(this, a1, "f")) throw new T("Cannot iterate over a consumed stream");
    v(this, a1, true, "f"), v(this, Q1, true, "f"), v(this, $4, void 0, "f");
    try {
      while (true) {
        let X;
        try {
          if (D(this, C$, "f").params.max_iterations && D(this, SX, "f") >= D(this, C$, "f").params.max_iterations) break;
          v(this, Q1, false, "f"), v(this, $4, void 0, "f"), v(this, SX, ($ = D(this, SX, "f"), $++, $), "f"), v(this, U6, void 0, "f");
          let { max_iterations: J, compactionControl: Q, ...Y } = D(this, C$, "f").params;
          if (Y.stream) X = this.client.beta.messages.stream({ ...Y }, D(this, RX, "f")), v(this, U6, X.finalMessage(), "f"), D(this, U6, "f").catch(() => {
          }), yield X;
          else v(this, U6, this.client.beta.messages.create({ ...Y, stream: false }, D(this, RX, "f")), "f"), yield D(this, U6, "f");
          if (!await D(this, EX, "m", eH).call(this)) {
            if (!D(this, Q1, "f")) {
              let { role: G, content: U } = await D(this, U6, "f");
              D(this, C$, "f").params.messages.push({ role: G, content: U });
            }
            let W = await D(this, EX, "m", Iz).call(this, D(this, C$, "f").params.messages.at(-1));
            if (W) D(this, C$, "f").params.messages.push(W);
            else if (!D(this, Q1, "f")) break;
          }
        } finally {
          if (X) X.abort();
        }
      }
      if (!D(this, U6, "f")) throw new T("ToolRunner concluded without a message from the server");
      D(this, b4, "f").resolve(await D(this, U6, "f"));
    } catch (X) {
      throw v(this, a1, false, "f"), D(this, b4, "f").promise.catch(() => {
      }), D(this, b4, "f").reject(X), v(this, b4, $K(), "f"), X;
    }
  }
  setMessagesParams($) {
    if (typeof $ === "function") D(this, C$, "f").params = $(D(this, C$, "f").params);
    else D(this, C$, "f").params = $;
    v(this, Q1, true, "f"), v(this, $4, void 0, "f");
  }
  async generateToolResponse() {
    let $ = await D(this, U6, "f") ?? this.params.messages.at(-1);
    if (!$) return null;
    return D(this, EX, "m", Iz).call(this, $);
  }
  done() {
    return D(this, b4, "f").promise;
  }
  async runUntilDone() {
    if (!D(this, a1, "f")) for await (let $ of this) ;
    return this.done();
  }
  get params() {
    return D(this, C$, "f").params;
  }
  pushMessages(...$) {
    this.setMessagesParams((X) => ({ ...X, messages: [...X.messages, ...$] }));
  }
  then($, X) {
    return this.runUntilDone().then($, X);
  }
};
Iz = async function(X) {
  if (D(this, $4, "f") !== void 0) return D(this, $4, "f");
  return v(this, $4, IF(D(this, C$, "f").params, X), "f"), D(this, $4, "f");
};
async function IF($, X = $.messages.at(-1)) {
  if (!X || X.role !== "assistant" || !X.content || typeof X.content === "string") return null;
  let J = X.content.filter((Y) => Y.type === "tool_use");
  if (J.length === 0) return null;
  return { role: "user", content: await Promise.all(J.map(async (Y) => {
    let z = $.tools.find((W) => ("name" in W ? W.name : W.mcp_server_name) === Y.name);
    if (!z || !("run" in z)) return { type: "tool_result", tool_use_id: Y.id, content: `Error: Tool '${Y.name}' not found`, is_error: true };
    try {
      let W = Y.input;
      if ("parse" in z && z.parse) W = z.parse(W);
      let G = await z.run(W);
      return { type: "tool_result", tool_use_id: Y.id, content: G };
    } catch (W) {
      return { type: "tool_result", tool_use_id: Y.id, content: W instanceof t1 ? W.content : `Error: ${W instanceof Error ? W.message : String(W)}`, is_error: true };
    }
  })) };
}
var s1 = class _s1 {
  constructor($, X) {
    this.iterator = $, this.controller = X;
  }
  async *decoder() {
    let $ = new M4();
    for await (let X of this.iterator) for (let J of $.decode(X)) yield JSON.parse(J);
    for (let X of $.flush()) yield JSON.parse(X);
  }
  [Symbol.asyncIterator]() {
    return this.decoder();
  }
  static fromResponse($, X) {
    if (!$.body) {
      if (X.abort(), typeof globalThis.navigator < "u" && globalThis.navigator.product === "ReactNative") throw new T("The default react-native fetch implementation does not support streaming. Please use expo/fetch: https://docs.expo.dev/versions/latest/sdk/expo/#expofetch-api");
      throw new T("Attempted to iterate over a response with no body");
    }
    return new _s1(KX($.body), X);
  }
};
var CX = class extends A$ {
  create($, X) {
    let { betas: J, ...Q } = $;
    return this._client.post("/v1/messages/batches?beta=true", { body: Q, ...X, headers: n([{ "anthropic-beta": [...J ?? [], "message-batches-2024-09-24"].toString() }, X?.headers]) });
  }
  retrieve($, X = {}, J) {
    let { betas: Q } = X ?? {};
    return this._client.get(F$`/v1/messages/batches/${$}?beta=true`, { ...J, headers: n([{ "anthropic-beta": [...Q ?? [], "message-batches-2024-09-24"].toString() }, J?.headers]) });
  }
  list($ = {}, X) {
    let { betas: J, ...Q } = $ ?? {};
    return this._client.getAPIList("/v1/messages/batches?beta=true", P6, { query: Q, ...X, headers: n([{ "anthropic-beta": [...J ?? [], "message-batches-2024-09-24"].toString() }, X?.headers]) });
  }
  delete($, X = {}, J) {
    let { betas: Q } = X ?? {};
    return this._client.delete(F$`/v1/messages/batches/${$}?beta=true`, { ...J, headers: n([{ "anthropic-beta": [...Q ?? [], "message-batches-2024-09-24"].toString() }, J?.headers]) });
  }
  cancel($, X = {}, J) {
    let { betas: Q } = X ?? {};
    return this._client.post(F$`/v1/messages/batches/${$}/cancel?beta=true`, { ...J, headers: n([{ "anthropic-beta": [...Q ?? [], "message-batches-2024-09-24"].toString() }, J?.headers]) });
  }
  async results($, X = {}, J) {
    let Q = await this.retrieve($);
    if (!Q.results_url) throw new T(`No batch \`results_url\`; Has it finished processing? ${Q.processing_status} - ${Q.id}`);
    let { betas: Y } = X ?? {};
    return this._client.get(Q.results_url, { ...J, headers: n([{ "anthropic-beta": [...Y ?? [], "message-batches-2024-09-24"].toString(), Accept: "application/binary" }, J?.headers]), stream: true, __binaryResponse: true })._thenUnwrap((z, W) => s1.fromResponse(W.response, W.controller));
  }
};
var XK = { "claude-1.3": "November 6th, 2024", "claude-1.3-100k": "November 6th, 2024", "claude-instant-1.1": "November 6th, 2024", "claude-instant-1.1-100k": "November 6th, 2024", "claude-instant-1.2": "November 6th, 2024", "claude-3-sonnet-20240229": "July 21st, 2025", "claude-3-opus-20240229": "January 5th, 2026", "claude-2.1": "July 21st, 2025", "claude-2.0": "July 21st, 2025", "claude-3-7-sonnet-latest": "February 19th, 2026", "claude-3-7-sonnet-20250219": "February 19th, 2026" };
var AF = ["claude-opus-4-6"];
var P4 = class extends A$ {
  constructor() {
    super(...arguments);
    this.batches = new CX(this._client);
  }
  create($, X) {
    let J = JK($), { betas: Q, ...Y } = J;
    if (Y.model in XK) console.warn(`The model '${Y.model}' is deprecated and will reach end-of-life on ${XK[Y.model]}
Please migrate to a newer model. Visit https://docs.anthropic.com/en/docs/resources/model-deprecations for more information.`);
    if (Y.model in AF && Y.thinking && Y.thinking.type === "enabled") console.warn(`Using Claude with ${Y.model} and 'thinking.type=enabled' is deprecated. Use 'thinking.type=adaptive' instead which results in better model performance in our testing: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking`);
    let z = this._client._options.timeout;
    if (!Y.stream && z == null) {
      let G = UJ[Y.model] ?? void 0;
      z = this._client.calculateNonstreamingTimeout(Y.max_tokens, G);
    }
    let W = GJ(Y.tools, Y.messages);
    return this._client.post("/v1/messages?beta=true", { body: Y, timeout: z ?? 6e5, ...X, headers: n([{ ...Q?.toString() != null ? { "anthropic-beta": Q?.toString() } : void 0 }, W, X?.headers]), stream: J.stream ?? false });
  }
  parse($, X) {
    return X = { ...X, headers: n([{ "anthropic-beta": [...$.betas ?? [], "structured-outputs-2025-12-15"].toString() }, X?.headers]) }, this.create($, X).then((J) => qz(J, $, { logger: this._client.logger ?? console }));
  }
  stream($, X) {
    return ZX.createMessage(this, $, X);
  }
  countTokens($, X) {
    let J = JK($), { betas: Q, ...Y } = J;
    return this._client.post("/v1/messages/count_tokens?beta=true", { body: Y, ...X, headers: n([{ "anthropic-beta": [...Q ?? [], "token-counting-2024-11-01"].toString() }, X?.headers]) });
  }
  toolRunner($, X) {
    return new vX(this._client, $, X);
  }
};
function JK($) {
  if (!$.output_format) return $;
  if ($.output_config?.format) throw new T("Both output_format and output_config.format were provided. Please use only output_config.format (output_format is deprecated).");
  let { output_format: X, ...J } = $;
  return { ...J, output_config: { ...$.output_config, format: X } };
}
P4.Batches = CX;
P4.BetaToolRunner = vX;
P4.ToolError = t1;
var kX = class extends A$ {
  create($, X = {}, J) {
    let { betas: Q, ...Y } = X ?? {};
    return this._client.post(F$`/v1/skills/${$}/versions?beta=true`, d1({ body: Y, ...J, headers: n([{ "anthropic-beta": [...Q ?? [], "skills-2025-10-02"].toString() }, J?.headers]) }, this._client));
  }
  retrieve($, X, J) {
    let { skill_id: Q, betas: Y } = X;
    return this._client.get(F$`/v1/skills/${Q}/versions/${$}?beta=true`, { ...J, headers: n([{ "anthropic-beta": [...Y ?? [], "skills-2025-10-02"].toString() }, J?.headers]) });
  }
  list($, X = {}, J) {
    let { betas: Q, ...Y } = X ?? {};
    return this._client.getAPIList(F$`/v1/skills/${$}/versions?beta=true`, BX, { query: Y, ...J, headers: n([{ "anthropic-beta": [...Q ?? [], "skills-2025-10-02"].toString() }, J?.headers]) });
  }
  delete($, X, J) {
    let { skill_id: Q, betas: Y } = X;
    return this._client.delete(F$`/v1/skills/${Q}/versions/${$}?beta=true`, { ...J, headers: n([{ "anthropic-beta": [...Y ?? [], "skills-2025-10-02"].toString() }, J?.headers]) });
  }
};
var e1 = class extends A$ {
  constructor() {
    super(...arguments);
    this.versions = new kX(this._client);
  }
  create($ = {}, X) {
    let { betas: J, ...Q } = $ ?? {};
    return this._client.post("/v1/skills?beta=true", d1({ body: Q, ...X, headers: n([{ "anthropic-beta": [...J ?? [], "skills-2025-10-02"].toString() }, X?.headers]) }, this._client, false));
  }
  retrieve($, X = {}, J) {
    let { betas: Q } = X ?? {};
    return this._client.get(F$`/v1/skills/${$}?beta=true`, { ...J, headers: n([{ "anthropic-beta": [...Q ?? [], "skills-2025-10-02"].toString() }, J?.headers]) });
  }
  list($ = {}, X) {
    let { betas: J, ...Q } = $ ?? {};
    return this._client.getAPIList("/v1/skills?beta=true", BX, { query: Q, ...X, headers: n([{ "anthropic-beta": [...J ?? [], "skills-2025-10-02"].toString() }, X?.headers]) });
  }
  delete($, X = {}, J) {
    let { betas: Q } = X ?? {};
    return this._client.delete(F$`/v1/skills/${$}?beta=true`, { ...J, headers: n([{ "anthropic-beta": [...Q ?? [], "skills-2025-10-02"].toString() }, J?.headers]) });
  }
};
e1.Versions = kX;
var f6 = class extends A$ {
  constructor() {
    super(...arguments);
    this.models = new jX(this._client), this.messages = new P4(this._client), this.files = new LX(this._client), this.skills = new e1(this._client);
  }
};
f6.Models = jX;
f6.Messages = P4;
f6.Files = LX;
f6.Skills = e1;
var $0 = class extends A$ {
  create($, X) {
    let { betas: J, ...Q } = $;
    return this._client.post("/v1/complete", { body: Q, timeout: this._client._options.timeout ?? 6e5, ...X, headers: n([{ ...J?.toString() != null ? { "anthropic-beta": J?.toString() } : void 0 }, X?.headers]), stream: $.stream ?? false });
  }
};
function YK($) {
  return $?.output_config?.format;
}
function Mz($, X, J) {
  let Q = YK(X);
  if (!X || !("parse" in (Q ?? {}))) return { ...$, content: $.content.map((Y) => {
    if (Y.type === "text") return Object.defineProperty({ ...Y }, "parsed_output", { value: null, enumerable: false });
    return Y;
  }), parsed_output: null };
  return Az($, X, J);
}
function Az($, X, J) {
  let Q = null, Y = $.content.map((z) => {
    if (z.type === "text") {
      let W = EF(X, z.text);
      if (Q === null) Q = W;
      return Object.defineProperty({ ...z }, "parsed_output", { value: W, enumerable: false });
    }
    return z;
  });
  return { ...$, content: Y, parsed_output: Q };
}
function EF($, X) {
  let J = YK($);
  if (J?.type !== "json_schema") return null;
  try {
    if ("parse" in J) return J.parse(X);
    return JSON.parse(X);
  } catch (Q) {
    throw new T(`Failed to parse structured output: ${Q}`);
  }
}
var w6;
var Z4;
var X0;
var _X;
var DJ;
var xX;
var TX;
var LJ;
var yX;
var X4;
var gX;
var jJ;
var FJ;
var z1;
var IJ;
var MJ;
var fX;
var bz;
var QK;
var Pz;
var Zz;
var Ez;
var Rz;
var zK;
var WK = "__json_buf";
function GK($) {
  return $.type === "tool_use" || $.type === "server_tool_use";
}
var hX = class _hX {
  constructor($, X) {
    w6.add(this), this.messages = [], this.receivedMessages = [], Z4.set(this, void 0), X0.set(this, null), this.controller = new AbortController(), _X.set(this, void 0), DJ.set(this, () => {
    }), xX.set(this, () => {
    }), TX.set(this, void 0), LJ.set(this, () => {
    }), yX.set(this, () => {
    }), X4.set(this, {}), gX.set(this, false), jJ.set(this, false), FJ.set(this, false), z1.set(this, false), IJ.set(this, void 0), MJ.set(this, void 0), fX.set(this, void 0), Pz.set(this, (J) => {
      if (v(this, jJ, true, "f"), a6(J)) J = new T$();
      if (J instanceof T$) return v(this, FJ, true, "f"), this._emit("abort", J);
      if (J instanceof T) return this._emit("error", J);
      if (J instanceof Error) {
        let Q = new T(J.message);
        return Q.cause = J, this._emit("error", Q);
      }
      return this._emit("error", new T(String(J)));
    }), v(this, _X, new Promise((J, Q) => {
      v(this, DJ, J, "f"), v(this, xX, Q, "f");
    }), "f"), v(this, TX, new Promise((J, Q) => {
      v(this, LJ, J, "f"), v(this, yX, Q, "f");
    }), "f"), D(this, _X, "f").catch(() => {
    }), D(this, TX, "f").catch(() => {
    }), v(this, X0, $, "f"), v(this, fX, X?.logger ?? console, "f");
  }
  get response() {
    return D(this, IJ, "f");
  }
  get request_id() {
    return D(this, MJ, "f");
  }
  async withResponse() {
    v(this, z1, true, "f");
    let $ = await D(this, _X, "f");
    if (!$) throw Error("Could not resolve a `Response` object");
    return { data: this, response: $, request_id: $.headers.get("request-id") };
  }
  static fromReadableStream($) {
    let X = new _hX(null);
    return X._run(() => X._fromReadableStream($)), X;
  }
  static createMessage($, X, J, { logger: Q } = {}) {
    let Y = new _hX(X, { logger: Q });
    for (let z of X.messages) Y._addMessageParam(z);
    return v(Y, X0, { ...X, stream: true }, "f"), Y._run(() => Y._createMessage($, { ...X, stream: true }, { ...J, headers: { ...J?.headers, "X-Stainless-Helper-Method": "stream" } })), Y;
  }
  _run($) {
    $().then(() => {
      this._emitFinal(), this._emit("end");
    }, D(this, Pz, "f"));
  }
  _addMessageParam($) {
    this.messages.push($);
  }
  _addMessage($, X = true) {
    if (this.receivedMessages.push($), X) this._emit("message", $);
  }
  async _createMessage($, X, J) {
    let Q = J?.signal, Y;
    if (Q) {
      if (Q.aborted) this.controller.abort();
      Y = this.controller.abort.bind(this.controller), Q.addEventListener("abort", Y);
    }
    try {
      D(this, w6, "m", Zz).call(this);
      let { response: z, data: W } = await $.create({ ...X, stream: true }, { ...J, signal: this.controller.signal }).withResponse();
      this._connected(z);
      for await (let G of W) D(this, w6, "m", Ez).call(this, G);
      if (W.controller.signal?.aborted) throw new T$();
      D(this, w6, "m", Rz).call(this);
    } finally {
      if (Q && Y) Q.removeEventListener("abort", Y);
    }
  }
  _connected($) {
    if (this.ended) return;
    v(this, IJ, $, "f"), v(this, MJ, $?.headers.get("request-id"), "f"), D(this, DJ, "f").call(this, $), this._emit("connect");
  }
  get ended() {
    return D(this, gX, "f");
  }
  get errored() {
    return D(this, jJ, "f");
  }
  get aborted() {
    return D(this, FJ, "f");
  }
  abort() {
    this.controller.abort();
  }
  on($, X) {
    return (D(this, X4, "f")[$] || (D(this, X4, "f")[$] = [])).push({ listener: X }), this;
  }
  off($, X) {
    let J = D(this, X4, "f")[$];
    if (!J) return this;
    let Q = J.findIndex((Y) => Y.listener === X);
    if (Q >= 0) J.splice(Q, 1);
    return this;
  }
  once($, X) {
    return (D(this, X4, "f")[$] || (D(this, X4, "f")[$] = [])).push({ listener: X, once: true }), this;
  }
  emitted($) {
    return new Promise((X, J) => {
      if (v(this, z1, true, "f"), $ !== "error") this.once("error", J);
      this.once($, X);
    });
  }
  async done() {
    v(this, z1, true, "f"), await D(this, TX, "f");
  }
  get currentMessage() {
    return D(this, Z4, "f");
  }
  async finalMessage() {
    return await this.done(), D(this, w6, "m", bz).call(this);
  }
  async finalText() {
    return await this.done(), D(this, w6, "m", QK).call(this);
  }
  _emit($, ...X) {
    if (D(this, gX, "f")) return;
    if ($ === "end") v(this, gX, true, "f"), D(this, LJ, "f").call(this);
    let J = D(this, X4, "f")[$];
    if (J) D(this, X4, "f")[$] = J.filter((Q) => !Q.once), J.forEach(({ listener: Q }) => Q(...X));
    if ($ === "abort") {
      let Q = X[0];
      if (!D(this, z1, "f") && !J?.length) Promise.reject(Q);
      D(this, xX, "f").call(this, Q), D(this, yX, "f").call(this, Q), this._emit("end");
      return;
    }
    if ($ === "error") {
      let Q = X[0];
      if (!D(this, z1, "f") && !J?.length) Promise.reject(Q);
      D(this, xX, "f").call(this, Q), D(this, yX, "f").call(this, Q), this._emit("end");
    }
  }
  _emitFinal() {
    if (this.receivedMessages.at(-1)) this._emit("finalMessage", D(this, w6, "m", bz).call(this));
  }
  async _fromReadableStream($, X) {
    let J = X?.signal, Q;
    if (J) {
      if (J.aborted) this.controller.abort();
      Q = this.controller.abort.bind(this.controller), J.addEventListener("abort", Q);
    }
    try {
      D(this, w6, "m", Zz).call(this), this._connected(null);
      let Y = G6.fromReadableStream($, this.controller);
      for await (let z of Y) D(this, w6, "m", Ez).call(this, z);
      if (Y.controller.signal?.aborted) throw new T$();
      D(this, w6, "m", Rz).call(this);
    } finally {
      if (J && Q) J.removeEventListener("abort", Q);
    }
  }
  [(Z4 = /* @__PURE__ */ new WeakMap(), X0 = /* @__PURE__ */ new WeakMap(), _X = /* @__PURE__ */ new WeakMap(), DJ = /* @__PURE__ */ new WeakMap(), xX = /* @__PURE__ */ new WeakMap(), TX = /* @__PURE__ */ new WeakMap(), LJ = /* @__PURE__ */ new WeakMap(), yX = /* @__PURE__ */ new WeakMap(), X4 = /* @__PURE__ */ new WeakMap(), gX = /* @__PURE__ */ new WeakMap(), jJ = /* @__PURE__ */ new WeakMap(), FJ = /* @__PURE__ */ new WeakMap(), z1 = /* @__PURE__ */ new WeakMap(), IJ = /* @__PURE__ */ new WeakMap(), MJ = /* @__PURE__ */ new WeakMap(), fX = /* @__PURE__ */ new WeakMap(), Pz = /* @__PURE__ */ new WeakMap(), w6 = /* @__PURE__ */ new WeakSet(), bz = function() {
    if (this.receivedMessages.length === 0) throw new T("stream ended without producing a Message with role=assistant");
    return this.receivedMessages.at(-1);
  }, QK = function() {
    if (this.receivedMessages.length === 0) throw new T("stream ended without producing a Message with role=assistant");
    let X = this.receivedMessages.at(-1).content.filter((J) => J.type === "text").map((J) => J.text);
    if (X.length === 0) throw new T("stream ended without producing a content block with type=text");
    return X.join(" ");
  }, Zz = function() {
    if (this.ended) return;
    v(this, Z4, void 0, "f");
  }, Ez = function(X) {
    if (this.ended) return;
    let J = D(this, w6, "m", zK).call(this, X);
    switch (this._emit("streamEvent", X, J), X.type) {
      case "content_block_delta": {
        let Q = J.content.at(-1);
        switch (X.delta.type) {
          case "text_delta": {
            if (Q.type === "text") this._emit("text", X.delta.text, Q.text || "");
            break;
          }
          case "citations_delta": {
            if (Q.type === "text") this._emit("citation", X.delta.citation, Q.citations ?? []);
            break;
          }
          case "input_json_delta": {
            if (GK(Q) && Q.input) this._emit("inputJson", X.delta.partial_json, Q.input);
            break;
          }
          case "thinking_delta": {
            if (Q.type === "thinking") this._emit("thinking", X.delta.thinking, Q.thinking);
            break;
          }
          case "signature_delta": {
            if (Q.type === "thinking") this._emit("signature", Q.signature);
            break;
          }
          default:
            UK(X.delta);
        }
        break;
      }
      case "message_stop": {
        this._addMessageParam(J), this._addMessage(Mz(J, D(this, X0, "f"), { logger: D(this, fX, "f") }), true);
        break;
      }
      case "content_block_stop": {
        this._emit("contentBlock", J.content.at(-1));
        break;
      }
      case "message_start": {
        v(this, Z4, J, "f");
        break;
      }
      case "content_block_start":
      case "message_delta":
        break;
    }
  }, Rz = function() {
    if (this.ended) throw new T("stream has ended, this shouldn't happen");
    let X = D(this, Z4, "f");
    if (!X) throw new T("request ended without sending any chunks");
    return v(this, Z4, void 0, "f"), Mz(X, D(this, X0, "f"), { logger: D(this, fX, "f") });
  }, zK = function(X) {
    let J = D(this, Z4, "f");
    if (X.type === "message_start") {
      if (J) throw new T(`Unexpected event order, got ${X.type} before receiving "message_stop"`);
      return X.message;
    }
    if (!J) throw new T(`Unexpected event order, got ${X.type} before "message_start"`);
    switch (X.type) {
      case "message_stop":
        return J;
      case "message_delta":
        if (J.stop_reason = X.delta.stop_reason, J.stop_sequence = X.delta.stop_sequence, J.usage.output_tokens = X.usage.output_tokens, X.usage.input_tokens != null) J.usage.input_tokens = X.usage.input_tokens;
        if (X.usage.cache_creation_input_tokens != null) J.usage.cache_creation_input_tokens = X.usage.cache_creation_input_tokens;
        if (X.usage.cache_read_input_tokens != null) J.usage.cache_read_input_tokens = X.usage.cache_read_input_tokens;
        if (X.usage.server_tool_use != null) J.usage.server_tool_use = X.usage.server_tool_use;
        return J;
      case "content_block_start":
        return J.content.push({ ...X.content_block }), J;
      case "content_block_delta": {
        let Q = J.content.at(X.index);
        switch (X.delta.type) {
          case "text_delta": {
            if (Q?.type === "text") J.content[X.index] = { ...Q, text: (Q.text || "") + X.delta.text };
            break;
          }
          case "citations_delta": {
            if (Q?.type === "text") J.content[X.index] = { ...Q, citations: [...Q.citations ?? [], X.delta.citation] };
            break;
          }
          case "input_json_delta": {
            if (Q && GK(Q)) {
              let Y = Q[WK] || "";
              Y += X.delta.partial_json;
              let z = { ...Q };
              if (Object.defineProperty(z, WK, { value: Y, enumerable: false, writable: true }), Y) z.input = HJ(Y);
              J.content[X.index] = z;
            }
            break;
          }
          case "thinking_delta": {
            if (Q?.type === "thinking") J.content[X.index] = { ...Q, thinking: Q.thinking + X.delta.thinking };
            break;
          }
          case "signature_delta": {
            if (Q?.type === "thinking") J.content[X.index] = { ...Q, signature: X.delta.signature };
            break;
          }
          default:
            UK(X.delta);
        }
        return J;
      }
      case "content_block_stop":
        return J;
    }
  }, Symbol.asyncIterator)]() {
    let $ = [], X = [], J = false;
    return this.on("streamEvent", (Q) => {
      let Y = X.shift();
      if (Y) Y.resolve(Q);
      else $.push(Q);
    }), this.on("end", () => {
      J = true;
      for (let Q of X) Q.resolve(void 0);
      X.length = 0;
    }), this.on("abort", (Q) => {
      J = true;
      for (let Y of X) Y.reject(Q);
      X.length = 0;
    }), this.on("error", (Q) => {
      J = true;
      for (let Y of X) Y.reject(Q);
      X.length = 0;
    }), { next: async () => {
      if (!$.length) {
        if (J) return { value: void 0, done: true };
        return new Promise((Y, z) => X.push({ resolve: Y, reject: z })).then((Y) => Y ? { value: Y, done: false } : { value: void 0, done: true });
      }
      return { value: $.shift(), done: false };
    }, return: async () => {
      return this.abort(), { value: void 0, done: true };
    } };
  }
  toReadableStream() {
    return new G6(this[Symbol.asyncIterator].bind(this), this.controller).toReadableStream();
  }
};
function UK($) {
}
var uX = class extends A$ {
  create($, X) {
    return this._client.post("/v1/messages/batches", { body: $, ...X });
  }
  retrieve($, X) {
    return this._client.get(F$`/v1/messages/batches/${$}`, X);
  }
  list($ = {}, X) {
    return this._client.getAPIList("/v1/messages/batches", P6, { query: $, ...X });
  }
  delete($, X) {
    return this._client.delete(F$`/v1/messages/batches/${$}`, X);
  }
  cancel($, X) {
    return this._client.post(F$`/v1/messages/batches/${$}/cancel`, X);
  }
  async results($, X) {
    let J = await this.retrieve($);
    if (!J.results_url) throw new T(`No batch \`results_url\`; Has it finished processing? ${J.processing_status} - ${J.id}`);
    return this._client.get(J.results_url, { ...X, headers: n([{ Accept: "application/binary" }, X?.headers]), stream: true, __binaryResponse: true })._thenUnwrap((Q, Y) => s1.fromResponse(Y.response, Y.controller));
  }
};
var W1 = class extends A$ {
  constructor() {
    super(...arguments);
    this.batches = new uX(this._client);
  }
  create($, X) {
    if ($.model in HK) console.warn(`The model '${$.model}' is deprecated and will reach end-of-life on ${HK[$.model]}
Please migrate to a newer model. Visit https://docs.anthropic.com/en/docs/resources/model-deprecations for more information.`);
    if ($.model in SF && $.thinking && $.thinking.type === "enabled") console.warn(`Using Claude with ${$.model} and 'thinking.type=enabled' is deprecated. Use 'thinking.type=adaptive' instead which results in better model performance in our testing: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking`);
    let J = this._client._options.timeout;
    if (!$.stream && J == null) {
      let Y = UJ[$.model] ?? void 0;
      J = this._client.calculateNonstreamingTimeout($.max_tokens, Y);
    }
    let Q = GJ($.tools, $.messages);
    return this._client.post("/v1/messages", { body: $, timeout: J ?? 6e5, ...X, headers: n([Q, X?.headers]), stream: $.stream ?? false });
  }
  parse($, X) {
    return this.create($, X).then((J) => Az(J, $, { logger: this._client.logger ?? console }));
  }
  stream($, X) {
    return hX.createMessage(this, $, X, { logger: this._client.logger ?? console });
  }
  countTokens($, X) {
    return this._client.post("/v1/messages/count_tokens", { body: $, ...X });
  }
};
var HK = { "claude-1.3": "November 6th, 2024", "claude-1.3-100k": "November 6th, 2024", "claude-instant-1.1": "November 6th, 2024", "claude-instant-1.1-100k": "November 6th, 2024", "claude-instant-1.2": "November 6th, 2024", "claude-3-sonnet-20240229": "July 21st, 2025", "claude-3-opus-20240229": "January 5th, 2026", "claude-2.1": "July 21st, 2025", "claude-2.0": "July 21st, 2025", "claude-3-7-sonnet-latest": "February 19th, 2026", "claude-3-7-sonnet-20250219": "February 19th, 2026", "claude-3-5-haiku-latest": "February 19th, 2026", "claude-3-5-haiku-20241022": "February 19th, 2026" };
var SF = ["claude-opus-4-6"];
W1.Batches = uX;
var J0 = class extends A$ {
  retrieve($, X = {}, J) {
    let { betas: Q } = X ?? {};
    return this._client.get(F$`/v1/models/${$}`, { ...J, headers: n([{ ...Q?.toString() != null ? { "anthropic-beta": Q?.toString() } : void 0 }, J?.headers]) });
  }
  list($ = {}, X) {
    let { betas: J, ...Q } = $ ?? {};
    return this._client.getAPIList("/v1/models", P6, { query: Q, ...X, headers: n([{ ...J?.toString() != null ? { "anthropic-beta": J?.toString() } : void 0 }, X?.headers]) });
  }
};
var mX = ($) => {
  if (typeof globalThis.process < "u") return globalThis.process.env?.[$]?.trim() ?? void 0;
  if (typeof globalThis.Deno < "u") return globalThis.Deno.env?.get?.($)?.trim();
  return;
};
var Sz;
var vz;
var AJ;
var KK;
var NK = "\\n\\nHuman:";
var VK = "\\n\\nAssistant:";
var P$ = class {
  constructor({ baseURL: $ = mX("ANTHROPIC_BASE_URL"), apiKey: X = mX("ANTHROPIC_API_KEY") ?? null, authToken: J = mX("ANTHROPIC_AUTH_TOKEN") ?? null, ...Q } = {}) {
    Sz.add(this), AJ.set(this, void 0);
    let Y = { apiKey: X, authToken: J, ...Q, baseURL: $ || "https://api.anthropic.com" };
    if (!Y.dangerouslyAllowBrowser && RH()) throw new T(`It looks like you're running in a browser-like environment.

This is disabled by default, as it risks exposing your secret API credentials to attackers.
If you understand the risks and have appropriate mitigations in place,
you can set the \`dangerouslyAllowBrowser\` option to \`true\`, e.g.,

new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
`);
    this.baseURL = Y.baseURL, this.timeout = Y.timeout ?? vz.DEFAULT_TIMEOUT, this.logger = Y.logger ?? console;
    let z = "warn";
    this.logLevel = z, this.logLevel = Gz(Y.logLevel, "ClientOptions.logLevel", this) ?? Gz(mX("ANTHROPIC_LOG"), "process.env['ANTHROPIC_LOG']", this) ?? z, this.fetchOptions = Y.fetchOptions, this.maxRetries = Y.maxRetries ?? 2, this.fetch = Y.fetch ?? vH(), v(this, AJ, kH, "f"), this._options = Y, this.apiKey = typeof X === "string" ? X : null, this.authToken = J;
  }
  withOptions($) {
    return new this.constructor({ ...this._options, baseURL: this.baseURL, maxRetries: this.maxRetries, timeout: this.timeout, logger: this.logger, logLevel: this.logLevel, fetch: this.fetch, fetchOptions: this.fetchOptions, apiKey: this.apiKey, authToken: this.authToken, ...$ });
  }
  defaultQuery() {
    return this._options.defaultQuery;
  }
  validateHeaders({ values: $, nulls: X }) {
    if ($.get("x-api-key") || $.get("authorization")) return;
    if (this.apiKey && $.get("x-api-key")) return;
    if (X.has("x-api-key")) return;
    if (this.authToken && $.get("authorization")) return;
    if (X.has("authorization")) return;
    throw Error('Could not resolve authentication method. Expected either apiKey or authToken to be set. Or for one of the "X-Api-Key" or "Authorization" headers to be explicitly omitted');
  }
  async authHeaders($) {
    return n([await this.apiKeyAuth($), await this.bearerAuth($)]);
  }
  async apiKeyAuth($) {
    if (this.apiKey == null) return;
    return n([{ "X-Api-Key": this.apiKey }]);
  }
  async bearerAuth($) {
    if (this.authToken == null) return;
    return n([{ Authorization: `Bearer ${this.authToken}` }]);
  }
  stringifyQuery($) {
    return Object.entries($).filter(([X, J]) => typeof J < "u").map(([X, J]) => {
      if (typeof J === "string" || typeof J === "number" || typeof J === "boolean") return `${encodeURIComponent(X)}=${encodeURIComponent(J)}`;
      if (J === null) return `${encodeURIComponent(X)}=`;
      throw new T(`Cannot stringify type ${typeof J}; Expected string, number, boolean, or null. If you need to pass nested query parameters, you can manually encode them, e.g. { query: { 'foo[key1]': value1, 'foo[key2]': value2 } }, and please open a GitHub issue requesting better support for your use case.`);
    }).join("&");
  }
  getUserAgent() {
    return `${this.constructor.name}/JS ${I4}`;
  }
  defaultIdempotencyKey() {
    return `stainless-node-retry-${Jz()}`;
  }
  makeStatusError($, X, J, Q) {
    return v$.generate($, X, J, Q);
  }
  buildURL($, X, J) {
    let Q = !D(this, Sz, "m", KK).call(this) && J || this.baseURL, Y = FH($) ? new URL($) : new URL(Q + (Q.endsWith("/") && $.startsWith("/") ? $.slice(1) : $)), z = this.defaultQuery();
    if (!IH(z)) X = { ...z, ...X };
    if (typeof X === "object" && X && !Array.isArray(X)) Y.search = this.stringifyQuery(X);
    return Y.toString();
  }
  _calculateNonstreamingTimeout($) {
    if (3600 * $ / 128e3 > 600) throw new T("Streaming is required for operations that may take longer than 10 minutes. See https://github.com/anthropics/anthropic-sdk-typescript#streaming-responses for more details");
    return 6e5;
  }
  async prepareOptions($) {
  }
  async prepareRequest($, { url: X, options: J }) {
  }
  get($, X) {
    return this.methodRequest("get", $, X);
  }
  post($, X) {
    return this.methodRequest("post", $, X);
  }
  patch($, X) {
    return this.methodRequest("patch", $, X);
  }
  put($, X) {
    return this.methodRequest("put", $, X);
  }
  delete($, X) {
    return this.methodRequest("delete", $, X);
  }
  methodRequest($, X, J) {
    return this.request(Promise.resolve(J).then((Q) => {
      return { method: $, path: X, ...Q };
    }));
  }
  request($, X = null) {
    return new X1(this, this.makeRequest($, X, void 0));
  }
  async makeRequest($, X, J) {
    let Q = await $, Y = Q.maxRetries ?? this.maxRetries;
    if (X == null) X = Y;
    await this.prepareOptions(Q);
    let { req: z, url: W, timeout: G } = await this.buildRequest(Q, { retryCount: Y - X });
    await this.prepareRequest(z, { url: W, options: Q });
    let U = "log_" + (Math.random() * 16777216 | 0).toString(16).padStart(6, "0"), H = J === void 0 ? "" : `, retryOf: ${J}`, K = Date.now();
    if (_$(this).debug(`[${U}] sending request`, s6({ retryOfRequestLogID: J, method: Q.method, url: W, options: Q, headers: z.headers })), Q.signal?.aborted) throw new T$();
    let V = new AbortController(), O = await this.fetchWithTimeout(W, z, G, V).catch($X), N = Date.now();
    if (O instanceof globalThis.Error) {
      let L = `retrying, ${X} attempts remaining`;
      if (Q.signal?.aborted) throw new T$();
      let j = a6(O) || /timed? ?out/i.test(String(O) + ("cause" in O ? String(O.cause) : ""));
      if (X) return _$(this).info(`[${U}] connection ${j ? "timed out" : "failed"} - ${L}`), _$(this).debug(`[${U}] connection ${j ? "timed out" : "failed"} (${L})`, s6({ retryOfRequestLogID: J, url: W, durationMs: N - K, message: O.message })), this.retryRequest(Q, X, J ?? U);
      if (_$(this).info(`[${U}] connection ${j ? "timed out" : "failed"} - error; no more retries left`), _$(this).debug(`[${U}] connection ${j ? "timed out" : "failed"} (error; no more retries left)`, s6({ retryOfRequestLogID: J, url: W, durationMs: N - K, message: O.message })), j) throw new XX();
      throw new $1({ cause: O });
    }
    let w = [...O.headers.entries()].filter(([L]) => L === "request-id").map(([L, j]) => ", " + L + ": " + JSON.stringify(j)).join(""), B = `[${U}${H}${w}] ${z.method} ${W} ${O.ok ? "succeeded" : "failed"} with status ${O.status} in ${N - K}ms`;
    if (!O.ok) {
      let L = await this.shouldRetry(O);
      if (X && L) {
        let B$ = `retrying, ${X} attempts remaining`;
        return await CH(O.body), _$(this).info(`${B} - ${B$}`), _$(this).debug(`[${U}] response error (${B$})`, s6({ retryOfRequestLogID: J, url: O.url, status: O.status, headers: O.headers, durationMs: N - K })), this.retryRequest(Q, X, J ?? U, O.headers);
      }
      let j = L ? "error; no more retries left" : "error; not retryable";
      _$(this).info(`${B} - ${j}`);
      let M = await O.text().catch((B$) => $X(B$).message), b = s9(M), x = b ? void 0 : M;
      throw _$(this).debug(`[${U}] response error (${j})`, s6({ retryOfRequestLogID: J, url: O.url, status: O.status, headers: O.headers, message: x, durationMs: Date.now() - K })), this.makeStatusError(O.status, b, x, O.headers);
    }
    return _$(this).info(B), _$(this).debug(`[${U}] response start`, s6({ retryOfRequestLogID: J, url: O.url, status: O.status, headers: O.headers, durationMs: N - K })), { response: O, options: Q, controller: V, requestLogID: U, retryOfRequestLogID: J, startTime: K };
  }
  getAPIList($, X, J) {
    return this.requestAPIList(X, J && "then" in J ? J.then((Q) => ({ method: "get", path: $, ...Q })) : { method: "get", path: $, ...J });
  }
  requestAPIList($, X) {
    let J = this.makeRequest(X, null, void 0);
    return new QJ(this, J, $);
  }
  async fetchWithTimeout($, X, J, Q) {
    let { signal: Y, method: z, ...W } = X || {}, G = this._makeAbort(Q);
    if (Y) Y.addEventListener("abort", G, { once: true });
    let U = setTimeout(G, J), H = globalThis.ReadableStream && W.body instanceof globalThis.ReadableStream || typeof W.body === "object" && W.body !== null && Symbol.asyncIterator in W.body, K = { signal: Q.signal, ...H ? { duplex: "half" } : {}, method: "GET", ...W };
    if (z) K.method = z.toUpperCase();
    try {
      return await this.fetch.call(void 0, $, K);
    } finally {
      clearTimeout(U);
    }
  }
  async shouldRetry($) {
    let X = $.headers.get("x-should-retry");
    if (X === "true") return true;
    if (X === "false") return false;
    if ($.status === 408) return true;
    if ($.status === 409) return true;
    if ($.status === 429) return true;
    if ($.status >= 500) return true;
    return false;
  }
  async retryRequest($, X, J, Q) {
    let Y, z = Q?.get("retry-after-ms");
    if (z) {
      let G = parseFloat(z);
      if (!Number.isNaN(G)) Y = G;
    }
    let W = Q?.get("retry-after");
    if (W && !Y) {
      let G = parseFloat(W);
      if (!Number.isNaN(G)) Y = G * 1e3;
      else Y = Date.parse(W) - Date.now();
    }
    if (!(Y && 0 <= Y && Y < 6e4)) {
      let G = $.maxRetries ?? this.maxRetries;
      Y = this.calculateDefaultRetryTimeoutMillis(X, G);
    }
    return await bH(Y), this.makeRequest($, X - 1, J);
  }
  calculateDefaultRetryTimeoutMillis($, X) {
    let Y = X - $, z = Math.min(0.5 * Math.pow(2, Y), 8), W = 1 - Math.random() * 0.25;
    return z * W * 1e3;
  }
  calculateNonstreamingTimeout($, X) {
    if (36e5 * $ / 128e3 > 6e5 || X != null && $ > X) throw new T("Streaming is required for operations that may take longer than 10 minutes. See https://github.com/anthropics/anthropic-sdk-typescript#long-requests for more details");
    return 6e5;
  }
  async buildRequest($, { retryCount: X = 0 } = {}) {
    let J = { ...$ }, { method: Q, path: Y, query: z, defaultBaseURL: W } = J, G = this.buildURL(Y, z, W);
    if ("timeout" in J) AH("timeout", J.timeout);
    J.timeout = J.timeout ?? this.timeout;
    let { bodyHeaders: U, body: H } = this.buildBody({ options: J }), K = await this.buildHeaders({ options: $, method: Q, bodyHeaders: U, retryCount: X });
    return { req: { method: Q, headers: K, ...J.signal && { signal: J.signal }, ...globalThis.ReadableStream && H instanceof globalThis.ReadableStream && { duplex: "half" }, ...H && { body: H }, ...this.fetchOptions ?? {}, ...J.fetchOptions ?? {} }, url: G, timeout: J.timeout };
  }
  async buildHeaders({ options: $, method: X, bodyHeaders: J, retryCount: Q }) {
    let Y = {};
    if (this.idempotencyHeader && X !== "get") {
      if (!$.idempotencyKey) $.idempotencyKey = this.defaultIdempotencyKey();
      Y[this.idempotencyHeader] = $.idempotencyKey;
    }
    let z = n([Y, { Accept: "application/json", "User-Agent": this.getUserAgent(), "X-Stainless-Retry-Count": String(Q), ...$.timeout ? { "X-Stainless-Timeout": String(Math.trunc($.timeout / 1e3)) } : {}, ...SH(), ...this._options.dangerouslyAllowBrowser ? { "anthropic-dangerous-direct-browser-access": "true" } : void 0, "anthropic-version": "2023-06-01" }, await this.authHeaders($), this._options.defaultHeaders, J, $.headers]);
    return this.validateHeaders(z), z.values;
  }
  _makeAbort($) {
    return () => $.abort();
  }
  buildBody({ options: { body: $, headers: X } }) {
    if (!$) return { bodyHeaders: void 0, body: void 0 };
    let J = n([X]);
    if (ArrayBuffer.isView($) || $ instanceof ArrayBuffer || $ instanceof DataView || typeof $ === "string" && J.values.has("content-type") || globalThis.Blob && $ instanceof globalThis.Blob || $ instanceof FormData || $ instanceof URLSearchParams || globalThis.ReadableStream && $ instanceof globalThis.ReadableStream) return { bodyHeaders: void 0, body: $ };
    else if (typeof $ === "object" && (Symbol.asyncIterator in $ || Symbol.iterator in $ && "next" in $ && typeof $.next === "function")) return { bodyHeaders: void 0, body: e9($) };
    else return D(this, AJ, "f").call(this, { body: $, headers: J });
  }
};
vz = P$, AJ = /* @__PURE__ */ new WeakMap(), Sz = /* @__PURE__ */ new WeakSet(), KK = function() {
  return this.baseURL !== "https://api.anthropic.com";
};
P$.Anthropic = vz;
P$.HUMAN_PROMPT = NK;
P$.AI_PROMPT = VK;
P$.DEFAULT_TIMEOUT = 6e5;
P$.AnthropicError = T;
P$.APIError = v$;
P$.APIConnectionError = $1;
P$.APIConnectionTimeoutError = XX;
P$.APIUserAbortError = T$;
P$.NotFoundError = zX;
P$.ConflictError = WX;
P$.RateLimitError = UX;
P$.BadRequestError = JX;
P$.AuthenticationError = YX;
P$.InternalServerError = HX;
P$.PermissionDeniedError = QX;
P$.UnprocessableEntityError = GX;
P$.toFile = zJ;
var G1 = class extends P$ {
  constructor() {
    super(...arguments);
    this.completions = new $0(this), this.messages = new W1(this), this.models = new J0(this), this.beta = new f6(this);
  }
};
G1.Completions = $0;
G1.Messages = W1;
G1.Models = J0;
G1.Beta = f6;
function U1($) {
  if ($ && typeof $ === "object" && "code" in $ && typeof $.code === "string") return $.code;
  return;
}
function wK($) {
  return U1($) === "ENOENT";
}
var hF = { cwd() {
  return process.cwd();
}, existsSync($) {
  let J = [];
  try {
    const X = N$(J, b$`fs.existsSync(${$})`, 0);
    return r.existsSync($);
  } catch (Q) {
    var Y = Q, z = 1;
  } finally {
    V$(J, Y, z);
  }
}, async stat($) {
  return CF($);
}, async readdir($) {
  return kF($, { withFileTypes: true });
}, async unlink($) {
  return _F($);
}, async rmdir($) {
  return xF($);
}, async rm($, X) {
  return TF($, X);
}, async mkdir($, X) {
  try {
    await yF($, { recursive: true, ...X });
  } catch (J) {
    if (U1(J) !== "EEXIST") throw J;
  }
}, async readFile($, X) {
  return BK($, { encoding: X.encoding });
}, async rename($, X) {
  return gF($, X);
}, statSync($) {
  let J = [];
  try {
    const X = N$(J, b$`fs.statSync(${$})`, 0);
    return r.statSync($);
  } catch (Q) {
    var Y = Q, z = 1;
  } finally {
    V$(J, Y, z);
  }
}, lstatSync($) {
  let J = [];
  try {
    const X = N$(J, b$`fs.lstatSync(${$})`, 0);
    return r.lstatSync($);
  } catch (Q) {
    var Y = Q, z = 1;
  } finally {
    V$(J, Y, z);
  }
}, readFileSync($, X) {
  let Q = [];
  try {
    const J = N$(Q, b$`fs.readFileSync(${$})`, 0);
    return r.readFileSync($, { encoding: X.encoding });
  } catch (Y) {
    var z = Y, W = 1;
  } finally {
    V$(Q, z, W);
  }
}, readFileBytesSync($) {
  let J = [];
  try {
    const X = N$(J, b$`fs.readFileBytesSync(${$})`, 0);
    return r.readFileSync($);
  } catch (Q) {
    var Y = Q, z = 1;
  } finally {
    V$(J, Y, z);
  }
}, readSync($, X) {
  let Y = [];
  try {
    const J = N$(Y, b$`fs.readSync(${$}, ${X.length} bytes)`, 0);
    let Q = void 0;
    try {
      Q = r.openSync($, "r");
      let U = Buffer.alloc(X.length), H = r.readSync(Q, U, 0, X.length, 0);
      return { buffer: U, bytesRead: H };
    } finally {
      if (Q) r.closeSync(Q);
    }
  } catch (z) {
    var W = z, G = 1;
  } finally {
    V$(Y, W, G);
  }
}, appendFileSync($, X, J) {
  let Y = [];
  try {
    const Q = N$(Y, b$`fs.appendFileSync(${$}, ${X.length} chars)`, 0);
    if (J?.mode !== void 0) try {
      let U = r.openSync($, "ax", J.mode);
      try {
        r.appendFileSync(U, X);
      } finally {
        r.closeSync(U);
      }
      return;
    } catch (U) {
      if (U1(U) !== "EEXIST") throw U;
    }
    r.appendFileSync($, X);
  } catch (z) {
    var W = z, G = 1;
  } finally {
    V$(Y, W, G);
  }
}, copyFileSync($, X) {
  let Q = [];
  try {
    const J = N$(Q, b$`fs.copyFileSync(${$} → ${X})`, 0);
    r.copyFileSync($, X);
  } catch (Y) {
    var z = Y, W = 1;
  } finally {
    V$(Q, z, W);
  }
}, unlinkSync($) {
  let J = [];
  try {
    const X = N$(J, b$`fs.unlinkSync(${$})`, 0);
    r.unlinkSync($);
  } catch (Q) {
    var Y = Q, z = 1;
  } finally {
    V$(J, Y, z);
  }
}, renameSync($, X) {
  let Q = [];
  try {
    const J = N$(Q, b$`fs.renameSync(${$} → ${X})`, 0);
    r.renameSync($, X);
  } catch (Y) {
    var z = Y, W = 1;
  } finally {
    V$(Q, z, W);
  }
}, linkSync($, X) {
  let Q = [];
  try {
    const J = N$(Q, b$`fs.linkSync(${$} → ${X})`, 0);
    r.linkSync($, X);
  } catch (Y) {
    var z = Y, W = 1;
  } finally {
    V$(Q, z, W);
  }
}, symlinkSync($, X, J) {
  let Y = [];
  try {
    const Q = N$(Y, b$`fs.symlinkSync(${$} → ${X})`, 0);
    r.symlinkSync($, X, J);
  } catch (z) {
    var W = z, G = 1;
  } finally {
    V$(Y, W, G);
  }
}, readlinkSync($) {
  let J = [];
  try {
    const X = N$(J, b$`fs.readlinkSync(${$})`, 0);
    return r.readlinkSync($);
  } catch (Q) {
    var Y = Q, z = 1;
  } finally {
    V$(J, Y, z);
  }
}, realpathSync($) {
  let J = [];
  try {
    const X = N$(J, b$`fs.realpathSync(${$})`, 0);
    return r.realpathSync($).normalize("NFC");
  } catch (Q) {
    var Y = Q, z = 1;
  } finally {
    V$(J, Y, z);
  }
}, mkdirSync($, X) {
  let Y = [];
  try {
    const J = N$(Y, b$`fs.mkdirSync(${$})`, 0);
    let Q = { recursive: true };
    if (X?.mode !== void 0) Q.mode = X.mode;
    try {
      r.mkdirSync($, Q);
    } catch (U) {
      if (U1(U) !== "EEXIST") throw U;
    }
  } catch (z) {
    var W = z, G = 1;
  } finally {
    V$(Y, W, G);
  }
}, readdirSync($) {
  let J = [];
  try {
    const X = N$(J, b$`fs.readdirSync(${$})`, 0);
    return r.readdirSync($, { withFileTypes: true });
  } catch (Q) {
    var Y = Q, z = 1;
  } finally {
    V$(J, Y, z);
  }
}, readdirStringSync($) {
  let J = [];
  try {
    const X = N$(J, b$`fs.readdirStringSync(${$})`, 0);
    return r.readdirSync($);
  } catch (Q) {
    var Y = Q, z = 1;
  } finally {
    V$(J, Y, z);
  }
}, isDirEmptySync($) {
  let Q = [];
  try {
    const X = N$(Q, b$`fs.isDirEmptySync(${$})`, 0);
    let J = this.readdirSync($);
    return J.length === 0;
  } catch (Y) {
    var z = Y, W = 1;
  } finally {
    V$(Q, z, W);
  }
}, rmdirSync($) {
  let J = [];
  try {
    const X = N$(J, b$`fs.rmdirSync(${$})`, 0);
    r.rmdirSync($);
  } catch (Q) {
    var Y = Q, z = 1;
  } finally {
    V$(J, Y, z);
  }
}, rmSync($, X) {
  let Q = [];
  try {
    const J = N$(Q, b$`fs.rmSync(${$})`, 0);
    r.rmSync($, X);
  } catch (Y) {
    var z = Y, W = 1;
  } finally {
    V$(Q, z, W);
  }
}, createWriteStream($) {
  return r.createWriteStream($);
}, async readFileBytes($, X) {
  if (X === void 0) return BK($);
  let J = await fF($, "r");
  try {
    let { size: Q } = await J.stat(), Y = Math.min(Q, X), z = Buffer.allocUnsafe(Y), W = 0;
    while (W < Y) {
      let { bytesRead: G } = await J.read(z, W, Y - W, W);
      if (G === 0) break;
      W += G;
    }
    return W < Y ? z.subarray(0, W) : z;
  } finally {
    await J.close();
  }
} };
var uF = hF;
function Cz() {
  return uF;
}
function mF($, X) {
  if ($.destroyed) return;
  $.write(X);
}
function qK($) {
  mF(process.stderr, $);
}
var _z = { verbose: 0, debug: 1, info: 2, warn: 3, error: 4 };
var nF = b6(() => {
  let $ = process.env.CLAUDE_CODE_DEBUG_LOG_LEVEL?.toLowerCase().trim();
  if ($ && Object.hasOwn(_z, $)) return $;
  return "debug";
});
var dF = false;
var xz = b6(() => {
  return dF || e0(process.env.DEBUG) || e0(process.env.DEBUG_SDK) || process.argv.includes("--debug") || process.argv.includes("-d") || jK() || process.argv.some(($) => $.startsWith("--debug=")) || FK() !== null;
});
var rF = b6(() => {
  let $ = process.argv.find((J) => J.startsWith("--debug="));
  if (!$) return null;
  let X = $.substring(8);
  return LH(X);
});
var jK = b6(() => {
  return process.argv.includes("--debug-to-stderr") || process.argv.includes("-d2e");
});
var FK = b6(() => {
  for (let $ = 0; $ < process.argv.length; $++) {
    let X = process.argv[$];
    if (X.startsWith("--debug-file=")) return X.substring(13);
    if (X === "--debug-file" && $ + 1 < process.argv.length) return process.argv[$ + 1];
  }
  return null;
});
function oF($) {
  if (!xz()) return false;
  if (typeof process > "u" || typeof process.versions > "u" || typeof process.versions.node > "u") return false;
  let X = rF();
  return jH($, X);
}
var tF = false;
var bJ = null;
var kz = Promise.resolve();
async function aF($, X, J, Q) {
  if ($) await cF(X, { recursive: true }).catch(() => {
  });
  await lF(J, Q), MK();
}
function sF() {
}
function eF() {
  if (!bJ) {
    let $ = null;
    bJ = BH({ writeFn: (X) => {
      let J = IK(), Q = DK(J), Y = $ !== Q;
      if ($ = Q, xz()) {
        if (Y) try {
          Cz().mkdirSync(Q);
        } catch {
        }
        Cz().appendFileSync(J, X), MK();
        return;
      }
      kz = kz.then(aF.bind(null, Y, Q, J, X)).catch(sF);
    }, flushIntervalMs: 1e3, maxBufferSize: 100, immediateMode: xz() }), DH(async () => {
      bJ?.dispose(), await kz;
    });
  }
  return bJ;
}
function h6($, { level: X } = { level: "debug" }) {
  if (_z[X] < _z[nF()]) return;
  if (!oF($)) return;
  if (tF && $.includes(`
`)) $ = q$($);
  let Q = `${(/* @__PURE__ */ new Date()).toISOString()} [${X.toUpperCase()}] ${$.trim()}
`;
  if (jK()) {
    qK(Q);
    return;
  }
  eF().write(Q);
}
function IK() {
  return FK() ?? process.env.CLAUDE_CODE_DEBUG_LOGS_DIR ?? LK(i1(), "debug", `${wH()}.txt`);
}
var MK = b6(async () => {
  try {
    let $ = IK(), X = DK($), J = LK(X, "latest");
    await iF(J).catch(() => {
    }), await pF($, J);
  } catch {
  }
});
var _u = (() => {
  let $ = process.env.CLAUDE_CODE_SLOW_OPERATION_THRESHOLD_MS;
  if ($ !== void 0) {
    let X = Number($);
    if (!Number.isNaN(X) && X >= 0) return X;
  }
  return 1 / 0;
})();
var $I = { [Symbol.dispose]() {
} };
function XI() {
  return $I;
}
var b$ = XI;
function q$($, X, J) {
  let Y = [];
  try {
    const Q = N$(Y, b$`JSON.stringify(${$})`, 0);
    return JSON.stringify($, X, J);
  } catch (z) {
    var W = z, G = 1;
  } finally {
    V$(Y, W, G);
  }
}
var u6 = ($, X) => {
  let Q = [];
  try {
    const J = N$(Q, b$`JSON.parse(${$})`, 0);
    return typeof X > "u" ? JSON.parse($) : JSON.parse($, X);
  } catch (Y) {
    var z = Y, W = 1;
  } finally {
    V$(Q, z, W);
  }
};
function JI($) {
  let X = $.trim();
  return X.startsWith("{") && X.endsWith("}");
}
function AK($, X) {
  let J = { ...$ };
  if (X) {
    let Q = J.settings;
    if (Q && !JI(Q)) throw Error("Cannot use both a settings file path and the sandbox option. Include the sandbox configuration in your settings file instead.");
    let Y = { sandbox: X };
    if (Q) try {
      Y = { ...u6(Q), sandbox: X };
    } catch {
    }
    J.settings = q$(Y);
  }
  return J;
}
var zI = 2e3;
var lX = class {
  options;
  process;
  processStdin;
  processStdout;
  ready = false;
  abortController;
  exitError;
  exitListeners = [];
  processExitHandler;
  abortHandler;
  constructor($) {
    this.options = $;
    this.abortController = $.abortController || g1(), this.initialize();
  }
  getDefaultExecutable() {
    return f1() ? "bun" : "node";
  }
  spawnLocalProcess($) {
    let { command: X, args: J, cwd: Q, env: Y, signal: z } = $, W = Y.DEBUG_CLAUDE_AGENT_SDK || this.options.stderr ? "pipe" : "ignore", G = YI(X, J, { cwd: Q, stdio: ["pipe", "pipe", W], signal: z, env: Y, windowsHide: true });
    if (Y.DEBUG_CLAUDE_AGENT_SDK || this.options.stderr) G.stderr.on("data", (H) => {
      let K = H.toString();
      if (V6(K), this.options.stderr) this.options.stderr(K);
    });
    return { stdin: G.stdin, stdout: G.stdout, get killed() {
      return G.killed;
    }, get exitCode() {
      return G.exitCode;
    }, kill: G.kill.bind(G), on: G.on.bind(G), once: G.once.bind(G), off: G.off.bind(G) };
  }
  initialize() {
    try {
      let { additionalDirectories: $ = [], agent: X, betas: J, cwd: Q, executable: Y = this.getDefaultExecutable(), executableArgs: z = [], extraArgs: W = {}, pathToClaudeCodeExecutable: G, env: U = { ...process.env }, thinkingConfig: H, maxTurns: K, maxBudgetUsd: V, taskBudget: O, model: N, fallbackModel: w, jsonSchema: B, permissionMode: L, allowDangerouslySkipPermissions: j, permissionPromptToolName: M, continueConversation: b, resume: x, settingSources: h, allowedTools: B$ = [], disallowedTools: x$ = [], tools: Q6, mcpServers: r6, strictMcpConfig: g6, canUseTool: t4, includePartialMessages: k1, plugins: o6, sandbox: r0 } = this.options, p = ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"];
      if (H) switch (H.type) {
        case "enabled":
          if (H.budgetTokens === void 0) p.push("--thinking", "adaptive");
          else p.push("--max-thinking-tokens", H.budgetTokens.toString());
          break;
        case "disabled":
          p.push("--thinking", "disabled");
          break;
        case "adaptive":
          p.push("--thinking", "adaptive");
          break;
      }
      if (this.options.effort) p.push("--effort", this.options.effort);
      if (K) p.push("--max-turns", K.toString());
      if (V !== void 0) p.push("--max-budget-usd", V.toString());
      if (O) p.push("--task-budget", O.total.toString());
      if (N) p.push("--model", N);
      if (X) p.push("--agent", X);
      if (J && J.length > 0) p.push("--betas", J.join(","));
      if (B) p.push("--json-schema", q$(B));
      if (this.options.debugFile) p.push("--debug-file", this.options.debugFile);
      else if (this.options.debug) p.push("--debug");
      if (U.DEBUG_CLAUDE_AGENT_SDK) p.push("--debug-to-stderr");
      if (t4) {
        if (M) throw Error("canUseTool callback cannot be used with permissionPromptToolName. Please use one or the other.");
        p.push("--permission-prompt-tool", "stdio");
      } else if (M) p.push("--permission-prompt-tool", M);
      if (b) p.push("--continue");
      if (x) p.push("--resume", x);
      if (this.options.proactive) p.push("--proactive");
      if (this.options.assistant) p.push("--assistant");
      if (this.options.channels && this.options.channels.length > 0) p.push("--channels", ...this.options.channels);
      if (B$.length > 0) p.push("--allowedTools", B$.join(","));
      if (x$.length > 0) p.push("--disallowedTools", x$.join(","));
      if (Q6 !== void 0) if (Array.isArray(Q6)) if (Q6.length === 0) p.push("--tools", "");
      else p.push("--tools", Q6.join(","));
      else p.push("--tools", "default");
      if (r6 && Object.keys(r6).length > 0) p.push("--mcp-config", q$({ mcpServers: r6 }));
      if (h) p.push("--setting-sources", h.join(","));
      if (g6) p.push("--strict-mcp-config");
      if (L) p.push("--permission-mode", L);
      if (j) p.push("--allow-dangerously-skip-permissions");
      if (w) {
        if (N && w === N) throw Error("Fallback model cannot be the same as the main model. Please specify a different model for fallbackModel option.");
        p.push("--fallback-model", w);
      }
      if (k1) p.push("--include-partial-messages");
      for (let i$ of $) p.push("--add-dir", i$);
      if (o6 && o6.length > 0) for (let i$ of o6) if (i$.type === "local") p.push("--plugin-dir", i$.path);
      else throw Error(`Unsupported plugin type: ${i$.type}`);
      if (this.options.forkSession) p.push("--fork-session");
      if (this.options.resumeSessionAt) p.push("--resume-session-at", this.options.resumeSessionAt);
      if (this.options.sessionId) p.push("--session-id", this.options.sessionId);
      if (this.options.persistSession === false) p.push("--no-session-persistence");
      let p9 = { ...W ?? {} };
      if (this.options.settings) p9.settings = this.options.settings;
      let t7 = AK(p9, r0);
      for (let [i$, L4] of Object.entries(t7)) if (L4 === null) p.push(`--${i$}`);
      else p.push(`--${i$}`, L4);
      if (!U.CLAUDE_CODE_ENTRYPOINT) U.CLAUDE_CODE_ENTRYPOINT = "sdk-ts";
      if (delete U.NODE_OPTIONS, U.DEBUG_CLAUDE_AGENT_SDK) U.DEBUG = "1";
      else delete U.DEBUG;
      let o0 = WI(G), a4 = o0 ? G : Y, t0 = o0 ? [...z, ...p] : [...z, G, ...p], _1 = { command: a4, args: t0, cwd: Q, env: U, signal: this.abortController.signal };
      if (this.options.spawnClaudeCodeProcess) V6(`Spawning Claude Code (custom): ${a4} ${t0.join(" ")}`), this.process = this.options.spawnClaudeCodeProcess(_1);
      else V6(`Spawning Claude Code: ${a4} ${t0.join(" ")}`), this.process = this.spawnLocalProcess(_1);
      this.processStdin = this.process.stdin, this.processStdout = this.process.stdout;
      let n9 = () => {
        if (this.process && !this.process.killed) this.process.kill("SIGTERM");
      };
      this.processExitHandler = n9, this.abortHandler = n9, process.on("exit", this.processExitHandler), this.abortController.signal.addEventListener("abort", this.abortHandler), this.process.on("error", (i$) => {
        if (this.ready = false, this.abortController.signal.aborted) this.exitError = new t$("Claude Code process aborted by user");
        else if (wK(i$)) {
          let L4 = o0 ? `Claude Code native binary not found at ${G}. Please ensure Claude Code is installed via native installer or specify a valid path with options.pathToClaudeCodeExecutable.` : `Claude Code executable not found at ${G}. Is options.pathToClaudeCodeExecutable set?`;
          this.exitError = ReferenceError(L4), V6(this.exitError.message);
        } else this.exitError = Error(`Failed to spawn Claude Code process: ${i$.message}`), V6(this.exitError.message);
      }), this.process.on("exit", (i$, L4) => {
        if (this.ready = false, this.abortController.signal.aborted) this.exitError = new t$("Claude Code process aborted by user");
        else {
          let x1 = this.getProcessExitError(i$, L4);
          if (x1) this.exitError = x1, V6(x1.message);
        }
      }), this.ready = true;
    } catch ($) {
      throw this.ready = false, $;
    }
  }
  getProcessExitError($, X) {
    if ($ !== 0 && $ !== null) return Error(`Claude Code process exited with code ${$}`);
    else if (X) return Error(`Claude Code process terminated by signal ${X}`);
    return;
  }
  write($) {
    if (this.abortController.signal.aborted) throw new t$("Operation aborted");
    if (!this.ready || !this.processStdin) throw Error("ProcessTransport is not ready for writing");
    if (this.process?.killed || this.process?.exitCode !== null) throw Error("Cannot write to terminated process");
    if (this.exitError) throw Error(`Cannot write to process that exited with error: ${this.exitError.message}`);
    V6(`[ProcessTransport] Writing to stdin: ${$.substring(0, 100)}`);
    try {
      if (!this.processStdin.write($)) V6("[ProcessTransport] Write buffer full, data queued");
    } catch (X) {
      throw this.ready = false, Error(`Failed to write to process stdin: ${X.message}`);
    }
  }
  close() {
    if (this.processStdin) this.processStdin.end(), this.processStdin = void 0;
    if (this.abortHandler) this.abortController.signal.removeEventListener("abort", this.abortHandler), this.abortHandler = void 0;
    for (let { handler: X } of this.exitListeners) this.process?.off("exit", X);
    this.exitListeners = [];
    let $ = this.process;
    if ($ && !$.killed && $.exitCode === null) setTimeout((X) => {
      if (X.killed || X.exitCode !== null) return;
      X.kill("SIGTERM"), setTimeout((J) => {
        if (J.exitCode === null) J.kill("SIGKILL");
      }, 5e3, X).unref();
    }, zI, $).unref(), $.once("exit", () => {
      if (this.processExitHandler) process.off("exit", this.processExitHandler), this.processExitHandler = void 0;
    });
    else if (this.processExitHandler) process.off("exit", this.processExitHandler), this.processExitHandler = void 0;
    this.ready = false;
  }
  isReady() {
    return this.ready;
  }
  async *readMessages() {
    if (!this.processStdout) throw Error("ProcessTransport output stream not available");
    let $ = QI({ input: this.processStdout });
    try {
      for await (let X of $) if (X.trim()) try {
        yield u6(X);
      } catch (J) {
        throw V6(`Non-JSON stdout: ${X}`), Error(`CLI output was not valid JSON. This may indicate an error during startup. Output: ${X.slice(0, 200)}${X.length > 200 ? "..." : ""}`);
      }
      await this.waitForExit();
    } catch (X) {
      throw X;
    } finally {
      $.close();
    }
  }
  endInput() {
    if (this.processStdin) this.processStdin.end();
  }
  getInputStream() {
    return this.processStdin;
  }
  onExit($) {
    if (!this.process) return () => {
    };
    let X = (J, Q) => {
      let Y = this.getProcessExitError(J, Q);
      $(Y);
    };
    return this.process.on("exit", X), this.exitListeners.push({ callback: $, handler: X }), () => {
      if (this.process) this.process.off("exit", X);
      let J = this.exitListeners.findIndex((Q) => Q.handler === X);
      if (J !== -1) this.exitListeners.splice(J, 1);
    };
  }
  async waitForExit() {
    if (!this.process) {
      if (this.exitError) throw this.exitError;
      return;
    }
    if (this.process.exitCode !== null || this.process.killed) {
      if (this.exitError) throw this.exitError;
      return;
    }
    return new Promise(($, X) => {
      let J = (Y, z) => {
        if (this.abortController.signal.aborted) {
          X(new t$("Operation aborted"));
          return;
        }
        let W = this.getProcessExitError(Y, z);
        if (W) X(W);
        else $();
      };
      this.process.once("exit", J);
      let Q = (Y) => {
        this.process.off("exit", J), X(Y);
      };
      this.process.once("error", Q), this.process.once("exit", () => {
        this.process.off("error", Q);
      });
    });
  }
};
function WI($) {
  return ![".js", ".mjs", ".tsx", ".ts", ".jsx"].some((J) => $.endsWith(J));
}
var H1 = class {
  returned;
  queue = [];
  readResolve;
  readReject;
  isDone = false;
  hasError;
  started = false;
  constructor($) {
    this.returned = $;
  }
  [Symbol.asyncIterator]() {
    if (this.started) throw Error("Stream can only be iterated once");
    return this.started = true, this;
  }
  next() {
    if (this.queue.length > 0) return Promise.resolve({ done: false, value: this.queue.shift() });
    if (this.isDone) return Promise.resolve({ done: true, value: void 0 });
    if (this.hasError) return Promise.reject(this.hasError);
    return new Promise(($, X) => {
      this.readResolve = $, this.readReject = X;
    });
  }
  enqueue($) {
    if (this.readResolve) {
      let X = this.readResolve;
      this.readResolve = void 0, this.readReject = void 0, X({ done: false, value: $ });
    } else this.queue.push($);
  }
  done() {
    if (this.isDone = true, this.readResolve) {
      let $ = this.readResolve;
      this.readResolve = void 0, this.readReject = void 0, $({ done: true, value: void 0 });
    }
  }
  error($) {
    if (this.hasError = $, this.readReject) {
      let X = this.readReject;
      this.readResolve = void 0, this.readReject = void 0, X($);
    }
  }
  return() {
    if (this.isDone = true, this.returned) this.returned();
    return Promise.resolve({ done: true, value: void 0 });
  }
};
var Tz = class {
  sendMcpMessage;
  isClosed = false;
  constructor($) {
    this.sendMcpMessage = $;
  }
  onclose;
  onerror;
  onmessage;
  async start() {
  }
  async send($) {
    if (this.isClosed) throw Error("Transport is closed");
    this.sendMcpMessage($);
  }
  async close() {
    if (this.isClosed) return;
    this.isClosed = true, this.onclose?.();
  }
};
var cX = class {
  transport;
  isSingleUserTurn;
  canUseTool;
  hooks;
  abortController;
  jsonSchema;
  initConfig;
  onElicitation;
  pendingControlResponses = /* @__PURE__ */ new Map();
  cleanupPerformed = false;
  sdkMessages;
  inputStream = new H1();
  initialization;
  cancelControllers = /* @__PURE__ */ new Map();
  hookCallbacks = /* @__PURE__ */ new Map();
  nextCallbackId = 0;
  sdkMcpTransports = /* @__PURE__ */ new Map();
  sdkMcpServerInstances = /* @__PURE__ */ new Map();
  pendingMcpResponses = /* @__PURE__ */ new Map();
  firstResultReceivedResolve;
  firstResultReceived = false;
  lastErrorResultText;
  hasBidirectionalNeeds() {
    return this.sdkMcpTransports.size > 0 || this.hooks !== void 0 && Object.keys(this.hooks).length > 0 || this.canUseTool !== void 0 || this.onElicitation !== void 0;
  }
  constructor($, X, J, Q, Y, z = /* @__PURE__ */ new Map(), W, G, U) {
    this.transport = $;
    this.isSingleUserTurn = X;
    this.canUseTool = J;
    this.hooks = Q;
    this.abortController = Y;
    this.jsonSchema = W;
    this.initConfig = G;
    this.onElicitation = U;
    for (let [H, K] of z) this.connectSdkMcpServer(H, K);
    this.sdkMessages = this.readSdkMessages(), this.readMessages(), this.initialization = this.initialize(), this.initialization.catch(() => {
    });
  }
  setError($) {
    this.inputStream.error($);
  }
  async stopTask($) {
    await this.request({ subtype: "stop_task", task_id: $ });
  }
  close() {
    this.cleanup();
  }
  cleanup($) {
    if (this.cleanupPerformed) return;
    this.cleanupPerformed = true;
    try {
      this.transport.close();
      let X = Error("Query closed before response received");
      for (let { reject: J } of this.pendingControlResponses.values()) J(X);
      this.pendingControlResponses.clear();
      for (let { reject: J } of this.pendingMcpResponses.values()) J(X);
      this.pendingMcpResponses.clear(), this.cancelControllers.clear(), this.hookCallbacks.clear();
      for (let J of this.sdkMcpTransports.values()) try {
        J.close();
      } catch {
      }
      if (this.sdkMcpTransports.clear(), $) this.inputStream.error($);
      else this.inputStream.done();
    } catch (X) {
    }
  }
  next(...[$]) {
    return this.sdkMessages.next(...[$]);
  }
  return($) {
    return this.sdkMessages.return($);
  }
  throw($) {
    return this.sdkMessages.throw($);
  }
  [Symbol.asyncIterator]() {
    return this.sdkMessages;
  }
  [Symbol.asyncDispose]() {
    return this.sdkMessages[Symbol.asyncDispose]();
  }
  async readMessages() {
    try {
      for await (let $ of this.transport.readMessages()) {
        if ($.type === "control_response") {
          let X = this.pendingControlResponses.get($.response.request_id);
          if (X) X.handler($.response);
          continue;
        } else if ($.type === "control_request") {
          this.handleControlRequest($);
          continue;
        } else if ($.type === "control_cancel_request") {
          this.handleControlCancelRequest($);
          continue;
        } else if ($.type === "keep_alive") continue;
        if ($.type === "streamlined_text" || $.type === "streamlined_tool_use_summary") continue;
        if ($.type === "result") {
          if (this.lastErrorResultText = $.is_error ? $.subtype === "success" ? $.result : $.errors.join("; ") : void 0, this.firstResultReceived = true, this.firstResultReceivedResolve) this.firstResultReceivedResolve();
          if (this.isSingleUserTurn) h6("[Query.readMessages] First result received for single-turn query, closing stdin"), this.transport.endInput();
        } else if (!($.type === "system" && $.subtype === "session_state_changed")) this.lastErrorResultText = void 0;
        this.inputStream.enqueue($);
      }
      if (this.firstResultReceivedResolve) this.firstResultReceivedResolve();
      this.inputStream.done(), this.cleanup();
    } catch ($) {
      if (this.firstResultReceivedResolve) this.firstResultReceivedResolve();
      if (this.lastErrorResultText !== void 0 && !($ instanceof t$)) {
        let X = Error(`Claude Code returned an error result: ${this.lastErrorResultText}`);
        h6(`[Query.readMessages] Replacing exit error with result text. Original: ${$.message}`), this.inputStream.error(X), this.cleanup(X);
        return;
      }
      this.inputStream.error($), this.cleanup($);
    }
  }
  async handleControlRequest($) {
    let X = new AbortController();
    this.cancelControllers.set($.request_id, X);
    try {
      let J = await this.processControlRequest($, X.signal), Q = { type: "control_response", response: { subtype: "success", request_id: $.request_id, response: J } };
      await Promise.resolve(this.transport.write(q$(Q) + `
`));
    } catch (J) {
      let Q = { type: "control_response", response: { subtype: "error", request_id: $.request_id, error: J.message || String(J) } };
      await Promise.resolve(this.transport.write(q$(Q) + `
`));
    } finally {
      this.cancelControllers.delete($.request_id);
    }
  }
  handleControlCancelRequest($) {
    let X = this.cancelControllers.get($.request_id);
    if (X) X.abort(), this.cancelControllers.delete($.request_id);
  }
  async processControlRequest($, X) {
    if ($.request.subtype === "can_use_tool") {
      if (!this.canUseTool) throw Error("canUseTool callback is not provided.");
      return { ...await this.canUseTool($.request.tool_name, $.request.input, { signal: X, suggestions: $.request.permission_suggestions, blockedPath: $.request.blocked_path, decisionReason: $.request.decision_reason, title: $.request.title, displayName: $.request.display_name, description: $.request.description, toolUseID: $.request.tool_use_id, agentID: $.request.agent_id }), toolUseID: $.request.tool_use_id };
    } else if ($.request.subtype === "hook_callback") return await this.handleHookCallbacks($.request.callback_id, $.request.input, $.request.tool_use_id, X);
    else if ($.request.subtype === "mcp_message") {
      let J = $.request, Q = this.sdkMcpTransports.get(J.server_name);
      if (!Q) throw Error(`SDK MCP server not found: ${J.server_name}`);
      if ("method" in J.message && "id" in J.message && J.message.id !== null) return { mcp_response: await this.handleMcpControlRequest(J.server_name, J, Q) };
      else {
        if (Q.onmessage) Q.onmessage(J.message);
        return { mcp_response: { jsonrpc: "2.0", result: {}, id: 0 } };
      }
    } else if ($.request.subtype === "elicitation") {
      let J = $.request;
      if (this.onElicitation) return await this.onElicitation({ serverName: J.mcp_server_name, message: J.message, mode: J.mode, url: J.url, elicitationId: J.elicitation_id, requestedSchema: J.requested_schema }, { signal: X });
      return { action: "decline" };
    }
    throw Error("Unsupported control request subtype: " + $.request.subtype);
  }
  async *readSdkMessages() {
    for await (let $ of this.inputStream) yield $;
  }
  async initialize() {
    let $;
    if (this.hooks) {
      $ = {};
      for (let [Y, z] of Object.entries(this.hooks)) if (z.length > 0) $[Y] = z.map((W) => {
        let G = [];
        for (let U of W.hooks) {
          let H = `hook_${this.nextCallbackId++}`;
          this.hookCallbacks.set(H, U), G.push(H);
        }
        return { matcher: W.matcher, hookCallbackIds: G, timeout: W.timeout };
      });
    }
    let X = this.sdkMcpTransports.size > 0 ? Array.from(this.sdkMcpTransports.keys()) : void 0, J = { subtype: "initialize", hooks: $, sdkMcpServers: X, jsonSchema: this.jsonSchema, systemPrompt: this.initConfig?.systemPrompt, appendSystemPrompt: this.initConfig?.appendSystemPrompt, agents: this.initConfig?.agents, promptSuggestions: this.initConfig?.promptSuggestions, agentProgressSummaries: this.initConfig?.agentProgressSummaries };
    return (await this.request(J)).response;
  }
  async interrupt() {
    await this.request({ subtype: "interrupt" });
  }
  async setPermissionMode($) {
    await this.request({ subtype: "set_permission_mode", mode: $ });
  }
  async setModel($) {
    await this.request({ subtype: "set_model", model: $ });
  }
  async setMaxThinkingTokens($) {
    await this.request({ subtype: "set_max_thinking_tokens", max_thinking_tokens: $ });
  }
  async applyFlagSettings($) {
    await this.request({ subtype: "apply_flag_settings", settings: $ });
  }
  async getSettings() {
    return (await this.request({ subtype: "get_settings" })).response;
  }
  async rewindFiles($, X) {
    return (await this.request({ subtype: "rewind_files", user_message_id: $, dry_run: X?.dryRun })).response;
  }
  async cancelAsyncMessage($) {
    return (await this.request({ subtype: "cancel_async_message", message_uuid: $ })).response.cancelled;
  }
  async seedReadState($, X) {
    await this.request({ subtype: "seed_read_state", path: $, mtime: X });
  }
  async enableRemoteControl($) {
    return (await this.request({ subtype: "remote_control", enabled: $ })).response;
  }
  async setProactive($) {
    await this.request({ subtype: "set_proactive", enabled: $ });
  }
  async generateSessionTitle($, X) {
    return (await this.request({ subtype: "generate_session_title", description: $, persist: X?.persist })).response.title;
  }
  async processPendingPermissionRequests($) {
    for (let X of $) if (X.request.subtype === "can_use_tool") this.handleControlRequest(X).catch(() => {
    });
  }
  request($) {
    let X = Math.random().toString(36).substring(2, 15), J = { request_id: X, type: "control_request", request: $ };
    return new Promise((Q, Y) => {
      this.pendingControlResponses.set(X, { handler: (z) => {
        if (this.pendingControlResponses.delete(X), z.subtype === "success") Q(z);
        else if (Y(Error(z.error)), z.pending_permission_requests) this.processPendingPermissionRequests(z.pending_permission_requests);
      }, reject: Y }), Promise.resolve(this.transport.write(q$(J) + `
`));
    });
  }
  async initializationResult() {
    return this.initialization;
  }
  async supportedCommands() {
    return (await this.initialization).commands;
  }
  async supportedModels() {
    return (await this.initialization).models;
  }
  async supportedAgents() {
    return (await this.initialization).agents;
  }
  async reconnectMcpServer($) {
    await this.request({ subtype: "mcp_reconnect", serverName: $ });
  }
  async toggleMcpServer($, X) {
    await this.request({ subtype: "mcp_toggle", serverName: $, enabled: X });
  }
  async enableChannel($) {
    await this.request({ subtype: "channel_enable", serverName: $ });
  }
  async mcpAuthenticate($) {
    return (await this.request({ subtype: "mcp_authenticate", serverName: $ })).response;
  }
  async mcpClearAuth($) {
    return (await this.request({ subtype: "mcp_clear_auth", serverName: $ })).response;
  }
  async mcpSubmitOAuthCallbackUrl($, X) {
    return (await this.request({ subtype: "mcp_oauth_callback_url", serverName: $, callbackUrl: X })).response;
  }
  async claudeAuthenticate($) {
    return (await this.request({ subtype: "claude_authenticate", loginWithClaudeAi: $ })).response;
  }
  async claudeOAuthCallback($, X) {
    return (await this.request({ subtype: "claude_oauth_callback", authorizationCode: $, state: X })).response;
  }
  async claudeOAuthWaitForCompletion() {
    return (await this.request({ subtype: "claude_oauth_wait_for_completion" })).response;
  }
  async mcpServerStatus() {
    return (await this.request({ subtype: "mcp_status" })).response.mcpServers;
  }
  async setMcpServers($) {
    let X = {}, J = {};
    for (let [G, U] of Object.entries($)) if (U.type === "sdk" && "instance" in U) X[G] = U.instance;
    else J[G] = U;
    let Q = new Set(this.sdkMcpServerInstances.keys()), Y = new Set(Object.keys(X));
    for (let G of Q) if (!Y.has(G)) await this.disconnectSdkMcpServer(G);
    for (let [G, U] of Object.entries(X)) if (!Q.has(G)) this.connectSdkMcpServer(G, U);
    let z = {};
    for (let G of Object.keys(X)) z[G] = { type: "sdk", name: G };
    return (await this.request({ subtype: "mcp_set_servers", servers: { ...J, ...z } })).response;
  }
  async accountInfo() {
    return (await this.initialization).account;
  }
  async streamInput($) {
    h6("[Query.streamInput] Starting to process input stream");
    try {
      let X = 0;
      for await (let J of $) {
        if (X++, h6(`[Query.streamInput] Processing message ${X}: ${J.type}`), this.abortController?.signal.aborted) break;
        await Promise.resolve(this.transport.write(q$(J) + `
`));
      }
      if (h6(`[Query.streamInput] Finished processing ${X} messages from input stream`), X > 0 && this.hasBidirectionalNeeds()) h6("[Query.streamInput] Has bidirectional needs, waiting for first result"), await this.waitForFirstResult();
      h6("[Query] Calling transport.endInput() to close stdin to CLI process"), this.transport.endInput();
    } catch (X) {
      if (!(X instanceof t$)) throw X;
    }
  }
  waitForFirstResult() {
    if (this.firstResultReceived) return h6("[Query.waitForFirstResult] Result already received, returning immediately"), Promise.resolve();
    return new Promise(($) => {
      if (this.abortController?.signal.aborted) {
        $();
        return;
      }
      this.abortController?.signal.addEventListener("abort", () => $(), { once: true }), this.firstResultReceivedResolve = $;
    });
  }
  handleHookCallbacks($, X, J, Q) {
    let Y = this.hookCallbacks.get($);
    if (!Y) throw Error(`No hook callback found for ID: ${$}`);
    return Y(X, J, { signal: Q });
  }
  connectSdkMcpServer($, X) {
    let J = new Tz((Q) => this.sendMcpServerMessageToCli($, Q));
    this.sdkMcpTransports.set($, J), this.sdkMcpServerInstances.set($, X), X.connect(J);
  }
  async disconnectSdkMcpServer($) {
    let X = this.sdkMcpTransports.get($);
    if (X) await X.close(), this.sdkMcpTransports.delete($);
    this.sdkMcpServerInstances.delete($);
  }
  sendMcpServerMessageToCli($, X) {
    if ("id" in X && X.id !== null && X.id !== void 0) {
      let Q = `${$}:${X.id}`, Y = this.pendingMcpResponses.get(Q);
      if (Y) {
        Y.resolve(X), this.pendingMcpResponses.delete(Q);
        return;
      }
    }
    let J = { type: "control_request", request_id: t9(), request: { subtype: "mcp_message", server_name: $, message: X } };
    this.transport.write(q$(J) + `
`);
  }
  handleMcpControlRequest($, X, J) {
    let Q = "id" in X.message ? X.message.id : null, Y = `${$}:${Q}`;
    return new Promise((z, W) => {
      let G = () => {
        this.pendingMcpResponses.delete(Y);
      }, U = (K) => {
        G(), z(K);
      }, H = (K) => {
        G(), W(K);
      };
      if (this.pendingMcpResponses.set(Y, { resolve: U, reject: H }), J.onmessage) J.onmessage(X.message);
      else {
        G(), W(Error("No message handler registered"));
        return;
      }
    });
  }
};
var UI = 5e3;
var yz = class {
  closed = false;
  inputStream;
  query;
  queryIterator = null;
  abortController;
  _sessionId = null;
  get sessionId() {
    if (this._sessionId === null) throw Error("Session ID not available until after receiving messages");
    return this._sessionId;
  }
  constructor($) {
    if ($.resume) this._sessionId = $.resume;
    this.inputStream = new H1();
    let X = $.pathToClaudeCodeExecutable;
    if (!X) {
      let Y = GI(import.meta.url), z = bK(Y, "..");
      X = bK(z, "cli.js");
    }
    let J = { ...$.env ?? process.env };
    if (!J.CLAUDE_CODE_ENTRYPOINT) J.CLAUDE_CODE_ENTRYPOINT = "sdk-ts";
    this.abortController = g1();
    let Q = new lX({ abortController: this.abortController, pathToClaudeCodeExecutable: X, env: J, executable: $.executable ?? (f1() ? "bun" : "node"), executableArgs: $.executableArgs ?? [], extraArgs: {}, thinkingConfig: void 0, maxTurns: void 0, maxBudgetUsd: void 0, model: $.model, fallbackModel: void 0, permissionMode: $.permissionMode ?? "default", allowDangerouslySkipPermissions: false, continueConversation: false, resume: $.resume, settingSources: [], allowedTools: $.allowedTools ?? [], disallowedTools: $.disallowedTools ?? [], mcpServers: {}, strictMcpConfig: false, canUseTool: !!$.canUseTool, hooks: !!$.hooks, includePartialMessages: false, forkSession: false, resumeSessionAt: void 0 });
    this.query = new cX(Q, false, $.canUseTool, $.hooks, this.abortController, /* @__PURE__ */ new Map()), this.query.streamInput(this.inputStream);
  }
  async send($) {
    if (this.closed) throw Error("Cannot send to closed session");
    let X = typeof $ === "string" ? { type: "user", session_id: "", message: { role: "user", content: [{ type: "text", text: $ }] }, parent_tool_use_id: null } : $;
    this.inputStream.enqueue(X);
  }
  async *stream() {
    if (!this.queryIterator) this.queryIterator = this.query[Symbol.asyncIterator]();
    while (true) {
      let { value: $, done: X } = await this.queryIterator.next();
      if (X) return;
      if ($.type === "system" && $.subtype === "init") this._sessionId = $.session_id;
      if (yield $, $.type === "result") return;
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true, this.inputStream.done(), setTimeout(() => {
      if (!this.abortController.signal.aborted) this.abortController.abort();
    }, UI).unref();
  }
  async [Symbol.asyncDispose]() {
    this.close();
  }
};
function gz($) {
  return new yz($);
}
function PK($, X) {
  return new yz({ ...X, resume: $ });
}
var NI = KI(HI);
var ZJ = Buffer.from('{"type":"attribution-snapshot"');
var II = Buffer.from('{"type":"system"');
var iX = 10;
var MI = Buffer.from([iX]);
var X$;
(function($) {
  $.assertEqual = (Y) => {
  };
  function X(Y) {
  }
  $.assertIs = X;
  function J(Y) {
    throw Error();
  }
  $.assertNever = J, $.arrayToEnum = (Y) => {
    let z = {};
    for (let W of Y) z[W] = W;
    return z;
  }, $.getValidEnumValues = (Y) => {
    let z = $.objectKeys(Y).filter((G) => typeof Y[Y[G]] !== "number"), W = {};
    for (let G of z) W[G] = Y[G];
    return $.objectValues(W);
  }, $.objectValues = (Y) => {
    return $.objectKeys(Y).map(function(z) {
      return Y[z];
    });
  }, $.objectKeys = typeof Object.keys === "function" ? (Y) => Object.keys(Y) : (Y) => {
    let z = [];
    for (let W in Y) if (Object.prototype.hasOwnProperty.call(Y, W)) z.push(W);
    return z;
  }, $.find = (Y, z) => {
    for (let W of Y) if (z(W)) return W;
    return;
  }, $.isInteger = typeof Number.isInteger === "function" ? (Y) => Number.isInteger(Y) : (Y) => typeof Y === "number" && Number.isFinite(Y) && Math.floor(Y) === Y;
  function Q(Y, z = " | ") {
    return Y.map((W) => typeof W === "string" ? `'${W}'` : W).join(z);
  }
  $.joinValues = Q, $.jsonStringifyReplacer = (Y, z) => {
    if (typeof z === "bigint") return z.toString();
    return z;
  };
})(X$ || (X$ = {}));
var lK;
(function($) {
  $.mergeShapes = (X, J) => {
    return { ...X, ...J };
  };
})(lK || (lK = {}));
var R = X$.arrayToEnum(["string", "nan", "number", "integer", "float", "boolean", "date", "bigint", "symbol", "function", "undefined", "null", "array", "object", "unknown", "promise", "void", "never", "map", "set"]);
var J4 = ($) => {
  switch (typeof $) {
    case "undefined":
      return R.undefined;
    case "string":
      return R.string;
    case "number":
      return Number.isNaN($) ? R.nan : R.number;
    case "boolean":
      return R.boolean;
    case "function":
      return R.function;
    case "bigint":
      return R.bigint;
    case "symbol":
      return R.symbol;
    case "object":
      if (Array.isArray($)) return R.array;
      if ($ === null) return R.null;
      if ($.then && typeof $.then === "function" && $.catch && typeof $.catch === "function") return R.promise;
      if (typeof Map < "u" && $ instanceof Map) return R.map;
      if (typeof Set < "u" && $ instanceof Set) return R.set;
      if (typeof Date < "u" && $ instanceof Date) return R.date;
      return R.object;
    default:
      return R.unknown;
  }
};
var A = X$.arrayToEnum(["invalid_type", "invalid_literal", "custom", "invalid_union", "invalid_union_discriminator", "invalid_enum_value", "unrecognized_keys", "invalid_arguments", "invalid_return_type", "invalid_date", "invalid_string", "too_small", "too_big", "invalid_intersection_types", "not_multiple_of", "not_finite"]);
var H6 = class _H6 extends Error {
  get errors() {
    return this.issues;
  }
  constructor($) {
    super();
    this.issues = [], this.addIssue = (J) => {
      this.issues = [...this.issues, J];
    }, this.addIssues = (J = []) => {
      this.issues = [...this.issues, ...J];
    };
    let X = new.target.prototype;
    if (Object.setPrototypeOf) Object.setPrototypeOf(this, X);
    else this.__proto__ = X;
    this.name = "ZodError", this.issues = $;
  }
  format($) {
    let X = $ || function(Y) {
      return Y.message;
    }, J = { _errors: [] }, Q = (Y) => {
      for (let z of Y.issues) if (z.code === "invalid_union") z.unionErrors.map(Q);
      else if (z.code === "invalid_return_type") Q(z.returnTypeError);
      else if (z.code === "invalid_arguments") Q(z.argumentsError);
      else if (z.path.length === 0) J._errors.push(X(z));
      else {
        let W = J, G = 0;
        while (G < z.path.length) {
          let U = z.path[G];
          if (G !== z.path.length - 1) W[U] = W[U] || { _errors: [] };
          else W[U] = W[U] || { _errors: [] }, W[U]._errors.push(X(z));
          W = W[U], G++;
        }
      }
    };
    return Q(this), J;
  }
  static assert($) {
    if (!($ instanceof _H6)) throw Error(`Not a ZodError: ${$}`);
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, X$.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten($ = (X) => X.message) {
    let X = {}, J = [];
    for (let Q of this.issues) if (Q.path.length > 0) {
      let Y = Q.path[0];
      X[Y] = X[Y] || [], X[Y].push($(Q));
    } else J.push($(Q));
    return { formErrors: J, fieldErrors: X };
  }
  get formErrors() {
    return this.flatten();
  }
};
H6.create = ($) => {
  return new H6($);
};
var $M = ($, X) => {
  let J;
  switch ($.code) {
    case A.invalid_type:
      if ($.received === R.undefined) J = "Required";
      else J = `Expected ${$.expected}, received ${$.received}`;
      break;
    case A.invalid_literal:
      J = `Invalid literal value, expected ${JSON.stringify($.expected, X$.jsonStringifyReplacer)}`;
      break;
    case A.unrecognized_keys:
      J = `Unrecognized key(s) in object: ${X$.joinValues($.keys, ", ")}`;
      break;
    case A.invalid_union:
      J = "Invalid input";
      break;
    case A.invalid_union_discriminator:
      J = `Invalid discriminator value. Expected ${X$.joinValues($.options)}`;
      break;
    case A.invalid_enum_value:
      J = `Invalid enum value. Expected ${X$.joinValues($.options)}, received '${$.received}'`;
      break;
    case A.invalid_arguments:
      J = "Invalid function arguments";
      break;
    case A.invalid_return_type:
      J = "Invalid function return type";
      break;
    case A.invalid_date:
      J = "Invalid date";
      break;
    case A.invalid_string:
      if (typeof $.validation === "object") if ("includes" in $.validation) {
        if (J = `Invalid input: must include "${$.validation.includes}"`, typeof $.validation.position === "number") J = `${J} at one or more positions greater than or equal to ${$.validation.position}`;
      } else if ("startsWith" in $.validation) J = `Invalid input: must start with "${$.validation.startsWith}"`;
      else if ("endsWith" in $.validation) J = `Invalid input: must end with "${$.validation.endsWith}"`;
      else X$.assertNever($.validation);
      else if ($.validation !== "regex") J = `Invalid ${$.validation}`;
      else J = "Invalid";
      break;
    case A.too_small:
      if ($.type === "array") J = `Array must contain ${$.exact ? "exactly" : $.inclusive ? "at least" : "more than"} ${$.minimum} element(s)`;
      else if ($.type === "string") J = `String must contain ${$.exact ? "exactly" : $.inclusive ? "at least" : "over"} ${$.minimum} character(s)`;
      else if ($.type === "number") J = `Number must be ${$.exact ? "exactly equal to " : $.inclusive ? "greater than or equal to " : "greater than "}${$.minimum}`;
      else if ($.type === "bigint") J = `Number must be ${$.exact ? "exactly equal to " : $.inclusive ? "greater than or equal to " : "greater than "}${$.minimum}`;
      else if ($.type === "date") J = `Date must be ${$.exact ? "exactly equal to " : $.inclusive ? "greater than or equal to " : "greater than "}${new Date(Number($.minimum))}`;
      else J = "Invalid input";
      break;
    case A.too_big:
      if ($.type === "array") J = `Array must contain ${$.exact ? "exactly" : $.inclusive ? "at most" : "less than"} ${$.maximum} element(s)`;
      else if ($.type === "string") J = `String must contain ${$.exact ? "exactly" : $.inclusive ? "at most" : "under"} ${$.maximum} character(s)`;
      else if ($.type === "number") J = `Number must be ${$.exact ? "exactly" : $.inclusive ? "less than or equal to" : "less than"} ${$.maximum}`;
      else if ($.type === "bigint") J = `BigInt must be ${$.exact ? "exactly" : $.inclusive ? "less than or equal to" : "less than"} ${$.maximum}`;
      else if ($.type === "date") J = `Date must be ${$.exact ? "exactly" : $.inclusive ? "smaller than or equal to" : "smaller than"} ${new Date(Number($.maximum))}`;
      else J = "Invalid input";
      break;
    case A.custom:
      J = "Invalid input";
      break;
    case A.invalid_intersection_types:
      J = "Intersection results could not be merged";
      break;
    case A.not_multiple_of:
      J = `Number must be a multiple of ${$.multipleOf}`;
      break;
    case A.not_finite:
      J = "Number must be finite";
      break;
    default:
      J = X.defaultError, X$.assertNever($);
  }
  return { message: J };
};
var R4 = $M;
var XM = R4;
function dX() {
  return XM;
}
var kJ = ($) => {
  let { data: X, path: J, errorMaps: Q, issueData: Y } = $, z = [...J, ...Y.path || []], W = { ...Y, path: z };
  if (Y.message !== void 0) return { ...Y, path: z, message: Y.message };
  let G = "", U = Q.filter((H) => !!H).slice().reverse();
  for (let H of U) G = H(W, { data: X, defaultError: G }).message;
  return { ...Y, path: z, message: G };
};
function C($, X) {
  let J = dX(), Q = kJ({ issueData: X, data: $.data, path: $.path, errorMaps: [$.common.contextualErrorMap, $.schemaErrorMap, J, J === R4 ? void 0 : R4].filter((Y) => !!Y) });
  $.common.issues.push(Q);
}
var u$ = class _u$ {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid") this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted") this.value = "aborted";
  }
  static mergeArray($, X) {
    let J = [];
    for (let Q of X) {
      if (Q.status === "aborted") return l;
      if (Q.status === "dirty") $.dirty();
      J.push(Q.value);
    }
    return { status: $.value, value: J };
  }
  static async mergeObjectAsync($, X) {
    let J = [];
    for (let Q of X) {
      let Y = await Q.key, z = await Q.value;
      J.push({ key: Y, value: z });
    }
    return _u$.mergeObjectSync($, J);
  }
  static mergeObjectSync($, X) {
    let J = {};
    for (let Q of X) {
      let { key: Y, value: z } = Q;
      if (Y.status === "aborted") return l;
      if (z.status === "aborted") return l;
      if (Y.status === "dirty") $.dirty();
      if (z.status === "dirty") $.dirty();
      if (Y.value !== "__proto__" && (typeof z.value < "u" || Q.alwaysSet)) J[Y.value] = z.value;
    }
    return { status: $.value, value: J };
  }
};
var l = Object.freeze({ status: "aborted" });
var z0 = ($) => ({ status: "dirty", value: $ });
var p$ = ($) => ({ status: "valid", value: $ });
var dz = ($) => $.status === "aborted";
var rz = ($) => $.status === "dirty";
var O1 = ($) => $.status === "valid";
var rX = ($) => typeof Promise < "u" && $ instanceof Promise;
var y;
(function($) {
  $.errToObj = (X) => typeof X === "string" ? { message: X } : X || {}, $.toString = (X) => typeof X === "string" ? X : X?.message;
})(y || (y = {}));
var Z6 = class {
  constructor($, X, J, Q) {
    this._cachedPath = [], this.parent = $, this.data = X, this._path = J, this._key = Q;
  }
  get path() {
    if (!this._cachedPath.length) if (Array.isArray(this._key)) this._cachedPath.push(...this._path, ...this._key);
    else this._cachedPath.push(...this._path, this._key);
    return this._cachedPath;
  }
};
var cK = ($, X) => {
  if (O1(X)) return { success: true, data: X.value };
  else {
    if (!$.common.issues.length) throw Error("Validation failed but no issues detected.");
    return { success: false, get error() {
      if (this._error) return this._error;
      let J = new H6($.common.issues);
      return this._error = J, this._error;
    } };
  }
};
function o($) {
  if (!$) return {};
  let { errorMap: X, invalid_type_error: J, required_error: Q, description: Y } = $;
  if (X && (J || Q)) throw Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  if (X) return { errorMap: X, description: Y };
  return { errorMap: (W, G) => {
    let { message: U } = $;
    if (W.code === "invalid_enum_value") return { message: U ?? G.defaultError };
    if (typeof G.data > "u") return { message: U ?? Q ?? G.defaultError };
    if (W.code !== "invalid_type") return { message: G.defaultError };
    return { message: U ?? J ?? G.defaultError };
  }, description: Y };
}
var e = class {
  get description() {
    return this._def.description;
  }
  _getType($) {
    return J4($.data);
  }
  _getOrReturnCtx($, X) {
    return X || { common: $.parent.common, data: $.data, parsedType: J4($.data), schemaErrorMap: this._def.errorMap, path: $.path, parent: $.parent };
  }
  _processInputParams($) {
    return { status: new u$(), ctx: { common: $.parent.common, data: $.data, parsedType: J4($.data), schemaErrorMap: this._def.errorMap, path: $.path, parent: $.parent } };
  }
  _parseSync($) {
    let X = this._parse($);
    if (rX(X)) throw Error("Synchronous parse encountered promise.");
    return X;
  }
  _parseAsync($) {
    let X = this._parse($);
    return Promise.resolve(X);
  }
  parse($, X) {
    let J = this.safeParse($, X);
    if (J.success) return J.data;
    throw J.error;
  }
  safeParse($, X) {
    let J = { common: { issues: [], async: X?.async ?? false, contextualErrorMap: X?.errorMap }, path: X?.path || [], schemaErrorMap: this._def.errorMap, parent: null, data: $, parsedType: J4($) }, Q = this._parseSync({ data: $, path: J.path, parent: J });
    return cK(J, Q);
  }
  "~validate"($) {
    let X = { common: { issues: [], async: !!this["~standard"].async }, path: [], schemaErrorMap: this._def.errorMap, parent: null, data: $, parsedType: J4($) };
    if (!this["~standard"].async) try {
      let J = this._parseSync({ data: $, path: [], parent: X });
      return O1(J) ? { value: J.value } : { issues: X.common.issues };
    } catch (J) {
      if (J?.message?.toLowerCase()?.includes("encountered")) this["~standard"].async = true;
      X.common = { issues: [], async: true };
    }
    return this._parseAsync({ data: $, path: [], parent: X }).then((J) => O1(J) ? { value: J.value } : { issues: X.common.issues });
  }
  async parseAsync($, X) {
    let J = await this.safeParseAsync($, X);
    if (J.success) return J.data;
    throw J.error;
  }
  async safeParseAsync($, X) {
    let J = { common: { issues: [], contextualErrorMap: X?.errorMap, async: true }, path: X?.path || [], schemaErrorMap: this._def.errorMap, parent: null, data: $, parsedType: J4($) }, Q = this._parse({ data: $, path: J.path, parent: J }), Y = await (rX(Q) ? Q : Promise.resolve(Q));
    return cK(J, Y);
  }
  refine($, X) {
    let J = (Q) => {
      if (typeof X === "string" || typeof X > "u") return { message: X };
      else if (typeof X === "function") return X(Q);
      else return X;
    };
    return this._refinement((Q, Y) => {
      let z = $(Q), W = () => Y.addIssue({ code: A.custom, ...J(Q) });
      if (typeof Promise < "u" && z instanceof Promise) return z.then((G) => {
        if (!G) return W(), false;
        else return true;
      });
      if (!z) return W(), false;
      else return true;
    });
  }
  refinement($, X) {
    return this._refinement((J, Q) => {
      if (!$(J)) return Q.addIssue(typeof X === "function" ? X(J, Q) : X), false;
      else return true;
    });
  }
  _refinement($) {
    return new c6({ schema: this, typeName: P.ZodEffects, effect: { type: "refinement", refinement: $ } });
  }
  superRefine($) {
    return this._refinement($);
  }
  constructor($) {
    this.spa = this.safeParseAsync, this._def = $, this.parse = this.parse.bind(this), this.safeParse = this.safeParse.bind(this), this.parseAsync = this.parseAsync.bind(this), this.safeParseAsync = this.safeParseAsync.bind(this), this.spa = this.spa.bind(this), this.refine = this.refine.bind(this), this.refinement = this.refinement.bind(this), this.superRefine = this.superRefine.bind(this), this.optional = this.optional.bind(this), this.nullable = this.nullable.bind(this), this.nullish = this.nullish.bind(this), this.array = this.array.bind(this), this.promise = this.promise.bind(this), this.or = this.or.bind(this), this.and = this.and.bind(this), this.transform = this.transform.bind(this), this.brand = this.brand.bind(this), this.default = this.default.bind(this), this.catch = this.catch.bind(this), this.describe = this.describe.bind(this), this.pipe = this.pipe.bind(this), this.readonly = this.readonly.bind(this), this.isNullable = this.isNullable.bind(this), this.isOptional = this.isOptional.bind(this), this["~standard"] = { version: 1, vendor: "zod", validate: (X) => this["~validate"](X) };
  }
  optional() {
    return D6.create(this, this._def);
  }
  nullable() {
    return S4.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return l6.create(this);
  }
  promise() {
    return K0.create(this, this._def);
  }
  or($) {
    return eX.create([this, $], this._def);
  }
  and($) {
    return $8.create(this, $, this._def);
  }
  transform($) {
    return new c6({ ...o(this._def), schema: this, typeName: P.ZodEffects, effect: { type: "transform", transform: $ } });
  }
  default($) {
    let X = typeof $ === "function" ? $ : () => $;
    return new Q8({ ...o(this._def), innerType: this, defaultValue: X, typeName: P.ZodDefault });
  }
  brand() {
    return new sz({ typeName: P.ZodBranded, type: this, ...o(this._def) });
  }
  catch($) {
    let X = typeof $ === "function" ? $ : () => $;
    return new z8({ ...o(this._def), innerType: this, catchValue: X, typeName: P.ZodCatch });
  }
  describe($) {
    return new this.constructor({ ...this._def, description: $ });
  }
  pipe($) {
    return uJ.create(this, $);
  }
  readonly() {
    return W8.create(this);
  }
  isOptional() {
    return this.safeParse(void 0).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
};
var JM = /^c[^\s-]{8,}$/i;
var YM = /^[0-9a-z]+$/;
var QM = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var zM = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var WM = /^[a-z0-9_-]{21}$/i;
var GM = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var UM = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var HM = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var KM = "^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$";
var oz;
var NM = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var VM = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var OM = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var wM = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var BM = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var qM = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var iK = "((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))";
var DM = new RegExp(`^${iK}$`);
function pK($) {
  let X = "[0-5]\\d";
  if ($.precision) X = `${X}\\.\\d{${$.precision}}`;
  else if ($.precision == null) X = `${X}(\\.\\d+)?`;
  let J = $.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${X})${J}`;
}
function LM($) {
  return new RegExp(`^${pK($)}$`);
}
function jM($) {
  let X = `${iK}T${pK($)}`, J = [];
  if (J.push($.local ? "Z?" : "Z"), $.offset) J.push("([+-]\\d{2}:?\\d{2})");
  return X = `${X}(${J.join("|")})`, new RegExp(`^${X}$`);
}
function FM($, X) {
  if ((X === "v4" || !X) && NM.test($)) return true;
  if ((X === "v6" || !X) && OM.test($)) return true;
  return false;
}
function IM($, X) {
  if (!GM.test($)) return false;
  try {
    let [J] = $.split(".");
    if (!J) return false;
    let Q = J.replace(/-/g, "+").replace(/_/g, "/").padEnd(J.length + (4 - J.length % 4) % 4, "="), Y = JSON.parse(atob(Q));
    if (typeof Y !== "object" || Y === null) return false;
    if ("typ" in Y && Y?.typ !== "JWT") return false;
    if (!Y.alg) return false;
    if (X && Y.alg !== X) return false;
    return true;
  } catch {
    return false;
  }
}
function MM($, X) {
  if ((X === "v4" || !X) && VM.test($)) return true;
  if ((X === "v6" || !X) && wM.test($)) return true;
  return false;
}
var Q4 = class _Q4 extends e {
  _parse($) {
    if (this._def.coerce) $.data = String($.data);
    if (this._getType($) !== R.string) {
      let Y = this._getOrReturnCtx($);
      return C(Y, { code: A.invalid_type, expected: R.string, received: Y.parsedType }), l;
    }
    let J = new u$(), Q = void 0;
    for (let Y of this._def.checks) if (Y.kind === "min") {
      if ($.data.length < Y.value) Q = this._getOrReturnCtx($, Q), C(Q, { code: A.too_small, minimum: Y.value, type: "string", inclusive: true, exact: false, message: Y.message }), J.dirty();
    } else if (Y.kind === "max") {
      if ($.data.length > Y.value) Q = this._getOrReturnCtx($, Q), C(Q, { code: A.too_big, maximum: Y.value, type: "string", inclusive: true, exact: false, message: Y.message }), J.dirty();
    } else if (Y.kind === "length") {
      let z = $.data.length > Y.value, W = $.data.length < Y.value;
      if (z || W) {
        if (Q = this._getOrReturnCtx($, Q), z) C(Q, { code: A.too_big, maximum: Y.value, type: "string", inclusive: true, exact: true, message: Y.message });
        else if (W) C(Q, { code: A.too_small, minimum: Y.value, type: "string", inclusive: true, exact: true, message: Y.message });
        J.dirty();
      }
    } else if (Y.kind === "email") {
      if (!HM.test($.data)) Q = this._getOrReturnCtx($, Q), C(Q, { validation: "email", code: A.invalid_string, message: Y.message }), J.dirty();
    } else if (Y.kind === "emoji") {
      if (!oz) oz = new RegExp(KM, "u");
      if (!oz.test($.data)) Q = this._getOrReturnCtx($, Q), C(Q, { validation: "emoji", code: A.invalid_string, message: Y.message }), J.dirty();
    } else if (Y.kind === "uuid") {
      if (!zM.test($.data)) Q = this._getOrReturnCtx($, Q), C(Q, { validation: "uuid", code: A.invalid_string, message: Y.message }), J.dirty();
    } else if (Y.kind === "nanoid") {
      if (!WM.test($.data)) Q = this._getOrReturnCtx($, Q), C(Q, { validation: "nanoid", code: A.invalid_string, message: Y.message }), J.dirty();
    } else if (Y.kind === "cuid") {
      if (!JM.test($.data)) Q = this._getOrReturnCtx($, Q), C(Q, { validation: "cuid", code: A.invalid_string, message: Y.message }), J.dirty();
    } else if (Y.kind === "cuid2") {
      if (!YM.test($.data)) Q = this._getOrReturnCtx($, Q), C(Q, { validation: "cuid2", code: A.invalid_string, message: Y.message }), J.dirty();
    } else if (Y.kind === "ulid") {
      if (!QM.test($.data)) Q = this._getOrReturnCtx($, Q), C(Q, { validation: "ulid", code: A.invalid_string, message: Y.message }), J.dirty();
    } else if (Y.kind === "url") try {
      new URL($.data);
    } catch {
      Q = this._getOrReturnCtx($, Q), C(Q, { validation: "url", code: A.invalid_string, message: Y.message }), J.dirty();
    }
    else if (Y.kind === "regex") {
      if (Y.regex.lastIndex = 0, !Y.regex.test($.data)) Q = this._getOrReturnCtx($, Q), C(Q, { validation: "regex", code: A.invalid_string, message: Y.message }), J.dirty();
    } else if (Y.kind === "trim") $.data = $.data.trim();
    else if (Y.kind === "includes") {
      if (!$.data.includes(Y.value, Y.position)) Q = this._getOrReturnCtx($, Q), C(Q, { code: A.invalid_string, validation: { includes: Y.value, position: Y.position }, message: Y.message }), J.dirty();
    } else if (Y.kind === "toLowerCase") $.data = $.data.toLowerCase();
    else if (Y.kind === "toUpperCase") $.data = $.data.toUpperCase();
    else if (Y.kind === "startsWith") {
      if (!$.data.startsWith(Y.value)) Q = this._getOrReturnCtx($, Q), C(Q, { code: A.invalid_string, validation: { startsWith: Y.value }, message: Y.message }), J.dirty();
    } else if (Y.kind === "endsWith") {
      if (!$.data.endsWith(Y.value)) Q = this._getOrReturnCtx($, Q), C(Q, { code: A.invalid_string, validation: { endsWith: Y.value }, message: Y.message }), J.dirty();
    } else if (Y.kind === "datetime") {
      if (!jM(Y).test($.data)) Q = this._getOrReturnCtx($, Q), C(Q, { code: A.invalid_string, validation: "datetime", message: Y.message }), J.dirty();
    } else if (Y.kind === "date") {
      if (!DM.test($.data)) Q = this._getOrReturnCtx($, Q), C(Q, { code: A.invalid_string, validation: "date", message: Y.message }), J.dirty();
    } else if (Y.kind === "time") {
      if (!LM(Y).test($.data)) Q = this._getOrReturnCtx($, Q), C(Q, { code: A.invalid_string, validation: "time", message: Y.message }), J.dirty();
    } else if (Y.kind === "duration") {
      if (!UM.test($.data)) Q = this._getOrReturnCtx($, Q), C(Q, { validation: "duration", code: A.invalid_string, message: Y.message }), J.dirty();
    } else if (Y.kind === "ip") {
      if (!FM($.data, Y.version)) Q = this._getOrReturnCtx($, Q), C(Q, { validation: "ip", code: A.invalid_string, message: Y.message }), J.dirty();
    } else if (Y.kind === "jwt") {
      if (!IM($.data, Y.alg)) Q = this._getOrReturnCtx($, Q), C(Q, { validation: "jwt", code: A.invalid_string, message: Y.message }), J.dirty();
    } else if (Y.kind === "cidr") {
      if (!MM($.data, Y.version)) Q = this._getOrReturnCtx($, Q), C(Q, { validation: "cidr", code: A.invalid_string, message: Y.message }), J.dirty();
    } else if (Y.kind === "base64") {
      if (!BM.test($.data)) Q = this._getOrReturnCtx($, Q), C(Q, { validation: "base64", code: A.invalid_string, message: Y.message }), J.dirty();
    } else if (Y.kind === "base64url") {
      if (!qM.test($.data)) Q = this._getOrReturnCtx($, Q), C(Q, { validation: "base64url", code: A.invalid_string, message: Y.message }), J.dirty();
    } else X$.assertNever(Y);
    return { status: J.value, value: $.data };
  }
  _regex($, X, J) {
    return this.refinement((Q) => $.test(Q), { validation: X, code: A.invalid_string, ...y.errToObj(J) });
  }
  _addCheck($) {
    return new _Q4({ ...this._def, checks: [...this._def.checks, $] });
  }
  email($) {
    return this._addCheck({ kind: "email", ...y.errToObj($) });
  }
  url($) {
    return this._addCheck({ kind: "url", ...y.errToObj($) });
  }
  emoji($) {
    return this._addCheck({ kind: "emoji", ...y.errToObj($) });
  }
  uuid($) {
    return this._addCheck({ kind: "uuid", ...y.errToObj($) });
  }
  nanoid($) {
    return this._addCheck({ kind: "nanoid", ...y.errToObj($) });
  }
  cuid($) {
    return this._addCheck({ kind: "cuid", ...y.errToObj($) });
  }
  cuid2($) {
    return this._addCheck({ kind: "cuid2", ...y.errToObj($) });
  }
  ulid($) {
    return this._addCheck({ kind: "ulid", ...y.errToObj($) });
  }
  base64($) {
    return this._addCheck({ kind: "base64", ...y.errToObj($) });
  }
  base64url($) {
    return this._addCheck({ kind: "base64url", ...y.errToObj($) });
  }
  jwt($) {
    return this._addCheck({ kind: "jwt", ...y.errToObj($) });
  }
  ip($) {
    return this._addCheck({ kind: "ip", ...y.errToObj($) });
  }
  cidr($) {
    return this._addCheck({ kind: "cidr", ...y.errToObj($) });
  }
  datetime($) {
    if (typeof $ === "string") return this._addCheck({ kind: "datetime", precision: null, offset: false, local: false, message: $ });
    return this._addCheck({ kind: "datetime", precision: typeof $?.precision > "u" ? null : $?.precision, offset: $?.offset ?? false, local: $?.local ?? false, ...y.errToObj($?.message) });
  }
  date($) {
    return this._addCheck({ kind: "date", message: $ });
  }
  time($) {
    if (typeof $ === "string") return this._addCheck({ kind: "time", precision: null, message: $ });
    return this._addCheck({ kind: "time", precision: typeof $?.precision > "u" ? null : $?.precision, ...y.errToObj($?.message) });
  }
  duration($) {
    return this._addCheck({ kind: "duration", ...y.errToObj($) });
  }
  regex($, X) {
    return this._addCheck({ kind: "regex", regex: $, ...y.errToObj(X) });
  }
  includes($, X) {
    return this._addCheck({ kind: "includes", value: $, position: X?.position, ...y.errToObj(X?.message) });
  }
  startsWith($, X) {
    return this._addCheck({ kind: "startsWith", value: $, ...y.errToObj(X) });
  }
  endsWith($, X) {
    return this._addCheck({ kind: "endsWith", value: $, ...y.errToObj(X) });
  }
  min($, X) {
    return this._addCheck({ kind: "min", value: $, ...y.errToObj(X) });
  }
  max($, X) {
    return this._addCheck({ kind: "max", value: $, ...y.errToObj(X) });
  }
  length($, X) {
    return this._addCheck({ kind: "length", value: $, ...y.errToObj(X) });
  }
  nonempty($) {
    return this.min(1, y.errToObj($));
  }
  trim() {
    return new _Q4({ ...this._def, checks: [...this._def.checks, { kind: "trim" }] });
  }
  toLowerCase() {
    return new _Q4({ ...this._def, checks: [...this._def.checks, { kind: "toLowerCase" }] });
  }
  toUpperCase() {
    return new _Q4({ ...this._def, checks: [...this._def.checks, { kind: "toUpperCase" }] });
  }
  get isDatetime() {
    return !!this._def.checks.find(($) => $.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find(($) => $.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find(($) => $.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find(($) => $.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find(($) => $.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find(($) => $.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find(($) => $.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find(($) => $.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find(($) => $.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find(($) => $.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find(($) => $.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find(($) => $.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find(($) => $.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find(($) => $.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find(($) => $.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find(($) => $.kind === "base64url");
  }
  get minLength() {
    let $ = null;
    for (let X of this._def.checks) if (X.kind === "min") {
      if ($ === null || X.value > $) $ = X.value;
    }
    return $;
  }
  get maxLength() {
    let $ = null;
    for (let X of this._def.checks) if (X.kind === "max") {
      if ($ === null || X.value < $) $ = X.value;
    }
    return $;
  }
};
Q4.create = ($) => {
  return new Q4({ checks: [], typeName: P.ZodString, coerce: $?.coerce ?? false, ...o($) });
};
function AM($, X) {
  let J = ($.toString().split(".")[1] || "").length, Q = (X.toString().split(".")[1] || "").length, Y = J > Q ? J : Q, z = Number.parseInt($.toFixed(Y).replace(".", "")), W = Number.parseInt(X.toFixed(Y).replace(".", ""));
  return z % W / 10 ** Y;
}
var G0 = class _G0 extends e {
  constructor() {
    super(...arguments);
    this.min = this.gte, this.max = this.lte, this.step = this.multipleOf;
  }
  _parse($) {
    if (this._def.coerce) $.data = Number($.data);
    if (this._getType($) !== R.number) {
      let Y = this._getOrReturnCtx($);
      return C(Y, { code: A.invalid_type, expected: R.number, received: Y.parsedType }), l;
    }
    let J = void 0, Q = new u$();
    for (let Y of this._def.checks) if (Y.kind === "int") {
      if (!X$.isInteger($.data)) J = this._getOrReturnCtx($, J), C(J, { code: A.invalid_type, expected: "integer", received: "float", message: Y.message }), Q.dirty();
    } else if (Y.kind === "min") {
      if (Y.inclusive ? $.data < Y.value : $.data <= Y.value) J = this._getOrReturnCtx($, J), C(J, { code: A.too_small, minimum: Y.value, type: "number", inclusive: Y.inclusive, exact: false, message: Y.message }), Q.dirty();
    } else if (Y.kind === "max") {
      if (Y.inclusive ? $.data > Y.value : $.data >= Y.value) J = this._getOrReturnCtx($, J), C(J, { code: A.too_big, maximum: Y.value, type: "number", inclusive: Y.inclusive, exact: false, message: Y.message }), Q.dirty();
    } else if (Y.kind === "multipleOf") {
      if (AM($.data, Y.value) !== 0) J = this._getOrReturnCtx($, J), C(J, { code: A.not_multiple_of, multipleOf: Y.value, message: Y.message }), Q.dirty();
    } else if (Y.kind === "finite") {
      if (!Number.isFinite($.data)) J = this._getOrReturnCtx($, J), C(J, { code: A.not_finite, message: Y.message }), Q.dirty();
    } else X$.assertNever(Y);
    return { status: Q.value, value: $.data };
  }
  gte($, X) {
    return this.setLimit("min", $, true, y.toString(X));
  }
  gt($, X) {
    return this.setLimit("min", $, false, y.toString(X));
  }
  lte($, X) {
    return this.setLimit("max", $, true, y.toString(X));
  }
  lt($, X) {
    return this.setLimit("max", $, false, y.toString(X));
  }
  setLimit($, X, J, Q) {
    return new _G0({ ...this._def, checks: [...this._def.checks, { kind: $, value: X, inclusive: J, message: y.toString(Q) }] });
  }
  _addCheck($) {
    return new _G0({ ...this._def, checks: [...this._def.checks, $] });
  }
  int($) {
    return this._addCheck({ kind: "int", message: y.toString($) });
  }
  positive($) {
    return this._addCheck({ kind: "min", value: 0, inclusive: false, message: y.toString($) });
  }
  negative($) {
    return this._addCheck({ kind: "max", value: 0, inclusive: false, message: y.toString($) });
  }
  nonpositive($) {
    return this._addCheck({ kind: "max", value: 0, inclusive: true, message: y.toString($) });
  }
  nonnegative($) {
    return this._addCheck({ kind: "min", value: 0, inclusive: true, message: y.toString($) });
  }
  multipleOf($, X) {
    return this._addCheck({ kind: "multipleOf", value: $, message: y.toString(X) });
  }
  finite($) {
    return this._addCheck({ kind: "finite", message: y.toString($) });
  }
  safe($) {
    return this._addCheck({ kind: "min", inclusive: true, value: Number.MIN_SAFE_INTEGER, message: y.toString($) })._addCheck({ kind: "max", inclusive: true, value: Number.MAX_SAFE_INTEGER, message: y.toString($) });
  }
  get minValue() {
    let $ = null;
    for (let X of this._def.checks) if (X.kind === "min") {
      if ($ === null || X.value > $) $ = X.value;
    }
    return $;
  }
  get maxValue() {
    let $ = null;
    for (let X of this._def.checks) if (X.kind === "max") {
      if ($ === null || X.value < $) $ = X.value;
    }
    return $;
  }
  get isInt() {
    return !!this._def.checks.find(($) => $.kind === "int" || $.kind === "multipleOf" && X$.isInteger($.value));
  }
  get isFinite() {
    let $ = null, X = null;
    for (let J of this._def.checks) if (J.kind === "finite" || J.kind === "int" || J.kind === "multipleOf") return true;
    else if (J.kind === "min") {
      if (X === null || J.value > X) X = J.value;
    } else if (J.kind === "max") {
      if ($ === null || J.value < $) $ = J.value;
    }
    return Number.isFinite(X) && Number.isFinite($);
  }
};
G0.create = ($) => {
  return new G0({ checks: [], typeName: P.ZodNumber, coerce: $?.coerce || false, ...o($) });
};
var U0 = class _U0 extends e {
  constructor() {
    super(...arguments);
    this.min = this.gte, this.max = this.lte;
  }
  _parse($) {
    if (this._def.coerce) try {
      $.data = BigInt($.data);
    } catch {
      return this._getInvalidInput($);
    }
    if (this._getType($) !== R.bigint) return this._getInvalidInput($);
    let J = void 0, Q = new u$();
    for (let Y of this._def.checks) if (Y.kind === "min") {
      if (Y.inclusive ? $.data < Y.value : $.data <= Y.value) J = this._getOrReturnCtx($, J), C(J, { code: A.too_small, type: "bigint", minimum: Y.value, inclusive: Y.inclusive, message: Y.message }), Q.dirty();
    } else if (Y.kind === "max") {
      if (Y.inclusive ? $.data > Y.value : $.data >= Y.value) J = this._getOrReturnCtx($, J), C(J, { code: A.too_big, type: "bigint", maximum: Y.value, inclusive: Y.inclusive, message: Y.message }), Q.dirty();
    } else if (Y.kind === "multipleOf") {
      if ($.data % Y.value !== BigInt(0)) J = this._getOrReturnCtx($, J), C(J, { code: A.not_multiple_of, multipleOf: Y.value, message: Y.message }), Q.dirty();
    } else X$.assertNever(Y);
    return { status: Q.value, value: $.data };
  }
  _getInvalidInput($) {
    let X = this._getOrReturnCtx($);
    return C(X, { code: A.invalid_type, expected: R.bigint, received: X.parsedType }), l;
  }
  gte($, X) {
    return this.setLimit("min", $, true, y.toString(X));
  }
  gt($, X) {
    return this.setLimit("min", $, false, y.toString(X));
  }
  lte($, X) {
    return this.setLimit("max", $, true, y.toString(X));
  }
  lt($, X) {
    return this.setLimit("max", $, false, y.toString(X));
  }
  setLimit($, X, J, Q) {
    return new _U0({ ...this._def, checks: [...this._def.checks, { kind: $, value: X, inclusive: J, message: y.toString(Q) }] });
  }
  _addCheck($) {
    return new _U0({ ...this._def, checks: [...this._def.checks, $] });
  }
  positive($) {
    return this._addCheck({ kind: "min", value: BigInt(0), inclusive: false, message: y.toString($) });
  }
  negative($) {
    return this._addCheck({ kind: "max", value: BigInt(0), inclusive: false, message: y.toString($) });
  }
  nonpositive($) {
    return this._addCheck({ kind: "max", value: BigInt(0), inclusive: true, message: y.toString($) });
  }
  nonnegative($) {
    return this._addCheck({ kind: "min", value: BigInt(0), inclusive: true, message: y.toString($) });
  }
  multipleOf($, X) {
    return this._addCheck({ kind: "multipleOf", value: $, message: y.toString(X) });
  }
  get minValue() {
    let $ = null;
    for (let X of this._def.checks) if (X.kind === "min") {
      if ($ === null || X.value > $) $ = X.value;
    }
    return $;
  }
  get maxValue() {
    let $ = null;
    for (let X of this._def.checks) if (X.kind === "max") {
      if ($ === null || X.value < $) $ = X.value;
    }
    return $;
  }
};
U0.create = ($) => {
  return new U0({ checks: [], typeName: P.ZodBigInt, coerce: $?.coerce ?? false, ...o($) });
};
var _J = class extends e {
  _parse($) {
    if (this._def.coerce) $.data = Boolean($.data);
    if (this._getType($) !== R.boolean) {
      let J = this._getOrReturnCtx($);
      return C(J, { code: A.invalid_type, expected: R.boolean, received: J.parsedType }), l;
    }
    return p$($.data);
  }
};
_J.create = ($) => {
  return new _J({ typeName: P.ZodBoolean, coerce: $?.coerce || false, ...o($) });
};
var tX = class _tX extends e {
  _parse($) {
    if (this._def.coerce) $.data = new Date($.data);
    if (this._getType($) !== R.date) {
      let Y = this._getOrReturnCtx($);
      return C(Y, { code: A.invalid_type, expected: R.date, received: Y.parsedType }), l;
    }
    if (Number.isNaN($.data.getTime())) {
      let Y = this._getOrReturnCtx($);
      return C(Y, { code: A.invalid_date }), l;
    }
    let J = new u$(), Q = void 0;
    for (let Y of this._def.checks) if (Y.kind === "min") {
      if ($.data.getTime() < Y.value) Q = this._getOrReturnCtx($, Q), C(Q, { code: A.too_small, message: Y.message, inclusive: true, exact: false, minimum: Y.value, type: "date" }), J.dirty();
    } else if (Y.kind === "max") {
      if ($.data.getTime() > Y.value) Q = this._getOrReturnCtx($, Q), C(Q, { code: A.too_big, message: Y.message, inclusive: true, exact: false, maximum: Y.value, type: "date" }), J.dirty();
    } else X$.assertNever(Y);
    return { status: J.value, value: new Date($.data.getTime()) };
  }
  _addCheck($) {
    return new _tX({ ...this._def, checks: [...this._def.checks, $] });
  }
  min($, X) {
    return this._addCheck({ kind: "min", value: $.getTime(), message: y.toString(X) });
  }
  max($, X) {
    return this._addCheck({ kind: "max", value: $.getTime(), message: y.toString(X) });
  }
  get minDate() {
    let $ = null;
    for (let X of this._def.checks) if (X.kind === "min") {
      if ($ === null || X.value > $) $ = X.value;
    }
    return $ != null ? new Date($) : null;
  }
  get maxDate() {
    let $ = null;
    for (let X of this._def.checks) if (X.kind === "max") {
      if ($ === null || X.value < $) $ = X.value;
    }
    return $ != null ? new Date($) : null;
  }
};
tX.create = ($) => {
  return new tX({ checks: [], coerce: $?.coerce || false, typeName: P.ZodDate, ...o($) });
};
var xJ = class extends e {
  _parse($) {
    if (this._getType($) !== R.symbol) {
      let J = this._getOrReturnCtx($);
      return C(J, { code: A.invalid_type, expected: R.symbol, received: J.parsedType }), l;
    }
    return p$($.data);
  }
};
xJ.create = ($) => {
  return new xJ({ typeName: P.ZodSymbol, ...o($) });
};
var aX = class extends e {
  _parse($) {
    if (this._getType($) !== R.undefined) {
      let J = this._getOrReturnCtx($);
      return C(J, { code: A.invalid_type, expected: R.undefined, received: J.parsedType }), l;
    }
    return p$($.data);
  }
};
aX.create = ($) => {
  return new aX({ typeName: P.ZodUndefined, ...o($) });
};
var sX = class extends e {
  _parse($) {
    if (this._getType($) !== R.null) {
      let J = this._getOrReturnCtx($);
      return C(J, { code: A.invalid_type, expected: R.null, received: J.parsedType }), l;
    }
    return p$($.data);
  }
};
sX.create = ($) => {
  return new sX({ typeName: P.ZodNull, ...o($) });
};
var TJ = class extends e {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse($) {
    return p$($.data);
  }
};
TJ.create = ($) => {
  return new TJ({ typeName: P.ZodAny, ...o($) });
};
var w1 = class extends e {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse($) {
    return p$($.data);
  }
};
w1.create = ($) => {
  return new w1({ typeName: P.ZodUnknown, ...o($) });
};
var z4 = class extends e {
  _parse($) {
    let X = this._getOrReturnCtx($);
    return C(X, { code: A.invalid_type, expected: R.never, received: X.parsedType }), l;
  }
};
z4.create = ($) => {
  return new z4({ typeName: P.ZodNever, ...o($) });
};
var yJ = class extends e {
  _parse($) {
    if (this._getType($) !== R.undefined) {
      let J = this._getOrReturnCtx($);
      return C(J, { code: A.invalid_type, expected: R.void, received: J.parsedType }), l;
    }
    return p$($.data);
  }
};
yJ.create = ($) => {
  return new yJ({ typeName: P.ZodVoid, ...o($) });
};
var l6 = class _l6 extends e {
  _parse($) {
    let { ctx: X, status: J } = this._processInputParams($), Q = this._def;
    if (X.parsedType !== R.array) return C(X, { code: A.invalid_type, expected: R.array, received: X.parsedType }), l;
    if (Q.exactLength !== null) {
      let z = X.data.length > Q.exactLength.value, W = X.data.length < Q.exactLength.value;
      if (z || W) C(X, { code: z ? A.too_big : A.too_small, minimum: W ? Q.exactLength.value : void 0, maximum: z ? Q.exactLength.value : void 0, type: "array", inclusive: true, exact: true, message: Q.exactLength.message }), J.dirty();
    }
    if (Q.minLength !== null) {
      if (X.data.length < Q.minLength.value) C(X, { code: A.too_small, minimum: Q.minLength.value, type: "array", inclusive: true, exact: false, message: Q.minLength.message }), J.dirty();
    }
    if (Q.maxLength !== null) {
      if (X.data.length > Q.maxLength.value) C(X, { code: A.too_big, maximum: Q.maxLength.value, type: "array", inclusive: true, exact: false, message: Q.maxLength.message }), J.dirty();
    }
    if (X.common.async) return Promise.all([...X.data].map((z, W) => {
      return Q.type._parseAsync(new Z6(X, z, X.path, W));
    })).then((z) => {
      return u$.mergeArray(J, z);
    });
    let Y = [...X.data].map((z, W) => {
      return Q.type._parseSync(new Z6(X, z, X.path, W));
    });
    return u$.mergeArray(J, Y);
  }
  get element() {
    return this._def.type;
  }
  min($, X) {
    return new _l6({ ...this._def, minLength: { value: $, message: y.toString(X) } });
  }
  max($, X) {
    return new _l6({ ...this._def, maxLength: { value: $, message: y.toString(X) } });
  }
  length($, X) {
    return new _l6({ ...this._def, exactLength: { value: $, message: y.toString(X) } });
  }
  nonempty($) {
    return this.min(1, $);
  }
};
l6.create = ($, X) => {
  return new l6({ type: $, minLength: null, maxLength: null, exactLength: null, typeName: P.ZodArray, ...o(X) });
};
function W0($) {
  if ($ instanceof Z$) {
    let X = {};
    for (let J in $.shape) {
      let Q = $.shape[J];
      X[J] = D6.create(W0(Q));
    }
    return new Z$({ ...$._def, shape: () => X });
  } else if ($ instanceof l6) return new l6({ ...$._def, type: W0($.element) });
  else if ($ instanceof D6) return D6.create(W0($.unwrap()));
  else if ($ instanceof S4) return S4.create(W0($.unwrap()));
  else if ($ instanceof W4) return W4.create($.items.map((X) => W0(X)));
  else return $;
}
var Z$ = class _Z$ extends e {
  constructor() {
    super(...arguments);
    this._cached = null, this.nonstrict = this.passthrough, this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null) return this._cached;
    let $ = this._def.shape(), X = X$.objectKeys($);
    return this._cached = { shape: $, keys: X }, this._cached;
  }
  _parse($) {
    if (this._getType($) !== R.object) {
      let U = this._getOrReturnCtx($);
      return C(U, { code: A.invalid_type, expected: R.object, received: U.parsedType }), l;
    }
    let { status: J, ctx: Q } = this._processInputParams($), { shape: Y, keys: z } = this._getCached(), W = [];
    if (!(this._def.catchall instanceof z4 && this._def.unknownKeys === "strip")) {
      for (let U in Q.data) if (!z.includes(U)) W.push(U);
    }
    let G = [];
    for (let U of z) {
      let H = Y[U], K = Q.data[U];
      G.push({ key: { status: "valid", value: U }, value: H._parse(new Z6(Q, K, Q.path, U)), alwaysSet: U in Q.data });
    }
    if (this._def.catchall instanceof z4) {
      let U = this._def.unknownKeys;
      if (U === "passthrough") for (let H of W) G.push({ key: { status: "valid", value: H }, value: { status: "valid", value: Q.data[H] } });
      else if (U === "strict") {
        if (W.length > 0) C(Q, { code: A.unrecognized_keys, keys: W }), J.dirty();
      } else if (U === "strip") ;
      else throw Error("Internal ZodObject error: invalid unknownKeys value.");
    } else {
      let U = this._def.catchall;
      for (let H of W) {
        let K = Q.data[H];
        G.push({ key: { status: "valid", value: H }, value: U._parse(new Z6(Q, K, Q.path, H)), alwaysSet: H in Q.data });
      }
    }
    if (Q.common.async) return Promise.resolve().then(async () => {
      let U = [];
      for (let H of G) {
        let K = await H.key, V = await H.value;
        U.push({ key: K, value: V, alwaysSet: H.alwaysSet });
      }
      return U;
    }).then((U) => {
      return u$.mergeObjectSync(J, U);
    });
    else return u$.mergeObjectSync(J, G);
  }
  get shape() {
    return this._def.shape();
  }
  strict($) {
    return y.errToObj, new _Z$({ ...this._def, unknownKeys: "strict", ...$ !== void 0 ? { errorMap: (X, J) => {
      let Q = this._def.errorMap?.(X, J).message ?? J.defaultError;
      if (X.code === "unrecognized_keys") return { message: y.errToObj($).message ?? Q };
      return { message: Q };
    } } : {} });
  }
  strip() {
    return new _Z$({ ...this._def, unknownKeys: "strip" });
  }
  passthrough() {
    return new _Z$({ ...this._def, unknownKeys: "passthrough" });
  }
  extend($) {
    return new _Z$({ ...this._def, shape: () => ({ ...this._def.shape(), ...$ }) });
  }
  merge($) {
    return new _Z$({ unknownKeys: $._def.unknownKeys, catchall: $._def.catchall, shape: () => ({ ...this._def.shape(), ...$._def.shape() }), typeName: P.ZodObject });
  }
  setKey($, X) {
    return this.augment({ [$]: X });
  }
  catchall($) {
    return new _Z$({ ...this._def, catchall: $ });
  }
  pick($) {
    let X = {};
    for (let J of X$.objectKeys($)) if ($[J] && this.shape[J]) X[J] = this.shape[J];
    return new _Z$({ ...this._def, shape: () => X });
  }
  omit($) {
    let X = {};
    for (let J of X$.objectKeys(this.shape)) if (!$[J]) X[J] = this.shape[J];
    return new _Z$({ ...this._def, shape: () => X });
  }
  deepPartial() {
    return W0(this);
  }
  partial($) {
    let X = {};
    for (let J of X$.objectKeys(this.shape)) {
      let Q = this.shape[J];
      if ($ && !$[J]) X[J] = Q;
      else X[J] = Q.optional();
    }
    return new _Z$({ ...this._def, shape: () => X });
  }
  required($) {
    let X = {};
    for (let J of X$.objectKeys(this.shape)) if ($ && !$[J]) X[J] = this.shape[J];
    else {
      let Y = this.shape[J];
      while (Y instanceof D6) Y = Y._def.innerType;
      X[J] = Y;
    }
    return new _Z$({ ...this._def, shape: () => X });
  }
  keyof() {
    return nK(X$.objectKeys(this.shape));
  }
};
Z$.create = ($, X) => {
  return new Z$({ shape: () => $, unknownKeys: "strip", catchall: z4.create(), typeName: P.ZodObject, ...o(X) });
};
Z$.strictCreate = ($, X) => {
  return new Z$({ shape: () => $, unknownKeys: "strict", catchall: z4.create(), typeName: P.ZodObject, ...o(X) });
};
Z$.lazycreate = ($, X) => {
  return new Z$({ shape: $, unknownKeys: "strip", catchall: z4.create(), typeName: P.ZodObject, ...o(X) });
};
var eX = class extends e {
  _parse($) {
    let { ctx: X } = this._processInputParams($), J = this._def.options;
    function Q(Y) {
      for (let W of Y) if (W.result.status === "valid") return W.result;
      for (let W of Y) if (W.result.status === "dirty") return X.common.issues.push(...W.ctx.common.issues), W.result;
      let z = Y.map((W) => new H6(W.ctx.common.issues));
      return C(X, { code: A.invalid_union, unionErrors: z }), l;
    }
    if (X.common.async) return Promise.all(J.map(async (Y) => {
      let z = { ...X, common: { ...X.common, issues: [] }, parent: null };
      return { result: await Y._parseAsync({ data: X.data, path: X.path, parent: z }), ctx: z };
    })).then(Q);
    else {
      let Y = void 0, z = [];
      for (let G of J) {
        let U = { ...X, common: { ...X.common, issues: [] }, parent: null }, H = G._parseSync({ data: X.data, path: X.path, parent: U });
        if (H.status === "valid") return H;
        else if (H.status === "dirty" && !Y) Y = { result: H, ctx: U };
        if (U.common.issues.length) z.push(U.common.issues);
      }
      if (Y) return X.common.issues.push(...Y.ctx.common.issues), Y.result;
      let W = z.map((G) => new H6(G));
      return C(X, { code: A.invalid_union, unionErrors: W }), l;
    }
  }
  get options() {
    return this._def.options;
  }
};
eX.create = ($, X) => {
  return new eX({ options: $, typeName: P.ZodUnion, ...o(X) });
};
var Y4 = ($) => {
  if ($ instanceof X8) return Y4($.schema);
  else if ($ instanceof c6) return Y4($.innerType());
  else if ($ instanceof J8) return [$.value];
  else if ($ instanceof B1) return $.options;
  else if ($ instanceof Y8) return X$.objectValues($.enum);
  else if ($ instanceof Q8) return Y4($._def.innerType);
  else if ($ instanceof aX) return [void 0];
  else if ($ instanceof sX) return [null];
  else if ($ instanceof D6) return [void 0, ...Y4($.unwrap())];
  else if ($ instanceof S4) return [null, ...Y4($.unwrap())];
  else if ($ instanceof sz) return Y4($.unwrap());
  else if ($ instanceof W8) return Y4($.unwrap());
  else if ($ instanceof z8) return Y4($._def.innerType);
  else return [];
};
var az = class _az extends e {
  _parse($) {
    let { ctx: X } = this._processInputParams($);
    if (X.parsedType !== R.object) return C(X, { code: A.invalid_type, expected: R.object, received: X.parsedType }), l;
    let J = this.discriminator, Q = X.data[J], Y = this.optionsMap.get(Q);
    if (!Y) return C(X, { code: A.invalid_union_discriminator, options: Array.from(this.optionsMap.keys()), path: [J] }), l;
    if (X.common.async) return Y._parseAsync({ data: X.data, path: X.path, parent: X });
    else return Y._parseSync({ data: X.data, path: X.path, parent: X });
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  static create($, X, J) {
    let Q = /* @__PURE__ */ new Map();
    for (let Y of X) {
      let z = Y4(Y.shape[$]);
      if (!z.length) throw Error(`A discriminator value for key \`${$}\` could not be extracted from all schema options`);
      for (let W of z) {
        if (Q.has(W)) throw Error(`Discriminator property ${String($)} has duplicate value ${String(W)}`);
        Q.set(W, Y);
      }
    }
    return new _az({ typeName: P.ZodDiscriminatedUnion, discriminator: $, options: X, optionsMap: Q, ...o(J) });
  }
};
function tz($, X) {
  let J = J4($), Q = J4(X);
  if ($ === X) return { valid: true, data: $ };
  else if (J === R.object && Q === R.object) {
    let Y = X$.objectKeys(X), z = X$.objectKeys($).filter((G) => Y.indexOf(G) !== -1), W = { ...$, ...X };
    for (let G of z) {
      let U = tz($[G], X[G]);
      if (!U.valid) return { valid: false };
      W[G] = U.data;
    }
    return { valid: true, data: W };
  } else if (J === R.array && Q === R.array) {
    if ($.length !== X.length) return { valid: false };
    let Y = [];
    for (let z = 0; z < $.length; z++) {
      let W = $[z], G = X[z], U = tz(W, G);
      if (!U.valid) return { valid: false };
      Y.push(U.data);
    }
    return { valid: true, data: Y };
  } else if (J === R.date && Q === R.date && +$ === +X) return { valid: true, data: $ };
  else return { valid: false };
}
var $8 = class extends e {
  _parse($) {
    let { status: X, ctx: J } = this._processInputParams($), Q = (Y, z) => {
      if (dz(Y) || dz(z)) return l;
      let W = tz(Y.value, z.value);
      if (!W.valid) return C(J, { code: A.invalid_intersection_types }), l;
      if (rz(Y) || rz(z)) X.dirty();
      return { status: X.value, value: W.data };
    };
    if (J.common.async) return Promise.all([this._def.left._parseAsync({ data: J.data, path: J.path, parent: J }), this._def.right._parseAsync({ data: J.data, path: J.path, parent: J })]).then(([Y, z]) => Q(Y, z));
    else return Q(this._def.left._parseSync({ data: J.data, path: J.path, parent: J }), this._def.right._parseSync({ data: J.data, path: J.path, parent: J }));
  }
};
$8.create = ($, X, J) => {
  return new $8({ left: $, right: X, typeName: P.ZodIntersection, ...o(J) });
};
var W4 = class _W4 extends e {
  _parse($) {
    let { status: X, ctx: J } = this._processInputParams($);
    if (J.parsedType !== R.array) return C(J, { code: A.invalid_type, expected: R.array, received: J.parsedType }), l;
    if (J.data.length < this._def.items.length) return C(J, { code: A.too_small, minimum: this._def.items.length, inclusive: true, exact: false, type: "array" }), l;
    if (!this._def.rest && J.data.length > this._def.items.length) C(J, { code: A.too_big, maximum: this._def.items.length, inclusive: true, exact: false, type: "array" }), X.dirty();
    let Y = [...J.data].map((z, W) => {
      let G = this._def.items[W] || this._def.rest;
      if (!G) return null;
      return G._parse(new Z6(J, z, J.path, W));
    }).filter((z) => !!z);
    if (J.common.async) return Promise.all(Y).then((z) => {
      return u$.mergeArray(X, z);
    });
    else return u$.mergeArray(X, Y);
  }
  get items() {
    return this._def.items;
  }
  rest($) {
    return new _W4({ ...this._def, rest: $ });
  }
};
W4.create = ($, X) => {
  if (!Array.isArray($)) throw Error("You must pass an array of schemas to z.tuple([ ... ])");
  return new W4({ items: $, typeName: P.ZodTuple, rest: null, ...o(X) });
};
var gJ = class _gJ extends e {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse($) {
    let { status: X, ctx: J } = this._processInputParams($);
    if (J.parsedType !== R.object) return C(J, { code: A.invalid_type, expected: R.object, received: J.parsedType }), l;
    let Q = [], Y = this._def.keyType, z = this._def.valueType;
    for (let W in J.data) Q.push({ key: Y._parse(new Z6(J, W, J.path, W)), value: z._parse(new Z6(J, J.data[W], J.path, W)), alwaysSet: W in J.data });
    if (J.common.async) return u$.mergeObjectAsync(X, Q);
    else return u$.mergeObjectSync(X, Q);
  }
  get element() {
    return this._def.valueType;
  }
  static create($, X, J) {
    if (X instanceof e) return new _gJ({ keyType: $, valueType: X, typeName: P.ZodRecord, ...o(J) });
    return new _gJ({ keyType: Q4.create(), valueType: $, typeName: P.ZodRecord, ...o(X) });
  }
};
var fJ = class extends e {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse($) {
    let { status: X, ctx: J } = this._processInputParams($);
    if (J.parsedType !== R.map) return C(J, { code: A.invalid_type, expected: R.map, received: J.parsedType }), l;
    let Q = this._def.keyType, Y = this._def.valueType, z = [...J.data.entries()].map(([W, G], U) => {
      return { key: Q._parse(new Z6(J, W, J.path, [U, "key"])), value: Y._parse(new Z6(J, G, J.path, [U, "value"])) };
    });
    if (J.common.async) {
      let W = /* @__PURE__ */ new Map();
      return Promise.resolve().then(async () => {
        for (let G of z) {
          let U = await G.key, H = await G.value;
          if (U.status === "aborted" || H.status === "aborted") return l;
          if (U.status === "dirty" || H.status === "dirty") X.dirty();
          W.set(U.value, H.value);
        }
        return { status: X.value, value: W };
      });
    } else {
      let W = /* @__PURE__ */ new Map();
      for (let G of z) {
        let { key: U, value: H } = G;
        if (U.status === "aborted" || H.status === "aborted") return l;
        if (U.status === "dirty" || H.status === "dirty") X.dirty();
        W.set(U.value, H.value);
      }
      return { status: X.value, value: W };
    }
  }
};
fJ.create = ($, X, J) => {
  return new fJ({ valueType: X, keyType: $, typeName: P.ZodMap, ...o(J) });
};
var H0 = class _H0 extends e {
  _parse($) {
    let { status: X, ctx: J } = this._processInputParams($);
    if (J.parsedType !== R.set) return C(J, { code: A.invalid_type, expected: R.set, received: J.parsedType }), l;
    let Q = this._def;
    if (Q.minSize !== null) {
      if (J.data.size < Q.minSize.value) C(J, { code: A.too_small, minimum: Q.minSize.value, type: "set", inclusive: true, exact: false, message: Q.minSize.message }), X.dirty();
    }
    if (Q.maxSize !== null) {
      if (J.data.size > Q.maxSize.value) C(J, { code: A.too_big, maximum: Q.maxSize.value, type: "set", inclusive: true, exact: false, message: Q.maxSize.message }), X.dirty();
    }
    let Y = this._def.valueType;
    function z(G) {
      let U = /* @__PURE__ */ new Set();
      for (let H of G) {
        if (H.status === "aborted") return l;
        if (H.status === "dirty") X.dirty();
        U.add(H.value);
      }
      return { status: X.value, value: U };
    }
    let W = [...J.data.values()].map((G, U) => Y._parse(new Z6(J, G, J.path, U)));
    if (J.common.async) return Promise.all(W).then((G) => z(G));
    else return z(W);
  }
  min($, X) {
    return new _H0({ ...this._def, minSize: { value: $, message: y.toString(X) } });
  }
  max($, X) {
    return new _H0({ ...this._def, maxSize: { value: $, message: y.toString(X) } });
  }
  size($, X) {
    return this.min($, X).max($, X);
  }
  nonempty($) {
    return this.min(1, $);
  }
};
H0.create = ($, X) => {
  return new H0({ valueType: $, minSize: null, maxSize: null, typeName: P.ZodSet, ...o(X) });
};
var oX = class _oX extends e {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse($) {
    let { ctx: X } = this._processInputParams($);
    if (X.parsedType !== R.function) return C(X, { code: A.invalid_type, expected: R.function, received: X.parsedType }), l;
    function J(W, G) {
      return kJ({ data: W, path: X.path, errorMaps: [X.common.contextualErrorMap, X.schemaErrorMap, dX(), R4].filter((U) => !!U), issueData: { code: A.invalid_arguments, argumentsError: G } });
    }
    function Q(W, G) {
      return kJ({ data: W, path: X.path, errorMaps: [X.common.contextualErrorMap, X.schemaErrorMap, dX(), R4].filter((U) => !!U), issueData: { code: A.invalid_return_type, returnTypeError: G } });
    }
    let Y = { errorMap: X.common.contextualErrorMap }, z = X.data;
    if (this._def.returns instanceof K0) {
      let W = this;
      return p$(async function(...G) {
        let U = new H6([]), H = await W._def.args.parseAsync(G, Y).catch((O) => {
          throw U.addIssue(J(G, O)), U;
        }), K = await Reflect.apply(z, this, H);
        return await W._def.returns._def.type.parseAsync(K, Y).catch((O) => {
          throw U.addIssue(Q(K, O)), U;
        });
      });
    } else {
      let W = this;
      return p$(function(...G) {
        let U = W._def.args.safeParse(G, Y);
        if (!U.success) throw new H6([J(G, U.error)]);
        let H = Reflect.apply(z, this, U.data), K = W._def.returns.safeParse(H, Y);
        if (!K.success) throw new H6([Q(H, K.error)]);
        return K.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...$) {
    return new _oX({ ...this._def, args: W4.create($).rest(w1.create()) });
  }
  returns($) {
    return new _oX({ ...this._def, returns: $ });
  }
  implement($) {
    return this.parse($);
  }
  strictImplement($) {
    return this.parse($);
  }
  static create($, X, J) {
    return new _oX({ args: $ ? $ : W4.create([]).rest(w1.create()), returns: X || w1.create(), typeName: P.ZodFunction, ...o(J) });
  }
};
var X8 = class extends e {
  get schema() {
    return this._def.getter();
  }
  _parse($) {
    let { ctx: X } = this._processInputParams($);
    return this._def.getter()._parse({ data: X.data, path: X.path, parent: X });
  }
};
X8.create = ($, X) => {
  return new X8({ getter: $, typeName: P.ZodLazy, ...o(X) });
};
var J8 = class extends e {
  _parse($) {
    if ($.data !== this._def.value) {
      let X = this._getOrReturnCtx($);
      return C(X, { received: X.data, code: A.invalid_literal, expected: this._def.value }), l;
    }
    return { status: "valid", value: $.data };
  }
  get value() {
    return this._def.value;
  }
};
J8.create = ($, X) => {
  return new J8({ value: $, typeName: P.ZodLiteral, ...o(X) });
};
function nK($, X) {
  return new B1({ values: $, typeName: P.ZodEnum, ...o(X) });
}
var B1 = class _B1 extends e {
  _parse($) {
    if (typeof $.data !== "string") {
      let X = this._getOrReturnCtx($), J = this._def.values;
      return C(X, { expected: X$.joinValues(J), received: X.parsedType, code: A.invalid_type }), l;
    }
    if (!this._cache) this._cache = new Set(this._def.values);
    if (!this._cache.has($.data)) {
      let X = this._getOrReturnCtx($), J = this._def.values;
      return C(X, { received: X.data, code: A.invalid_enum_value, options: J }), l;
    }
    return p$($.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    let $ = {};
    for (let X of this._def.values) $[X] = X;
    return $;
  }
  get Values() {
    let $ = {};
    for (let X of this._def.values) $[X] = X;
    return $;
  }
  get Enum() {
    let $ = {};
    for (let X of this._def.values) $[X] = X;
    return $;
  }
  extract($, X = this._def) {
    return _B1.create($, { ...this._def, ...X });
  }
  exclude($, X = this._def) {
    return _B1.create(this.options.filter((J) => !$.includes(J)), { ...this._def, ...X });
  }
};
B1.create = nK;
var Y8 = class extends e {
  _parse($) {
    let X = X$.getValidEnumValues(this._def.values), J = this._getOrReturnCtx($);
    if (J.parsedType !== R.string && J.parsedType !== R.number) {
      let Q = X$.objectValues(X);
      return C(J, { expected: X$.joinValues(Q), received: J.parsedType, code: A.invalid_type }), l;
    }
    if (!this._cache) this._cache = new Set(X$.getValidEnumValues(this._def.values));
    if (!this._cache.has($.data)) {
      let Q = X$.objectValues(X);
      return C(J, { received: J.data, code: A.invalid_enum_value, options: Q }), l;
    }
    return p$($.data);
  }
  get enum() {
    return this._def.values;
  }
};
Y8.create = ($, X) => {
  return new Y8({ values: $, typeName: P.ZodNativeEnum, ...o(X) });
};
var K0 = class extends e {
  unwrap() {
    return this._def.type;
  }
  _parse($) {
    let { ctx: X } = this._processInputParams($);
    if (X.parsedType !== R.promise && X.common.async === false) return C(X, { code: A.invalid_type, expected: R.promise, received: X.parsedType }), l;
    let J = X.parsedType === R.promise ? X.data : Promise.resolve(X.data);
    return p$(J.then((Q) => {
      return this._def.type.parseAsync(Q, { path: X.path, errorMap: X.common.contextualErrorMap });
    }));
  }
};
K0.create = ($, X) => {
  return new K0({ type: $, typeName: P.ZodPromise, ...o(X) });
};
var c6 = class extends e {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === P.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse($) {
    let { status: X, ctx: J } = this._processInputParams($), Q = this._def.effect || null, Y = { addIssue: (z) => {
      if (C(J, z), z.fatal) X.abort();
      else X.dirty();
    }, get path() {
      return J.path;
    } };
    if (Y.addIssue = Y.addIssue.bind(Y), Q.type === "preprocess") {
      let z = Q.transform(J.data, Y);
      if (J.common.async) return Promise.resolve(z).then(async (W) => {
        if (X.value === "aborted") return l;
        let G = await this._def.schema._parseAsync({ data: W, path: J.path, parent: J });
        if (G.status === "aborted") return l;
        if (G.status === "dirty") return z0(G.value);
        if (X.value === "dirty") return z0(G.value);
        return G;
      });
      else {
        if (X.value === "aborted") return l;
        let W = this._def.schema._parseSync({ data: z, path: J.path, parent: J });
        if (W.status === "aborted") return l;
        if (W.status === "dirty") return z0(W.value);
        if (X.value === "dirty") return z0(W.value);
        return W;
      }
    }
    if (Q.type === "refinement") {
      let z = (W) => {
        let G = Q.refinement(W, Y);
        if (J.common.async) return Promise.resolve(G);
        if (G instanceof Promise) throw Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        return W;
      };
      if (J.common.async === false) {
        let W = this._def.schema._parseSync({ data: J.data, path: J.path, parent: J });
        if (W.status === "aborted") return l;
        if (W.status === "dirty") X.dirty();
        return z(W.value), { status: X.value, value: W.value };
      } else return this._def.schema._parseAsync({ data: J.data, path: J.path, parent: J }).then((W) => {
        if (W.status === "aborted") return l;
        if (W.status === "dirty") X.dirty();
        return z(W.value).then(() => {
          return { status: X.value, value: W.value };
        });
      });
    }
    if (Q.type === "transform") if (J.common.async === false) {
      let z = this._def.schema._parseSync({ data: J.data, path: J.path, parent: J });
      if (!O1(z)) return l;
      let W = Q.transform(z.value, Y);
      if (W instanceof Promise) throw Error("Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.");
      return { status: X.value, value: W };
    } else return this._def.schema._parseAsync({ data: J.data, path: J.path, parent: J }).then((z) => {
      if (!O1(z)) return l;
      return Promise.resolve(Q.transform(z.value, Y)).then((W) => ({ status: X.value, value: W }));
    });
    X$.assertNever(Q);
  }
};
c6.create = ($, X, J) => {
  return new c6({ schema: $, typeName: P.ZodEffects, effect: X, ...o(J) });
};
c6.createWithPreprocess = ($, X, J) => {
  return new c6({ schema: X, effect: { type: "preprocess", transform: $ }, typeName: P.ZodEffects, ...o(J) });
};
var D6 = class extends e {
  _parse($) {
    if (this._getType($) === R.undefined) return p$(void 0);
    return this._def.innerType._parse($);
  }
  unwrap() {
    return this._def.innerType;
  }
};
D6.create = ($, X) => {
  return new D6({ innerType: $, typeName: P.ZodOptional, ...o(X) });
};
var S4 = class extends e {
  _parse($) {
    if (this._getType($) === R.null) return p$(null);
    return this._def.innerType._parse($);
  }
  unwrap() {
    return this._def.innerType;
  }
};
S4.create = ($, X) => {
  return new S4({ innerType: $, typeName: P.ZodNullable, ...o(X) });
};
var Q8 = class extends e {
  _parse($) {
    let { ctx: X } = this._processInputParams($), J = X.data;
    if (X.parsedType === R.undefined) J = this._def.defaultValue();
    return this._def.innerType._parse({ data: J, path: X.path, parent: X });
  }
  removeDefault() {
    return this._def.innerType;
  }
};
Q8.create = ($, X) => {
  return new Q8({ innerType: $, typeName: P.ZodDefault, defaultValue: typeof X.default === "function" ? X.default : () => X.default, ...o(X) });
};
var z8 = class extends e {
  _parse($) {
    let { ctx: X } = this._processInputParams($), J = { ...X, common: { ...X.common, issues: [] } }, Q = this._def.innerType._parse({ data: J.data, path: J.path, parent: { ...J } });
    if (rX(Q)) return Q.then((Y) => {
      return { status: "valid", value: Y.status === "valid" ? Y.value : this._def.catchValue({ get error() {
        return new H6(J.common.issues);
      }, input: J.data }) };
    });
    else return { status: "valid", value: Q.status === "valid" ? Q.value : this._def.catchValue({ get error() {
      return new H6(J.common.issues);
    }, input: J.data }) };
  }
  removeCatch() {
    return this._def.innerType;
  }
};
z8.create = ($, X) => {
  return new z8({ innerType: $, typeName: P.ZodCatch, catchValue: typeof X.catch === "function" ? X.catch : () => X.catch, ...o(X) });
};
var hJ = class extends e {
  _parse($) {
    if (this._getType($) !== R.nan) {
      let J = this._getOrReturnCtx($);
      return C(J, { code: A.invalid_type, expected: R.nan, received: J.parsedType }), l;
    }
    return { status: "valid", value: $.data };
  }
};
hJ.create = ($) => {
  return new hJ({ typeName: P.ZodNaN, ...o($) });
};
var sz = class extends e {
  _parse($) {
    let { ctx: X } = this._processInputParams($), J = X.data;
    return this._def.type._parse({ data: J, path: X.path, parent: X });
  }
  unwrap() {
    return this._def.type;
  }
};
var uJ = class _uJ extends e {
  _parse($) {
    let { status: X, ctx: J } = this._processInputParams($);
    if (J.common.async) return (async () => {
      let Y = await this._def.in._parseAsync({ data: J.data, path: J.path, parent: J });
      if (Y.status === "aborted") return l;
      if (Y.status === "dirty") return X.dirty(), z0(Y.value);
      else return this._def.out._parseAsync({ data: Y.value, path: J.path, parent: J });
    })();
    else {
      let Q = this._def.in._parseSync({ data: J.data, path: J.path, parent: J });
      if (Q.status === "aborted") return l;
      if (Q.status === "dirty") return X.dirty(), { status: "dirty", value: Q.value };
      else return this._def.out._parseSync({ data: Q.value, path: J.path, parent: J });
    }
  }
  static create($, X) {
    return new _uJ({ in: $, out: X, typeName: P.ZodPipeline });
  }
};
var W8 = class extends e {
  _parse($) {
    let X = this._def.innerType._parse($), J = (Q) => {
      if (O1(Q)) Q.value = Object.freeze(Q.value);
      return Q;
    };
    return rX(X) ? X.then((Q) => J(Q)) : J(X);
  }
  unwrap() {
    return this._def.innerType;
  }
};
W8.create = ($, X) => {
  return new W8({ innerType: $, typeName: P.ZodReadonly, ...o(X) });
};
var Bl = { object: Z$.lazycreate };
var P;
(function($) {
  $.ZodString = "ZodString", $.ZodNumber = "ZodNumber", $.ZodNaN = "ZodNaN", $.ZodBigInt = "ZodBigInt", $.ZodBoolean = "ZodBoolean", $.ZodDate = "ZodDate", $.ZodSymbol = "ZodSymbol", $.ZodUndefined = "ZodUndefined", $.ZodNull = "ZodNull", $.ZodAny = "ZodAny", $.ZodUnknown = "ZodUnknown", $.ZodNever = "ZodNever", $.ZodVoid = "ZodVoid", $.ZodArray = "ZodArray", $.ZodObject = "ZodObject", $.ZodUnion = "ZodUnion", $.ZodDiscriminatedUnion = "ZodDiscriminatedUnion", $.ZodIntersection = "ZodIntersection", $.ZodTuple = "ZodTuple", $.ZodRecord = "ZodRecord", $.ZodMap = "ZodMap", $.ZodSet = "ZodSet", $.ZodFunction = "ZodFunction", $.ZodLazy = "ZodLazy", $.ZodLiteral = "ZodLiteral", $.ZodEnum = "ZodEnum", $.ZodEffects = "ZodEffects", $.ZodNativeEnum = "ZodNativeEnum", $.ZodOptional = "ZodOptional", $.ZodNullable = "ZodNullable", $.ZodDefault = "ZodDefault", $.ZodCatch = "ZodCatch", $.ZodPromise = "ZodPromise", $.ZodBranded = "ZodBranded", $.ZodPipeline = "ZodPipeline", $.ZodReadonly = "ZodReadonly";
})(P || (P = {}));
var ql = Q4.create;
var Dl = G0.create;
var Ll = hJ.create;
var jl = U0.create;
var Fl = _J.create;
var Il = tX.create;
var Ml = xJ.create;
var Al = aX.create;
var bl = sX.create;
var Pl = TJ.create;
var Zl = w1.create;
var El = z4.create;
var Rl = yJ.create;
var Sl = l6.create;
var dK = Z$.create;
var vl = Z$.strictCreate;
var Cl = eX.create;
var kl = az.create;
var _l = $8.create;
var xl = W4.create;
var Tl = gJ.create;
var yl = fJ.create;
var gl = H0.create;
var fl = oX.create;
var hl = X8.create;
var ul = J8.create;
var ml = B1.create;
var ll = Y8.create;
var cl = K0.create;
var il = c6.create;
var pl = D6.create;
var nl = S4.create;
var dl = c6.createWithPreprocess;
var rl = uJ.create;
var R6 = {};
e4(R6, { version: () => JW, util: () => E, treeifyError: () => iJ, toJSONSchema: () => Z0, toDotPath: () => tK, safeParseAsync: () => k4, safeParse: () => C4, registry: () => M8, regexes: () => _4, prettifyError: () => pJ, parseAsync: () => j1, parse: () => L1, locales: () => I0, isValidJWT: () => wN, isValidBase64URL: () => ON, isValidBase64: () => UW, globalRegistry: () => E6, globalConfig: () => G8, function: () => PQ, formatError: () => B0, flattenError: () => w0, config: () => E$, clone: () => m$, _xid: () => x8, _void: () => DQ, _uuidv7: () => E8, _uuidv6: () => Z8, _uuidv4: () => P8, _uuid: () => b8, _url: () => R8, _uppercase: () => d8, _unknown: () => M1, _union: () => mA, _undefined: () => OQ, _ulid: () => _8, _uint64: () => NQ, _uint32: () => GQ, _tuple: () => GG, _trim: () => e8, _transform: () => tA, _toUpperCase: () => X9, _toLowerCase: () => $9, _templateLiteral: () => z2, _symbol: () => VQ, _success: () => X2, _stringbool: () => AQ, _stringFormat: () => bQ, _string: () => $Q, _startsWith: () => o8, _size: () => i8, _set: () => nA, _safeParseAsync: () => oJ, _safeParse: () => rJ, _regex: () => p8, _refine: () => MQ, _record: () => iA, _readonly: () => Q2, _property: () => WG, _promise: () => G2, _positive: () => JG, _pipe: () => Y2, _parseAsync: () => dJ, _parse: () => nJ, _overwrite: () => N4, _optional: () => aA, _number: () => JQ, _nullable: () => sA, _null: () => wQ, _normalize: () => s8, _nonpositive: () => QG, _nonoptional: () => $2, _nonnegative: () => zG, _never: () => qQ, _negative: () => YG, _nativeEnum: () => rA, _nanoid: () => v8, _nan: () => jQ, _multipleOf: () => A1, _minSize: () => b1, _minLength: () => y4, _min: () => e$, _mime: () => a8, _maxSize: () => A0, _maxLength: () => b0, _max: () => L6, _map: () => pA, _lte: () => L6, _lt: () => H4, _lowercase: () => n8, _literal: () => oA, _length: () => P0, _lazy: () => W2, _ksuid: () => T8, _jwt: () => c8, _isoTime: () => tW, _isoDuration: () => aW, _isoDateTime: () => rW, _isoDate: () => oW, _ipv6: () => g8, _ipv4: () => y8, _intersection: () => cA, _int64: () => KQ, _int32: () => WQ, _int: () => YQ, _includes: () => r8, _guid: () => M0, _gte: () => e$, _gt: () => K4, _float64: () => zQ, _float32: () => QQ, _file: () => FQ, _enum: () => dA, _endsWith: () => t8, _emoji: () => S8, _email: () => A8, _e164: () => l8, _discriminatedUnion: () => lA, _default: () => eA, _date: () => LQ, _custom: () => IQ, _cuid2: () => k8, _cuid: () => C8, _coercedString: () => dW, _coercedNumber: () => sW, _coercedDate: () => XG, _coercedBoolean: () => eW, _coercedBigint: () => $G, _cidrv6: () => h8, _cidrv4: () => f8, _catch: () => J2, _boolean: () => UQ, _bigint: () => HQ, _base64url: () => m8, _base64: () => u8, _array: () => J9, _any: () => BQ, TimePrecision: () => XQ, NEVER: () => mJ, JSONSchemaGenerator: () => ZQ, JSONSchema: () => LN, Doc: () => eJ, $output: () => sY, $input: () => eY, $constructor: () => q, $brand: () => lJ, $ZodXID: () => NY, $ZodVoid: () => SY, $ZodUnknown: () => I1, $ZodUnion: () => j8, $ZodUndefined: () => PY, $ZodUUID: () => YY, $ZodURL: () => zY, $ZodULID: () => KY, $ZodType: () => i, $ZodTuple: () => T4, $ZodTransform: () => j0, $ZodTemplateLiteral: () => rY, $ZodSymbol: () => bY, $ZodSuccess: () => iY, $ZodStringFormat: () => H$, $ZodString: () => x4, $ZodSet: () => TY, $ZodRegistry: () => I8, $ZodRecord: () => _Y, $ZodRealError: () => O0, $ZodReadonly: () => dY, $ZodPromise: () => oY, $ZodPrefault: () => lY, $ZodPipe: () => F0, $ZodOptional: () => hY, $ZodObject: () => L8, $ZodNumberFormat: () => MY, $ZodNumber: () => q8, $ZodNullable: () => uY, $ZodNull: () => ZY, $ZodNonOptional: () => cY, $ZodNever: () => RY, $ZodNanoID: () => GY, $ZodNaN: () => nY, $ZodMap: () => xY, $ZodLiteral: () => gY, $ZodLazy: () => tY, $ZodKSUID: () => VY, $ZodJWT: () => FY, $ZodIntersection: () => kY, $ZodISOTime: () => WW, $ZodISODuration: () => GW, $ZodISODateTime: () => QW, $ZodISODate: () => zW, $ZodIPv6: () => wY, $ZodIPv4: () => OY, $ZodGUID: () => JY, $ZodFunction: () => UG, $ZodFile: () => fY, $ZodError: () => B8, $ZodEnum: () => yY, $ZodEmoji: () => WY, $ZodEmail: () => QY, $ZodE164: () => jY, $ZodDiscriminatedUnion: () => CY, $ZodDefault: () => mY, $ZodDate: () => vY, $ZodCustomStringFormat: () => IY, $ZodCustom: () => aY, $ZodCheckUpperCase: () => o5, $ZodCheckStringFormat: () => q0, $ZodCheckStartsWith: () => a5, $ZodCheckSizeEquals: () => c5, $ZodCheckRegex: () => d5, $ZodCheckProperty: () => e5, $ZodCheckOverwrite: () => XW, $ZodCheckNumberFormat: () => h5, $ZodCheckMultipleOf: () => f5, $ZodCheckMinSize: () => l5, $ZodCheckMinLength: () => p5, $ZodCheckMimeType: () => $W, $ZodCheckMaxSize: () => m5, $ZodCheckMaxLength: () => i5, $ZodCheckLowerCase: () => r5, $ZodCheckLessThan: () => aJ, $ZodCheckLengthEquals: () => n5, $ZodCheckIncludes: () => t5, $ZodCheckGreaterThan: () => sJ, $ZodCheckEndsWith: () => s5, $ZodCheckBigIntFormat: () => u5, $ZodCheck: () => I$, $ZodCatch: () => pY, $ZodCUID2: () => HY, $ZodCUID: () => UY, $ZodCIDRv6: () => qY, $ZodCIDRv4: () => BY, $ZodBoolean: () => D0, $ZodBigIntFormat: () => AY, $ZodBigInt: () => D8, $ZodBase64URL: () => LY, $ZodBase64: () => DY, $ZodAsyncError: () => G4, $ZodArray: () => L0, $ZodAny: () => EY });
var mJ = Object.freeze({ status: "aborted" });
function q($, X, J) {
  function Q(G, U) {
    var H;
    Object.defineProperty(G, "_zod", { value: G._zod ?? {}, enumerable: false }), (H = G._zod).traits ?? (H.traits = /* @__PURE__ */ new Set()), G._zod.traits.add($), X(G, U);
    for (let K in W.prototype) if (!(K in G)) Object.defineProperty(G, K, { value: W.prototype[K].bind(G) });
    G._zod.constr = W, G._zod.def = U;
  }
  let Y = J?.Parent ?? Object;
  class z extends Y {
  }
  Object.defineProperty(z, "name", { value: $ });
  function W(G) {
    var U;
    let H = J?.Parent ? new z() : this;
    Q(H, G), (U = H._zod).deferred ?? (U.deferred = []);
    for (let K of H._zod.deferred) K();
    return H;
  }
  return Object.defineProperty(W, "init", { value: Q }), Object.defineProperty(W, Symbol.hasInstance, { value: (G) => {
    if (J?.Parent && G instanceof J.Parent) return true;
    return G?._zod?.traits?.has($);
  } }), Object.defineProperty(W, "name", { value: $ }), W;
}
var lJ = /* @__PURE__ */ Symbol("zod_brand");
var G4 = class extends Error {
  constructor() {
    super("Encountered Promise during synchronous parse. Use .parseAsync() instead.");
  }
};
var G8 = {};
function E$($) {
  if ($) Object.assign(G8, $);
  return G8;
}
var E = {};
e4(E, { unwrapMessage: () => U8, stringifyPrimitive: () => S, required: () => uM, randomString: () => CM, propertyKeyTypes: () => V8, promiseAllObject: () => vM, primitiveTypes: () => Q5, prefixIssues: () => s$, pick: () => TM, partial: () => hM, optionalKeys: () => z5, omit: () => yM, numKeys: () => kM, nullish: () => v4, normalizeParams: () => Z, merge: () => fM, jsonStringifyReplacer: () => $5, joinValues: () => I, issue: () => U5, isPlainObject: () => V0, isObject: () => N0, getSizableOrigin: () => O8, getParsedType: () => _M, getLengthableOrigin: () => w8, getEnumValues: () => H8, getElementAtPath: () => SM, floatSafeRemainder: () => X5, finalizeIssue: () => K6, extend: () => gM, escapeRegex: () => U4, esc: () => q1, defineLazy: () => W$, createTransparentProxy: () => xM, clone: () => m$, cleanRegex: () => N8, cleanEnum: () => mM, captureStackTrace: () => cJ, cached: () => K8, assignProp: () => J5, assertNotEqual: () => PM, assertNever: () => EM, assertIs: () => ZM, assertEqual: () => bM, assert: () => RM, allowsEval: () => Y5, aborted: () => D1, NUMBER_FORMAT_RANGES: () => W5, Class: () => rK, BIGINT_FORMAT_RANGES: () => G5 });
function bM($) {
  return $;
}
function PM($) {
  return $;
}
function ZM($) {
}
function EM($) {
  throw Error();
}
function RM($) {
}
function H8($) {
  let X = Object.values($).filter((Q) => typeof Q === "number");
  return Object.entries($).filter(([Q, Y]) => X.indexOf(+Q) === -1).map(([Q, Y]) => Y);
}
function I($, X = "|") {
  return $.map((J) => S(J)).join(X);
}
function $5($, X) {
  if (typeof X === "bigint") return X.toString();
  return X;
}
function K8($) {
  return { get value() {
    {
      let J = $();
      return Object.defineProperty(this, "value", { value: J }), J;
    }
    throw Error("cached value already set");
  } };
}
function v4($) {
  return $ === null || $ === void 0;
}
function N8($) {
  let X = $.startsWith("^") ? 1 : 0, J = $.endsWith("$") ? $.length - 1 : $.length;
  return $.slice(X, J);
}
function X5($, X) {
  let J = ($.toString().split(".")[1] || "").length, Q = (X.toString().split(".")[1] || "").length, Y = J > Q ? J : Q, z = Number.parseInt($.toFixed(Y).replace(".", "")), W = Number.parseInt(X.toFixed(Y).replace(".", ""));
  return z % W / 10 ** Y;
}
function W$($, X, J) {
  Object.defineProperty($, X, { get() {
    {
      let Y = J();
      return $[X] = Y, Y;
    }
    throw Error("cached value already set");
  }, set(Y) {
    Object.defineProperty($, X, { value: Y });
  }, configurable: true });
}
function J5($, X, J) {
  Object.defineProperty($, X, { value: J, writable: true, enumerable: true, configurable: true });
}
function SM($, X) {
  if (!X) return $;
  return X.reduce((J, Q) => J?.[Q], $);
}
function vM($) {
  let X = Object.keys($), J = X.map((Q) => $[Q]);
  return Promise.all(J).then((Q) => {
    let Y = {};
    for (let z = 0; z < X.length; z++) Y[X[z]] = Q[z];
    return Y;
  });
}
function CM($ = 10) {
  let J = "";
  for (let Q = 0; Q < $; Q++) J += "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)];
  return J;
}
function q1($) {
  return JSON.stringify($);
}
var cJ = Error.captureStackTrace ? Error.captureStackTrace : (...$) => {
};
function N0($) {
  return typeof $ === "object" && $ !== null && !Array.isArray($);
}
var Y5 = K8(() => {
  if (typeof navigator < "u" && navigator?.userAgent?.includes("Cloudflare")) return false;
  try {
    return new Function(""), true;
  } catch ($) {
    return false;
  }
});
function V0($) {
  if (N0($) === false) return false;
  let X = $.constructor;
  if (X === void 0) return true;
  let J = X.prototype;
  if (N0(J) === false) return false;
  if (Object.prototype.hasOwnProperty.call(J, "isPrototypeOf") === false) return false;
  return true;
}
function kM($) {
  let X = 0;
  for (let J in $) if (Object.prototype.hasOwnProperty.call($, J)) X++;
  return X;
}
var _M = ($) => {
  let X = typeof $;
  switch (X) {
    case "undefined":
      return "undefined";
    case "string":
      return "string";
    case "number":
      return Number.isNaN($) ? "nan" : "number";
    case "boolean":
      return "boolean";
    case "function":
      return "function";
    case "bigint":
      return "bigint";
    case "symbol":
      return "symbol";
    case "object":
      if (Array.isArray($)) return "array";
      if ($ === null) return "null";
      if ($.then && typeof $.then === "function" && $.catch && typeof $.catch === "function") return "promise";
      if (typeof Map < "u" && $ instanceof Map) return "map";
      if (typeof Set < "u" && $ instanceof Set) return "set";
      if (typeof Date < "u" && $ instanceof Date) return "date";
      if (typeof File < "u" && $ instanceof File) return "file";
      return "object";
    default:
      throw Error(`Unknown data type: ${X}`);
  }
};
var V8 = /* @__PURE__ */ new Set(["string", "number", "symbol"]);
var Q5 = /* @__PURE__ */ new Set(["string", "number", "bigint", "boolean", "symbol", "undefined"]);
function U4($) {
  return $.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function m$($, X, J) {
  let Q = new $._zod.constr(X ?? $._zod.def);
  if (!X || J?.parent) Q._zod.parent = $;
  return Q;
}
function Z($) {
  let X = $;
  if (!X) return {};
  if (typeof X === "string") return { error: () => X };
  if (X?.message !== void 0) {
    if (X?.error !== void 0) throw Error("Cannot specify both `message` and `error` params");
    X.error = X.message;
  }
  if (delete X.message, typeof X.error === "string") return { ...X, error: () => X.error };
  return X;
}
function xM($) {
  let X;
  return new Proxy({}, { get(J, Q, Y) {
    return X ?? (X = $()), Reflect.get(X, Q, Y);
  }, set(J, Q, Y, z) {
    return X ?? (X = $()), Reflect.set(X, Q, Y, z);
  }, has(J, Q) {
    return X ?? (X = $()), Reflect.has(X, Q);
  }, deleteProperty(J, Q) {
    return X ?? (X = $()), Reflect.deleteProperty(X, Q);
  }, ownKeys(J) {
    return X ?? (X = $()), Reflect.ownKeys(X);
  }, getOwnPropertyDescriptor(J, Q) {
    return X ?? (X = $()), Reflect.getOwnPropertyDescriptor(X, Q);
  }, defineProperty(J, Q, Y) {
    return X ?? (X = $()), Reflect.defineProperty(X, Q, Y);
  } });
}
function S($) {
  if (typeof $ === "bigint") return $.toString() + "n";
  if (typeof $ === "string") return `"${$}"`;
  return `${$}`;
}
function z5($) {
  return Object.keys($).filter((X) => {
    return $[X]._zod.optin === "optional" && $[X]._zod.optout === "optional";
  });
}
var W5 = { safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], int32: [-2147483648, 2147483647], uint32: [0, 4294967295], float32: [-34028234663852886e22, 34028234663852886e22], float64: [-Number.MAX_VALUE, Number.MAX_VALUE] };
var G5 = { int64: [BigInt("-9223372036854775808"), BigInt("9223372036854775807")], uint64: [BigInt(0), BigInt("18446744073709551615")] };
function TM($, X) {
  let J = {}, Q = $._zod.def;
  for (let Y in X) {
    if (!(Y in Q.shape)) throw Error(`Unrecognized key: "${Y}"`);
    if (!X[Y]) continue;
    J[Y] = Q.shape[Y];
  }
  return m$($, { ...$._zod.def, shape: J, checks: [] });
}
function yM($, X) {
  let J = { ...$._zod.def.shape }, Q = $._zod.def;
  for (let Y in X) {
    if (!(Y in Q.shape)) throw Error(`Unrecognized key: "${Y}"`);
    if (!X[Y]) continue;
    delete J[Y];
  }
  return m$($, { ...$._zod.def, shape: J, checks: [] });
}
function gM($, X) {
  if (!V0(X)) throw Error("Invalid input to extend: expected a plain object");
  let J = { ...$._zod.def, get shape() {
    let Q = { ...$._zod.def.shape, ...X };
    return J5(this, "shape", Q), Q;
  }, checks: [] };
  return m$($, J);
}
function fM($, X) {
  return m$($, { ...$._zod.def, get shape() {
    let J = { ...$._zod.def.shape, ...X._zod.def.shape };
    return J5(this, "shape", J), J;
  }, catchall: X._zod.def.catchall, checks: [] });
}
function hM($, X, J) {
  let Q = X._zod.def.shape, Y = { ...Q };
  if (J) for (let z in J) {
    if (!(z in Q)) throw Error(`Unrecognized key: "${z}"`);
    if (!J[z]) continue;
    Y[z] = $ ? new $({ type: "optional", innerType: Q[z] }) : Q[z];
  }
  else for (let z in Q) Y[z] = $ ? new $({ type: "optional", innerType: Q[z] }) : Q[z];
  return m$(X, { ...X._zod.def, shape: Y, checks: [] });
}
function uM($, X, J) {
  let Q = X._zod.def.shape, Y = { ...Q };
  if (J) for (let z in J) {
    if (!(z in Y)) throw Error(`Unrecognized key: "${z}"`);
    if (!J[z]) continue;
    Y[z] = new $({ type: "nonoptional", innerType: Q[z] });
  }
  else for (let z in Q) Y[z] = new $({ type: "nonoptional", innerType: Q[z] });
  return m$(X, { ...X._zod.def, shape: Y, checks: [] });
}
function D1($, X = 0) {
  for (let J = X; J < $.issues.length; J++) if ($.issues[J]?.continue !== true) return true;
  return false;
}
function s$($, X) {
  return X.map((J) => {
    var Q;
    return (Q = J).path ?? (Q.path = []), J.path.unshift($), J;
  });
}
function U8($) {
  return typeof $ === "string" ? $ : $?.message;
}
function K6($, X, J) {
  let Q = { ...$, path: $.path ?? [] };
  if (!$.message) {
    let Y = U8($.inst?._zod.def?.error?.($)) ?? U8(X?.error?.($)) ?? U8(J.customError?.($)) ?? U8(J.localeError?.($)) ?? "Invalid input";
    Q.message = Y;
  }
  if (delete Q.inst, delete Q.continue, !X?.reportInput) delete Q.input;
  return Q;
}
function O8($) {
  if ($ instanceof Set) return "set";
  if ($ instanceof Map) return "map";
  if ($ instanceof File) return "file";
  return "unknown";
}
function w8($) {
  if (Array.isArray($)) return "array";
  if (typeof $ === "string") return "string";
  return "unknown";
}
function U5(...$) {
  let [X, J, Q] = $;
  if (typeof X === "string") return { message: X, code: "custom", input: J, inst: Q };
  return { ...X };
}
function mM($) {
  return Object.entries($).filter(([X, J]) => {
    return Number.isNaN(Number.parseInt(X, 10));
  }).map((X) => X[1]);
}
var rK = class {
  constructor(...$) {
  }
};
var oK = ($, X) => {
  $.name = "$ZodError", Object.defineProperty($, "_zod", { value: $._zod, enumerable: false }), Object.defineProperty($, "issues", { value: X, enumerable: false }), Object.defineProperty($, "message", { get() {
    return JSON.stringify(X, $5, 2);
  }, enumerable: true });
};
var B8 = q("$ZodError", oK);
var O0 = q("$ZodError", oK, { Parent: Error });
function w0($, X = (J) => J.message) {
  let J = {}, Q = [];
  for (let Y of $.issues) if (Y.path.length > 0) J[Y.path[0]] = J[Y.path[0]] || [], J[Y.path[0]].push(X(Y));
  else Q.push(X(Y));
  return { formErrors: Q, fieldErrors: J };
}
function B0($, X) {
  let J = X || function(z) {
    return z.message;
  }, Q = { _errors: [] }, Y = (z) => {
    for (let W of z.issues) if (W.code === "invalid_union" && W.errors.length) W.errors.map((G) => Y({ issues: G }));
    else if (W.code === "invalid_key") Y({ issues: W.issues });
    else if (W.code === "invalid_element") Y({ issues: W.issues });
    else if (W.path.length === 0) Q._errors.push(J(W));
    else {
      let G = Q, U = 0;
      while (U < W.path.length) {
        let H = W.path[U];
        if (U !== W.path.length - 1) G[H] = G[H] || { _errors: [] };
        else G[H] = G[H] || { _errors: [] }, G[H]._errors.push(J(W));
        G = G[H], U++;
      }
    }
  };
  return Y($), Q;
}
function iJ($, X) {
  let J = X || function(z) {
    return z.message;
  }, Q = { errors: [] }, Y = (z, W = []) => {
    var G, U;
    for (let H of z.issues) if (H.code === "invalid_union" && H.errors.length) H.errors.map((K) => Y({ issues: K }, H.path));
    else if (H.code === "invalid_key") Y({ issues: H.issues }, H.path);
    else if (H.code === "invalid_element") Y({ issues: H.issues }, H.path);
    else {
      let K = [...W, ...H.path];
      if (K.length === 0) {
        Q.errors.push(J(H));
        continue;
      }
      let V = Q, O = 0;
      while (O < K.length) {
        let N = K[O], w = O === K.length - 1;
        if (typeof N === "string") V.properties ?? (V.properties = {}), (G = V.properties)[N] ?? (G[N] = { errors: [] }), V = V.properties[N];
        else V.items ?? (V.items = []), (U = V.items)[N] ?? (U[N] = { errors: [] }), V = V.items[N];
        if (w) V.errors.push(J(H));
        O++;
      }
    }
  };
  return Y($), Q;
}
function tK($) {
  let X = [];
  for (let J of $) if (typeof J === "number") X.push(`[${J}]`);
  else if (typeof J === "symbol") X.push(`[${JSON.stringify(String(J))}]`);
  else if (/[^\w$]/.test(J)) X.push(`[${JSON.stringify(J)}]`);
  else {
    if (X.length) X.push(".");
    X.push(J);
  }
  return X.join("");
}
function pJ($) {
  let X = [], J = [...$.issues].sort((Q, Y) => Q.path.length - Y.path.length);
  for (let Q of J) if (X.push(`\u2716 ${Q.message}`), Q.path?.length) X.push(`  \u2192 at ${tK(Q.path)}`);
  return X.join(`
`);
}
var nJ = ($) => (X, J, Q, Y) => {
  let z = Q ? Object.assign(Q, { async: false }) : { async: false }, W = X._zod.run({ value: J, issues: [] }, z);
  if (W instanceof Promise) throw new G4();
  if (W.issues.length) {
    let G = new (Y?.Err ?? $)(W.issues.map((U) => K6(U, z, E$())));
    throw cJ(G, Y?.callee), G;
  }
  return W.value;
};
var L1 = nJ(O0);
var dJ = ($) => async (X, J, Q, Y) => {
  let z = Q ? Object.assign(Q, { async: true }) : { async: true }, W = X._zod.run({ value: J, issues: [] }, z);
  if (W instanceof Promise) W = await W;
  if (W.issues.length) {
    let G = new (Y?.Err ?? $)(W.issues.map((U) => K6(U, z, E$())));
    throw cJ(G, Y?.callee), G;
  }
  return W.value;
};
var j1 = dJ(O0);
var rJ = ($) => (X, J, Q) => {
  let Y = Q ? { ...Q, async: false } : { async: false }, z = X._zod.run({ value: J, issues: [] }, Y);
  if (z instanceof Promise) throw new G4();
  return z.issues.length ? { success: false, error: new ($ ?? B8)(z.issues.map((W) => K6(W, Y, E$()))) } : { success: true, data: z.value };
};
var C4 = rJ(O0);
var oJ = ($) => async (X, J, Q) => {
  let Y = Q ? Object.assign(Q, { async: true }) : { async: true }, z = X._zod.run({ value: J, issues: [] }, Y);
  if (z instanceof Promise) z = await z;
  return z.issues.length ? { success: false, error: new $(z.issues.map((W) => K6(W, Y, E$()))) } : { success: true, data: z.value };
};
var k4 = oJ(O0);
var _4 = {};
e4(_4, { xid: () => V5, uuid7: () => nM, uuid6: () => pM, uuid4: () => iM, uuid: () => F1, uppercase: () => g5, unicodeEmail: () => oM, undefined: () => T5, ulid: () => N5, time: () => E5, string: () => S5, rfc5322Email: () => rM, number: () => k5, null: () => x5, nanoid: () => w5, lowercase: () => y5, ksuid: () => O5, ipv6: () => F5, ipv4: () => j5, integer: () => C5, html5Email: () => dM, hostname: () => b5, guid: () => q5, extendedDuration: () => cM, emoji: () => L5, email: () => D5, e164: () => P5, duration: () => B5, domain: () => sM, datetime: () => R5, date: () => Z5, cuid2: () => K5, cuid: () => H5, cidrv6: () => M5, cidrv4: () => I5, browserEmail: () => tM, boolean: () => _5, bigint: () => v5, base64url: () => tJ, base64: () => A5, _emoji: () => aM });
var H5 = /^[cC][^\s-]{8,}$/;
var K5 = /^[0-9a-z]+$/;
var N5 = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;
var V5 = /^[0-9a-vA-V]{20}$/;
var O5 = /^[A-Za-z0-9]{27}$/;
var w5 = /^[a-zA-Z0-9_-]{21}$/;
var B5 = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/;
var cM = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var q5 = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
var F1 = ($) => {
  if (!$) return /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000)$/;
  return new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${$}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`);
};
var iM = F1(4);
var pM = F1(6);
var nM = F1(7);
var D5 = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
var dM = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
var rM = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
var oM = /^[^\s@"]{1,64}@[^\s@]{1,255}$/u;
var tM = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
var aM = "^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$";
function L5() {
  return new RegExp("^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$", "u");
}
var j5 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var F5 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::|([0-9a-fA-F]{1,4})?::([0-9a-fA-F]{1,4}:?){0,6})$/;
var I5 = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/;
var M5 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::|([0-9a-fA-F]{1,4})?::([0-9a-fA-F]{1,4}:?){0,6})\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var A5 = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/;
var tJ = /^[A-Za-z0-9_-]*$/;
var b5 = /^([a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+$/;
var sM = /^([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
var P5 = /^\+(?:[0-9]){6,14}[0-9]$/;
var aK = "(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))";
var Z5 = new RegExp(`^${aK}$`);
function sK($) {
  return typeof $.precision === "number" ? $.precision === -1 ? "(?:[01]\\d|2[0-3]):[0-5]\\d" : $.precision === 0 ? "(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d" : `(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{${$.precision}}` : "(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?";
}
function E5($) {
  return new RegExp(`^${sK($)}$`);
}
function R5($) {
  let X = sK({ precision: $.precision }), J = ["Z"];
  if ($.local) J.push("");
  if ($.offset) J.push("([+-]\\d{2}:\\d{2})");
  let Q = `${X}(?:${J.join("|")})`;
  return new RegExp(`^${aK}T(?:${Q})$`);
}
var S5 = ($) => {
  let X = $ ? `[\\s\\S]{${$?.minimum ?? 0},${$?.maximum ?? ""}}` : "[\\s\\S]*";
  return new RegExp(`^${X}$`);
};
var v5 = /^\d+n?$/;
var C5 = /^\d+$/;
var k5 = /^-?\d+(?:\.\d+)?/i;
var _5 = /true|false/i;
var x5 = /null/i;
var T5 = /undefined/i;
var y5 = /^[^A-Z]*$/;
var g5 = /^[^a-z]*$/;
var I$ = q("$ZodCheck", ($, X) => {
  var J;
  $._zod ?? ($._zod = {}), $._zod.def = X, (J = $._zod).onattach ?? (J.onattach = []);
});
var $N = { number: "number", bigint: "bigint", object: "date" };
var aJ = q("$ZodCheckLessThan", ($, X) => {
  I$.init($, X);
  let J = $N[typeof X.value];
  $._zod.onattach.push((Q) => {
    let Y = Q._zod.bag, z = (X.inclusive ? Y.maximum : Y.exclusiveMaximum) ?? Number.POSITIVE_INFINITY;
    if (X.value < z) if (X.inclusive) Y.maximum = X.value;
    else Y.exclusiveMaximum = X.value;
  }), $._zod.check = (Q) => {
    if (X.inclusive ? Q.value <= X.value : Q.value < X.value) return;
    Q.issues.push({ origin: J, code: "too_big", maximum: X.value, input: Q.value, inclusive: X.inclusive, inst: $, continue: !X.abort });
  };
});
var sJ = q("$ZodCheckGreaterThan", ($, X) => {
  I$.init($, X);
  let J = $N[typeof X.value];
  $._zod.onattach.push((Q) => {
    let Y = Q._zod.bag, z = (X.inclusive ? Y.minimum : Y.exclusiveMinimum) ?? Number.NEGATIVE_INFINITY;
    if (X.value > z) if (X.inclusive) Y.minimum = X.value;
    else Y.exclusiveMinimum = X.value;
  }), $._zod.check = (Q) => {
    if (X.inclusive ? Q.value >= X.value : Q.value > X.value) return;
    Q.issues.push({ origin: J, code: "too_small", minimum: X.value, input: Q.value, inclusive: X.inclusive, inst: $, continue: !X.abort });
  };
});
var f5 = q("$ZodCheckMultipleOf", ($, X) => {
  I$.init($, X), $._zod.onattach.push((J) => {
    var Q;
    (Q = J._zod.bag).multipleOf ?? (Q.multipleOf = X.value);
  }), $._zod.check = (J) => {
    if (typeof J.value !== typeof X.value) throw Error("Cannot mix number and bigint in multiple_of check.");
    if (typeof J.value === "bigint" ? J.value % X.value === BigInt(0) : X5(J.value, X.value) === 0) return;
    J.issues.push({ origin: typeof J.value, code: "not_multiple_of", divisor: X.value, input: J.value, inst: $, continue: !X.abort });
  };
});
var h5 = q("$ZodCheckNumberFormat", ($, X) => {
  I$.init($, X), X.format = X.format || "float64";
  let J = X.format?.includes("int"), Q = J ? "int" : "number", [Y, z] = W5[X.format];
  $._zod.onattach.push((W) => {
    let G = W._zod.bag;
    if (G.format = X.format, G.minimum = Y, G.maximum = z, J) G.pattern = C5;
  }), $._zod.check = (W) => {
    let G = W.value;
    if (J) {
      if (!Number.isInteger(G)) {
        W.issues.push({ expected: Q, format: X.format, code: "invalid_type", input: G, inst: $ });
        return;
      }
      if (!Number.isSafeInteger(G)) {
        if (G > 0) W.issues.push({ input: G, code: "too_big", maximum: Number.MAX_SAFE_INTEGER, note: "Integers must be within the safe integer range.", inst: $, origin: Q, continue: !X.abort });
        else W.issues.push({ input: G, code: "too_small", minimum: Number.MIN_SAFE_INTEGER, note: "Integers must be within the safe integer range.", inst: $, origin: Q, continue: !X.abort });
        return;
      }
    }
    if (G < Y) W.issues.push({ origin: "number", input: G, code: "too_small", minimum: Y, inclusive: true, inst: $, continue: !X.abort });
    if (G > z) W.issues.push({ origin: "number", input: G, code: "too_big", maximum: z, inst: $ });
  };
});
var u5 = q("$ZodCheckBigIntFormat", ($, X) => {
  I$.init($, X);
  let [J, Q] = G5[X.format];
  $._zod.onattach.push((Y) => {
    let z = Y._zod.bag;
    z.format = X.format, z.minimum = J, z.maximum = Q;
  }), $._zod.check = (Y) => {
    let z = Y.value;
    if (z < J) Y.issues.push({ origin: "bigint", input: z, code: "too_small", minimum: J, inclusive: true, inst: $, continue: !X.abort });
    if (z > Q) Y.issues.push({ origin: "bigint", input: z, code: "too_big", maximum: Q, inst: $ });
  };
});
var m5 = q("$ZodCheckMaxSize", ($, X) => {
  I$.init($, X), $._zod.when = (J) => {
    let Q = J.value;
    return !v4(Q) && Q.size !== void 0;
  }, $._zod.onattach.push((J) => {
    let Q = J._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
    if (X.maximum < Q) J._zod.bag.maximum = X.maximum;
  }), $._zod.check = (J) => {
    let Q = J.value;
    if (Q.size <= X.maximum) return;
    J.issues.push({ origin: O8(Q), code: "too_big", maximum: X.maximum, input: Q, inst: $, continue: !X.abort });
  };
});
var l5 = q("$ZodCheckMinSize", ($, X) => {
  I$.init($, X), $._zod.when = (J) => {
    let Q = J.value;
    return !v4(Q) && Q.size !== void 0;
  }, $._zod.onattach.push((J) => {
    let Q = J._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
    if (X.minimum > Q) J._zod.bag.minimum = X.minimum;
  }), $._zod.check = (J) => {
    let Q = J.value;
    if (Q.size >= X.minimum) return;
    J.issues.push({ origin: O8(Q), code: "too_small", minimum: X.minimum, input: Q, inst: $, continue: !X.abort });
  };
});
var c5 = q("$ZodCheckSizeEquals", ($, X) => {
  I$.init($, X), $._zod.when = (J) => {
    let Q = J.value;
    return !v4(Q) && Q.size !== void 0;
  }, $._zod.onattach.push((J) => {
    let Q = J._zod.bag;
    Q.minimum = X.size, Q.maximum = X.size, Q.size = X.size;
  }), $._zod.check = (J) => {
    let Q = J.value, Y = Q.size;
    if (Y === X.size) return;
    let z = Y > X.size;
    J.issues.push({ origin: O8(Q), ...z ? { code: "too_big", maximum: X.size } : { code: "too_small", minimum: X.size }, inclusive: true, exact: true, input: J.value, inst: $, continue: !X.abort });
  };
});
var i5 = q("$ZodCheckMaxLength", ($, X) => {
  I$.init($, X), $._zod.when = (J) => {
    let Q = J.value;
    return !v4(Q) && Q.length !== void 0;
  }, $._zod.onattach.push((J) => {
    let Q = J._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
    if (X.maximum < Q) J._zod.bag.maximum = X.maximum;
  }), $._zod.check = (J) => {
    let Q = J.value;
    if (Q.length <= X.maximum) return;
    let z = w8(Q);
    J.issues.push({ origin: z, code: "too_big", maximum: X.maximum, inclusive: true, input: Q, inst: $, continue: !X.abort });
  };
});
var p5 = q("$ZodCheckMinLength", ($, X) => {
  I$.init($, X), $._zod.when = (J) => {
    let Q = J.value;
    return !v4(Q) && Q.length !== void 0;
  }, $._zod.onattach.push((J) => {
    let Q = J._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
    if (X.minimum > Q) J._zod.bag.minimum = X.minimum;
  }), $._zod.check = (J) => {
    let Q = J.value;
    if (Q.length >= X.minimum) return;
    let z = w8(Q);
    J.issues.push({ origin: z, code: "too_small", minimum: X.minimum, inclusive: true, input: Q, inst: $, continue: !X.abort });
  };
});
var n5 = q("$ZodCheckLengthEquals", ($, X) => {
  I$.init($, X), $._zod.when = (J) => {
    let Q = J.value;
    return !v4(Q) && Q.length !== void 0;
  }, $._zod.onattach.push((J) => {
    let Q = J._zod.bag;
    Q.minimum = X.length, Q.maximum = X.length, Q.length = X.length;
  }), $._zod.check = (J) => {
    let Q = J.value, Y = Q.length;
    if (Y === X.length) return;
    let z = w8(Q), W = Y > X.length;
    J.issues.push({ origin: z, ...W ? { code: "too_big", maximum: X.length } : { code: "too_small", minimum: X.length }, inclusive: true, exact: true, input: J.value, inst: $, continue: !X.abort });
  };
});
var q0 = q("$ZodCheckStringFormat", ($, X) => {
  var J, Q;
  if (I$.init($, X), $._zod.onattach.push((Y) => {
    let z = Y._zod.bag;
    if (z.format = X.format, X.pattern) z.patterns ?? (z.patterns = /* @__PURE__ */ new Set()), z.patterns.add(X.pattern);
  }), X.pattern) (J = $._zod).check ?? (J.check = (Y) => {
    if (X.pattern.lastIndex = 0, X.pattern.test(Y.value)) return;
    Y.issues.push({ origin: "string", code: "invalid_format", format: X.format, input: Y.value, ...X.pattern ? { pattern: X.pattern.toString() } : {}, inst: $, continue: !X.abort });
  });
  else (Q = $._zod).check ?? (Q.check = () => {
  });
});
var d5 = q("$ZodCheckRegex", ($, X) => {
  q0.init($, X), $._zod.check = (J) => {
    if (X.pattern.lastIndex = 0, X.pattern.test(J.value)) return;
    J.issues.push({ origin: "string", code: "invalid_format", format: "regex", input: J.value, pattern: X.pattern.toString(), inst: $, continue: !X.abort });
  };
});
var r5 = q("$ZodCheckLowerCase", ($, X) => {
  X.pattern ?? (X.pattern = y5), q0.init($, X);
});
var o5 = q("$ZodCheckUpperCase", ($, X) => {
  X.pattern ?? (X.pattern = g5), q0.init($, X);
});
var t5 = q("$ZodCheckIncludes", ($, X) => {
  I$.init($, X);
  let J = U4(X.includes), Q = new RegExp(typeof X.position === "number" ? `^.{${X.position}}${J}` : J);
  X.pattern = Q, $._zod.onattach.push((Y) => {
    let z = Y._zod.bag;
    z.patterns ?? (z.patterns = /* @__PURE__ */ new Set()), z.patterns.add(Q);
  }), $._zod.check = (Y) => {
    if (Y.value.includes(X.includes, X.position)) return;
    Y.issues.push({ origin: "string", code: "invalid_format", format: "includes", includes: X.includes, input: Y.value, inst: $, continue: !X.abort });
  };
});
var a5 = q("$ZodCheckStartsWith", ($, X) => {
  I$.init($, X);
  let J = new RegExp(`^${U4(X.prefix)}.*`);
  X.pattern ?? (X.pattern = J), $._zod.onattach.push((Q) => {
    let Y = Q._zod.bag;
    Y.patterns ?? (Y.patterns = /* @__PURE__ */ new Set()), Y.patterns.add(J);
  }), $._zod.check = (Q) => {
    if (Q.value.startsWith(X.prefix)) return;
    Q.issues.push({ origin: "string", code: "invalid_format", format: "starts_with", prefix: X.prefix, input: Q.value, inst: $, continue: !X.abort });
  };
});
var s5 = q("$ZodCheckEndsWith", ($, X) => {
  I$.init($, X);
  let J = new RegExp(`.*${U4(X.suffix)}$`);
  X.pattern ?? (X.pattern = J), $._zod.onattach.push((Q) => {
    let Y = Q._zod.bag;
    Y.patterns ?? (Y.patterns = /* @__PURE__ */ new Set()), Y.patterns.add(J);
  }), $._zod.check = (Q) => {
    if (Q.value.endsWith(X.suffix)) return;
    Q.issues.push({ origin: "string", code: "invalid_format", format: "ends_with", suffix: X.suffix, input: Q.value, inst: $, continue: !X.abort });
  };
});
function eK($, X, J) {
  if ($.issues.length) X.issues.push(...s$(J, $.issues));
}
var e5 = q("$ZodCheckProperty", ($, X) => {
  I$.init($, X), $._zod.check = (J) => {
    let Q = X.schema._zod.run({ value: J.value[X.property], issues: [] }, {});
    if (Q instanceof Promise) return Q.then((Y) => eK(Y, J, X.property));
    eK(Q, J, X.property);
    return;
  };
});
var $W = q("$ZodCheckMimeType", ($, X) => {
  I$.init($, X);
  let J = new Set(X.mime);
  $._zod.onattach.push((Q) => {
    Q._zod.bag.mime = X.mime;
  }), $._zod.check = (Q) => {
    if (J.has(Q.value.type)) return;
    Q.issues.push({ code: "invalid_value", values: X.mime, input: Q.value.type, inst: $ });
  };
});
var XW = q("$ZodCheckOverwrite", ($, X) => {
  I$.init($, X), $._zod.check = (J) => {
    J.value = X.tx(J.value);
  };
});
var eJ = class {
  constructor($ = []) {
    if (this.content = [], this.indent = 0, this) this.args = $;
  }
  indented($) {
    this.indent += 1, $(this), this.indent -= 1;
  }
  write($) {
    if (typeof $ === "function") {
      $(this, { execution: "sync" }), $(this, { execution: "async" });
      return;
    }
    let J = $.split(`
`).filter((z) => z), Q = Math.min(...J.map((z) => z.length - z.trimStart().length)), Y = J.map((z) => z.slice(Q)).map((z) => " ".repeat(this.indent * 2) + z);
    for (let z of Y) this.content.push(z);
  }
  compile() {
    let $ = Function, X = this?.args, Q = [...(this?.content ?? [""]).map((Y) => `  ${Y}`)];
    return new $(...X, Q.join(`
`));
  }
};
var JW = { major: 4, minor: 0, patch: 0 };
var i = q("$ZodType", ($, X) => {
  var J;
  $ ?? ($ = {}), $._zod.def = X, $._zod.bag = $._zod.bag || {}, $._zod.version = JW;
  let Q = [...$._zod.def.checks ?? []];
  if ($._zod.traits.has("$ZodCheck")) Q.unshift($);
  for (let Y of Q) for (let z of Y._zod.onattach) z($);
  if (Q.length === 0) (J = $._zod).deferred ?? (J.deferred = []), $._zod.deferred?.push(() => {
    $._zod.run = $._zod.parse;
  });
  else {
    let Y = (z, W, G) => {
      let U = D1(z), H;
      for (let K of W) {
        if (K._zod.when) {
          if (!K._zod.when(z)) continue;
        } else if (U) continue;
        let V = z.issues.length, O = K._zod.check(z);
        if (O instanceof Promise && G?.async === false) throw new G4();
        if (H || O instanceof Promise) H = (H ?? Promise.resolve()).then(async () => {
          if (await O, z.issues.length === V) return;
          if (!U) U = D1(z, V);
        });
        else {
          if (z.issues.length === V) continue;
          if (!U) U = D1(z, V);
        }
      }
      if (H) return H.then(() => {
        return z;
      });
      return z;
    };
    $._zod.run = (z, W) => {
      let G = $._zod.parse(z, W);
      if (G instanceof Promise) {
        if (W.async === false) throw new G4();
        return G.then((U) => Y(U, Q, W));
      }
      return Y(G, Q, W);
    };
  }
  $["~standard"] = { validate: (Y) => {
    try {
      let z = C4($, Y);
      return z.success ? { value: z.data } : { issues: z.error?.issues };
    } catch (z) {
      return k4($, Y).then((W) => W.success ? { value: W.data } : { issues: W.error?.issues });
    }
  }, vendor: "zod", version: 1 };
});
var x4 = q("$ZodString", ($, X) => {
  i.init($, X), $._zod.pattern = [...$?._zod.bag?.patterns ?? []].pop() ?? S5($._zod.bag), $._zod.parse = (J, Q) => {
    if (X.coerce) try {
      J.value = String(J.value);
    } catch (Y) {
    }
    if (typeof J.value === "string") return J;
    return J.issues.push({ expected: "string", code: "invalid_type", input: J.value, inst: $ }), J;
  };
});
var H$ = q("$ZodStringFormat", ($, X) => {
  q0.init($, X), x4.init($, X);
});
var JY = q("$ZodGUID", ($, X) => {
  X.pattern ?? (X.pattern = q5), H$.init($, X);
});
var YY = q("$ZodUUID", ($, X) => {
  if (X.version) {
    let Q = { v1: 1, v2: 2, v3: 3, v4: 4, v5: 5, v6: 6, v7: 7, v8: 8 }[X.version];
    if (Q === void 0) throw Error(`Invalid UUID version: "${X.version}"`);
    X.pattern ?? (X.pattern = F1(Q));
  } else X.pattern ?? (X.pattern = F1());
  H$.init($, X);
});
var QY = q("$ZodEmail", ($, X) => {
  X.pattern ?? (X.pattern = D5), H$.init($, X);
});
var zY = q("$ZodURL", ($, X) => {
  H$.init($, X), $._zod.check = (J) => {
    try {
      let Q = J.value, Y = new URL(Q), z = Y.href;
      if (X.hostname) {
        if (X.hostname.lastIndex = 0, !X.hostname.test(Y.hostname)) J.issues.push({ code: "invalid_format", format: "url", note: "Invalid hostname", pattern: b5.source, input: J.value, inst: $, continue: !X.abort });
      }
      if (X.protocol) {
        if (X.protocol.lastIndex = 0, !X.protocol.test(Y.protocol.endsWith(":") ? Y.protocol.slice(0, -1) : Y.protocol)) J.issues.push({ code: "invalid_format", format: "url", note: "Invalid protocol", pattern: X.protocol.source, input: J.value, inst: $, continue: !X.abort });
      }
      if (!Q.endsWith("/") && z.endsWith("/")) J.value = z.slice(0, -1);
      else J.value = z;
      return;
    } catch (Q) {
      J.issues.push({ code: "invalid_format", format: "url", input: J.value, inst: $, continue: !X.abort });
    }
  };
});
var WY = q("$ZodEmoji", ($, X) => {
  X.pattern ?? (X.pattern = L5()), H$.init($, X);
});
var GY = q("$ZodNanoID", ($, X) => {
  X.pattern ?? (X.pattern = w5), H$.init($, X);
});
var UY = q("$ZodCUID", ($, X) => {
  X.pattern ?? (X.pattern = H5), H$.init($, X);
});
var HY = q("$ZodCUID2", ($, X) => {
  X.pattern ?? (X.pattern = K5), H$.init($, X);
});
var KY = q("$ZodULID", ($, X) => {
  X.pattern ?? (X.pattern = N5), H$.init($, X);
});
var NY = q("$ZodXID", ($, X) => {
  X.pattern ?? (X.pattern = V5), H$.init($, X);
});
var VY = q("$ZodKSUID", ($, X) => {
  X.pattern ?? (X.pattern = O5), H$.init($, X);
});
var QW = q("$ZodISODateTime", ($, X) => {
  X.pattern ?? (X.pattern = R5(X)), H$.init($, X);
});
var zW = q("$ZodISODate", ($, X) => {
  X.pattern ?? (X.pattern = Z5), H$.init($, X);
});
var WW = q("$ZodISOTime", ($, X) => {
  X.pattern ?? (X.pattern = E5(X)), H$.init($, X);
});
var GW = q("$ZodISODuration", ($, X) => {
  X.pattern ?? (X.pattern = B5), H$.init($, X);
});
var OY = q("$ZodIPv4", ($, X) => {
  X.pattern ?? (X.pattern = j5), H$.init($, X), $._zod.onattach.push((J) => {
    let Q = J._zod.bag;
    Q.format = "ipv4";
  });
});
var wY = q("$ZodIPv6", ($, X) => {
  X.pattern ?? (X.pattern = F5), H$.init($, X), $._zod.onattach.push((J) => {
    let Q = J._zod.bag;
    Q.format = "ipv6";
  }), $._zod.check = (J) => {
    try {
      new URL(`http://[${J.value}]`);
    } catch {
      J.issues.push({ code: "invalid_format", format: "ipv6", input: J.value, inst: $, continue: !X.abort });
    }
  };
});
var BY = q("$ZodCIDRv4", ($, X) => {
  X.pattern ?? (X.pattern = I5), H$.init($, X);
});
var qY = q("$ZodCIDRv6", ($, X) => {
  X.pattern ?? (X.pattern = M5), H$.init($, X), $._zod.check = (J) => {
    let [Q, Y] = J.value.split("/");
    try {
      if (!Y) throw Error();
      let z = Number(Y);
      if (`${z}` !== Y) throw Error();
      if (z < 0 || z > 128) throw Error();
      new URL(`http://[${Q}]`);
    } catch {
      J.issues.push({ code: "invalid_format", format: "cidrv6", input: J.value, inst: $, continue: !X.abort });
    }
  };
});
function UW($) {
  if ($ === "") return true;
  if ($.length % 4 !== 0) return false;
  try {
    return atob($), true;
  } catch {
    return false;
  }
}
var DY = q("$ZodBase64", ($, X) => {
  X.pattern ?? (X.pattern = A5), H$.init($, X), $._zod.onattach.push((J) => {
    J._zod.bag.contentEncoding = "base64";
  }), $._zod.check = (J) => {
    if (UW(J.value)) return;
    J.issues.push({ code: "invalid_format", format: "base64", input: J.value, inst: $, continue: !X.abort });
  };
});
function ON($) {
  if (!tJ.test($)) return false;
  let X = $.replace(/[-_]/g, (Q) => Q === "-" ? "+" : "/"), J = X.padEnd(Math.ceil(X.length / 4) * 4, "=");
  return UW(J);
}
var LY = q("$ZodBase64URL", ($, X) => {
  X.pattern ?? (X.pattern = tJ), H$.init($, X), $._zod.onattach.push((J) => {
    J._zod.bag.contentEncoding = "base64url";
  }), $._zod.check = (J) => {
    if (ON(J.value)) return;
    J.issues.push({ code: "invalid_format", format: "base64url", input: J.value, inst: $, continue: !X.abort });
  };
});
var jY = q("$ZodE164", ($, X) => {
  X.pattern ?? (X.pattern = P5), H$.init($, X);
});
function wN($, X = null) {
  try {
    let J = $.split(".");
    if (J.length !== 3) return false;
    let [Q] = J;
    if (!Q) return false;
    let Y = JSON.parse(atob(Q));
    if ("typ" in Y && Y?.typ !== "JWT") return false;
    if (!Y.alg) return false;
    if (X && (!("alg" in Y) || Y.alg !== X)) return false;
    return true;
  } catch {
    return false;
  }
}
var FY = q("$ZodJWT", ($, X) => {
  H$.init($, X), $._zod.check = (J) => {
    if (wN(J.value, X.alg)) return;
    J.issues.push({ code: "invalid_format", format: "jwt", input: J.value, inst: $, continue: !X.abort });
  };
});
var IY = q("$ZodCustomStringFormat", ($, X) => {
  H$.init($, X), $._zod.check = (J) => {
    if (X.fn(J.value)) return;
    J.issues.push({ code: "invalid_format", format: X.format, input: J.value, inst: $, continue: !X.abort });
  };
});
var q8 = q("$ZodNumber", ($, X) => {
  i.init($, X), $._zod.pattern = $._zod.bag.pattern ?? k5, $._zod.parse = (J, Q) => {
    if (X.coerce) try {
      J.value = Number(J.value);
    } catch (W) {
    }
    let Y = J.value;
    if (typeof Y === "number" && !Number.isNaN(Y) && Number.isFinite(Y)) return J;
    let z = typeof Y === "number" ? Number.isNaN(Y) ? "NaN" : !Number.isFinite(Y) ? "Infinity" : void 0 : void 0;
    return J.issues.push({ expected: "number", code: "invalid_type", input: Y, inst: $, ...z ? { received: z } : {} }), J;
  };
});
var MY = q("$ZodNumber", ($, X) => {
  h5.init($, X), q8.init($, X);
});
var D0 = q("$ZodBoolean", ($, X) => {
  i.init($, X), $._zod.pattern = _5, $._zod.parse = (J, Q) => {
    if (X.coerce) try {
      J.value = Boolean(J.value);
    } catch (z) {
    }
    let Y = J.value;
    if (typeof Y === "boolean") return J;
    return J.issues.push({ expected: "boolean", code: "invalid_type", input: Y, inst: $ }), J;
  };
});
var D8 = q("$ZodBigInt", ($, X) => {
  i.init($, X), $._zod.pattern = v5, $._zod.parse = (J, Q) => {
    if (X.coerce) try {
      J.value = BigInt(J.value);
    } catch (Y) {
    }
    if (typeof J.value === "bigint") return J;
    return J.issues.push({ expected: "bigint", code: "invalid_type", input: J.value, inst: $ }), J;
  };
});
var AY = q("$ZodBigInt", ($, X) => {
  u5.init($, X), D8.init($, X);
});
var bY = q("$ZodSymbol", ($, X) => {
  i.init($, X), $._zod.parse = (J, Q) => {
    let Y = J.value;
    if (typeof Y === "symbol") return J;
    return J.issues.push({ expected: "symbol", code: "invalid_type", input: Y, inst: $ }), J;
  };
});
var PY = q("$ZodUndefined", ($, X) => {
  i.init($, X), $._zod.pattern = T5, $._zod.values = /* @__PURE__ */ new Set([void 0]), $._zod.optin = "optional", $._zod.optout = "optional", $._zod.parse = (J, Q) => {
    let Y = J.value;
    if (typeof Y > "u") return J;
    return J.issues.push({ expected: "undefined", code: "invalid_type", input: Y, inst: $ }), J;
  };
});
var ZY = q("$ZodNull", ($, X) => {
  i.init($, X), $._zod.pattern = x5, $._zod.values = /* @__PURE__ */ new Set([null]), $._zod.parse = (J, Q) => {
    let Y = J.value;
    if (Y === null) return J;
    return J.issues.push({ expected: "null", code: "invalid_type", input: Y, inst: $ }), J;
  };
});
var EY = q("$ZodAny", ($, X) => {
  i.init($, X), $._zod.parse = (J) => J;
});
var I1 = q("$ZodUnknown", ($, X) => {
  i.init($, X), $._zod.parse = (J) => J;
});
var RY = q("$ZodNever", ($, X) => {
  i.init($, X), $._zod.parse = (J, Q) => {
    return J.issues.push({ expected: "never", code: "invalid_type", input: J.value, inst: $ }), J;
  };
});
var SY = q("$ZodVoid", ($, X) => {
  i.init($, X), $._zod.parse = (J, Q) => {
    let Y = J.value;
    if (typeof Y > "u") return J;
    return J.issues.push({ expected: "void", code: "invalid_type", input: Y, inst: $ }), J;
  };
});
var vY = q("$ZodDate", ($, X) => {
  i.init($, X), $._zod.parse = (J, Q) => {
    if (X.coerce) try {
      J.value = new Date(J.value);
    } catch (G) {
    }
    let Y = J.value, z = Y instanceof Date;
    if (z && !Number.isNaN(Y.getTime())) return J;
    return J.issues.push({ expected: "date", code: "invalid_type", input: Y, ...z ? { received: "Invalid Date" } : {}, inst: $ }), J;
  };
});
function JN($, X, J) {
  if ($.issues.length) X.issues.push(...s$(J, $.issues));
  X.value[J] = $.value;
}
var L0 = q("$ZodArray", ($, X) => {
  i.init($, X), $._zod.parse = (J, Q) => {
    let Y = J.value;
    if (!Array.isArray(Y)) return J.issues.push({ expected: "array", code: "invalid_type", input: Y, inst: $ }), J;
    J.value = Array(Y.length);
    let z = [];
    for (let W = 0; W < Y.length; W++) {
      let G = Y[W], U = X.element._zod.run({ value: G, issues: [] }, Q);
      if (U instanceof Promise) z.push(U.then((H) => JN(H, J, W)));
      else JN(U, J, W);
    }
    if (z.length) return Promise.all(z).then(() => J);
    return J;
  };
});
function $Y($, X, J) {
  if ($.issues.length) X.issues.push(...s$(J, $.issues));
  X.value[J] = $.value;
}
function YN($, X, J, Q) {
  if ($.issues.length) if (Q[J] === void 0) if (J in Q) X.value[J] = void 0;
  else X.value[J] = $.value;
  else X.issues.push(...s$(J, $.issues));
  else if ($.value === void 0) {
    if (J in Q) X.value[J] = void 0;
  } else X.value[J] = $.value;
}
var L8 = q("$ZodObject", ($, X) => {
  i.init($, X);
  let J = K8(() => {
    let V = Object.keys(X.shape);
    for (let N of V) if (!(X.shape[N] instanceof i)) throw Error(`Invalid element at key "${N}": expected a Zod schema`);
    let O = z5(X.shape);
    return { shape: X.shape, keys: V, keySet: new Set(V), numKeys: V.length, optionalKeys: new Set(O) };
  });
  W$($._zod, "propValues", () => {
    let V = X.shape, O = {};
    for (let N in V) {
      let w = V[N]._zod;
      if (w.values) {
        O[N] ?? (O[N] = /* @__PURE__ */ new Set());
        for (let B of w.values) O[N].add(B);
      }
    }
    return O;
  });
  let Q = (V) => {
    let O = new eJ(["shape", "payload", "ctx"]), N = J.value, w = (M) => {
      let b = q1(M);
      return `shape[${b}]._zod.run({ value: input[${b}], issues: [] }, ctx)`;
    };
    O.write("const input = payload.value;");
    let B = /* @__PURE__ */ Object.create(null), L = 0;
    for (let M of N.keys) B[M] = `key_${L++}`;
    O.write("const newResult = {}");
    for (let M of N.keys) if (N.optionalKeys.has(M)) {
      let b = B[M];
      O.write(`const ${b} = ${w(M)};`);
      let x = q1(M);
      O.write(`
        if (${b}.issues.length) {
          if (input[${x}] === undefined) {
            if (${x} in input) {
              newResult[${x}] = undefined;
            }
          } else {
            payload.issues = payload.issues.concat(
              ${b}.issues.map((iss) => ({
                ...iss,
                path: iss.path ? [${x}, ...iss.path] : [${x}],
              }))
            );
          }
        } else if (${b}.value === undefined) {
          if (${x} in input) newResult[${x}] = undefined;
        } else {
          newResult[${x}] = ${b}.value;
        }
        `);
    } else {
      let b = B[M];
      O.write(`const ${b} = ${w(M)};`), O.write(`
          if (${b}.issues.length) payload.issues = payload.issues.concat(${b}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${q1(M)}, ...iss.path] : [${q1(M)}]
          })));`), O.write(`newResult[${q1(M)}] = ${b}.value`);
    }
    O.write("payload.value = newResult;"), O.write("return payload;");
    let j = O.compile();
    return (M, b) => j(V, M, b);
  }, Y, z = N0, W = !G8.jitless, U = W && Y5.value, H = X.catchall, K;
  $._zod.parse = (V, O) => {
    K ?? (K = J.value);
    let N = V.value;
    if (!z(N)) return V.issues.push({ expected: "object", code: "invalid_type", input: N, inst: $ }), V;
    let w = [];
    if (W && U && O?.async === false && O.jitless !== true) {
      if (!Y) Y = Q(X.shape);
      V = Y(V, O);
    } else {
      V.value = {};
      let b = K.shape;
      for (let x of K.keys) {
        let h = b[x], B$ = h._zod.run({ value: N[x], issues: [] }, O), x$ = h._zod.optin === "optional" && h._zod.optout === "optional";
        if (B$ instanceof Promise) w.push(B$.then((Q6) => x$ ? YN(Q6, V, x, N) : $Y(Q6, V, x)));
        else if (x$) YN(B$, V, x, N);
        else $Y(B$, V, x);
      }
    }
    if (!H) return w.length ? Promise.all(w).then(() => V) : V;
    let B = [], L = K.keySet, j = H._zod, M = j.def.type;
    for (let b of Object.keys(N)) {
      if (L.has(b)) continue;
      if (M === "never") {
        B.push(b);
        continue;
      }
      let x = j.run({ value: N[b], issues: [] }, O);
      if (x instanceof Promise) w.push(x.then((h) => $Y(h, V, b)));
      else $Y(x, V, b);
    }
    if (B.length) V.issues.push({ code: "unrecognized_keys", keys: B, input: N, inst: $ });
    if (!w.length) return V;
    return Promise.all(w).then(() => {
      return V;
    });
  };
});
function QN($, X, J, Q) {
  for (let Y of $) if (Y.issues.length === 0) return X.value = Y.value, X;
  return X.issues.push({ code: "invalid_union", input: X.value, inst: J, errors: $.map((Y) => Y.issues.map((z) => K6(z, Q, E$()))) }), X;
}
var j8 = q("$ZodUnion", ($, X) => {
  i.init($, X), W$($._zod, "optin", () => X.options.some((J) => J._zod.optin === "optional") ? "optional" : void 0), W$($._zod, "optout", () => X.options.some((J) => J._zod.optout === "optional") ? "optional" : void 0), W$($._zod, "values", () => {
    if (X.options.every((J) => J._zod.values)) return new Set(X.options.flatMap((J) => Array.from(J._zod.values)));
    return;
  }), W$($._zod, "pattern", () => {
    if (X.options.every((J) => J._zod.pattern)) {
      let J = X.options.map((Q) => Q._zod.pattern);
      return new RegExp(`^(${J.map((Q) => N8(Q.source)).join("|")})$`);
    }
    return;
  }), $._zod.parse = (J, Q) => {
    let Y = false, z = [];
    for (let W of X.options) {
      let G = W._zod.run({ value: J.value, issues: [] }, Q);
      if (G instanceof Promise) z.push(G), Y = true;
      else {
        if (G.issues.length === 0) return G;
        z.push(G);
      }
    }
    if (!Y) return QN(z, J, $, Q);
    return Promise.all(z).then((W) => {
      return QN(W, J, $, Q);
    });
  };
});
var CY = q("$ZodDiscriminatedUnion", ($, X) => {
  j8.init($, X);
  let J = $._zod.parse;
  W$($._zod, "propValues", () => {
    let Y = {};
    for (let z of X.options) {
      let W = z._zod.propValues;
      if (!W || Object.keys(W).length === 0) throw Error(`Invalid discriminated union option at index "${X.options.indexOf(z)}"`);
      for (let [G, U] of Object.entries(W)) {
        if (!Y[G]) Y[G] = /* @__PURE__ */ new Set();
        for (let H of U) Y[G].add(H);
      }
    }
    return Y;
  });
  let Q = K8(() => {
    let Y = X.options, z = /* @__PURE__ */ new Map();
    for (let W of Y) {
      let G = W._zod.propValues[X.discriminator];
      if (!G || G.size === 0) throw Error(`Invalid discriminated union option at index "${X.options.indexOf(W)}"`);
      for (let U of G) {
        if (z.has(U)) throw Error(`Duplicate discriminator value "${String(U)}"`);
        z.set(U, W);
      }
    }
    return z;
  });
  $._zod.parse = (Y, z) => {
    let W = Y.value;
    if (!N0(W)) return Y.issues.push({ code: "invalid_type", expected: "object", input: W, inst: $ }), Y;
    let G = Q.value.get(W?.[X.discriminator]);
    if (G) return G._zod.run(Y, z);
    if (X.unionFallback) return J(Y, z);
    return Y.issues.push({ code: "invalid_union", errors: [], note: "No matching discriminator", input: W, path: [X.discriminator], inst: $ }), Y;
  };
});
var kY = q("$ZodIntersection", ($, X) => {
  i.init($, X), $._zod.parse = (J, Q) => {
    let Y = J.value, z = X.left._zod.run({ value: Y, issues: [] }, Q), W = X.right._zod.run({ value: Y, issues: [] }, Q);
    if (z instanceof Promise || W instanceof Promise) return Promise.all([z, W]).then(([U, H]) => {
      return zN(J, U, H);
    });
    return zN(J, z, W);
  };
});
function YW($, X) {
  if ($ === X) return { valid: true, data: $ };
  if ($ instanceof Date && X instanceof Date && +$ === +X) return { valid: true, data: $ };
  if (V0($) && V0(X)) {
    let J = Object.keys(X), Q = Object.keys($).filter((z) => J.indexOf(z) !== -1), Y = { ...$, ...X };
    for (let z of Q) {
      let W = YW($[z], X[z]);
      if (!W.valid) return { valid: false, mergeErrorPath: [z, ...W.mergeErrorPath] };
      Y[z] = W.data;
    }
    return { valid: true, data: Y };
  }
  if (Array.isArray($) && Array.isArray(X)) {
    if ($.length !== X.length) return { valid: false, mergeErrorPath: [] };
    let J = [];
    for (let Q = 0; Q < $.length; Q++) {
      let Y = $[Q], z = X[Q], W = YW(Y, z);
      if (!W.valid) return { valid: false, mergeErrorPath: [Q, ...W.mergeErrorPath] };
      J.push(W.data);
    }
    return { valid: true, data: J };
  }
  return { valid: false, mergeErrorPath: [] };
}
function zN($, X, J) {
  if (X.issues.length) $.issues.push(...X.issues);
  if (J.issues.length) $.issues.push(...J.issues);
  if (D1($)) return $;
  let Q = YW(X.value, J.value);
  if (!Q.valid) throw Error(`Unmergable intersection. Error path: ${JSON.stringify(Q.mergeErrorPath)}`);
  return $.value = Q.data, $;
}
var T4 = q("$ZodTuple", ($, X) => {
  i.init($, X);
  let J = X.items, Q = J.length - [...J].reverse().findIndex((Y) => Y._zod.optin !== "optional");
  $._zod.parse = (Y, z) => {
    let W = Y.value;
    if (!Array.isArray(W)) return Y.issues.push({ input: W, inst: $, expected: "tuple", code: "invalid_type" }), Y;
    Y.value = [];
    let G = [];
    if (!X.rest) {
      let H = W.length > J.length, K = W.length < Q - 1;
      if (H || K) return Y.issues.push({ input: W, inst: $, origin: "array", ...H ? { code: "too_big", maximum: J.length } : { code: "too_small", minimum: J.length } }), Y;
    }
    let U = -1;
    for (let H of J) {
      if (U++, U >= W.length) {
        if (U >= Q) continue;
      }
      let K = H._zod.run({ value: W[U], issues: [] }, z);
      if (K instanceof Promise) G.push(K.then((V) => XY(V, Y, U)));
      else XY(K, Y, U);
    }
    if (X.rest) {
      let H = W.slice(J.length);
      for (let K of H) {
        U++;
        let V = X.rest._zod.run({ value: K, issues: [] }, z);
        if (V instanceof Promise) G.push(V.then((O) => XY(O, Y, U)));
        else XY(V, Y, U);
      }
    }
    if (G.length) return Promise.all(G).then(() => Y);
    return Y;
  };
});
function XY($, X, J) {
  if ($.issues.length) X.issues.push(...s$(J, $.issues));
  X.value[J] = $.value;
}
var _Y = q("$ZodRecord", ($, X) => {
  i.init($, X), $._zod.parse = (J, Q) => {
    let Y = J.value;
    if (!V0(Y)) return J.issues.push({ expected: "record", code: "invalid_type", input: Y, inst: $ }), J;
    let z = [];
    if (X.keyType._zod.values) {
      let W = X.keyType._zod.values;
      J.value = {};
      for (let U of W) if (typeof U === "string" || typeof U === "number" || typeof U === "symbol") {
        let H = X.valueType._zod.run({ value: Y[U], issues: [] }, Q);
        if (H instanceof Promise) z.push(H.then((K) => {
          if (K.issues.length) J.issues.push(...s$(U, K.issues));
          J.value[U] = K.value;
        }));
        else {
          if (H.issues.length) J.issues.push(...s$(U, H.issues));
          J.value[U] = H.value;
        }
      }
      let G;
      for (let U in Y) if (!W.has(U)) G = G ?? [], G.push(U);
      if (G && G.length > 0) J.issues.push({ code: "unrecognized_keys", input: Y, inst: $, keys: G });
    } else {
      J.value = {};
      for (let W of Reflect.ownKeys(Y)) {
        if (W === "__proto__") continue;
        let G = X.keyType._zod.run({ value: W, issues: [] }, Q);
        if (G instanceof Promise) throw Error("Async schemas not supported in object keys currently");
        if (G.issues.length) {
          J.issues.push({ origin: "record", code: "invalid_key", issues: G.issues.map((H) => K6(H, Q, E$())), input: W, path: [W], inst: $ }), J.value[G.value] = G.value;
          continue;
        }
        let U = X.valueType._zod.run({ value: Y[W], issues: [] }, Q);
        if (U instanceof Promise) z.push(U.then((H) => {
          if (H.issues.length) J.issues.push(...s$(W, H.issues));
          J.value[G.value] = H.value;
        }));
        else {
          if (U.issues.length) J.issues.push(...s$(W, U.issues));
          J.value[G.value] = U.value;
        }
      }
    }
    if (z.length) return Promise.all(z).then(() => J);
    return J;
  };
});
var xY = q("$ZodMap", ($, X) => {
  i.init($, X), $._zod.parse = (J, Q) => {
    let Y = J.value;
    if (!(Y instanceof Map)) return J.issues.push({ expected: "map", code: "invalid_type", input: Y, inst: $ }), J;
    let z = [];
    J.value = /* @__PURE__ */ new Map();
    for (let [W, G] of Y) {
      let U = X.keyType._zod.run({ value: W, issues: [] }, Q), H = X.valueType._zod.run({ value: G, issues: [] }, Q);
      if (U instanceof Promise || H instanceof Promise) z.push(Promise.all([U, H]).then(([K, V]) => {
        WN(K, V, J, W, Y, $, Q);
      }));
      else WN(U, H, J, W, Y, $, Q);
    }
    if (z.length) return Promise.all(z).then(() => J);
    return J;
  };
});
function WN($, X, J, Q, Y, z, W) {
  if ($.issues.length) if (V8.has(typeof Q)) J.issues.push(...s$(Q, $.issues));
  else J.issues.push({ origin: "map", code: "invalid_key", input: Y, inst: z, issues: $.issues.map((G) => K6(G, W, E$())) });
  if (X.issues.length) if (V8.has(typeof Q)) J.issues.push(...s$(Q, X.issues));
  else J.issues.push({ origin: "map", code: "invalid_element", input: Y, inst: z, key: Q, issues: X.issues.map((G) => K6(G, W, E$())) });
  J.value.set($.value, X.value);
}
var TY = q("$ZodSet", ($, X) => {
  i.init($, X), $._zod.parse = (J, Q) => {
    let Y = J.value;
    if (!(Y instanceof Set)) return J.issues.push({ input: Y, inst: $, expected: "set", code: "invalid_type" }), J;
    let z = [];
    J.value = /* @__PURE__ */ new Set();
    for (let W of Y) {
      let G = X.valueType._zod.run({ value: W, issues: [] }, Q);
      if (G instanceof Promise) z.push(G.then((U) => GN(U, J)));
      else GN(G, J);
    }
    if (z.length) return Promise.all(z).then(() => J);
    return J;
  };
});
function GN($, X) {
  if ($.issues.length) X.issues.push(...$.issues);
  X.value.add($.value);
}
var yY = q("$ZodEnum", ($, X) => {
  i.init($, X);
  let J = H8(X.entries);
  $._zod.values = new Set(J), $._zod.pattern = new RegExp(`^(${J.filter((Q) => V8.has(typeof Q)).map((Q) => typeof Q === "string" ? U4(Q) : Q.toString()).join("|")})$`), $._zod.parse = (Q, Y) => {
    let z = Q.value;
    if ($._zod.values.has(z)) return Q;
    return Q.issues.push({ code: "invalid_value", values: J, input: z, inst: $ }), Q;
  };
});
var gY = q("$ZodLiteral", ($, X) => {
  i.init($, X), $._zod.values = new Set(X.values), $._zod.pattern = new RegExp(`^(${X.values.map((J) => typeof J === "string" ? U4(J) : J ? J.toString() : String(J)).join("|")})$`), $._zod.parse = (J, Q) => {
    let Y = J.value;
    if ($._zod.values.has(Y)) return J;
    return J.issues.push({ code: "invalid_value", values: X.values, input: Y, inst: $ }), J;
  };
});
var fY = q("$ZodFile", ($, X) => {
  i.init($, X), $._zod.parse = (J, Q) => {
    let Y = J.value;
    if (Y instanceof File) return J;
    return J.issues.push({ expected: "file", code: "invalid_type", input: Y, inst: $ }), J;
  };
});
var j0 = q("$ZodTransform", ($, X) => {
  i.init($, X), $._zod.parse = (J, Q) => {
    let Y = X.transform(J.value, J);
    if (Q.async) return (Y instanceof Promise ? Y : Promise.resolve(Y)).then((W) => {
      return J.value = W, J;
    });
    if (Y instanceof Promise) throw new G4();
    return J.value = Y, J;
  };
});
var hY = q("$ZodOptional", ($, X) => {
  i.init($, X), $._zod.optin = "optional", $._zod.optout = "optional", W$($._zod, "values", () => {
    return X.innerType._zod.values ? /* @__PURE__ */ new Set([...X.innerType._zod.values, void 0]) : void 0;
  }), W$($._zod, "pattern", () => {
    let J = X.innerType._zod.pattern;
    return J ? new RegExp(`^(${N8(J.source)})?$`) : void 0;
  }), $._zod.parse = (J, Q) => {
    if (X.innerType._zod.optin === "optional") return X.innerType._zod.run(J, Q);
    if (J.value === void 0) return J;
    return X.innerType._zod.run(J, Q);
  };
});
var uY = q("$ZodNullable", ($, X) => {
  i.init($, X), W$($._zod, "optin", () => X.innerType._zod.optin), W$($._zod, "optout", () => X.innerType._zod.optout), W$($._zod, "pattern", () => {
    let J = X.innerType._zod.pattern;
    return J ? new RegExp(`^(${N8(J.source)}|null)$`) : void 0;
  }), W$($._zod, "values", () => {
    return X.innerType._zod.values ? /* @__PURE__ */ new Set([...X.innerType._zod.values, null]) : void 0;
  }), $._zod.parse = (J, Q) => {
    if (J.value === null) return J;
    return X.innerType._zod.run(J, Q);
  };
});
var mY = q("$ZodDefault", ($, X) => {
  i.init($, X), $._zod.optin = "optional", W$($._zod, "values", () => X.innerType._zod.values), $._zod.parse = (J, Q) => {
    if (J.value === void 0) return J.value = X.defaultValue, J;
    let Y = X.innerType._zod.run(J, Q);
    if (Y instanceof Promise) return Y.then((z) => UN(z, X));
    return UN(Y, X);
  };
});
function UN($, X) {
  if ($.value === void 0) $.value = X.defaultValue;
  return $;
}
var lY = q("$ZodPrefault", ($, X) => {
  i.init($, X), $._zod.optin = "optional", W$($._zod, "values", () => X.innerType._zod.values), $._zod.parse = (J, Q) => {
    if (J.value === void 0) J.value = X.defaultValue;
    return X.innerType._zod.run(J, Q);
  };
});
var cY = q("$ZodNonOptional", ($, X) => {
  i.init($, X), W$($._zod, "values", () => {
    let J = X.innerType._zod.values;
    return J ? new Set([...J].filter((Q) => Q !== void 0)) : void 0;
  }), $._zod.parse = (J, Q) => {
    let Y = X.innerType._zod.run(J, Q);
    if (Y instanceof Promise) return Y.then((z) => HN(z, $));
    return HN(Y, $);
  };
});
function HN($, X) {
  if (!$.issues.length && $.value === void 0) $.issues.push({ code: "invalid_type", expected: "nonoptional", input: $.value, inst: X });
  return $;
}
var iY = q("$ZodSuccess", ($, X) => {
  i.init($, X), $._zod.parse = (J, Q) => {
    let Y = X.innerType._zod.run(J, Q);
    if (Y instanceof Promise) return Y.then((z) => {
      return J.value = z.issues.length === 0, J;
    });
    return J.value = Y.issues.length === 0, J;
  };
});
var pY = q("$ZodCatch", ($, X) => {
  i.init($, X), $._zod.optin = "optional", W$($._zod, "optout", () => X.innerType._zod.optout), W$($._zod, "values", () => X.innerType._zod.values), $._zod.parse = (J, Q) => {
    let Y = X.innerType._zod.run(J, Q);
    if (Y instanceof Promise) return Y.then((z) => {
      if (J.value = z.value, z.issues.length) J.value = X.catchValue({ ...J, error: { issues: z.issues.map((W) => K6(W, Q, E$())) }, input: J.value }), J.issues = [];
      return J;
    });
    if (J.value = Y.value, Y.issues.length) J.value = X.catchValue({ ...J, error: { issues: Y.issues.map((z) => K6(z, Q, E$())) }, input: J.value }), J.issues = [];
    return J;
  };
});
var nY = q("$ZodNaN", ($, X) => {
  i.init($, X), $._zod.parse = (J, Q) => {
    if (typeof J.value !== "number" || !Number.isNaN(J.value)) return J.issues.push({ input: J.value, inst: $, expected: "nan", code: "invalid_type" }), J;
    return J;
  };
});
var F0 = q("$ZodPipe", ($, X) => {
  i.init($, X), W$($._zod, "values", () => X.in._zod.values), W$($._zod, "optin", () => X.in._zod.optin), W$($._zod, "optout", () => X.out._zod.optout), $._zod.parse = (J, Q) => {
    let Y = X.in._zod.run(J, Q);
    if (Y instanceof Promise) return Y.then((z) => KN(z, X, Q));
    return KN(Y, X, Q);
  };
});
function KN($, X, J) {
  if (D1($)) return $;
  return X.out._zod.run({ value: $.value, issues: $.issues }, J);
}
var dY = q("$ZodReadonly", ($, X) => {
  i.init($, X), W$($._zod, "propValues", () => X.innerType._zod.propValues), W$($._zod, "values", () => X.innerType._zod.values), W$($._zod, "optin", () => X.innerType._zod.optin), W$($._zod, "optout", () => X.innerType._zod.optout), $._zod.parse = (J, Q) => {
    let Y = X.innerType._zod.run(J, Q);
    if (Y instanceof Promise) return Y.then(NN);
    return NN(Y);
  };
});
function NN($) {
  return $.value = Object.freeze($.value), $;
}
var rY = q("$ZodTemplateLiteral", ($, X) => {
  i.init($, X);
  let J = [];
  for (let Q of X.parts) if (Q instanceof i) {
    if (!Q._zod.pattern) throw Error(`Invalid template literal part, no pattern found: ${[...Q._zod.traits].shift()}`);
    let Y = Q._zod.pattern instanceof RegExp ? Q._zod.pattern.source : Q._zod.pattern;
    if (!Y) throw Error(`Invalid template literal part: ${Q._zod.traits}`);
    let z = Y.startsWith("^") ? 1 : 0, W = Y.endsWith("$") ? Y.length - 1 : Y.length;
    J.push(Y.slice(z, W));
  } else if (Q === null || Q5.has(typeof Q)) J.push(U4(`${Q}`));
  else throw Error(`Invalid template literal part: ${Q}`);
  $._zod.pattern = new RegExp(`^${J.join("")}$`), $._zod.parse = (Q, Y) => {
    if (typeof Q.value !== "string") return Q.issues.push({ input: Q.value, inst: $, expected: "template_literal", code: "invalid_type" }), Q;
    if ($._zod.pattern.lastIndex = 0, !$._zod.pattern.test(Q.value)) return Q.issues.push({ input: Q.value, inst: $, code: "invalid_format", format: "template_literal", pattern: $._zod.pattern.source }), Q;
    return Q;
  };
});
var oY = q("$ZodPromise", ($, X) => {
  i.init($, X), $._zod.parse = (J, Q) => {
    return Promise.resolve(J.value).then((Y) => X.innerType._zod.run({ value: Y, issues: [] }, Q));
  };
});
var tY = q("$ZodLazy", ($, X) => {
  i.init($, X), W$($._zod, "innerType", () => X.getter()), W$($._zod, "pattern", () => $._zod.innerType._zod.pattern), W$($._zod, "propValues", () => $._zod.innerType._zod.propValues), W$($._zod, "optin", () => $._zod.innerType._zod.optin), W$($._zod, "optout", () => $._zod.innerType._zod.optout), $._zod.parse = (J, Q) => {
    return $._zod.innerType._zod.run(J, Q);
  };
});
var aY = q("$ZodCustom", ($, X) => {
  I$.init($, X), i.init($, X), $._zod.parse = (J, Q) => {
    return J;
  }, $._zod.check = (J) => {
    let Q = J.value, Y = X.fn(Q);
    if (Y instanceof Promise) return Y.then((z) => VN(z, J, Q, $));
    VN(Y, J, Q, $);
    return;
  };
});
function VN($, X, J, Q) {
  if (!$) {
    let Y = { code: "custom", input: J, inst: Q, path: [...Q._zod.def.path ?? []], continue: !Q._zod.def.abort };
    if (Q._zod.def.params) Y.params = Q._zod.def.params;
    X.issues.push(U5(Y));
  }
}
var I0 = {};
e4(I0, { zhTW: () => nW, zhCN: () => pW, vi: () => iW, ur: () => cW, ua: () => lW, tr: () => mW, th: () => uW, ta: () => hW, sv: () => fW, sl: () => gW, ru: () => yW, pt: () => TW, ps: () => _W, pl: () => xW, ota: () => kW, no: () => CW, nl: () => vW, ms: () => SW, mk: () => RW, ko: () => EW, kh: () => ZW, ja: () => PW, it: () => bW, id: () => AW, hu: () => MW, he: () => IW, frCA: () => FW, fr: () => jW, fi: () => LW, fa: () => DW, es: () => qW, eo: () => BW, en: () => F8, de: () => wW, cs: () => OW, ca: () => VW, be: () => NW, az: () => KW, ar: () => HW });
var eM = () => {
  let $ = { string: { unit: "\u062D\u0631\u0641", verb: "\u0623\u0646 \u064A\u062D\u0648\u064A" }, file: { unit: "\u0628\u0627\u064A\u062A", verb: "\u0623\u0646 \u064A\u062D\u0648\u064A" }, array: { unit: "\u0639\u0646\u0635\u0631", verb: "\u0623\u0646 \u064A\u062D\u0648\u064A" }, set: { unit: "\u0639\u0646\u0635\u0631", verb: "\u0623\u0646 \u064A\u062D\u0648\u064A" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "NaN" : "number";
      case "object": {
        if (Array.isArray(Y)) return "array";
        if (Y === null) return "null";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "\u0645\u062F\u062E\u0644", email: "\u0628\u0631\u064A\u062F \u0625\u0644\u0643\u062A\u0631\u0648\u0646\u064A", url: "\u0631\u0627\u0628\u0637", emoji: "\u0625\u064A\u0645\u0648\u062C\u064A", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "\u062A\u0627\u0631\u064A\u062E \u0648\u0648\u0642\u062A \u0628\u0645\u0639\u064A\u0627\u0631 ISO", date: "\u062A\u0627\u0631\u064A\u062E \u0628\u0645\u0639\u064A\u0627\u0631 ISO", time: "\u0648\u0642\u062A \u0628\u0645\u0639\u064A\u0627\u0631 ISO", duration: "\u0645\u062F\u0629 \u0628\u0645\u0639\u064A\u0627\u0631 ISO", ipv4: "\u0639\u0646\u0648\u0627\u0646 IPv4", ipv6: "\u0639\u0646\u0648\u0627\u0646 IPv6", cidrv4: "\u0645\u062F\u0649 \u0639\u0646\u0627\u0648\u064A\u0646 \u0628\u0635\u064A\u063A\u0629 IPv4", cidrv6: "\u0645\u062F\u0649 \u0639\u0646\u0627\u0648\u064A\u0646 \u0628\u0635\u064A\u063A\u0629 IPv6", base64: "\u0646\u064E\u0635 \u0628\u062A\u0631\u0645\u064A\u0632 base64-encoded", base64url: "\u0646\u064E\u0635 \u0628\u062A\u0631\u0645\u064A\u0632 base64url-encoded", json_string: "\u0646\u064E\u0635 \u0639\u0644\u0649 \u0647\u064A\u0626\u0629 JSON", e164: "\u0631\u0642\u0645 \u0647\u0627\u062A\u0641 \u0628\u0645\u0639\u064A\u0627\u0631 E.164", jwt: "JWT", template_literal: "\u0645\u062F\u062E\u0644" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `\u0645\u062F\u062E\u0644\u0627\u062A \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644\u0629: \u064A\u0641\u062A\u0631\u0636 \u0625\u062F\u062E\u0627\u0644 ${Y.expected}\u060C \u0648\u0644\u0643\u0646 \u062A\u0645 \u0625\u062F\u062E\u0627\u0644 ${J(Y.input)}`;
      case "invalid_value":
        if (Y.values.length === 1) return `\u0645\u062F\u062E\u0644\u0627\u062A \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644\u0629: \u064A\u0641\u062A\u0631\u0636 \u0625\u062F\u062E\u0627\u0644 ${S(Y.values[0])}`;
        return `\u0627\u062E\u062A\u064A\u0627\u0631 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644: \u064A\u062A\u0648\u0642\u0639 \u0627\u0646\u062A\u0642\u0627\u0621 \u0623\u062D\u062F \u0647\u0630\u0647 \u0627\u0644\u062E\u064A\u0627\u0631\u0627\u062A: ${I(Y.values, "|")}`;
      case "too_big": {
        let z = Y.inclusive ? "<=" : "<", W = X(Y.origin);
        if (W) return ` \u0623\u0643\u0628\u0631 \u0645\u0646 \u0627\u0644\u0644\u0627\u0632\u0645: \u064A\u0641\u062A\u0631\u0636 \u0623\u0646 \u062A\u0643\u0648\u0646 ${Y.origin ?? "\u0627\u0644\u0642\u064A\u0645\u0629"} ${z} ${Y.maximum.toString()} ${W.unit ?? "\u0639\u0646\u0635\u0631"}`;
        return `\u0623\u0643\u0628\u0631 \u0645\u0646 \u0627\u0644\u0644\u0627\u0632\u0645: \u064A\u0641\u062A\u0631\u0636 \u0623\u0646 \u062A\u0643\u0648\u0646 ${Y.origin ?? "\u0627\u0644\u0642\u064A\u0645\u0629"} ${z} ${Y.maximum.toString()}`;
      }
      case "too_small": {
        let z = Y.inclusive ? ">=" : ">", W = X(Y.origin);
        if (W) return `\u0623\u0635\u063A\u0631 \u0645\u0646 \u0627\u0644\u0644\u0627\u0632\u0645: \u064A\u0641\u062A\u0631\u0636 \u0644\u0640 ${Y.origin} \u0623\u0646 \u064A\u0643\u0648\u0646 ${z} ${Y.minimum.toString()} ${W.unit}`;
        return `\u0623\u0635\u063A\u0631 \u0645\u0646 \u0627\u0644\u0644\u0627\u0632\u0645: \u064A\u0641\u062A\u0631\u0636 \u0644\u0640 ${Y.origin} \u0623\u0646 \u064A\u0643\u0648\u0646 ${z} ${Y.minimum.toString()}`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `\u0646\u064E\u0635 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644: \u064A\u062C\u0628 \u0623\u0646 \u064A\u0628\u062F\u0623 \u0628\u0640 "${Y.prefix}"`;
        if (z.format === "ends_with") return `\u0646\u064E\u0635 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644: \u064A\u062C\u0628 \u0623\u0646 \u064A\u0646\u062A\u0647\u064A \u0628\u0640 "${z.suffix}"`;
        if (z.format === "includes") return `\u0646\u064E\u0635 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644: \u064A\u062C\u0628 \u0623\u0646 \u064A\u062A\u0636\u0645\u0651\u064E\u0646 "${z.includes}"`;
        if (z.format === "regex") return `\u0646\u064E\u0635 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644: \u064A\u062C\u0628 \u0623\u0646 \u064A\u0637\u0627\u0628\u0642 \u0627\u0644\u0646\u0645\u0637 ${z.pattern}`;
        return `${Q[z.format] ?? Y.format} \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644`;
      }
      case "not_multiple_of":
        return `\u0631\u0642\u0645 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644: \u064A\u062C\u0628 \u0623\u0646 \u064A\u0643\u0648\u0646 \u0645\u0646 \u0645\u0636\u0627\u0639\u0641\u0627\u062A ${Y.divisor}`;
      case "unrecognized_keys":
        return `\u0645\u0639\u0631\u0641${Y.keys.length > 1 ? "\u0627\u062A" : ""} \u063A\u0631\u064A\u0628${Y.keys.length > 1 ? "\u0629" : ""}: ${I(Y.keys, "\u060C ")}`;
      case "invalid_key":
        return `\u0645\u0639\u0631\u0641 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644 \u0641\u064A ${Y.origin}`;
      case "invalid_union":
        return "\u0645\u062F\u062E\u0644 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644";
      case "invalid_element":
        return `\u0645\u062F\u062E\u0644 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644 \u0641\u064A ${Y.origin}`;
      default:
        return "\u0645\u062F\u062E\u0644 \u063A\u064A\u0631 \u0645\u0642\u0628\u0648\u0644";
    }
  };
};
function HW() {
  return { localeError: eM() };
}
var $A = () => {
  let $ = { string: { unit: "simvol", verb: "olmal\u0131d\u0131r" }, file: { unit: "bayt", verb: "olmal\u0131d\u0131r" }, array: { unit: "element", verb: "olmal\u0131d\u0131r" }, set: { unit: "element", verb: "olmal\u0131d\u0131r" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "NaN" : "number";
      case "object": {
        if (Array.isArray(Y)) return "array";
        if (Y === null) return "null";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "input", email: "email address", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO datetime", date: "ISO date", time: "ISO time", duration: "ISO duration", ipv4: "IPv4 address", ipv6: "IPv6 address", cidrv4: "IPv4 range", cidrv6: "IPv6 range", base64: "base64-encoded string", base64url: "base64url-encoded string", json_string: "JSON string", e164: "E.164 number", jwt: "JWT", template_literal: "input" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `Yanl\u0131\u015F d\u0259y\u0259r: g\xF6zl\u0259nil\u0259n ${Y.expected}, daxil olan ${J(Y.input)}`;
      case "invalid_value":
        if (Y.values.length === 1) return `Yanl\u0131\u015F d\u0259y\u0259r: g\xF6zl\u0259nil\u0259n ${S(Y.values[0])}`;
        return `Yanl\u0131\u015F se\xE7im: a\u015Fa\u011F\u0131dak\u0131lardan biri olmal\u0131d\u0131r: ${I(Y.values, "|")}`;
      case "too_big": {
        let z = Y.inclusive ? "<=" : "<", W = X(Y.origin);
        if (W) return `\xC7ox b\xF6y\xFCk: g\xF6zl\u0259nil\u0259n ${Y.origin ?? "d\u0259y\u0259r"} ${z}${Y.maximum.toString()} ${W.unit ?? "element"}`;
        return `\xC7ox b\xF6y\xFCk: g\xF6zl\u0259nil\u0259n ${Y.origin ?? "d\u0259y\u0259r"} ${z}${Y.maximum.toString()}`;
      }
      case "too_small": {
        let z = Y.inclusive ? ">=" : ">", W = X(Y.origin);
        if (W) return `\xC7ox ki\xE7ik: g\xF6zl\u0259nil\u0259n ${Y.origin} ${z}${Y.minimum.toString()} ${W.unit}`;
        return `\xC7ox ki\xE7ik: g\xF6zl\u0259nil\u0259n ${Y.origin} ${z}${Y.minimum.toString()}`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `Yanl\u0131\u015F m\u0259tn: "${z.prefix}" il\u0259 ba\u015Flamal\u0131d\u0131r`;
        if (z.format === "ends_with") return `Yanl\u0131\u015F m\u0259tn: "${z.suffix}" il\u0259 bitm\u0259lidir`;
        if (z.format === "includes") return `Yanl\u0131\u015F m\u0259tn: "${z.includes}" daxil olmal\u0131d\u0131r`;
        if (z.format === "regex") return `Yanl\u0131\u015F m\u0259tn: ${z.pattern} \u015Fablonuna uy\u011Fun olmal\u0131d\u0131r`;
        return `Yanl\u0131\u015F ${Q[z.format] ?? Y.format}`;
      }
      case "not_multiple_of":
        return `Yanl\u0131\u015F \u0259d\u0259d: ${Y.divisor} il\u0259 b\xF6l\xFCn\u0259 bil\u0259n olmal\u0131d\u0131r`;
      case "unrecognized_keys":
        return `Tan\u0131nmayan a\xE7ar${Y.keys.length > 1 ? "lar" : ""}: ${I(Y.keys, ", ")}`;
      case "invalid_key":
        return `${Y.origin} daxilind\u0259 yanl\u0131\u015F a\xE7ar`;
      case "invalid_union":
        return "Yanl\u0131\u015F d\u0259y\u0259r";
      case "invalid_element":
        return `${Y.origin} daxilind\u0259 yanl\u0131\u015F d\u0259y\u0259r`;
      default:
        return "Yanl\u0131\u015F d\u0259y\u0259r";
    }
  };
};
function KW() {
  return { localeError: $A() };
}
function qN($, X, J, Q) {
  let Y = Math.abs($), z = Y % 10, W = Y % 100;
  if (W >= 11 && W <= 19) return Q;
  if (z === 1) return X;
  if (z >= 2 && z <= 4) return J;
  return Q;
}
var XA = () => {
  let $ = { string: { unit: { one: "\u0441\u0456\u043C\u0432\u0430\u043B", few: "\u0441\u0456\u043C\u0432\u0430\u043B\u044B", many: "\u0441\u0456\u043C\u0432\u0430\u043B\u0430\u045E" }, verb: "\u043C\u0435\u0446\u044C" }, array: { unit: { one: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442", few: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u044B", many: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u0430\u045E" }, verb: "\u043C\u0435\u0446\u044C" }, set: { unit: { one: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442", few: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u044B", many: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u0430\u045E" }, verb: "\u043C\u0435\u0446\u044C" }, file: { unit: { one: "\u0431\u0430\u0439\u0442", few: "\u0431\u0430\u0439\u0442\u044B", many: "\u0431\u0430\u0439\u0442\u0430\u045E" }, verb: "\u043C\u0435\u0446\u044C" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "NaN" : "\u043B\u0456\u043A";
      case "object": {
        if (Array.isArray(Y)) return "\u043C\u0430\u0441\u0456\u045E";
        if (Y === null) return "null";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "\u0443\u0432\u043E\u0434", email: "email \u0430\u0434\u0440\u0430\u0441", url: "URL", emoji: "\u044D\u043C\u043E\u0434\u0437\u0456", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO \u0434\u0430\u0442\u0430 \u0456 \u0447\u0430\u0441", date: "ISO \u0434\u0430\u0442\u0430", time: "ISO \u0447\u0430\u0441", duration: "ISO \u043F\u0440\u0430\u0446\u044F\u0433\u043B\u0430\u0441\u0446\u044C", ipv4: "IPv4 \u0430\u0434\u0440\u0430\u0441", ipv6: "IPv6 \u0430\u0434\u0440\u0430\u0441", cidrv4: "IPv4 \u0434\u044B\u044F\u043F\u0430\u0437\u043E\u043D", cidrv6: "IPv6 \u0434\u044B\u044F\u043F\u0430\u0437\u043E\u043D", base64: "\u0440\u0430\u0434\u043E\u043A \u0443 \u0444\u0430\u0440\u043C\u0430\u0446\u0435 base64", base64url: "\u0440\u0430\u0434\u043E\u043A \u0443 \u0444\u0430\u0440\u043C\u0430\u0446\u0435 base64url", json_string: "JSON \u0440\u0430\u0434\u043E\u043A", e164: "\u043D\u0443\u043C\u0430\u0440 E.164", jwt: "JWT", template_literal: "\u0443\u0432\u043E\u0434" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u045E\u0432\u043E\u0434: \u0447\u0430\u043A\u0430\u045E\u0441\u044F ${Y.expected}, \u0430\u0442\u0440\u044B\u043C\u0430\u043D\u0430 ${J(Y.input)}`;
      case "invalid_value":
        if (Y.values.length === 1) return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u045E\u0432\u043E\u0434: \u0447\u0430\u043A\u0430\u043B\u0430\u0441\u044F ${S(Y.values[0])}`;
        return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u0432\u0430\u0440\u044B\u044F\u043D\u0442: \u0447\u0430\u043A\u0430\u045E\u0441\u044F \u0430\u0434\u0437\u0456\u043D \u0437 ${I(Y.values, "|")}`;
      case "too_big": {
        let z = Y.inclusive ? "<=" : "<", W = X(Y.origin);
        if (W) {
          let G = Number(Y.maximum), U = qN(G, W.unit.one, W.unit.few, W.unit.many);
          return `\u0417\u0430\u043D\u0430\u0434\u0442\u0430 \u0432\u044F\u043B\u0456\u043A\u0456: \u0447\u0430\u043A\u0430\u043B\u0430\u0441\u044F, \u0448\u0442\u043E ${Y.origin ?? "\u0437\u043D\u0430\u0447\u044D\u043D\u043D\u0435"} \u043F\u0430\u0432\u0456\u043D\u043D\u0430 ${W.verb} ${z}${Y.maximum.toString()} ${U}`;
        }
        return `\u0417\u0430\u043D\u0430\u0434\u0442\u0430 \u0432\u044F\u043B\u0456\u043A\u0456: \u0447\u0430\u043A\u0430\u043B\u0430\u0441\u044F, \u0448\u0442\u043E ${Y.origin ?? "\u0437\u043D\u0430\u0447\u044D\u043D\u043D\u0435"} \u043F\u0430\u0432\u0456\u043D\u043D\u0430 \u0431\u044B\u0446\u044C ${z}${Y.maximum.toString()}`;
      }
      case "too_small": {
        let z = Y.inclusive ? ">=" : ">", W = X(Y.origin);
        if (W) {
          let G = Number(Y.minimum), U = qN(G, W.unit.one, W.unit.few, W.unit.many);
          return `\u0417\u0430\u043D\u0430\u0434\u0442\u0430 \u043C\u0430\u043B\u044B: \u0447\u0430\u043A\u0430\u043B\u0430\u0441\u044F, \u0448\u0442\u043E ${Y.origin} \u043F\u0430\u0432\u0456\u043D\u043D\u0430 ${W.verb} ${z}${Y.minimum.toString()} ${U}`;
        }
        return `\u0417\u0430\u043D\u0430\u0434\u0442\u0430 \u043C\u0430\u043B\u044B: \u0447\u0430\u043A\u0430\u043B\u0430\u0441\u044F, \u0448\u0442\u043E ${Y.origin} \u043F\u0430\u0432\u0456\u043D\u043D\u0430 \u0431\u044B\u0446\u044C ${z}${Y.minimum.toString()}`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u0440\u0430\u0434\u043E\u043A: \u043F\u0430\u0432\u0456\u043D\u0435\u043D \u043F\u0430\u0447\u044B\u043D\u0430\u0446\u0446\u0430 \u0437 "${z.prefix}"`;
        if (z.format === "ends_with") return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u0440\u0430\u0434\u043E\u043A: \u043F\u0430\u0432\u0456\u043D\u0435\u043D \u0437\u0430\u043A\u0430\u043D\u0447\u0432\u0430\u0446\u0446\u0430 \u043D\u0430 "${z.suffix}"`;
        if (z.format === "includes") return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u0440\u0430\u0434\u043E\u043A: \u043F\u0430\u0432\u0456\u043D\u0435\u043D \u0437\u043C\u044F\u0448\u0447\u0430\u0446\u044C "${z.includes}"`;
        if (z.format === "regex") return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u0440\u0430\u0434\u043E\u043A: \u043F\u0430\u0432\u0456\u043D\u0435\u043D \u0430\u0434\u043F\u0430\u0432\u044F\u0434\u0430\u0446\u044C \u0448\u0430\u0431\u043B\u043E\u043D\u0443 ${z.pattern}`;
        return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B ${Q[z.format] ?? Y.format}`;
      }
      case "not_multiple_of":
        return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u043B\u0456\u043A: \u043F\u0430\u0432\u0456\u043D\u0435\u043D \u0431\u044B\u0446\u044C \u043A\u0440\u0430\u0442\u043D\u044B\u043C ${Y.divisor}`;
      case "unrecognized_keys":
        return `\u041D\u0435\u0440\u0430\u0441\u043F\u0430\u0437\u043D\u0430\u043D\u044B ${Y.keys.length > 1 ? "\u043A\u043B\u044E\u0447\u044B" : "\u043A\u043B\u044E\u0447"}: ${I(Y.keys, ", ")}`;
      case "invalid_key":
        return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u043A\u043B\u044E\u0447 \u0443 ${Y.origin}`;
      case "invalid_union":
        return "\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u045E\u0432\u043E\u0434";
      case "invalid_element":
        return `\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u0430\u0435 \u0437\u043D\u0430\u0447\u044D\u043D\u043D\u0435 \u045E ${Y.origin}`;
      default:
        return "\u041D\u044F\u043F\u0440\u0430\u0432\u0456\u043B\u044C\u043D\u044B \u045E\u0432\u043E\u0434";
    }
  };
};
function NW() {
  return { localeError: XA() };
}
var JA = () => {
  let $ = { string: { unit: "car\xE0cters", verb: "contenir" }, file: { unit: "bytes", verb: "contenir" }, array: { unit: "elements", verb: "contenir" }, set: { unit: "elements", verb: "contenir" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "NaN" : "number";
      case "object": {
        if (Array.isArray(Y)) return "array";
        if (Y === null) return "null";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "entrada", email: "adre\xE7a electr\xF2nica", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "data i hora ISO", date: "data ISO", time: "hora ISO", duration: "durada ISO", ipv4: "adre\xE7a IPv4", ipv6: "adre\xE7a IPv6", cidrv4: "rang IPv4", cidrv6: "rang IPv6", base64: "cadena codificada en base64", base64url: "cadena codificada en base64url", json_string: "cadena JSON", e164: "n\xFAmero E.164", jwt: "JWT", template_literal: "entrada" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `Tipus inv\xE0lid: s'esperava ${Y.expected}, s'ha rebut ${J(Y.input)}`;
      case "invalid_value":
        if (Y.values.length === 1) return `Valor inv\xE0lid: s'esperava ${S(Y.values[0])}`;
        return `Opci\xF3 inv\xE0lida: s'esperava una de ${I(Y.values, " o ")}`;
      case "too_big": {
        let z = Y.inclusive ? "com a m\xE0xim" : "menys de", W = X(Y.origin);
        if (W) return `Massa gran: s'esperava que ${Y.origin ?? "el valor"} contingu\xE9s ${z} ${Y.maximum.toString()} ${W.unit ?? "elements"}`;
        return `Massa gran: s'esperava que ${Y.origin ?? "el valor"} fos ${z} ${Y.maximum.toString()}`;
      }
      case "too_small": {
        let z = Y.inclusive ? "com a m\xEDnim" : "m\xE9s de", W = X(Y.origin);
        if (W) return `Massa petit: s'esperava que ${Y.origin} contingu\xE9s ${z} ${Y.minimum.toString()} ${W.unit}`;
        return `Massa petit: s'esperava que ${Y.origin} fos ${z} ${Y.minimum.toString()}`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `Format inv\xE0lid: ha de comen\xE7ar amb "${z.prefix}"`;
        if (z.format === "ends_with") return `Format inv\xE0lid: ha d'acabar amb "${z.suffix}"`;
        if (z.format === "includes") return `Format inv\xE0lid: ha d'incloure "${z.includes}"`;
        if (z.format === "regex") return `Format inv\xE0lid: ha de coincidir amb el patr\xF3 ${z.pattern}`;
        return `Format inv\xE0lid per a ${Q[z.format] ?? Y.format}`;
      }
      case "not_multiple_of":
        return `N\xFAmero inv\xE0lid: ha de ser m\xFAltiple de ${Y.divisor}`;
      case "unrecognized_keys":
        return `Clau${Y.keys.length > 1 ? "s" : ""} no reconeguda${Y.keys.length > 1 ? "s" : ""}: ${I(Y.keys, ", ")}`;
      case "invalid_key":
        return `Clau inv\xE0lida a ${Y.origin}`;
      case "invalid_union":
        return "Entrada inv\xE0lida";
      case "invalid_element":
        return `Element inv\xE0lid a ${Y.origin}`;
      default:
        return "Entrada inv\xE0lida";
    }
  };
};
function VW() {
  return { localeError: JA() };
}
var YA = () => {
  let $ = { string: { unit: "znak\u016F", verb: "m\xEDt" }, file: { unit: "bajt\u016F", verb: "m\xEDt" }, array: { unit: "prvk\u016F", verb: "m\xEDt" }, set: { unit: "prvk\u016F", verb: "m\xEDt" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "NaN" : "\u010D\xEDslo";
      case "string":
        return "\u0159et\u011Bzec";
      case "boolean":
        return "boolean";
      case "bigint":
        return "bigint";
      case "function":
        return "funkce";
      case "symbol":
        return "symbol";
      case "undefined":
        return "undefined";
      case "object": {
        if (Array.isArray(Y)) return "pole";
        if (Y === null) return "null";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "regul\xE1rn\xED v\xFDraz", email: "e-mailov\xE1 adresa", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "datum a \u010Das ve form\xE1tu ISO", date: "datum ve form\xE1tu ISO", time: "\u010Das ve form\xE1tu ISO", duration: "doba trv\xE1n\xED ISO", ipv4: "IPv4 adresa", ipv6: "IPv6 adresa", cidrv4: "rozsah IPv4", cidrv6: "rozsah IPv6", base64: "\u0159et\u011Bzec zak\xF3dovan\xFD ve form\xE1tu base64", base64url: "\u0159et\u011Bzec zak\xF3dovan\xFD ve form\xE1tu base64url", json_string: "\u0159et\u011Bzec ve form\xE1tu JSON", e164: "\u010D\xEDslo E.164", jwt: "JWT", template_literal: "vstup" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `Neplatn\xFD vstup: o\u010Dek\xE1v\xE1no ${Y.expected}, obdr\u017Eeno ${J(Y.input)}`;
      case "invalid_value":
        if (Y.values.length === 1) return `Neplatn\xFD vstup: o\u010Dek\xE1v\xE1no ${S(Y.values[0])}`;
        return `Neplatn\xE1 mo\u017Enost: o\u010Dek\xE1v\xE1na jedna z hodnot ${I(Y.values, "|")}`;
      case "too_big": {
        let z = Y.inclusive ? "<=" : "<", W = X(Y.origin);
        if (W) return `Hodnota je p\u0159\xEDli\u0161 velk\xE1: ${Y.origin ?? "hodnota"} mus\xED m\xEDt ${z}${Y.maximum.toString()} ${W.unit ?? "prvk\u016F"}`;
        return `Hodnota je p\u0159\xEDli\u0161 velk\xE1: ${Y.origin ?? "hodnota"} mus\xED b\xFDt ${z}${Y.maximum.toString()}`;
      }
      case "too_small": {
        let z = Y.inclusive ? ">=" : ">", W = X(Y.origin);
        if (W) return `Hodnota je p\u0159\xEDli\u0161 mal\xE1: ${Y.origin ?? "hodnota"} mus\xED m\xEDt ${z}${Y.minimum.toString()} ${W.unit ?? "prvk\u016F"}`;
        return `Hodnota je p\u0159\xEDli\u0161 mal\xE1: ${Y.origin ?? "hodnota"} mus\xED b\xFDt ${z}${Y.minimum.toString()}`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `Neplatn\xFD \u0159et\u011Bzec: mus\xED za\u010D\xEDnat na "${z.prefix}"`;
        if (z.format === "ends_with") return `Neplatn\xFD \u0159et\u011Bzec: mus\xED kon\u010Dit na "${z.suffix}"`;
        if (z.format === "includes") return `Neplatn\xFD \u0159et\u011Bzec: mus\xED obsahovat "${z.includes}"`;
        if (z.format === "regex") return `Neplatn\xFD \u0159et\u011Bzec: mus\xED odpov\xEDdat vzoru ${z.pattern}`;
        return `Neplatn\xFD form\xE1t ${Q[z.format] ?? Y.format}`;
      }
      case "not_multiple_of":
        return `Neplatn\xE9 \u010D\xEDslo: mus\xED b\xFDt n\xE1sobkem ${Y.divisor}`;
      case "unrecognized_keys":
        return `Nezn\xE1m\xE9 kl\xED\u010De: ${I(Y.keys, ", ")}`;
      case "invalid_key":
        return `Neplatn\xFD kl\xED\u010D v ${Y.origin}`;
      case "invalid_union":
        return "Neplatn\xFD vstup";
      case "invalid_element":
        return `Neplatn\xE1 hodnota v ${Y.origin}`;
      default:
        return "Neplatn\xFD vstup";
    }
  };
};
function OW() {
  return { localeError: YA() };
}
var QA = () => {
  let $ = { string: { unit: "Zeichen", verb: "zu haben" }, file: { unit: "Bytes", verb: "zu haben" }, array: { unit: "Elemente", verb: "zu haben" }, set: { unit: "Elemente", verb: "zu haben" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "NaN" : "Zahl";
      case "object": {
        if (Array.isArray(Y)) return "Array";
        if (Y === null) return "null";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "Eingabe", email: "E-Mail-Adresse", url: "URL", emoji: "Emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO-Datum und -Uhrzeit", date: "ISO-Datum", time: "ISO-Uhrzeit", duration: "ISO-Dauer", ipv4: "IPv4-Adresse", ipv6: "IPv6-Adresse", cidrv4: "IPv4-Bereich", cidrv6: "IPv6-Bereich", base64: "Base64-codierter String", base64url: "Base64-URL-codierter String", json_string: "JSON-String", e164: "E.164-Nummer", jwt: "JWT", template_literal: "Eingabe" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `Ung\xFCltige Eingabe: erwartet ${Y.expected}, erhalten ${J(Y.input)}`;
      case "invalid_value":
        if (Y.values.length === 1) return `Ung\xFCltige Eingabe: erwartet ${S(Y.values[0])}`;
        return `Ung\xFCltige Option: erwartet eine von ${I(Y.values, "|")}`;
      case "too_big": {
        let z = Y.inclusive ? "<=" : "<", W = X(Y.origin);
        if (W) return `Zu gro\xDF: erwartet, dass ${Y.origin ?? "Wert"} ${z}${Y.maximum.toString()} ${W.unit ?? "Elemente"} hat`;
        return `Zu gro\xDF: erwartet, dass ${Y.origin ?? "Wert"} ${z}${Y.maximum.toString()} ist`;
      }
      case "too_small": {
        let z = Y.inclusive ? ">=" : ">", W = X(Y.origin);
        if (W) return `Zu klein: erwartet, dass ${Y.origin} ${z}${Y.minimum.toString()} ${W.unit} hat`;
        return `Zu klein: erwartet, dass ${Y.origin} ${z}${Y.minimum.toString()} ist`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `Ung\xFCltiger String: muss mit "${z.prefix}" beginnen`;
        if (z.format === "ends_with") return `Ung\xFCltiger String: muss mit "${z.suffix}" enden`;
        if (z.format === "includes") return `Ung\xFCltiger String: muss "${z.includes}" enthalten`;
        if (z.format === "regex") return `Ung\xFCltiger String: muss dem Muster ${z.pattern} entsprechen`;
        return `Ung\xFCltig: ${Q[z.format] ?? Y.format}`;
      }
      case "not_multiple_of":
        return `Ung\xFCltige Zahl: muss ein Vielfaches von ${Y.divisor} sein`;
      case "unrecognized_keys":
        return `${Y.keys.length > 1 ? "Unbekannte Schl\xFCssel" : "Unbekannter Schl\xFCssel"}: ${I(Y.keys, ", ")}`;
      case "invalid_key":
        return `Ung\xFCltiger Schl\xFCssel in ${Y.origin}`;
      case "invalid_union":
        return "Ung\xFCltige Eingabe";
      case "invalid_element":
        return `Ung\xFCltiger Wert in ${Y.origin}`;
      default:
        return "Ung\xFCltige Eingabe";
    }
  };
};
function wW() {
  return { localeError: QA() };
}
var zA = ($) => {
  let X = typeof $;
  switch (X) {
    case "number":
      return Number.isNaN($) ? "NaN" : "number";
    case "object": {
      if (Array.isArray($)) return "array";
      if ($ === null) return "null";
      if (Object.getPrototypeOf($) !== Object.prototype && $.constructor) return $.constructor.name;
    }
  }
  return X;
};
var WA = () => {
  let $ = { string: { unit: "characters", verb: "to have" }, file: { unit: "bytes", verb: "to have" }, array: { unit: "items", verb: "to have" }, set: { unit: "items", verb: "to have" } };
  function X(Q) {
    return $[Q] ?? null;
  }
  let J = { regex: "input", email: "email address", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO datetime", date: "ISO date", time: "ISO time", duration: "ISO duration", ipv4: "IPv4 address", ipv6: "IPv6 address", cidrv4: "IPv4 range", cidrv6: "IPv6 range", base64: "base64-encoded string", base64url: "base64url-encoded string", json_string: "JSON string", e164: "E.164 number", jwt: "JWT", template_literal: "input" };
  return (Q) => {
    switch (Q.code) {
      case "invalid_type":
        return `Invalid input: expected ${Q.expected}, received ${zA(Q.input)}`;
      case "invalid_value":
        if (Q.values.length === 1) return `Invalid input: expected ${S(Q.values[0])}`;
        return `Invalid option: expected one of ${I(Q.values, "|")}`;
      case "too_big": {
        let Y = Q.inclusive ? "<=" : "<", z = X(Q.origin);
        if (z) return `Too big: expected ${Q.origin ?? "value"} to have ${Y}${Q.maximum.toString()} ${z.unit ?? "elements"}`;
        return `Too big: expected ${Q.origin ?? "value"} to be ${Y}${Q.maximum.toString()}`;
      }
      case "too_small": {
        let Y = Q.inclusive ? ">=" : ">", z = X(Q.origin);
        if (z) return `Too small: expected ${Q.origin} to have ${Y}${Q.minimum.toString()} ${z.unit}`;
        return `Too small: expected ${Q.origin} to be ${Y}${Q.minimum.toString()}`;
      }
      case "invalid_format": {
        let Y = Q;
        if (Y.format === "starts_with") return `Invalid string: must start with "${Y.prefix}"`;
        if (Y.format === "ends_with") return `Invalid string: must end with "${Y.suffix}"`;
        if (Y.format === "includes") return `Invalid string: must include "${Y.includes}"`;
        if (Y.format === "regex") return `Invalid string: must match pattern ${Y.pattern}`;
        return `Invalid ${J[Y.format] ?? Q.format}`;
      }
      case "not_multiple_of":
        return `Invalid number: must be a multiple of ${Q.divisor}`;
      case "unrecognized_keys":
        return `Unrecognized key${Q.keys.length > 1 ? "s" : ""}: ${I(Q.keys, ", ")}`;
      case "invalid_key":
        return `Invalid key in ${Q.origin}`;
      case "invalid_union":
        return "Invalid input";
      case "invalid_element":
        return `Invalid value in ${Q.origin}`;
      default:
        return "Invalid input";
    }
  };
};
function F8() {
  return { localeError: WA() };
}
var GA = ($) => {
  let X = typeof $;
  switch (X) {
    case "number":
      return Number.isNaN($) ? "NaN" : "nombro";
    case "object": {
      if (Array.isArray($)) return "tabelo";
      if ($ === null) return "senvalora";
      if (Object.getPrototypeOf($) !== Object.prototype && $.constructor) return $.constructor.name;
    }
  }
  return X;
};
var UA = () => {
  let $ = { string: { unit: "karaktrojn", verb: "havi" }, file: { unit: "bajtojn", verb: "havi" }, array: { unit: "elementojn", verb: "havi" }, set: { unit: "elementojn", verb: "havi" } };
  function X(Q) {
    return $[Q] ?? null;
  }
  let J = { regex: "enigo", email: "retadreso", url: "URL", emoji: "emo\u011Dio", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO-datotempo", date: "ISO-dato", time: "ISO-tempo", duration: "ISO-da\u016Dro", ipv4: "IPv4-adreso", ipv6: "IPv6-adreso", cidrv4: "IPv4-rango", cidrv6: "IPv6-rango", base64: "64-ume kodita karaktraro", base64url: "URL-64-ume kodita karaktraro", json_string: "JSON-karaktraro", e164: "E.164-nombro", jwt: "JWT", template_literal: "enigo" };
  return (Q) => {
    switch (Q.code) {
      case "invalid_type":
        return `Nevalida enigo: atendi\u011Dis ${Q.expected}, ricevi\u011Dis ${GA(Q.input)}`;
      case "invalid_value":
        if (Q.values.length === 1) return `Nevalida enigo: atendi\u011Dis ${S(Q.values[0])}`;
        return `Nevalida opcio: atendi\u011Dis unu el ${I(Q.values, "|")}`;
      case "too_big": {
        let Y = Q.inclusive ? "<=" : "<", z = X(Q.origin);
        if (z) return `Tro granda: atendi\u011Dis ke ${Q.origin ?? "valoro"} havu ${Y}${Q.maximum.toString()} ${z.unit ?? "elementojn"}`;
        return `Tro granda: atendi\u011Dis ke ${Q.origin ?? "valoro"} havu ${Y}${Q.maximum.toString()}`;
      }
      case "too_small": {
        let Y = Q.inclusive ? ">=" : ">", z = X(Q.origin);
        if (z) return `Tro malgranda: atendi\u011Dis ke ${Q.origin} havu ${Y}${Q.minimum.toString()} ${z.unit}`;
        return `Tro malgranda: atendi\u011Dis ke ${Q.origin} estu ${Y}${Q.minimum.toString()}`;
      }
      case "invalid_format": {
        let Y = Q;
        if (Y.format === "starts_with") return `Nevalida karaktraro: devas komenci\u011Di per "${Y.prefix}"`;
        if (Y.format === "ends_with") return `Nevalida karaktraro: devas fini\u011Di per "${Y.suffix}"`;
        if (Y.format === "includes") return `Nevalida karaktraro: devas inkluzivi "${Y.includes}"`;
        if (Y.format === "regex") return `Nevalida karaktraro: devas kongrui kun la modelo ${Y.pattern}`;
        return `Nevalida ${J[Y.format] ?? Q.format}`;
      }
      case "not_multiple_of":
        return `Nevalida nombro: devas esti oblo de ${Q.divisor}`;
      case "unrecognized_keys":
        return `Nekonata${Q.keys.length > 1 ? "j" : ""} \u015Dlosilo${Q.keys.length > 1 ? "j" : ""}: ${I(Q.keys, ", ")}`;
      case "invalid_key":
        return `Nevalida \u015Dlosilo en ${Q.origin}`;
      case "invalid_union":
        return "Nevalida enigo";
      case "invalid_element":
        return `Nevalida valoro en ${Q.origin}`;
      default:
        return "Nevalida enigo";
    }
  };
};
function BW() {
  return { localeError: UA() };
}
var HA = () => {
  let $ = { string: { unit: "caracteres", verb: "tener" }, file: { unit: "bytes", verb: "tener" }, array: { unit: "elementos", verb: "tener" }, set: { unit: "elementos", verb: "tener" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "NaN" : "n\xFAmero";
      case "object": {
        if (Array.isArray(Y)) return "arreglo";
        if (Y === null) return "nulo";
        if (Object.getPrototypeOf(Y) !== Object.prototype) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "entrada", email: "direcci\xF3n de correo electr\xF3nico", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "fecha y hora ISO", date: "fecha ISO", time: "hora ISO", duration: "duraci\xF3n ISO", ipv4: "direcci\xF3n IPv4", ipv6: "direcci\xF3n IPv6", cidrv4: "rango IPv4", cidrv6: "rango IPv6", base64: "cadena codificada en base64", base64url: "URL codificada en base64", json_string: "cadena JSON", e164: "n\xFAmero E.164", jwt: "JWT", template_literal: "entrada" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `Entrada inv\xE1lida: se esperaba ${Y.expected}, recibido ${J(Y.input)}`;
      case "invalid_value":
        if (Y.values.length === 1) return `Entrada inv\xE1lida: se esperaba ${S(Y.values[0])}`;
        return `Opci\xF3n inv\xE1lida: se esperaba una de ${I(Y.values, "|")}`;
      case "too_big": {
        let z = Y.inclusive ? "<=" : "<", W = X(Y.origin);
        if (W) return `Demasiado grande: se esperaba que ${Y.origin ?? "valor"} tuviera ${z}${Y.maximum.toString()} ${W.unit ?? "elementos"}`;
        return `Demasiado grande: se esperaba que ${Y.origin ?? "valor"} fuera ${z}${Y.maximum.toString()}`;
      }
      case "too_small": {
        let z = Y.inclusive ? ">=" : ">", W = X(Y.origin);
        if (W) return `Demasiado peque\xF1o: se esperaba que ${Y.origin} tuviera ${z}${Y.minimum.toString()} ${W.unit}`;
        return `Demasiado peque\xF1o: se esperaba que ${Y.origin} fuera ${z}${Y.minimum.toString()}`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `Cadena inv\xE1lida: debe comenzar con "${z.prefix}"`;
        if (z.format === "ends_with") return `Cadena inv\xE1lida: debe terminar en "${z.suffix}"`;
        if (z.format === "includes") return `Cadena inv\xE1lida: debe incluir "${z.includes}"`;
        if (z.format === "regex") return `Cadena inv\xE1lida: debe coincidir con el patr\xF3n ${z.pattern}`;
        return `Inv\xE1lido ${Q[z.format] ?? Y.format}`;
      }
      case "not_multiple_of":
        return `N\xFAmero inv\xE1lido: debe ser m\xFAltiplo de ${Y.divisor}`;
      case "unrecognized_keys":
        return `Llave${Y.keys.length > 1 ? "s" : ""} desconocida${Y.keys.length > 1 ? "s" : ""}: ${I(Y.keys, ", ")}`;
      case "invalid_key":
        return `Llave inv\xE1lida en ${Y.origin}`;
      case "invalid_union":
        return "Entrada inv\xE1lida";
      case "invalid_element":
        return `Valor inv\xE1lido en ${Y.origin}`;
      default:
        return "Entrada inv\xE1lida";
    }
  };
};
function qW() {
  return { localeError: HA() };
}
var KA = () => {
  let $ = { string: { unit: "\u06A9\u0627\u0631\u0627\u06A9\u062A\u0631", verb: "\u062F\u0627\u0634\u062A\u0647 \u0628\u0627\u0634\u062F" }, file: { unit: "\u0628\u0627\u06CC\u062A", verb: "\u062F\u0627\u0634\u062A\u0647 \u0628\u0627\u0634\u062F" }, array: { unit: "\u0622\u06CC\u062A\u0645", verb: "\u062F\u0627\u0634\u062A\u0647 \u0628\u0627\u0634\u062F" }, set: { unit: "\u0622\u06CC\u062A\u0645", verb: "\u062F\u0627\u0634\u062A\u0647 \u0628\u0627\u0634\u062F" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "NaN" : "\u0639\u062F\u062F";
      case "object": {
        if (Array.isArray(Y)) return "\u0622\u0631\u0627\u06CC\u0647";
        if (Y === null) return "null";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "\u0648\u0631\u0648\u062F\u06CC", email: "\u0622\u062F\u0631\u0633 \u0627\u06CC\u0645\u06CC\u0644", url: "URL", emoji: "\u0627\u06CC\u0645\u0648\u062C\u06CC", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "\u062A\u0627\u0631\u06CC\u062E \u0648 \u0632\u0645\u0627\u0646 \u0627\u06CC\u0632\u0648", date: "\u062A\u0627\u0631\u06CC\u062E \u0627\u06CC\u0632\u0648", time: "\u0632\u0645\u0627\u0646 \u0627\u06CC\u0632\u0648", duration: "\u0645\u062F\u062A \u0632\u0645\u0627\u0646 \u0627\u06CC\u0632\u0648", ipv4: "IPv4 \u0622\u062F\u0631\u0633", ipv6: "IPv6 \u0622\u062F\u0631\u0633", cidrv4: "IPv4 \u062F\u0627\u0645\u0646\u0647", cidrv6: "IPv6 \u062F\u0627\u0645\u0646\u0647", base64: "base64-encoded \u0631\u0634\u062A\u0647", base64url: "base64url-encoded \u0631\u0634\u062A\u0647", json_string: "JSON \u0631\u0634\u062A\u0647", e164: "E.164 \u0639\u062F\u062F", jwt: "JWT", template_literal: "\u0648\u0631\u0648\u062F\u06CC" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `\u0648\u0631\u0648\u062F\u06CC \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0645\u06CC\u200C\u0628\u0627\u06CC\u0633\u062A ${Y.expected} \u0645\u06CC\u200C\u0628\u0648\u062F\u060C ${J(Y.input)} \u062F\u0631\u06CC\u0627\u0641\u062A \u0634\u062F`;
      case "invalid_value":
        if (Y.values.length === 1) return `\u0648\u0631\u0648\u062F\u06CC \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0645\u06CC\u200C\u0628\u0627\u06CC\u0633\u062A ${S(Y.values[0])} \u0645\u06CC\u200C\u0628\u0648\u062F`;
        return `\u06AF\u0632\u06CC\u0646\u0647 \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0645\u06CC\u200C\u0628\u0627\u06CC\u0633\u062A \u06CC\u06A9\u06CC \u0627\u0632 ${I(Y.values, "|")} \u0645\u06CC\u200C\u0628\u0648\u062F`;
      case "too_big": {
        let z = Y.inclusive ? "<=" : "<", W = X(Y.origin);
        if (W) return `\u062E\u06CC\u0644\u06CC \u0628\u0632\u0631\u06AF: ${Y.origin ?? "\u0645\u0642\u062F\u0627\u0631"} \u0628\u0627\u06CC\u062F ${z}${Y.maximum.toString()} ${W.unit ?? "\u0639\u0646\u0635\u0631"} \u0628\u0627\u0634\u062F`;
        return `\u062E\u06CC\u0644\u06CC \u0628\u0632\u0631\u06AF: ${Y.origin ?? "\u0645\u0642\u062F\u0627\u0631"} \u0628\u0627\u06CC\u062F ${z}${Y.maximum.toString()} \u0628\u0627\u0634\u062F`;
      }
      case "too_small": {
        let z = Y.inclusive ? ">=" : ">", W = X(Y.origin);
        if (W) return `\u062E\u06CC\u0644\u06CC \u06A9\u0648\u0686\u06A9: ${Y.origin} \u0628\u0627\u06CC\u062F ${z}${Y.minimum.toString()} ${W.unit} \u0628\u0627\u0634\u062F`;
        return `\u062E\u06CC\u0644\u06CC \u06A9\u0648\u0686\u06A9: ${Y.origin} \u0628\u0627\u06CC\u062F ${z}${Y.minimum.toString()} \u0628\u0627\u0634\u062F`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `\u0631\u0634\u062A\u0647 \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0628\u0627\u06CC\u062F \u0628\u0627 "${z.prefix}" \u0634\u0631\u0648\u0639 \u0634\u0648\u062F`;
        if (z.format === "ends_with") return `\u0631\u0634\u062A\u0647 \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0628\u0627\u06CC\u062F \u0628\u0627 "${z.suffix}" \u062A\u0645\u0627\u0645 \u0634\u0648\u062F`;
        if (z.format === "includes") return `\u0631\u0634\u062A\u0647 \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0628\u0627\u06CC\u062F \u0634\u0627\u0645\u0644 "${z.includes}" \u0628\u0627\u0634\u062F`;
        if (z.format === "regex") return `\u0631\u0634\u062A\u0647 \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0628\u0627\u06CC\u062F \u0628\u0627 \u0627\u0644\u06AF\u0648\u06CC ${z.pattern} \u0645\u0637\u0627\u0628\u0642\u062A \u062F\u0627\u0634\u062A\u0647 \u0628\u0627\u0634\u062F`;
        return `${Q[z.format] ?? Y.format} \u0646\u0627\u0645\u0639\u062A\u0628\u0631`;
      }
      case "not_multiple_of":
        return `\u0639\u062F\u062F \u0646\u0627\u0645\u0639\u062A\u0628\u0631: \u0628\u0627\u06CC\u062F \u0645\u0636\u0631\u0628 ${Y.divisor} \u0628\u0627\u0634\u062F`;
      case "unrecognized_keys":
        return `\u06A9\u0644\u06CC\u062F${Y.keys.length > 1 ? "\u0647\u0627\u06CC" : ""} \u0646\u0627\u0634\u0646\u0627\u0633: ${I(Y.keys, ", ")}`;
      case "invalid_key":
        return `\u06A9\u0644\u06CC\u062F \u0646\u0627\u0634\u0646\u0627\u0633 \u062F\u0631 ${Y.origin}`;
      case "invalid_union":
        return "\u0648\u0631\u0648\u062F\u06CC \u0646\u0627\u0645\u0639\u062A\u0628\u0631";
      case "invalid_element":
        return `\u0645\u0642\u062F\u0627\u0631 \u0646\u0627\u0645\u0639\u062A\u0628\u0631 \u062F\u0631 ${Y.origin}`;
      default:
        return "\u0648\u0631\u0648\u062F\u06CC \u0646\u0627\u0645\u0639\u062A\u0628\u0631";
    }
  };
};
function DW() {
  return { localeError: KA() };
}
var NA = () => {
  let $ = { string: { unit: "merkki\xE4", subject: "merkkijonon" }, file: { unit: "tavua", subject: "tiedoston" }, array: { unit: "alkiota", subject: "listan" }, set: { unit: "alkiota", subject: "joukon" }, number: { unit: "", subject: "luvun" }, bigint: { unit: "", subject: "suuren kokonaisluvun" }, int: { unit: "", subject: "kokonaisluvun" }, date: { unit: "", subject: "p\xE4iv\xE4m\xE4\xE4r\xE4n" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "NaN" : "number";
      case "object": {
        if (Array.isArray(Y)) return "array";
        if (Y === null) return "null";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "s\xE4\xE4nn\xF6llinen lauseke", email: "s\xE4hk\xF6postiosoite", url: "URL-osoite", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO-aikaleima", date: "ISO-p\xE4iv\xE4m\xE4\xE4r\xE4", time: "ISO-aika", duration: "ISO-kesto", ipv4: "IPv4-osoite", ipv6: "IPv6-osoite", cidrv4: "IPv4-alue", cidrv6: "IPv6-alue", base64: "base64-koodattu merkkijono", base64url: "base64url-koodattu merkkijono", json_string: "JSON-merkkijono", e164: "E.164-luku", jwt: "JWT", template_literal: "templaattimerkkijono" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `Virheellinen tyyppi: odotettiin ${Y.expected}, oli ${J(Y.input)}`;
      case "invalid_value":
        if (Y.values.length === 1) return `Virheellinen sy\xF6te: t\xE4ytyy olla ${S(Y.values[0])}`;
        return `Virheellinen valinta: t\xE4ytyy olla yksi seuraavista: ${I(Y.values, "|")}`;
      case "too_big": {
        let z = Y.inclusive ? "<=" : "<", W = X(Y.origin);
        if (W) return `Liian suuri: ${W.subject} t\xE4ytyy olla ${z}${Y.maximum.toString()} ${W.unit}`.trim();
        return `Liian suuri: arvon t\xE4ytyy olla ${z}${Y.maximum.toString()}`;
      }
      case "too_small": {
        let z = Y.inclusive ? ">=" : ">", W = X(Y.origin);
        if (W) return `Liian pieni: ${W.subject} t\xE4ytyy olla ${z}${Y.minimum.toString()} ${W.unit}`.trim();
        return `Liian pieni: arvon t\xE4ytyy olla ${z}${Y.minimum.toString()}`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `Virheellinen sy\xF6te: t\xE4ytyy alkaa "${z.prefix}"`;
        if (z.format === "ends_with") return `Virheellinen sy\xF6te: t\xE4ytyy loppua "${z.suffix}"`;
        if (z.format === "includes") return `Virheellinen sy\xF6te: t\xE4ytyy sis\xE4lt\xE4\xE4 "${z.includes}"`;
        if (z.format === "regex") return `Virheellinen sy\xF6te: t\xE4ytyy vastata s\xE4\xE4nn\xF6llist\xE4 lauseketta ${z.pattern}`;
        return `Virheellinen ${Q[z.format] ?? Y.format}`;
      }
      case "not_multiple_of":
        return `Virheellinen luku: t\xE4ytyy olla luvun ${Y.divisor} monikerta`;
      case "unrecognized_keys":
        return `${Y.keys.length > 1 ? "Tuntemattomat avaimet" : "Tuntematon avain"}: ${I(Y.keys, ", ")}`;
      case "invalid_key":
        return "Virheellinen avain tietueessa";
      case "invalid_union":
        return "Virheellinen unioni";
      case "invalid_element":
        return "Virheellinen arvo joukossa";
      default:
        return "Virheellinen sy\xF6te";
    }
  };
};
function LW() {
  return { localeError: NA() };
}
var VA = () => {
  let $ = { string: { unit: "caract\xE8res", verb: "avoir" }, file: { unit: "octets", verb: "avoir" }, array: { unit: "\xE9l\xE9ments", verb: "avoir" }, set: { unit: "\xE9l\xE9ments", verb: "avoir" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "NaN" : "nombre";
      case "object": {
        if (Array.isArray(Y)) return "tableau";
        if (Y === null) return "null";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "entr\xE9e", email: "adresse e-mail", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "date et heure ISO", date: "date ISO", time: "heure ISO", duration: "dur\xE9e ISO", ipv4: "adresse IPv4", ipv6: "adresse IPv6", cidrv4: "plage IPv4", cidrv6: "plage IPv6", base64: "cha\xEEne encod\xE9e en base64", base64url: "cha\xEEne encod\xE9e en base64url", json_string: "cha\xEEne JSON", e164: "num\xE9ro E.164", jwt: "JWT", template_literal: "entr\xE9e" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `Entr\xE9e invalide : ${Y.expected} attendu, ${J(Y.input)} re\xE7u`;
      case "invalid_value":
        if (Y.values.length === 1) return `Entr\xE9e invalide : ${S(Y.values[0])} attendu`;
        return `Option invalide : une valeur parmi ${I(Y.values, "|")} attendue`;
      case "too_big": {
        let z = Y.inclusive ? "<=" : "<", W = X(Y.origin);
        if (W) return `Trop grand : ${Y.origin ?? "valeur"} doit ${W.verb} ${z}${Y.maximum.toString()} ${W.unit ?? "\xE9l\xE9ment(s)"}`;
        return `Trop grand : ${Y.origin ?? "valeur"} doit \xEAtre ${z}${Y.maximum.toString()}`;
      }
      case "too_small": {
        let z = Y.inclusive ? ">=" : ">", W = X(Y.origin);
        if (W) return `Trop petit : ${Y.origin} doit ${W.verb} ${z}${Y.minimum.toString()} ${W.unit}`;
        return `Trop petit : ${Y.origin} doit \xEAtre ${z}${Y.minimum.toString()}`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `Cha\xEEne invalide : doit commencer par "${z.prefix}"`;
        if (z.format === "ends_with") return `Cha\xEEne invalide : doit se terminer par "${z.suffix}"`;
        if (z.format === "includes") return `Cha\xEEne invalide : doit inclure "${z.includes}"`;
        if (z.format === "regex") return `Cha\xEEne invalide : doit correspondre au mod\xE8le ${z.pattern}`;
        return `${Q[z.format] ?? Y.format} invalide`;
      }
      case "not_multiple_of":
        return `Nombre invalide : doit \xEAtre un multiple de ${Y.divisor}`;
      case "unrecognized_keys":
        return `Cl\xE9${Y.keys.length > 1 ? "s" : ""} non reconnue${Y.keys.length > 1 ? "s" : ""} : ${I(Y.keys, ", ")}`;
      case "invalid_key":
        return `Cl\xE9 invalide dans ${Y.origin}`;
      case "invalid_union":
        return "Entr\xE9e invalide";
      case "invalid_element":
        return `Valeur invalide dans ${Y.origin}`;
      default:
        return "Entr\xE9e invalide";
    }
  };
};
function jW() {
  return { localeError: VA() };
}
var OA = () => {
  let $ = { string: { unit: "caract\xE8res", verb: "avoir" }, file: { unit: "octets", verb: "avoir" }, array: { unit: "\xE9l\xE9ments", verb: "avoir" }, set: { unit: "\xE9l\xE9ments", verb: "avoir" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "NaN" : "number";
      case "object": {
        if (Array.isArray(Y)) return "array";
        if (Y === null) return "null";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "entr\xE9e", email: "adresse courriel", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "date-heure ISO", date: "date ISO", time: "heure ISO", duration: "dur\xE9e ISO", ipv4: "adresse IPv4", ipv6: "adresse IPv6", cidrv4: "plage IPv4", cidrv6: "plage IPv6", base64: "cha\xEEne encod\xE9e en base64", base64url: "cha\xEEne encod\xE9e en base64url", json_string: "cha\xEEne JSON", e164: "num\xE9ro E.164", jwt: "JWT", template_literal: "entr\xE9e" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `Entr\xE9e invalide : attendu ${Y.expected}, re\xE7u ${J(Y.input)}`;
      case "invalid_value":
        if (Y.values.length === 1) return `Entr\xE9e invalide : attendu ${S(Y.values[0])}`;
        return `Option invalide : attendu l'une des valeurs suivantes ${I(Y.values, "|")}`;
      case "too_big": {
        let z = Y.inclusive ? "\u2264" : "<", W = X(Y.origin);
        if (W) return `Trop grand : attendu que ${Y.origin ?? "la valeur"} ait ${z}${Y.maximum.toString()} ${W.unit}`;
        return `Trop grand : attendu que ${Y.origin ?? "la valeur"} soit ${z}${Y.maximum.toString()}`;
      }
      case "too_small": {
        let z = Y.inclusive ? "\u2265" : ">", W = X(Y.origin);
        if (W) return `Trop petit : attendu que ${Y.origin} ait ${z}${Y.minimum.toString()} ${W.unit}`;
        return `Trop petit : attendu que ${Y.origin} soit ${z}${Y.minimum.toString()}`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `Cha\xEEne invalide : doit commencer par "${z.prefix}"`;
        if (z.format === "ends_with") return `Cha\xEEne invalide : doit se terminer par "${z.suffix}"`;
        if (z.format === "includes") return `Cha\xEEne invalide : doit inclure "${z.includes}"`;
        if (z.format === "regex") return `Cha\xEEne invalide : doit correspondre au motif ${z.pattern}`;
        return `${Q[z.format] ?? Y.format} invalide`;
      }
      case "not_multiple_of":
        return `Nombre invalide : doit \xEAtre un multiple de ${Y.divisor}`;
      case "unrecognized_keys":
        return `Cl\xE9${Y.keys.length > 1 ? "s" : ""} non reconnue${Y.keys.length > 1 ? "s" : ""} : ${I(Y.keys, ", ")}`;
      case "invalid_key":
        return `Cl\xE9 invalide dans ${Y.origin}`;
      case "invalid_union":
        return "Entr\xE9e invalide";
      case "invalid_element":
        return `Valeur invalide dans ${Y.origin}`;
      default:
        return "Entr\xE9e invalide";
    }
  };
};
function FW() {
  return { localeError: OA() };
}
var wA = () => {
  let $ = { string: { unit: "\u05D0\u05D5\u05EA\u05D9\u05D5\u05EA", verb: "\u05DC\u05DB\u05DC\u05D5\u05DC" }, file: { unit: "\u05D1\u05D9\u05D9\u05D8\u05D9\u05DD", verb: "\u05DC\u05DB\u05DC\u05D5\u05DC" }, array: { unit: "\u05E4\u05E8\u05D9\u05D8\u05D9\u05DD", verb: "\u05DC\u05DB\u05DC\u05D5\u05DC" }, set: { unit: "\u05E4\u05E8\u05D9\u05D8\u05D9\u05DD", verb: "\u05DC\u05DB\u05DC\u05D5\u05DC" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "NaN" : "number";
      case "object": {
        if (Array.isArray(Y)) return "array";
        if (Y === null) return "null";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "\u05E7\u05DC\u05D8", email: "\u05DB\u05EA\u05D5\u05D1\u05EA \u05D0\u05D9\u05DE\u05D9\u05D9\u05DC", url: "\u05DB\u05EA\u05D5\u05D1\u05EA \u05E8\u05E9\u05EA", emoji: "\u05D0\u05D9\u05DE\u05D5\u05D2'\u05D9", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "\u05EA\u05D0\u05E8\u05D9\u05DA \u05D5\u05D6\u05DE\u05DF ISO", date: "\u05EA\u05D0\u05E8\u05D9\u05DA ISO", time: "\u05D6\u05DE\u05DF ISO", duration: "\u05DE\u05E9\u05DA \u05D6\u05DE\u05DF ISO", ipv4: "\u05DB\u05EA\u05D5\u05D1\u05EA IPv4", ipv6: "\u05DB\u05EA\u05D5\u05D1\u05EA IPv6", cidrv4: "\u05D8\u05D5\u05D5\u05D7 IPv4", cidrv6: "\u05D8\u05D5\u05D5\u05D7 IPv6", base64: "\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA \u05D1\u05D1\u05E1\u05D9\u05E1 64", base64url: "\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA \u05D1\u05D1\u05E1\u05D9\u05E1 64 \u05DC\u05DB\u05EA\u05D5\u05D1\u05D5\u05EA \u05E8\u05E9\u05EA", json_string: "\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA JSON", e164: "\u05DE\u05E1\u05E4\u05E8 E.164", jwt: "JWT", template_literal: "\u05E7\u05DC\u05D8" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `\u05E7\u05DC\u05D8 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF: \u05E6\u05E8\u05D9\u05DA ${Y.expected}, \u05D4\u05EA\u05E7\u05D1\u05DC ${J(Y.input)}`;
      case "invalid_value":
        if (Y.values.length === 1) return `\u05E7\u05DC\u05D8 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF: \u05E6\u05E8\u05D9\u05DA ${S(Y.values[0])}`;
        return `\u05E7\u05DC\u05D8 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF: \u05E6\u05E8\u05D9\u05DA \u05D0\u05D7\u05EA \u05DE\u05D4\u05D0\u05E4\u05E9\u05E8\u05D5\u05D9\u05D5\u05EA  ${I(Y.values, "|")}`;
      case "too_big": {
        let z = Y.inclusive ? "<=" : "<", W = X(Y.origin);
        if (W) return `\u05D2\u05D3\u05D5\u05DC \u05DE\u05D3\u05D9: ${Y.origin ?? "value"} \u05E6\u05E8\u05D9\u05DA \u05DC\u05D4\u05D9\u05D5\u05EA ${z}${Y.maximum.toString()} ${W.unit ?? "elements"}`;
        return `\u05D2\u05D3\u05D5\u05DC \u05DE\u05D3\u05D9: ${Y.origin ?? "value"} \u05E6\u05E8\u05D9\u05DA \u05DC\u05D4\u05D9\u05D5\u05EA ${z}${Y.maximum.toString()}`;
      }
      case "too_small": {
        let z = Y.inclusive ? ">=" : ">", W = X(Y.origin);
        if (W) return `\u05E7\u05D8\u05DF \u05DE\u05D3\u05D9: ${Y.origin} \u05E6\u05E8\u05D9\u05DA \u05DC\u05D4\u05D9\u05D5\u05EA ${z}${Y.minimum.toString()} ${W.unit}`;
        return `\u05E7\u05D8\u05DF \u05DE\u05D3\u05D9: ${Y.origin} \u05E6\u05E8\u05D9\u05DA \u05DC\u05D4\u05D9\u05D5\u05EA ${z}${Y.minimum.toString()}`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA \u05DC\u05D0 \u05EA\u05E7\u05D9\u05E0\u05D4: \u05D7\u05D9\u05D9\u05D1\u05EA \u05DC\u05D4\u05EA\u05D7\u05D9\u05DC \u05D1"${z.prefix}"`;
        if (z.format === "ends_with") return `\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA \u05DC\u05D0 \u05EA\u05E7\u05D9\u05E0\u05D4: \u05D7\u05D9\u05D9\u05D1\u05EA \u05DC\u05D4\u05E1\u05EA\u05D9\u05D9\u05DD \u05D1 "${z.suffix}"`;
        if (z.format === "includes") return `\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA \u05DC\u05D0 \u05EA\u05E7\u05D9\u05E0\u05D4: \u05D7\u05D9\u05D9\u05D1\u05EA \u05DC\u05DB\u05DC\u05D5\u05DC "${z.includes}"`;
        if (z.format === "regex") return `\u05DE\u05D7\u05E8\u05D5\u05D6\u05EA \u05DC\u05D0 \u05EA\u05E7\u05D9\u05E0\u05D4: \u05D7\u05D9\u05D9\u05D1\u05EA \u05DC\u05D4\u05EA\u05D0\u05D9\u05DD \u05DC\u05EA\u05D1\u05E0\u05D9\u05EA ${z.pattern}`;
        return `${Q[z.format] ?? Y.format} \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF`;
      }
      case "not_multiple_of":
        return `\u05DE\u05E1\u05E4\u05E8 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF: \u05D7\u05D9\u05D9\u05D1 \u05DC\u05D4\u05D9\u05D5\u05EA \u05DE\u05DB\u05E4\u05DC\u05D4 \u05E9\u05DC ${Y.divisor}`;
      case "unrecognized_keys":
        return `\u05DE\u05E4\u05EA\u05D7${Y.keys.length > 1 ? "\u05D5\u05EA" : ""} \u05DC\u05D0 \u05DE\u05D6\u05D5\u05D4${Y.keys.length > 1 ? "\u05D9\u05DD" : "\u05D4"}: ${I(Y.keys, ", ")}`;
      case "invalid_key":
        return `\u05DE\u05E4\u05EA\u05D7 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF \u05D1${Y.origin}`;
      case "invalid_union":
        return "\u05E7\u05DC\u05D8 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF";
      case "invalid_element":
        return `\u05E2\u05E8\u05DA \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF \u05D1${Y.origin}`;
      default:
        return "\u05E7\u05DC\u05D8 \u05DC\u05D0 \u05EA\u05E7\u05D9\u05DF";
    }
  };
};
function IW() {
  return { localeError: wA() };
}
var BA = () => {
  let $ = { string: { unit: "karakter", verb: "legyen" }, file: { unit: "byte", verb: "legyen" }, array: { unit: "elem", verb: "legyen" }, set: { unit: "elem", verb: "legyen" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "NaN" : "sz\xE1m";
      case "object": {
        if (Array.isArray(Y)) return "t\xF6mb";
        if (Y === null) return "null";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "bemenet", email: "email c\xEDm", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO id\u0151b\xE9lyeg", date: "ISO d\xE1tum", time: "ISO id\u0151", duration: "ISO id\u0151intervallum", ipv4: "IPv4 c\xEDm", ipv6: "IPv6 c\xEDm", cidrv4: "IPv4 tartom\xE1ny", cidrv6: "IPv6 tartom\xE1ny", base64: "base64-k\xF3dolt string", base64url: "base64url-k\xF3dolt string", json_string: "JSON string", e164: "E.164 sz\xE1m", jwt: "JWT", template_literal: "bemenet" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `\xC9rv\xE9nytelen bemenet: a v\xE1rt \xE9rt\xE9k ${Y.expected}, a kapott \xE9rt\xE9k ${J(Y.input)}`;
      case "invalid_value":
        if (Y.values.length === 1) return `\xC9rv\xE9nytelen bemenet: a v\xE1rt \xE9rt\xE9k ${S(Y.values[0])}`;
        return `\xC9rv\xE9nytelen opci\xF3: valamelyik \xE9rt\xE9k v\xE1rt ${I(Y.values, "|")}`;
      case "too_big": {
        let z = Y.inclusive ? "<=" : "<", W = X(Y.origin);
        if (W) return `T\xFAl nagy: ${Y.origin ?? "\xE9rt\xE9k"} m\xE9rete t\xFAl nagy ${z}${Y.maximum.toString()} ${W.unit ?? "elem"}`;
        return `T\xFAl nagy: a bemeneti \xE9rt\xE9k ${Y.origin ?? "\xE9rt\xE9k"} t\xFAl nagy: ${z}${Y.maximum.toString()}`;
      }
      case "too_small": {
        let z = Y.inclusive ? ">=" : ">", W = X(Y.origin);
        if (W) return `T\xFAl kicsi: a bemeneti \xE9rt\xE9k ${Y.origin} m\xE9rete t\xFAl kicsi ${z}${Y.minimum.toString()} ${W.unit}`;
        return `T\xFAl kicsi: a bemeneti \xE9rt\xE9k ${Y.origin} t\xFAl kicsi ${z}${Y.minimum.toString()}`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `\xC9rv\xE9nytelen string: "${z.prefix}" \xE9rt\xE9kkel kell kezd\u0151dnie`;
        if (z.format === "ends_with") return `\xC9rv\xE9nytelen string: "${z.suffix}" \xE9rt\xE9kkel kell v\xE9gz\u0151dnie`;
        if (z.format === "includes") return `\xC9rv\xE9nytelen string: "${z.includes}" \xE9rt\xE9ket kell tartalmaznia`;
        if (z.format === "regex") return `\xC9rv\xE9nytelen string: ${z.pattern} mint\xE1nak kell megfelelnie`;
        return `\xC9rv\xE9nytelen ${Q[z.format] ?? Y.format}`;
      }
      case "not_multiple_of":
        return `\xC9rv\xE9nytelen sz\xE1m: ${Y.divisor} t\xF6bbsz\xF6r\xF6s\xE9nek kell lennie`;
      case "unrecognized_keys":
        return `Ismeretlen kulcs${Y.keys.length > 1 ? "s" : ""}: ${I(Y.keys, ", ")}`;
      case "invalid_key":
        return `\xC9rv\xE9nytelen kulcs ${Y.origin}`;
      case "invalid_union":
        return "\xC9rv\xE9nytelen bemenet";
      case "invalid_element":
        return `\xC9rv\xE9nytelen \xE9rt\xE9k: ${Y.origin}`;
      default:
        return "\xC9rv\xE9nytelen bemenet";
    }
  };
};
function MW() {
  return { localeError: BA() };
}
var qA = () => {
  let $ = { string: { unit: "karakter", verb: "memiliki" }, file: { unit: "byte", verb: "memiliki" }, array: { unit: "item", verb: "memiliki" }, set: { unit: "item", verb: "memiliki" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "NaN" : "number";
      case "object": {
        if (Array.isArray(Y)) return "array";
        if (Y === null) return "null";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "input", email: "alamat email", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "tanggal dan waktu format ISO", date: "tanggal format ISO", time: "jam format ISO", duration: "durasi format ISO", ipv4: "alamat IPv4", ipv6: "alamat IPv6", cidrv4: "rentang alamat IPv4", cidrv6: "rentang alamat IPv6", base64: "string dengan enkode base64", base64url: "string dengan enkode base64url", json_string: "string JSON", e164: "angka E.164", jwt: "JWT", template_literal: "input" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `Input tidak valid: diharapkan ${Y.expected}, diterima ${J(Y.input)}`;
      case "invalid_value":
        if (Y.values.length === 1) return `Input tidak valid: diharapkan ${S(Y.values[0])}`;
        return `Pilihan tidak valid: diharapkan salah satu dari ${I(Y.values, "|")}`;
      case "too_big": {
        let z = Y.inclusive ? "<=" : "<", W = X(Y.origin);
        if (W) return `Terlalu besar: diharapkan ${Y.origin ?? "value"} memiliki ${z}${Y.maximum.toString()} ${W.unit ?? "elemen"}`;
        return `Terlalu besar: diharapkan ${Y.origin ?? "value"} menjadi ${z}${Y.maximum.toString()}`;
      }
      case "too_small": {
        let z = Y.inclusive ? ">=" : ">", W = X(Y.origin);
        if (W) return `Terlalu kecil: diharapkan ${Y.origin} memiliki ${z}${Y.minimum.toString()} ${W.unit}`;
        return `Terlalu kecil: diharapkan ${Y.origin} menjadi ${z}${Y.minimum.toString()}`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `String tidak valid: harus dimulai dengan "${z.prefix}"`;
        if (z.format === "ends_with") return `String tidak valid: harus berakhir dengan "${z.suffix}"`;
        if (z.format === "includes") return `String tidak valid: harus menyertakan "${z.includes}"`;
        if (z.format === "regex") return `String tidak valid: harus sesuai pola ${z.pattern}`;
        return `${Q[z.format] ?? Y.format} tidak valid`;
      }
      case "not_multiple_of":
        return `Angka tidak valid: harus kelipatan dari ${Y.divisor}`;
      case "unrecognized_keys":
        return `Kunci tidak dikenali ${Y.keys.length > 1 ? "s" : ""}: ${I(Y.keys, ", ")}`;
      case "invalid_key":
        return `Kunci tidak valid di ${Y.origin}`;
      case "invalid_union":
        return "Input tidak valid";
      case "invalid_element":
        return `Nilai tidak valid di ${Y.origin}`;
      default:
        return "Input tidak valid";
    }
  };
};
function AW() {
  return { localeError: qA() };
}
var DA = () => {
  let $ = { string: { unit: "caratteri", verb: "avere" }, file: { unit: "byte", verb: "avere" }, array: { unit: "elementi", verb: "avere" }, set: { unit: "elementi", verb: "avere" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "NaN" : "numero";
      case "object": {
        if (Array.isArray(Y)) return "vettore";
        if (Y === null) return "null";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "input", email: "indirizzo email", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "data e ora ISO", date: "data ISO", time: "ora ISO", duration: "durata ISO", ipv4: "indirizzo IPv4", ipv6: "indirizzo IPv6", cidrv4: "intervallo IPv4", cidrv6: "intervallo IPv6", base64: "stringa codificata in base64", base64url: "URL codificata in base64", json_string: "stringa JSON", e164: "numero E.164", jwt: "JWT", template_literal: "input" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `Input non valido: atteso ${Y.expected}, ricevuto ${J(Y.input)}`;
      case "invalid_value":
        if (Y.values.length === 1) return `Input non valido: atteso ${S(Y.values[0])}`;
        return `Opzione non valida: atteso uno tra ${I(Y.values, "|")}`;
      case "too_big": {
        let z = Y.inclusive ? "<=" : "<", W = X(Y.origin);
        if (W) return `Troppo grande: ${Y.origin ?? "valore"} deve avere ${z}${Y.maximum.toString()} ${W.unit ?? "elementi"}`;
        return `Troppo grande: ${Y.origin ?? "valore"} deve essere ${z}${Y.maximum.toString()}`;
      }
      case "too_small": {
        let z = Y.inclusive ? ">=" : ">", W = X(Y.origin);
        if (W) return `Troppo piccolo: ${Y.origin} deve avere ${z}${Y.minimum.toString()} ${W.unit}`;
        return `Troppo piccolo: ${Y.origin} deve essere ${z}${Y.minimum.toString()}`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `Stringa non valida: deve iniziare con "${z.prefix}"`;
        if (z.format === "ends_with") return `Stringa non valida: deve terminare con "${z.suffix}"`;
        if (z.format === "includes") return `Stringa non valida: deve includere "${z.includes}"`;
        if (z.format === "regex") return `Stringa non valida: deve corrispondere al pattern ${z.pattern}`;
        return `Invalid ${Q[z.format] ?? Y.format}`;
      }
      case "not_multiple_of":
        return `Numero non valido: deve essere un multiplo di ${Y.divisor}`;
      case "unrecognized_keys":
        return `Chiav${Y.keys.length > 1 ? "i" : "e"} non riconosciut${Y.keys.length > 1 ? "e" : "a"}: ${I(Y.keys, ", ")}`;
      case "invalid_key":
        return `Chiave non valida in ${Y.origin}`;
      case "invalid_union":
        return "Input non valido";
      case "invalid_element":
        return `Valore non valido in ${Y.origin}`;
      default:
        return "Input non valido";
    }
  };
};
function bW() {
  return { localeError: DA() };
}
var LA = () => {
  let $ = { string: { unit: "\u6587\u5B57", verb: "\u3067\u3042\u308B" }, file: { unit: "\u30D0\u30A4\u30C8", verb: "\u3067\u3042\u308B" }, array: { unit: "\u8981\u7D20", verb: "\u3067\u3042\u308B" }, set: { unit: "\u8981\u7D20", verb: "\u3067\u3042\u308B" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "NaN" : "\u6570\u5024";
      case "object": {
        if (Array.isArray(Y)) return "\u914D\u5217";
        if (Y === null) return "null";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "\u5165\u529B\u5024", email: "\u30E1\u30FC\u30EB\u30A2\u30C9\u30EC\u30B9", url: "URL", emoji: "\u7D75\u6587\u5B57", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO\u65E5\u6642", date: "ISO\u65E5\u4ED8", time: "ISO\u6642\u523B", duration: "ISO\u671F\u9593", ipv4: "IPv4\u30A2\u30C9\u30EC\u30B9", ipv6: "IPv6\u30A2\u30C9\u30EC\u30B9", cidrv4: "IPv4\u7BC4\u56F2", cidrv6: "IPv6\u7BC4\u56F2", base64: "base64\u30A8\u30F3\u30B3\u30FC\u30C9\u6587\u5B57\u5217", base64url: "base64url\u30A8\u30F3\u30B3\u30FC\u30C9\u6587\u5B57\u5217", json_string: "JSON\u6587\u5B57\u5217", e164: "E.164\u756A\u53F7", jwt: "JWT", template_literal: "\u5165\u529B\u5024" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `\u7121\u52B9\u306A\u5165\u529B: ${Y.expected}\u304C\u671F\u5F85\u3055\u308C\u307E\u3057\u305F\u304C\u3001${J(Y.input)}\u304C\u5165\u529B\u3055\u308C\u307E\u3057\u305F`;
      case "invalid_value":
        if (Y.values.length === 1) return `\u7121\u52B9\u306A\u5165\u529B: ${S(Y.values[0])}\u304C\u671F\u5F85\u3055\u308C\u307E\u3057\u305F`;
        return `\u7121\u52B9\u306A\u9078\u629E: ${I(Y.values, "\u3001")}\u306E\u3044\u305A\u308C\u304B\u3067\u3042\u308B\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
      case "too_big": {
        let z = Y.inclusive ? "\u4EE5\u4E0B\u3067\u3042\u308B" : "\u3088\u308A\u5C0F\u3055\u3044", W = X(Y.origin);
        if (W) return `\u5927\u304D\u3059\u304E\u308B\u5024: ${Y.origin ?? "\u5024"}\u306F${Y.maximum.toString()}${W.unit ?? "\u8981\u7D20"}${z}\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
        return `\u5927\u304D\u3059\u304E\u308B\u5024: ${Y.origin ?? "\u5024"}\u306F${Y.maximum.toString()}${z}\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
      }
      case "too_small": {
        let z = Y.inclusive ? "\u4EE5\u4E0A\u3067\u3042\u308B" : "\u3088\u308A\u5927\u304D\u3044", W = X(Y.origin);
        if (W) return `\u5C0F\u3055\u3059\u304E\u308B\u5024: ${Y.origin}\u306F${Y.minimum.toString()}${W.unit}${z}\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
        return `\u5C0F\u3055\u3059\u304E\u308B\u5024: ${Y.origin}\u306F${Y.minimum.toString()}${z}\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `\u7121\u52B9\u306A\u6587\u5B57\u5217: "${z.prefix}"\u3067\u59CB\u307E\u308B\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
        if (z.format === "ends_with") return `\u7121\u52B9\u306A\u6587\u5B57\u5217: "${z.suffix}"\u3067\u7D42\u308F\u308B\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
        if (z.format === "includes") return `\u7121\u52B9\u306A\u6587\u5B57\u5217: "${z.includes}"\u3092\u542B\u3080\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
        if (z.format === "regex") return `\u7121\u52B9\u306A\u6587\u5B57\u5217: \u30D1\u30BF\u30FC\u30F3${z.pattern}\u306B\u4E00\u81F4\u3059\u308B\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
        return `\u7121\u52B9\u306A${Q[z.format] ?? Y.format}`;
      }
      case "not_multiple_of":
        return `\u7121\u52B9\u306A\u6570\u5024: ${Y.divisor}\u306E\u500D\u6570\u3067\u3042\u308B\u5FC5\u8981\u304C\u3042\u308A\u307E\u3059`;
      case "unrecognized_keys":
        return `\u8A8D\u8B58\u3055\u308C\u3066\u3044\u306A\u3044\u30AD\u30FC${Y.keys.length > 1 ? "\u7FA4" : ""}: ${I(Y.keys, "\u3001")}`;
      case "invalid_key":
        return `${Y.origin}\u5185\u306E\u7121\u52B9\u306A\u30AD\u30FC`;
      case "invalid_union":
        return "\u7121\u52B9\u306A\u5165\u529B";
      case "invalid_element":
        return `${Y.origin}\u5185\u306E\u7121\u52B9\u306A\u5024`;
      default:
        return "\u7121\u52B9\u306A\u5165\u529B";
    }
  };
};
function PW() {
  return { localeError: LA() };
}
var jA = () => {
  let $ = { string: { unit: "\u178F\u17BD\u17A2\u1780\u17D2\u179F\u179A", verb: "\u1782\u17BD\u179A\u1798\u17B6\u1793" }, file: { unit: "\u1794\u17C3", verb: "\u1782\u17BD\u179A\u1798\u17B6\u1793" }, array: { unit: "\u1792\u17B6\u178F\u17BB", verb: "\u1782\u17BD\u179A\u1798\u17B6\u1793" }, set: { unit: "\u1792\u17B6\u178F\u17BB", verb: "\u1782\u17BD\u179A\u1798\u17B6\u1793" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "\u1798\u17B7\u1793\u1798\u17C2\u1793\u1787\u17B6\u179B\u17C1\u1781 (NaN)" : "\u179B\u17C1\u1781";
      case "object": {
        if (Array.isArray(Y)) return "\u17A2\u17B6\u179A\u17C1 (Array)";
        if (Y === null) return "\u1782\u17D2\u1798\u17B6\u1793\u178F\u1798\u17D2\u179B\u17C3 (null)";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1794\u1789\u17D2\u1785\u17BC\u179B", email: "\u17A2\u17B6\u179F\u1799\u178A\u17D2\u178B\u17B6\u1793\u17A2\u17CA\u17B8\u1798\u17C2\u179B", url: "URL", emoji: "\u179F\u1789\u17D2\u1789\u17B6\u17A2\u17B6\u179A\u1798\u17D2\u1798\u178E\u17CD", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "\u1780\u17B6\u179B\u1794\u179A\u17B7\u1785\u17D2\u1786\u17C1\u1791 \u1793\u17B7\u1784\u1798\u17C9\u17C4\u1784 ISO", date: "\u1780\u17B6\u179B\u1794\u179A\u17B7\u1785\u17D2\u1786\u17C1\u1791 ISO", time: "\u1798\u17C9\u17C4\u1784 ISO", duration: "\u179A\u1799\u17C8\u1796\u17C1\u179B ISO", ipv4: "\u17A2\u17B6\u179F\u1799\u178A\u17D2\u178B\u17B6\u1793 IPv4", ipv6: "\u17A2\u17B6\u179F\u1799\u178A\u17D2\u178B\u17B6\u1793 IPv6", cidrv4: "\u178A\u17C2\u1793\u17A2\u17B6\u179F\u1799\u178A\u17D2\u178B\u17B6\u1793 IPv4", cidrv6: "\u178A\u17C2\u1793\u17A2\u17B6\u179F\u1799\u178A\u17D2\u178B\u17B6\u1793 IPv6", base64: "\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A\u17A2\u17CA\u17B7\u1780\u17BC\u178A base64", base64url: "\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A\u17A2\u17CA\u17B7\u1780\u17BC\u178A base64url", json_string: "\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A JSON", e164: "\u179B\u17C1\u1781 E.164", jwt: "JWT", template_literal: "\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1794\u1789\u17D2\u1785\u17BC\u179B" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1794\u1789\u17D2\u1785\u17BC\u179B\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1780\u17B6\u179A ${Y.expected} \u1794\u17C9\u17BB\u1793\u17D2\u178F\u17C2\u1791\u1791\u17BD\u179B\u1794\u17B6\u1793 ${J(Y.input)}`;
      case "invalid_value":
        if (Y.values.length === 1) return `\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1794\u1789\u17D2\u1785\u17BC\u179B\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1780\u17B6\u179A ${S(Y.values[0])}`;
        return `\u1787\u1798\u17D2\u179A\u17BE\u179F\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1787\u17B6\u1798\u17BD\u1799\u1780\u17D2\u1793\u17BB\u1784\u1785\u17C6\u178E\u17C4\u1798 ${I(Y.values, "|")}`;
      case "too_big": {
        let z = Y.inclusive ? "<=" : "<", W = X(Y.origin);
        if (W) return `\u1792\u17C6\u1796\u17C1\u1780\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1780\u17B6\u179A ${Y.origin ?? "\u178F\u1798\u17D2\u179B\u17C3"} ${z} ${Y.maximum.toString()} ${W.unit ?? "\u1792\u17B6\u178F\u17BB"}`;
        return `\u1792\u17C6\u1796\u17C1\u1780\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1780\u17B6\u179A ${Y.origin ?? "\u178F\u1798\u17D2\u179B\u17C3"} ${z} ${Y.maximum.toString()}`;
      }
      case "too_small": {
        let z = Y.inclusive ? ">=" : ">", W = X(Y.origin);
        if (W) return `\u178F\u17BC\u1785\u1796\u17C1\u1780\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1780\u17B6\u179A ${Y.origin} ${z} ${Y.minimum.toString()} ${W.unit}`;
        return `\u178F\u17BC\u1785\u1796\u17C1\u1780\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1780\u17B6\u179A ${Y.origin} ${z} ${Y.minimum.toString()}`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1785\u17B6\u1794\u17CB\u1795\u17D2\u178F\u17BE\u1798\u178A\u17C4\u1799 "${z.prefix}"`;
        if (z.format === "ends_with") return `\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1794\u1789\u17D2\u1785\u1794\u17CB\u178A\u17C4\u1799 "${z.suffix}"`;
        if (z.format === "includes") return `\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u1798\u17B6\u1793 "${z.includes}"`;
        if (z.format === "regex") return `\u1781\u17D2\u179F\u17C2\u17A2\u1780\u17D2\u179F\u179A\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u178F\u17C2\u1795\u17D2\u1782\u17BC\u1795\u17D2\u1782\u1784\u1793\u17B9\u1784\u1791\u1798\u17D2\u179A\u1784\u17CB\u178A\u17C2\u179B\u1794\u17B6\u1793\u1780\u17C6\u178E\u178F\u17CB ${z.pattern}`;
        return `\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 ${Q[z.format] ?? Y.format}`;
      }
      case "not_multiple_of":
        return `\u179B\u17C1\u1781\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u17D6 \u178F\u17D2\u179A\u17BC\u179C\u178F\u17C2\u1787\u17B6\u1796\u17A0\u17BB\u1782\u17BB\u178E\u1793\u17C3 ${Y.divisor}`;
      case "unrecognized_keys":
        return `\u179A\u1780\u1783\u17BE\u1789\u179F\u17C4\u1798\u17B7\u1793\u179F\u17D2\u1782\u17B6\u179B\u17CB\u17D6 ${I(Y.keys, ", ")}`;
      case "invalid_key":
        return `\u179F\u17C4\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u1793\u17C5\u1780\u17D2\u1793\u17BB\u1784 ${Y.origin}`;
      case "invalid_union":
        return "\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C";
      case "invalid_element":
        return `\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C\u1793\u17C5\u1780\u17D2\u1793\u17BB\u1784 ${Y.origin}`;
      default:
        return "\u1791\u17B7\u1793\u17D2\u1793\u1793\u17D0\u1799\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C";
    }
  };
};
function ZW() {
  return { localeError: jA() };
}
var FA = () => {
  let $ = { string: { unit: "\uBB38\uC790", verb: "to have" }, file: { unit: "\uBC14\uC774\uD2B8", verb: "to have" }, array: { unit: "\uAC1C", verb: "to have" }, set: { unit: "\uAC1C", verb: "to have" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "NaN" : "number";
      case "object": {
        if (Array.isArray(Y)) return "array";
        if (Y === null) return "null";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "\uC785\uB825", email: "\uC774\uBA54\uC77C \uC8FC\uC18C", url: "URL", emoji: "\uC774\uBAA8\uC9C0", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO \uB0A0\uC9DC\uC2DC\uAC04", date: "ISO \uB0A0\uC9DC", time: "ISO \uC2DC\uAC04", duration: "ISO \uAE30\uAC04", ipv4: "IPv4 \uC8FC\uC18C", ipv6: "IPv6 \uC8FC\uC18C", cidrv4: "IPv4 \uBC94\uC704", cidrv6: "IPv6 \uBC94\uC704", base64: "base64 \uC778\uCF54\uB529 \uBB38\uC790\uC5F4", base64url: "base64url \uC778\uCF54\uB529 \uBB38\uC790\uC5F4", json_string: "JSON \uBB38\uC790\uC5F4", e164: "E.164 \uBC88\uD638", jwt: "JWT", template_literal: "\uC785\uB825" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `\uC798\uBABB\uB41C \uC785\uB825: \uC608\uC0C1 \uD0C0\uC785\uC740 ${Y.expected}, \uBC1B\uC740 \uD0C0\uC785\uC740 ${J(Y.input)}\uC785\uB2C8\uB2E4`;
      case "invalid_value":
        if (Y.values.length === 1) return `\uC798\uBABB\uB41C \uC785\uB825: \uAC12\uC740 ${S(Y.values[0])} \uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4`;
        return `\uC798\uBABB\uB41C \uC635\uC158: ${I(Y.values, "\uB610\uB294 ")} \uC911 \uD558\uB098\uC5EC\uC57C \uD569\uB2C8\uB2E4`;
      case "too_big": {
        let z = Y.inclusive ? "\uC774\uD558" : "\uBBF8\uB9CC", W = z === "\uBBF8\uB9CC" ? "\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4" : "\uC5EC\uC57C \uD569\uB2C8\uB2E4", G = X(Y.origin), U = G?.unit ?? "\uC694\uC18C";
        if (G) return `${Y.origin ?? "\uAC12"}\uC774 \uB108\uBB34 \uD07D\uB2C8\uB2E4: ${Y.maximum.toString()}${U} ${z}${W}`;
        return `${Y.origin ?? "\uAC12"}\uC774 \uB108\uBB34 \uD07D\uB2C8\uB2E4: ${Y.maximum.toString()} ${z}${W}`;
      }
      case "too_small": {
        let z = Y.inclusive ? "\uC774\uC0C1" : "\uCD08\uACFC", W = z === "\uC774\uC0C1" ? "\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4" : "\uC5EC\uC57C \uD569\uB2C8\uB2E4", G = X(Y.origin), U = G?.unit ?? "\uC694\uC18C";
        if (G) return `${Y.origin ?? "\uAC12"}\uC774 \uB108\uBB34 \uC791\uC2B5\uB2C8\uB2E4: ${Y.minimum.toString()}${U} ${z}${W}`;
        return `${Y.origin ?? "\uAC12"}\uC774 \uB108\uBB34 \uC791\uC2B5\uB2C8\uB2E4: ${Y.minimum.toString()} ${z}${W}`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `\uC798\uBABB\uB41C \uBB38\uC790\uC5F4: "${z.prefix}"(\uC73C)\uB85C \uC2DC\uC791\uD574\uC57C \uD569\uB2C8\uB2E4`;
        if (z.format === "ends_with") return `\uC798\uBABB\uB41C \uBB38\uC790\uC5F4: "${z.suffix}"(\uC73C)\uB85C \uB05D\uB098\uC57C \uD569\uB2C8\uB2E4`;
        if (z.format === "includes") return `\uC798\uBABB\uB41C \uBB38\uC790\uC5F4: "${z.includes}"\uC744(\uB97C) \uD3EC\uD568\uD574\uC57C \uD569\uB2C8\uB2E4`;
        if (z.format === "regex") return `\uC798\uBABB\uB41C \uBB38\uC790\uC5F4: \uC815\uADDC\uC2DD ${z.pattern} \uD328\uD134\uACFC \uC77C\uCE58\uD574\uC57C \uD569\uB2C8\uB2E4`;
        return `\uC798\uBABB\uB41C ${Q[z.format] ?? Y.format}`;
      }
      case "not_multiple_of":
        return `\uC798\uBABB\uB41C \uC22B\uC790: ${Y.divisor}\uC758 \uBC30\uC218\uC5EC\uC57C \uD569\uB2C8\uB2E4`;
      case "unrecognized_keys":
        return `\uC778\uC2DD\uD560 \uC218 \uC5C6\uB294 \uD0A4: ${I(Y.keys, ", ")}`;
      case "invalid_key":
        return `\uC798\uBABB\uB41C \uD0A4: ${Y.origin}`;
      case "invalid_union":
        return "\uC798\uBABB\uB41C \uC785\uB825";
      case "invalid_element":
        return `\uC798\uBABB\uB41C \uAC12: ${Y.origin}`;
      default:
        return "\uC798\uBABB\uB41C \uC785\uB825";
    }
  };
};
function EW() {
  return { localeError: FA() };
}
var IA = () => {
  let $ = { string: { unit: "\u0437\u043D\u0430\u0446\u0438", verb: "\u0434\u0430 \u0438\u043C\u0430\u0430\u0442" }, file: { unit: "\u0431\u0430\u0458\u0442\u0438", verb: "\u0434\u0430 \u0438\u043C\u0430\u0430\u0442" }, array: { unit: "\u0441\u0442\u0430\u0432\u043A\u0438", verb: "\u0434\u0430 \u0438\u043C\u0430\u0430\u0442" }, set: { unit: "\u0441\u0442\u0430\u0432\u043A\u0438", verb: "\u0434\u0430 \u0438\u043C\u0430\u0430\u0442" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "NaN" : "\u0431\u0440\u043E\u0458";
      case "object": {
        if (Array.isArray(Y)) return "\u043D\u0438\u0437\u0430";
        if (Y === null) return "null";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "\u0432\u043D\u0435\u0441", email: "\u0430\u0434\u0440\u0435\u0441\u0430 \u043D\u0430 \u0435-\u043F\u043E\u0448\u0442\u0430", url: "URL", emoji: "\u0435\u043C\u043E\u045F\u0438", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO \u0434\u0430\u0442\u0443\u043C \u0438 \u0432\u0440\u0435\u043C\u0435", date: "ISO \u0434\u0430\u0442\u0443\u043C", time: "ISO \u0432\u0440\u0435\u043C\u0435", duration: "ISO \u0432\u0440\u0435\u043C\u0435\u0442\u0440\u0430\u0435\u045A\u0435", ipv4: "IPv4 \u0430\u0434\u0440\u0435\u0441\u0430", ipv6: "IPv6 \u0430\u0434\u0440\u0435\u0441\u0430", cidrv4: "IPv4 \u043E\u043F\u0441\u0435\u0433", cidrv6: "IPv6 \u043E\u043F\u0441\u0435\u0433", base64: "base64-\u0435\u043D\u043A\u043E\u0434\u0438\u0440\u0430\u043D\u0430 \u043D\u0438\u0437\u0430", base64url: "base64url-\u0435\u043D\u043A\u043E\u0434\u0438\u0440\u0430\u043D\u0430 \u043D\u0438\u0437\u0430", json_string: "JSON \u043D\u0438\u0437\u0430", e164: "E.164 \u0431\u0440\u043E\u0458", jwt: "JWT", template_literal: "\u0432\u043D\u0435\u0441" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `\u0413\u0440\u0435\u0448\u0435\u043D \u0432\u043D\u0435\u0441: \u0441\u0435 \u043E\u0447\u0435\u043A\u0443\u0432\u0430 ${Y.expected}, \u043F\u0440\u0438\u043C\u0435\u043D\u043E ${J(Y.input)}`;
      case "invalid_value":
        if (Y.values.length === 1) return `Invalid input: expected ${S(Y.values[0])}`;
        return `\u0413\u0440\u0435\u0448\u0430\u043D\u0430 \u043E\u043F\u0446\u0438\u0458\u0430: \u0441\u0435 \u043E\u0447\u0435\u043A\u0443\u0432\u0430 \u0435\u0434\u043D\u0430 ${I(Y.values, "|")}`;
      case "too_big": {
        let z = Y.inclusive ? "<=" : "<", W = X(Y.origin);
        if (W) return `\u041F\u0440\u0435\u043C\u043D\u043E\u0433\u0443 \u0433\u043E\u043B\u0435\u043C: \u0441\u0435 \u043E\u0447\u0435\u043A\u0443\u0432\u0430 ${Y.origin ?? "\u0432\u0440\u0435\u0434\u043D\u043E\u0441\u0442\u0430"} \u0434\u0430 \u0438\u043C\u0430 ${z}${Y.maximum.toString()} ${W.unit ?? "\u0435\u043B\u0435\u043C\u0435\u043D\u0442\u0438"}`;
        return `\u041F\u0440\u0435\u043C\u043D\u043E\u0433\u0443 \u0433\u043E\u043B\u0435\u043C: \u0441\u0435 \u043E\u0447\u0435\u043A\u0443\u0432\u0430 ${Y.origin ?? "\u0432\u0440\u0435\u0434\u043D\u043E\u0441\u0442\u0430"} \u0434\u0430 \u0431\u0438\u0434\u0435 ${z}${Y.maximum.toString()}`;
      }
      case "too_small": {
        let z = Y.inclusive ? ">=" : ">", W = X(Y.origin);
        if (W) return `\u041F\u0440\u0435\u043C\u043D\u043E\u0433\u0443 \u043C\u0430\u043B: \u0441\u0435 \u043E\u0447\u0435\u043A\u0443\u0432\u0430 ${Y.origin} \u0434\u0430 \u0438\u043C\u0430 ${z}${Y.minimum.toString()} ${W.unit}`;
        return `\u041F\u0440\u0435\u043C\u043D\u043E\u0433\u0443 \u043C\u0430\u043B: \u0441\u0435 \u043E\u0447\u0435\u043A\u0443\u0432\u0430 ${Y.origin} \u0434\u0430 \u0431\u0438\u0434\u0435 ${z}${Y.minimum.toString()}`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `\u041D\u0435\u0432\u0430\u0436\u0435\u0447\u043A\u0430 \u043D\u0438\u0437\u0430: \u043C\u043E\u0440\u0430 \u0434\u0430 \u0437\u0430\u043F\u043E\u0447\u043D\u0443\u0432\u0430 \u0441\u043E "${z.prefix}"`;
        if (z.format === "ends_with") return `\u041D\u0435\u0432\u0430\u0436\u0435\u0447\u043A\u0430 \u043D\u0438\u0437\u0430: \u043C\u043E\u0440\u0430 \u0434\u0430 \u0437\u0430\u0432\u0440\u0448\u0443\u0432\u0430 \u0441\u043E "${z.suffix}"`;
        if (z.format === "includes") return `\u041D\u0435\u0432\u0430\u0436\u0435\u0447\u043A\u0430 \u043D\u0438\u0437\u0430: \u043C\u043E\u0440\u0430 \u0434\u0430 \u0432\u043A\u043B\u0443\u0447\u0443\u0432\u0430 "${z.includes}"`;
        if (z.format === "regex") return `\u041D\u0435\u0432\u0430\u0436\u0435\u0447\u043A\u0430 \u043D\u0438\u0437\u0430: \u043C\u043E\u0440\u0430 \u0434\u0430 \u043E\u0434\u0433\u043E\u0430\u0440\u0430 \u043D\u0430 \u043F\u0430\u0442\u0435\u0440\u043D\u043E\u0442 ${z.pattern}`;
        return `Invalid ${Q[z.format] ?? Y.format}`;
      }
      case "not_multiple_of":
        return `\u0413\u0440\u0435\u0448\u0435\u043D \u0431\u0440\u043E\u0458: \u043C\u043E\u0440\u0430 \u0434\u0430 \u0431\u0438\u0434\u0435 \u0434\u0435\u043B\u0438\u0432 \u0441\u043E ${Y.divisor}`;
      case "unrecognized_keys":
        return `${Y.keys.length > 1 ? "\u041D\u0435\u043F\u0440\u0435\u043F\u043E\u0437\u043D\u0430\u0435\u043D\u0438 \u043A\u043B\u0443\u0447\u0435\u0432\u0438" : "\u041D\u0435\u043F\u0440\u0435\u043F\u043E\u0437\u043D\u0430\u0435\u043D \u043A\u043B\u0443\u0447"}: ${I(Y.keys, ", ")}`;
      case "invalid_key":
        return `\u0413\u0440\u0435\u0448\u0435\u043D \u043A\u043B\u0443\u0447 \u0432\u043E ${Y.origin}`;
      case "invalid_union":
        return "\u0413\u0440\u0435\u0448\u0435\u043D \u0432\u043D\u0435\u0441";
      case "invalid_element":
        return `\u0413\u0440\u0435\u0448\u043D\u0430 \u0432\u0440\u0435\u0434\u043D\u043E\u0441\u0442 \u0432\u043E ${Y.origin}`;
      default:
        return "\u0413\u0440\u0435\u0448\u0435\u043D \u0432\u043D\u0435\u0441";
    }
  };
};
function RW() {
  return { localeError: IA() };
}
var MA = () => {
  let $ = { string: { unit: "aksara", verb: "mempunyai" }, file: { unit: "bait", verb: "mempunyai" }, array: { unit: "elemen", verb: "mempunyai" }, set: { unit: "elemen", verb: "mempunyai" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "NaN" : "nombor";
      case "object": {
        if (Array.isArray(Y)) return "array";
        if (Y === null) return "null";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "input", email: "alamat e-mel", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "tarikh masa ISO", date: "tarikh ISO", time: "masa ISO", duration: "tempoh ISO", ipv4: "alamat IPv4", ipv6: "alamat IPv6", cidrv4: "julat IPv4", cidrv6: "julat IPv6", base64: "string dikodkan base64", base64url: "string dikodkan base64url", json_string: "string JSON", e164: "nombor E.164", jwt: "JWT", template_literal: "input" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `Input tidak sah: dijangka ${Y.expected}, diterima ${J(Y.input)}`;
      case "invalid_value":
        if (Y.values.length === 1) return `Input tidak sah: dijangka ${S(Y.values[0])}`;
        return `Pilihan tidak sah: dijangka salah satu daripada ${I(Y.values, "|")}`;
      case "too_big": {
        let z = Y.inclusive ? "<=" : "<", W = X(Y.origin);
        if (W) return `Terlalu besar: dijangka ${Y.origin ?? "nilai"} ${W.verb} ${z}${Y.maximum.toString()} ${W.unit ?? "elemen"}`;
        return `Terlalu besar: dijangka ${Y.origin ?? "nilai"} adalah ${z}${Y.maximum.toString()}`;
      }
      case "too_small": {
        let z = Y.inclusive ? ">=" : ">", W = X(Y.origin);
        if (W) return `Terlalu kecil: dijangka ${Y.origin} ${W.verb} ${z}${Y.minimum.toString()} ${W.unit}`;
        return `Terlalu kecil: dijangka ${Y.origin} adalah ${z}${Y.minimum.toString()}`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `String tidak sah: mesti bermula dengan "${z.prefix}"`;
        if (z.format === "ends_with") return `String tidak sah: mesti berakhir dengan "${z.suffix}"`;
        if (z.format === "includes") return `String tidak sah: mesti mengandungi "${z.includes}"`;
        if (z.format === "regex") return `String tidak sah: mesti sepadan dengan corak ${z.pattern}`;
        return `${Q[z.format] ?? Y.format} tidak sah`;
      }
      case "not_multiple_of":
        return `Nombor tidak sah: perlu gandaan ${Y.divisor}`;
      case "unrecognized_keys":
        return `Kunci tidak dikenali: ${I(Y.keys, ", ")}`;
      case "invalid_key":
        return `Kunci tidak sah dalam ${Y.origin}`;
      case "invalid_union":
        return "Input tidak sah";
      case "invalid_element":
        return `Nilai tidak sah dalam ${Y.origin}`;
      default:
        return "Input tidak sah";
    }
  };
};
function SW() {
  return { localeError: MA() };
}
var AA = () => {
  let $ = { string: { unit: "tekens" }, file: { unit: "bytes" }, array: { unit: "elementen" }, set: { unit: "elementen" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "NaN" : "getal";
      case "object": {
        if (Array.isArray(Y)) return "array";
        if (Y === null) return "null";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "invoer", email: "emailadres", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO datum en tijd", date: "ISO datum", time: "ISO tijd", duration: "ISO duur", ipv4: "IPv4-adres", ipv6: "IPv6-adres", cidrv4: "IPv4-bereik", cidrv6: "IPv6-bereik", base64: "base64-gecodeerde tekst", base64url: "base64 URL-gecodeerde tekst", json_string: "JSON string", e164: "E.164-nummer", jwt: "JWT", template_literal: "invoer" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `Ongeldige invoer: verwacht ${Y.expected}, ontving ${J(Y.input)}`;
      case "invalid_value":
        if (Y.values.length === 1) return `Ongeldige invoer: verwacht ${S(Y.values[0])}`;
        return `Ongeldige optie: verwacht \xE9\xE9n van ${I(Y.values, "|")}`;
      case "too_big": {
        let z = Y.inclusive ? "<=" : "<", W = X(Y.origin);
        if (W) return `Te lang: verwacht dat ${Y.origin ?? "waarde"} ${z}${Y.maximum.toString()} ${W.unit ?? "elementen"} bevat`;
        return `Te lang: verwacht dat ${Y.origin ?? "waarde"} ${z}${Y.maximum.toString()} is`;
      }
      case "too_small": {
        let z = Y.inclusive ? ">=" : ">", W = X(Y.origin);
        if (W) return `Te kort: verwacht dat ${Y.origin} ${z}${Y.minimum.toString()} ${W.unit} bevat`;
        return `Te kort: verwacht dat ${Y.origin} ${z}${Y.minimum.toString()} is`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `Ongeldige tekst: moet met "${z.prefix}" beginnen`;
        if (z.format === "ends_with") return `Ongeldige tekst: moet op "${z.suffix}" eindigen`;
        if (z.format === "includes") return `Ongeldige tekst: moet "${z.includes}" bevatten`;
        if (z.format === "regex") return `Ongeldige tekst: moet overeenkomen met patroon ${z.pattern}`;
        return `Ongeldig: ${Q[z.format] ?? Y.format}`;
      }
      case "not_multiple_of":
        return `Ongeldig getal: moet een veelvoud van ${Y.divisor} zijn`;
      case "unrecognized_keys":
        return `Onbekende key${Y.keys.length > 1 ? "s" : ""}: ${I(Y.keys, ", ")}`;
      case "invalid_key":
        return `Ongeldige key in ${Y.origin}`;
      case "invalid_union":
        return "Ongeldige invoer";
      case "invalid_element":
        return `Ongeldige waarde in ${Y.origin}`;
      default:
        return "Ongeldige invoer";
    }
  };
};
function vW() {
  return { localeError: AA() };
}
var bA = () => {
  let $ = { string: { unit: "tegn", verb: "\xE5 ha" }, file: { unit: "bytes", verb: "\xE5 ha" }, array: { unit: "elementer", verb: "\xE5 inneholde" }, set: { unit: "elementer", verb: "\xE5 inneholde" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "NaN" : "tall";
      case "object": {
        if (Array.isArray(Y)) return "liste";
        if (Y === null) return "null";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "input", email: "e-postadresse", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO dato- og klokkeslett", date: "ISO-dato", time: "ISO-klokkeslett", duration: "ISO-varighet", ipv4: "IPv4-omr\xE5de", ipv6: "IPv6-omr\xE5de", cidrv4: "IPv4-spekter", cidrv6: "IPv6-spekter", base64: "base64-enkodet streng", base64url: "base64url-enkodet streng", json_string: "JSON-streng", e164: "E.164-nummer", jwt: "JWT", template_literal: "input" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `Ugyldig input: forventet ${Y.expected}, fikk ${J(Y.input)}`;
      case "invalid_value":
        if (Y.values.length === 1) return `Ugyldig verdi: forventet ${S(Y.values[0])}`;
        return `Ugyldig valg: forventet en av ${I(Y.values, "|")}`;
      case "too_big": {
        let z = Y.inclusive ? "<=" : "<", W = X(Y.origin);
        if (W) return `For stor(t): forventet ${Y.origin ?? "value"} til \xE5 ha ${z}${Y.maximum.toString()} ${W.unit ?? "elementer"}`;
        return `For stor(t): forventet ${Y.origin ?? "value"} til \xE5 ha ${z}${Y.maximum.toString()}`;
      }
      case "too_small": {
        let z = Y.inclusive ? ">=" : ">", W = X(Y.origin);
        if (W) return `For lite(n): forventet ${Y.origin} til \xE5 ha ${z}${Y.minimum.toString()} ${W.unit}`;
        return `For lite(n): forventet ${Y.origin} til \xE5 ha ${z}${Y.minimum.toString()}`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `Ugyldig streng: m\xE5 starte med "${z.prefix}"`;
        if (z.format === "ends_with") return `Ugyldig streng: m\xE5 ende med "${z.suffix}"`;
        if (z.format === "includes") return `Ugyldig streng: m\xE5 inneholde "${z.includes}"`;
        if (z.format === "regex") return `Ugyldig streng: m\xE5 matche m\xF8nsteret ${z.pattern}`;
        return `Ugyldig ${Q[z.format] ?? Y.format}`;
      }
      case "not_multiple_of":
        return `Ugyldig tall: m\xE5 v\xE6re et multiplum av ${Y.divisor}`;
      case "unrecognized_keys":
        return `${Y.keys.length > 1 ? "Ukjente n\xF8kler" : "Ukjent n\xF8kkel"}: ${I(Y.keys, ", ")}`;
      case "invalid_key":
        return `Ugyldig n\xF8kkel i ${Y.origin}`;
      case "invalid_union":
        return "Ugyldig input";
      case "invalid_element":
        return `Ugyldig verdi i ${Y.origin}`;
      default:
        return "Ugyldig input";
    }
  };
};
function CW() {
  return { localeError: bA() };
}
var PA = () => {
  let $ = { string: { unit: "harf", verb: "olmal\u0131d\u0131r" }, file: { unit: "bayt", verb: "olmal\u0131d\u0131r" }, array: { unit: "unsur", verb: "olmal\u0131d\u0131r" }, set: { unit: "unsur", verb: "olmal\u0131d\u0131r" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "NaN" : "numara";
      case "object": {
        if (Array.isArray(Y)) return "saf";
        if (Y === null) return "gayb";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "giren", email: "epostag\xE2h", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO heng\xE2m\u0131", date: "ISO tarihi", time: "ISO zaman\u0131", duration: "ISO m\xFCddeti", ipv4: "IPv4 ni\u015F\xE2n\u0131", ipv6: "IPv6 ni\u015F\xE2n\u0131", cidrv4: "IPv4 menzili", cidrv6: "IPv6 menzili", base64: "base64-\u015Fifreli metin", base64url: "base64url-\u015Fifreli metin", json_string: "JSON metin", e164: "E.164 say\u0131s\u0131", jwt: "JWT", template_literal: "giren" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `F\xE2sit giren: umulan ${Y.expected}, al\u0131nan ${J(Y.input)}`;
      case "invalid_value":
        if (Y.values.length === 1) return `F\xE2sit giren: umulan ${S(Y.values[0])}`;
        return `F\xE2sit tercih: m\xFBteberler ${I(Y.values, "|")}`;
      case "too_big": {
        let z = Y.inclusive ? "<=" : "<", W = X(Y.origin);
        if (W) return `Fazla b\xFCy\xFCk: ${Y.origin ?? "value"}, ${z}${Y.maximum.toString()} ${W.unit ?? "elements"} sahip olmal\u0131yd\u0131.`;
        return `Fazla b\xFCy\xFCk: ${Y.origin ?? "value"}, ${z}${Y.maximum.toString()} olmal\u0131yd\u0131.`;
      }
      case "too_small": {
        let z = Y.inclusive ? ">=" : ">", W = X(Y.origin);
        if (W) return `Fazla k\xFC\xE7\xFCk: ${Y.origin}, ${z}${Y.minimum.toString()} ${W.unit} sahip olmal\u0131yd\u0131.`;
        return `Fazla k\xFC\xE7\xFCk: ${Y.origin}, ${z}${Y.minimum.toString()} olmal\u0131yd\u0131.`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `F\xE2sit metin: "${z.prefix}" ile ba\u015Flamal\u0131.`;
        if (z.format === "ends_with") return `F\xE2sit metin: "${z.suffix}" ile bitmeli.`;
        if (z.format === "includes") return `F\xE2sit metin: "${z.includes}" ihtiv\xE2 etmeli.`;
        if (z.format === "regex") return `F\xE2sit metin: ${z.pattern} nak\u015F\u0131na uymal\u0131.`;
        return `F\xE2sit ${Q[z.format] ?? Y.format}`;
      }
      case "not_multiple_of":
        return `F\xE2sit say\u0131: ${Y.divisor} kat\u0131 olmal\u0131yd\u0131.`;
      case "unrecognized_keys":
        return `Tan\u0131nmayan anahtar ${Y.keys.length > 1 ? "s" : ""}: ${I(Y.keys, ", ")}`;
      case "invalid_key":
        return `${Y.origin} i\xE7in tan\u0131nmayan anahtar var.`;
      case "invalid_union":
        return "Giren tan\u0131namad\u0131.";
      case "invalid_element":
        return `${Y.origin} i\xE7in tan\u0131nmayan k\u0131ymet var.`;
      default:
        return "K\u0131ymet tan\u0131namad\u0131.";
    }
  };
};
function kW() {
  return { localeError: PA() };
}
var ZA = () => {
  let $ = { string: { unit: "\u062A\u0648\u06A9\u064A", verb: "\u0648\u0644\u0631\u064A" }, file: { unit: "\u0628\u0627\u06CC\u067C\u0633", verb: "\u0648\u0644\u0631\u064A" }, array: { unit: "\u062A\u0648\u06A9\u064A", verb: "\u0648\u0644\u0631\u064A" }, set: { unit: "\u062A\u0648\u06A9\u064A", verb: "\u0648\u0644\u0631\u064A" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "NaN" : "\u0639\u062F\u062F";
      case "object": {
        if (Array.isArray(Y)) return "\u0627\u0631\u06D0";
        if (Y === null) return "null";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "\u0648\u0631\u0648\u062F\u064A", email: "\u0628\u0631\u06CC\u069A\u0646\u0627\u0644\u06CC\u06A9", url: "\u06CC\u0648 \u0622\u0631 \u0627\u0644", emoji: "\u0627\u06CC\u0645\u0648\u062C\u064A", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "\u0646\u06CC\u067C\u0647 \u0627\u0648 \u0648\u062E\u062A", date: "\u0646\u06D0\u067C\u0647", time: "\u0648\u062E\u062A", duration: "\u0645\u0648\u062F\u0647", ipv4: "\u062F IPv4 \u067E\u062A\u0647", ipv6: "\u062F IPv6 \u067E\u062A\u0647", cidrv4: "\u062F IPv4 \u0633\u0627\u062D\u0647", cidrv6: "\u062F IPv6 \u0633\u0627\u062D\u0647", base64: "base64-encoded \u0645\u062A\u0646", base64url: "base64url-encoded \u0645\u062A\u0646", json_string: "JSON \u0645\u062A\u0646", e164: "\u062F E.164 \u0634\u0645\u06D0\u0631\u0647", jwt: "JWT", template_literal: "\u0648\u0631\u0648\u062F\u064A" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `\u0646\u0627\u0633\u0645 \u0648\u0631\u0648\u062F\u064A: \u0628\u0627\u06CC\u062F ${Y.expected} \u0648\u0627\u06CC, \u0645\u06AB\u0631 ${J(Y.input)} \u062A\u0631\u0644\u0627\u0633\u0647 \u0634\u0648`;
      case "invalid_value":
        if (Y.values.length === 1) return `\u0646\u0627\u0633\u0645 \u0648\u0631\u0648\u062F\u064A: \u0628\u0627\u06CC\u062F ${S(Y.values[0])} \u0648\u0627\u06CC`;
        return `\u0646\u0627\u0633\u0645 \u0627\u0646\u062A\u062E\u0627\u0628: \u0628\u0627\u06CC\u062F \u06CC\u0648 \u0644\u0647 ${I(Y.values, "|")} \u0685\u062E\u0647 \u0648\u0627\u06CC`;
      case "too_big": {
        let z = Y.inclusive ? "<=" : "<", W = X(Y.origin);
        if (W) return `\u0689\u06CC\u0631 \u0644\u0648\u06CC: ${Y.origin ?? "\u0627\u0631\u0632\u069A\u062A"} \u0628\u0627\u06CC\u062F ${z}${Y.maximum.toString()} ${W.unit ?? "\u0639\u0646\u0635\u0631\u0648\u0646\u0647"} \u0648\u0644\u0631\u064A`;
        return `\u0689\u06CC\u0631 \u0644\u0648\u06CC: ${Y.origin ?? "\u0627\u0631\u0632\u069A\u062A"} \u0628\u0627\u06CC\u062F ${z}${Y.maximum.toString()} \u0648\u064A`;
      }
      case "too_small": {
        let z = Y.inclusive ? ">=" : ">", W = X(Y.origin);
        if (W) return `\u0689\u06CC\u0631 \u06A9\u0648\u0686\u0646\u06CC: ${Y.origin} \u0628\u0627\u06CC\u062F ${z}${Y.minimum.toString()} ${W.unit} \u0648\u0644\u0631\u064A`;
        return `\u0689\u06CC\u0631 \u06A9\u0648\u0686\u0646\u06CC: ${Y.origin} \u0628\u0627\u06CC\u062F ${z}${Y.minimum.toString()} \u0648\u064A`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `\u0646\u0627\u0633\u0645 \u0645\u062A\u0646: \u0628\u0627\u06CC\u062F \u062F "${z.prefix}" \u0633\u0631\u0647 \u067E\u06CC\u0644 \u0634\u064A`;
        if (z.format === "ends_with") return `\u0646\u0627\u0633\u0645 \u0645\u062A\u0646: \u0628\u0627\u06CC\u062F \u062F "${z.suffix}" \u0633\u0631\u0647 \u067E\u0627\u06CC \u062A\u0647 \u0648\u0631\u0633\u064A\u0696\u064A`;
        if (z.format === "includes") return `\u0646\u0627\u0633\u0645 \u0645\u062A\u0646: \u0628\u0627\u06CC\u062F "${z.includes}" \u0648\u0644\u0631\u064A`;
        if (z.format === "regex") return `\u0646\u0627\u0633\u0645 \u0645\u062A\u0646: \u0628\u0627\u06CC\u062F \u062F ${z.pattern} \u0633\u0631\u0647 \u0645\u0637\u0627\u0628\u0642\u062A \u0648\u0644\u0631\u064A`;
        return `${Q[z.format] ?? Y.format} \u0646\u0627\u0633\u0645 \u062F\u06CC`;
      }
      case "not_multiple_of":
        return `\u0646\u0627\u0633\u0645 \u0639\u062F\u062F: \u0628\u0627\u06CC\u062F \u062F ${Y.divisor} \u0645\u0636\u0631\u0628 \u0648\u064A`;
      case "unrecognized_keys":
        return `\u0646\u0627\u0633\u0645 ${Y.keys.length > 1 ? "\u06A9\u0644\u06CC\u0689\u0648\u0646\u0647" : "\u06A9\u0644\u06CC\u0689"}: ${I(Y.keys, ", ")}`;
      case "invalid_key":
        return `\u0646\u0627\u0633\u0645 \u06A9\u0644\u06CC\u0689 \u067E\u0647 ${Y.origin} \u06A9\u06D0`;
      case "invalid_union":
        return "\u0646\u0627\u0633\u0645\u0647 \u0648\u0631\u0648\u062F\u064A";
      case "invalid_element":
        return `\u0646\u0627\u0633\u0645 \u0639\u0646\u0635\u0631 \u067E\u0647 ${Y.origin} \u06A9\u06D0`;
      default:
        return "\u0646\u0627\u0633\u0645\u0647 \u0648\u0631\u0648\u062F\u064A";
    }
  };
};
function _W() {
  return { localeError: ZA() };
}
var EA = () => {
  let $ = { string: { unit: "znak\xF3w", verb: "mie\u0107" }, file: { unit: "bajt\xF3w", verb: "mie\u0107" }, array: { unit: "element\xF3w", verb: "mie\u0107" }, set: { unit: "element\xF3w", verb: "mie\u0107" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "NaN" : "liczba";
      case "object": {
        if (Array.isArray(Y)) return "tablica";
        if (Y === null) return "null";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "wyra\u017Cenie", email: "adres email", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "data i godzina w formacie ISO", date: "data w formacie ISO", time: "godzina w formacie ISO", duration: "czas trwania ISO", ipv4: "adres IPv4", ipv6: "adres IPv6", cidrv4: "zakres IPv4", cidrv6: "zakres IPv6", base64: "ci\u0105g znak\xF3w zakodowany w formacie base64", base64url: "ci\u0105g znak\xF3w zakodowany w formacie base64url", json_string: "ci\u0105g znak\xF3w w formacie JSON", e164: "liczba E.164", jwt: "JWT", template_literal: "wej\u015Bcie" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `Nieprawid\u0142owe dane wej\u015Bciowe: oczekiwano ${Y.expected}, otrzymano ${J(Y.input)}`;
      case "invalid_value":
        if (Y.values.length === 1) return `Nieprawid\u0142owe dane wej\u015Bciowe: oczekiwano ${S(Y.values[0])}`;
        return `Nieprawid\u0142owa opcja: oczekiwano jednej z warto\u015Bci ${I(Y.values, "|")}`;
      case "too_big": {
        let z = Y.inclusive ? "<=" : "<", W = X(Y.origin);
        if (W) return `Za du\u017Ca warto\u015B\u0107: oczekiwano, \u017Ce ${Y.origin ?? "warto\u015B\u0107"} b\u0119dzie mie\u0107 ${z}${Y.maximum.toString()} ${W.unit ?? "element\xF3w"}`;
        return `Zbyt du\u017C(y/a/e): oczekiwano, \u017Ce ${Y.origin ?? "warto\u015B\u0107"} b\u0119dzie wynosi\u0107 ${z}${Y.maximum.toString()}`;
      }
      case "too_small": {
        let z = Y.inclusive ? ">=" : ">", W = X(Y.origin);
        if (W) return `Za ma\u0142a warto\u015B\u0107: oczekiwano, \u017Ce ${Y.origin ?? "warto\u015B\u0107"} b\u0119dzie mie\u0107 ${z}${Y.minimum.toString()} ${W.unit ?? "element\xF3w"}`;
        return `Zbyt ma\u0142(y/a/e): oczekiwano, \u017Ce ${Y.origin ?? "warto\u015B\u0107"} b\u0119dzie wynosi\u0107 ${z}${Y.minimum.toString()}`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `Nieprawid\u0142owy ci\u0105g znak\xF3w: musi zaczyna\u0107 si\u0119 od "${z.prefix}"`;
        if (z.format === "ends_with") return `Nieprawid\u0142owy ci\u0105g znak\xF3w: musi ko\u0144czy\u0107 si\u0119 na "${z.suffix}"`;
        if (z.format === "includes") return `Nieprawid\u0142owy ci\u0105g znak\xF3w: musi zawiera\u0107 "${z.includes}"`;
        if (z.format === "regex") return `Nieprawid\u0142owy ci\u0105g znak\xF3w: musi odpowiada\u0107 wzorcowi ${z.pattern}`;
        return `Nieprawid\u0142ow(y/a/e) ${Q[z.format] ?? Y.format}`;
      }
      case "not_multiple_of":
        return `Nieprawid\u0142owa liczba: musi by\u0107 wielokrotno\u015Bci\u0105 ${Y.divisor}`;
      case "unrecognized_keys":
        return `Nierozpoznane klucze${Y.keys.length > 1 ? "s" : ""}: ${I(Y.keys, ", ")}`;
      case "invalid_key":
        return `Nieprawid\u0142owy klucz w ${Y.origin}`;
      case "invalid_union":
        return "Nieprawid\u0142owe dane wej\u015Bciowe";
      case "invalid_element":
        return `Nieprawid\u0142owa warto\u015B\u0107 w ${Y.origin}`;
      default:
        return "Nieprawid\u0142owe dane wej\u015Bciowe";
    }
  };
};
function xW() {
  return { localeError: EA() };
}
var RA = () => {
  let $ = { string: { unit: "caracteres", verb: "ter" }, file: { unit: "bytes", verb: "ter" }, array: { unit: "itens", verb: "ter" }, set: { unit: "itens", verb: "ter" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "NaN" : "n\xFAmero";
      case "object": {
        if (Array.isArray(Y)) return "array";
        if (Y === null) return "nulo";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "padr\xE3o", email: "endere\xE7o de e-mail", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "data e hora ISO", date: "data ISO", time: "hora ISO", duration: "dura\xE7\xE3o ISO", ipv4: "endere\xE7o IPv4", ipv6: "endere\xE7o IPv6", cidrv4: "faixa de IPv4", cidrv6: "faixa de IPv6", base64: "texto codificado em base64", base64url: "URL codificada em base64", json_string: "texto JSON", e164: "n\xFAmero E.164", jwt: "JWT", template_literal: "entrada" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `Tipo inv\xE1lido: esperado ${Y.expected}, recebido ${J(Y.input)}`;
      case "invalid_value":
        if (Y.values.length === 1) return `Entrada inv\xE1lida: esperado ${S(Y.values[0])}`;
        return `Op\xE7\xE3o inv\xE1lida: esperada uma das ${I(Y.values, "|")}`;
      case "too_big": {
        let z = Y.inclusive ? "<=" : "<", W = X(Y.origin);
        if (W) return `Muito grande: esperado que ${Y.origin ?? "valor"} tivesse ${z}${Y.maximum.toString()} ${W.unit ?? "elementos"}`;
        return `Muito grande: esperado que ${Y.origin ?? "valor"} fosse ${z}${Y.maximum.toString()}`;
      }
      case "too_small": {
        let z = Y.inclusive ? ">=" : ">", W = X(Y.origin);
        if (W) return `Muito pequeno: esperado que ${Y.origin} tivesse ${z}${Y.minimum.toString()} ${W.unit}`;
        return `Muito pequeno: esperado que ${Y.origin} fosse ${z}${Y.minimum.toString()}`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `Texto inv\xE1lido: deve come\xE7ar com "${z.prefix}"`;
        if (z.format === "ends_with") return `Texto inv\xE1lido: deve terminar com "${z.suffix}"`;
        if (z.format === "includes") return `Texto inv\xE1lido: deve incluir "${z.includes}"`;
        if (z.format === "regex") return `Texto inv\xE1lido: deve corresponder ao padr\xE3o ${z.pattern}`;
        return `${Q[z.format] ?? Y.format} inv\xE1lido`;
      }
      case "not_multiple_of":
        return `N\xFAmero inv\xE1lido: deve ser m\xFAltiplo de ${Y.divisor}`;
      case "unrecognized_keys":
        return `Chave${Y.keys.length > 1 ? "s" : ""} desconhecida${Y.keys.length > 1 ? "s" : ""}: ${I(Y.keys, ", ")}`;
      case "invalid_key":
        return `Chave inv\xE1lida em ${Y.origin}`;
      case "invalid_union":
        return "Entrada inv\xE1lida";
      case "invalid_element":
        return `Valor inv\xE1lido em ${Y.origin}`;
      default:
        return "Campo inv\xE1lido";
    }
  };
};
function TW() {
  return { localeError: RA() };
}
function DN($, X, J, Q) {
  let Y = Math.abs($), z = Y % 10, W = Y % 100;
  if (W >= 11 && W <= 19) return Q;
  if (z === 1) return X;
  if (z >= 2 && z <= 4) return J;
  return Q;
}
var SA = () => {
  let $ = { string: { unit: { one: "\u0441\u0438\u043C\u0432\u043E\u043B", few: "\u0441\u0438\u043C\u0432\u043E\u043B\u0430", many: "\u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432" }, verb: "\u0438\u043C\u0435\u0442\u044C" }, file: { unit: { one: "\u0431\u0430\u0439\u0442", few: "\u0431\u0430\u0439\u0442\u0430", many: "\u0431\u0430\u0439\u0442" }, verb: "\u0438\u043C\u0435\u0442\u044C" }, array: { unit: { one: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442", few: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u0430", many: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u043E\u0432" }, verb: "\u0438\u043C\u0435\u0442\u044C" }, set: { unit: { one: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442", few: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u0430", many: "\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u043E\u0432" }, verb: "\u0438\u043C\u0435\u0442\u044C" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "NaN" : "\u0447\u0438\u0441\u043B\u043E";
      case "object": {
        if (Array.isArray(Y)) return "\u043C\u0430\u0441\u0441\u0438\u0432";
        if (Y === null) return "null";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "\u0432\u0432\u043E\u0434", email: "email \u0430\u0434\u0440\u0435\u0441", url: "URL", emoji: "\u044D\u043C\u043E\u0434\u0437\u0438", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO \u0434\u0430\u0442\u0430 \u0438 \u0432\u0440\u0435\u043C\u044F", date: "ISO \u0434\u0430\u0442\u0430", time: "ISO \u0432\u0440\u0435\u043C\u044F", duration: "ISO \u0434\u043B\u0438\u0442\u0435\u043B\u044C\u043D\u043E\u0441\u0442\u044C", ipv4: "IPv4 \u0430\u0434\u0440\u0435\u0441", ipv6: "IPv6 \u0430\u0434\u0440\u0435\u0441", cidrv4: "IPv4 \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D", cidrv6: "IPv6 \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D", base64: "\u0441\u0442\u0440\u043E\u043A\u0430 \u0432 \u0444\u043E\u0440\u043C\u0430\u0442\u0435 base64", base64url: "\u0441\u0442\u0440\u043E\u043A\u0430 \u0432 \u0444\u043E\u0440\u043C\u0430\u0442\u0435 base64url", json_string: "JSON \u0441\u0442\u0440\u043E\u043A\u0430", e164: "\u043D\u043E\u043C\u0435\u0440 E.164", jwt: "JWT", template_literal: "\u0432\u0432\u043E\u0434" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u0432\u0432\u043E\u0434: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C ${Y.expected}, \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u043E ${J(Y.input)}`;
      case "invalid_value":
        if (Y.values.length === 1) return `\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u0432\u0432\u043E\u0434: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C ${S(Y.values[0])}`;
        return `\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u0432\u0430\u0440\u0438\u0430\u043D\u0442: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u0434\u043D\u043E \u0438\u0437 ${I(Y.values, "|")}`;
      case "too_big": {
        let z = Y.inclusive ? "<=" : "<", W = X(Y.origin);
        if (W) {
          let G = Number(Y.maximum), U = DN(G, W.unit.one, W.unit.few, W.unit.many);
          return `\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u0431\u043E\u043B\u044C\u0448\u043E\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C, \u0447\u0442\u043E ${Y.origin ?? "\u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435"} \u0431\u0443\u0434\u0435\u0442 \u0438\u043C\u0435\u0442\u044C ${z}${Y.maximum.toString()} ${U}`;
        }
        return `\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u0431\u043E\u043B\u044C\u0448\u043E\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C, \u0447\u0442\u043E ${Y.origin ?? "\u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435"} \u0431\u0443\u0434\u0435\u0442 ${z}${Y.maximum.toString()}`;
      }
      case "too_small": {
        let z = Y.inclusive ? ">=" : ">", W = X(Y.origin);
        if (W) {
          let G = Number(Y.minimum), U = DN(G, W.unit.one, W.unit.few, W.unit.many);
          return `\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u043C\u0430\u043B\u0435\u043D\u044C\u043A\u043E\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C, \u0447\u0442\u043E ${Y.origin} \u0431\u0443\u0434\u0435\u0442 \u0438\u043C\u0435\u0442\u044C ${z}${Y.minimum.toString()} ${U}`;
        }
        return `\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u043C\u0430\u043B\u0435\u043D\u044C\u043A\u043E\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435: \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C, \u0447\u0442\u043E ${Y.origin} \u0431\u0443\u0434\u0435\u0442 ${z}${Y.minimum.toString()}`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `\u041D\u0435\u0432\u0435\u0440\u043D\u0430\u044F \u0441\u0442\u0440\u043E\u043A\u0430: \u0434\u043E\u043B\u0436\u043D\u0430 \u043D\u0430\u0447\u0438\u043D\u0430\u0442\u044C\u0441\u044F \u0441 "${z.prefix}"`;
        if (z.format === "ends_with") return `\u041D\u0435\u0432\u0435\u0440\u043D\u0430\u044F \u0441\u0442\u0440\u043E\u043A\u0430: \u0434\u043E\u043B\u0436\u043D\u0430 \u0437\u0430\u043A\u0430\u043D\u0447\u0438\u0432\u0430\u0442\u044C\u0441\u044F \u043D\u0430 "${z.suffix}"`;
        if (z.format === "includes") return `\u041D\u0435\u0432\u0435\u0440\u043D\u0430\u044F \u0441\u0442\u0440\u043E\u043A\u0430: \u0434\u043E\u043B\u0436\u043D\u0430 \u0441\u043E\u0434\u0435\u0440\u0436\u0430\u0442\u044C "${z.includes}"`;
        if (z.format === "regex") return `\u041D\u0435\u0432\u0435\u0440\u043D\u0430\u044F \u0441\u0442\u0440\u043E\u043A\u0430: \u0434\u043E\u043B\u0436\u043D\u0430 \u0441\u043E\u043E\u0442\u0432\u0435\u0442\u0441\u0442\u0432\u043E\u0432\u0430\u0442\u044C \u0448\u0430\u0431\u043B\u043E\u043D\u0443 ${z.pattern}`;
        return `\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 ${Q[z.format] ?? Y.format}`;
      }
      case "not_multiple_of":
        return `\u041D\u0435\u0432\u0435\u0440\u043D\u043E\u0435 \u0447\u0438\u0441\u043B\u043E: \u0434\u043E\u043B\u0436\u043D\u043E \u0431\u044B\u0442\u044C \u043A\u0440\u0430\u0442\u043D\u044B\u043C ${Y.divisor}`;
      case "unrecognized_keys":
        return `\u041D\u0435\u0440\u0430\u0441\u043F\u043E\u0437\u043D\u0430\u043D\u043D${Y.keys.length > 1 ? "\u044B\u0435" : "\u044B\u0439"} \u043A\u043B\u044E\u0447${Y.keys.length > 1 ? "\u0438" : ""}: ${I(Y.keys, ", ")}`;
      case "invalid_key":
        return `\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u043A\u043B\u044E\u0447 \u0432 ${Y.origin}`;
      case "invalid_union":
        return "\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0435 \u0432\u0445\u043E\u0434\u043D\u044B\u0435 \u0434\u0430\u043D\u043D\u044B\u0435";
      case "invalid_element":
        return `\u041D\u0435\u0432\u0435\u0440\u043D\u043E\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435 \u0432 ${Y.origin}`;
      default:
        return "\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0435 \u0432\u0445\u043E\u0434\u043D\u044B\u0435 \u0434\u0430\u043D\u043D\u044B\u0435";
    }
  };
};
function yW() {
  return { localeError: SA() };
}
var vA = () => {
  let $ = { string: { unit: "znakov", verb: "imeti" }, file: { unit: "bajtov", verb: "imeti" }, array: { unit: "elementov", verb: "imeti" }, set: { unit: "elementov", verb: "imeti" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "NaN" : "\u0161tevilo";
      case "object": {
        if (Array.isArray(Y)) return "tabela";
        if (Y === null) return "null";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "vnos", email: "e-po\u0161tni naslov", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO datum in \u010Das", date: "ISO datum", time: "ISO \u010Das", duration: "ISO trajanje", ipv4: "IPv4 naslov", ipv6: "IPv6 naslov", cidrv4: "obseg IPv4", cidrv6: "obseg IPv6", base64: "base64 kodiran niz", base64url: "base64url kodiran niz", json_string: "JSON niz", e164: "E.164 \u0161tevilka", jwt: "JWT", template_literal: "vnos" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `Neveljaven vnos: pri\u010Dakovano ${Y.expected}, prejeto ${J(Y.input)}`;
      case "invalid_value":
        if (Y.values.length === 1) return `Neveljaven vnos: pri\u010Dakovano ${S(Y.values[0])}`;
        return `Neveljavna mo\u017Enost: pri\u010Dakovano eno izmed ${I(Y.values, "|")}`;
      case "too_big": {
        let z = Y.inclusive ? "<=" : "<", W = X(Y.origin);
        if (W) return `Preveliko: pri\u010Dakovano, da bo ${Y.origin ?? "vrednost"} imelo ${z}${Y.maximum.toString()} ${W.unit ?? "elementov"}`;
        return `Preveliko: pri\u010Dakovano, da bo ${Y.origin ?? "vrednost"} ${z}${Y.maximum.toString()}`;
      }
      case "too_small": {
        let z = Y.inclusive ? ">=" : ">", W = X(Y.origin);
        if (W) return `Premajhno: pri\u010Dakovano, da bo ${Y.origin} imelo ${z}${Y.minimum.toString()} ${W.unit}`;
        return `Premajhno: pri\u010Dakovano, da bo ${Y.origin} ${z}${Y.minimum.toString()}`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `Neveljaven niz: mora se za\u010Deti z "${z.prefix}"`;
        if (z.format === "ends_with") return `Neveljaven niz: mora se kon\u010Dati z "${z.suffix}"`;
        if (z.format === "includes") return `Neveljaven niz: mora vsebovati "${z.includes}"`;
        if (z.format === "regex") return `Neveljaven niz: mora ustrezati vzorcu ${z.pattern}`;
        return `Neveljaven ${Q[z.format] ?? Y.format}`;
      }
      case "not_multiple_of":
        return `Neveljavno \u0161tevilo: mora biti ve\u010Dkratnik ${Y.divisor}`;
      case "unrecognized_keys":
        return `Neprepoznan${Y.keys.length > 1 ? "i klju\u010Di" : " klju\u010D"}: ${I(Y.keys, ", ")}`;
      case "invalid_key":
        return `Neveljaven klju\u010D v ${Y.origin}`;
      case "invalid_union":
        return "Neveljaven vnos";
      case "invalid_element":
        return `Neveljavna vrednost v ${Y.origin}`;
      default:
        return "Neveljaven vnos";
    }
  };
};
function gW() {
  return { localeError: vA() };
}
var CA = () => {
  let $ = { string: { unit: "tecken", verb: "att ha" }, file: { unit: "bytes", verb: "att ha" }, array: { unit: "objekt", verb: "att inneh\xE5lla" }, set: { unit: "objekt", verb: "att inneh\xE5lla" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "NaN" : "antal";
      case "object": {
        if (Array.isArray(Y)) return "lista";
        if (Y === null) return "null";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "regulj\xE4rt uttryck", email: "e-postadress", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO-datum och tid", date: "ISO-datum", time: "ISO-tid", duration: "ISO-varaktighet", ipv4: "IPv4-intervall", ipv6: "IPv6-intervall", cidrv4: "IPv4-spektrum", cidrv6: "IPv6-spektrum", base64: "base64-kodad str\xE4ng", base64url: "base64url-kodad str\xE4ng", json_string: "JSON-str\xE4ng", e164: "E.164-nummer", jwt: "JWT", template_literal: "mall-literal" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `Ogiltig inmatning: f\xF6rv\xE4ntat ${Y.expected}, fick ${J(Y.input)}`;
      case "invalid_value":
        if (Y.values.length === 1) return `Ogiltig inmatning: f\xF6rv\xE4ntat ${S(Y.values[0])}`;
        return `Ogiltigt val: f\xF6rv\xE4ntade en av ${I(Y.values, "|")}`;
      case "too_big": {
        let z = Y.inclusive ? "<=" : "<", W = X(Y.origin);
        if (W) return `F\xF6r stor(t): f\xF6rv\xE4ntade ${Y.origin ?? "v\xE4rdet"} att ha ${z}${Y.maximum.toString()} ${W.unit ?? "element"}`;
        return `F\xF6r stor(t): f\xF6rv\xE4ntat ${Y.origin ?? "v\xE4rdet"} att ha ${z}${Y.maximum.toString()}`;
      }
      case "too_small": {
        let z = Y.inclusive ? ">=" : ">", W = X(Y.origin);
        if (W) return `F\xF6r lite(t): f\xF6rv\xE4ntade ${Y.origin ?? "v\xE4rdet"} att ha ${z}${Y.minimum.toString()} ${W.unit}`;
        return `F\xF6r lite(t): f\xF6rv\xE4ntade ${Y.origin ?? "v\xE4rdet"} att ha ${z}${Y.minimum.toString()}`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `Ogiltig str\xE4ng: m\xE5ste b\xF6rja med "${z.prefix}"`;
        if (z.format === "ends_with") return `Ogiltig str\xE4ng: m\xE5ste sluta med "${z.suffix}"`;
        if (z.format === "includes") return `Ogiltig str\xE4ng: m\xE5ste inneh\xE5lla "${z.includes}"`;
        if (z.format === "regex") return `Ogiltig str\xE4ng: m\xE5ste matcha m\xF6nstret "${z.pattern}"`;
        return `Ogiltig(t) ${Q[z.format] ?? Y.format}`;
      }
      case "not_multiple_of":
        return `Ogiltigt tal: m\xE5ste vara en multipel av ${Y.divisor}`;
      case "unrecognized_keys":
        return `${Y.keys.length > 1 ? "Ok\xE4nda nycklar" : "Ok\xE4nd nyckel"}: ${I(Y.keys, ", ")}`;
      case "invalid_key":
        return `Ogiltig nyckel i ${Y.origin ?? "v\xE4rdet"}`;
      case "invalid_union":
        return "Ogiltig input";
      case "invalid_element":
        return `Ogiltigt v\xE4rde i ${Y.origin ?? "v\xE4rdet"}`;
      default:
        return "Ogiltig input";
    }
  };
};
function fW() {
  return { localeError: CA() };
}
var kA = () => {
  let $ = { string: { unit: "\u0B8E\u0BB4\u0BC1\u0BA4\u0BCD\u0BA4\u0BC1\u0B95\u0BCD\u0B95\u0BB3\u0BCD", verb: "\u0B95\u0BCA\u0BA3\u0BCD\u0B9F\u0BBF\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD" }, file: { unit: "\u0BAA\u0BC8\u0B9F\u0BCD\u0B9F\u0BC1\u0B95\u0BB3\u0BCD", verb: "\u0B95\u0BCA\u0BA3\u0BCD\u0B9F\u0BBF\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD" }, array: { unit: "\u0B89\u0BB1\u0BC1\u0BAA\u0BCD\u0BAA\u0BC1\u0B95\u0BB3\u0BCD", verb: "\u0B95\u0BCA\u0BA3\u0BCD\u0B9F\u0BBF\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD" }, set: { unit: "\u0B89\u0BB1\u0BC1\u0BAA\u0BCD\u0BAA\u0BC1\u0B95\u0BB3\u0BCD", verb: "\u0B95\u0BCA\u0BA3\u0BCD\u0B9F\u0BBF\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "\u0B8E\u0BA3\u0BCD \u0B85\u0BB2\u0BCD\u0BB2\u0BBE\u0BA4\u0BA4\u0BC1" : "\u0B8E\u0BA3\u0BCD";
      case "object": {
        if (Array.isArray(Y)) return "\u0B85\u0BA3\u0BBF";
        if (Y === null) return "\u0BB5\u0BC6\u0BB1\u0BC1\u0BAE\u0BC8";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "\u0B89\u0BB3\u0BCD\u0BB3\u0BC0\u0B9F\u0BC1", email: "\u0BAE\u0BBF\u0BA9\u0BCD\u0BA9\u0B9E\u0BCD\u0B9A\u0BB2\u0BCD \u0BAE\u0BC1\u0B95\u0BB5\u0BB0\u0BBF", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO \u0BA4\u0BC7\u0BA4\u0BBF \u0BA8\u0BC7\u0BB0\u0BAE\u0BCD", date: "ISO \u0BA4\u0BC7\u0BA4\u0BBF", time: "ISO \u0BA8\u0BC7\u0BB0\u0BAE\u0BCD", duration: "ISO \u0B95\u0BBE\u0BB2 \u0B85\u0BB3\u0BB5\u0BC1", ipv4: "IPv4 \u0BAE\u0BC1\u0B95\u0BB5\u0BB0\u0BBF", ipv6: "IPv6 \u0BAE\u0BC1\u0B95\u0BB5\u0BB0\u0BBF", cidrv4: "IPv4 \u0BB5\u0BB0\u0BAE\u0BCD\u0BAA\u0BC1", cidrv6: "IPv6 \u0BB5\u0BB0\u0BAE\u0BCD\u0BAA\u0BC1", base64: "base64-encoded \u0B9A\u0BB0\u0BAE\u0BCD", base64url: "base64url-encoded \u0B9A\u0BB0\u0BAE\u0BCD", json_string: "JSON \u0B9A\u0BB0\u0BAE\u0BCD", e164: "E.164 \u0B8E\u0BA3\u0BCD", jwt: "JWT", template_literal: "input" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B89\u0BB3\u0BCD\u0BB3\u0BC0\u0B9F\u0BC1: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${Y.expected}, \u0BAA\u0BC6\u0BB1\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${J(Y.input)}`;
      case "invalid_value":
        if (Y.values.length === 1) return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B89\u0BB3\u0BCD\u0BB3\u0BC0\u0B9F\u0BC1: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${S(Y.values[0])}`;
        return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0BB5\u0BBF\u0BB0\u0BC1\u0BAA\u0BCD\u0BAA\u0BAE\u0BCD: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${I(Y.values, "|")} \u0B87\u0BB2\u0BCD \u0B92\u0BA9\u0BCD\u0BB1\u0BC1`;
      case "too_big": {
        let z = Y.inclusive ? "<=" : "<", W = X(Y.origin);
        if (W) return `\u0BAE\u0BBF\u0B95 \u0BAA\u0BC6\u0BB0\u0BBF\u0BAF\u0BA4\u0BC1: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${Y.origin ?? "\u0BAE\u0BA4\u0BBF\u0BAA\u0BCD\u0BAA\u0BC1"} ${z}${Y.maximum.toString()} ${W.unit ?? "\u0B89\u0BB1\u0BC1\u0BAA\u0BCD\u0BAA\u0BC1\u0B95\u0BB3\u0BCD"} \u0B86\u0B95 \u0B87\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
        return `\u0BAE\u0BBF\u0B95 \u0BAA\u0BC6\u0BB0\u0BBF\u0BAF\u0BA4\u0BC1: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${Y.origin ?? "\u0BAE\u0BA4\u0BBF\u0BAA\u0BCD\u0BAA\u0BC1"} ${z}${Y.maximum.toString()} \u0B86\u0B95 \u0B87\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
      }
      case "too_small": {
        let z = Y.inclusive ? ">=" : ">", W = X(Y.origin);
        if (W) return `\u0BAE\u0BBF\u0B95\u0B9A\u0BCD \u0B9A\u0BBF\u0BB1\u0BBF\u0BAF\u0BA4\u0BC1: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${Y.origin} ${z}${Y.minimum.toString()} ${W.unit} \u0B86\u0B95 \u0B87\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
        return `\u0BAE\u0BBF\u0B95\u0B9A\u0BCD \u0B9A\u0BBF\u0BB1\u0BBF\u0BAF\u0BA4\u0BC1: \u0B8E\u0BA4\u0BBF\u0BB0\u0BCD\u0BAA\u0BBE\u0BB0\u0BCD\u0B95\u0BCD\u0B95\u0BAA\u0BCD\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1 ${Y.origin} ${z}${Y.minimum.toString()} \u0B86\u0B95 \u0B87\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B9A\u0BB0\u0BAE\u0BCD: "${z.prefix}" \u0B87\u0BB2\u0BCD \u0BA4\u0BCA\u0B9F\u0B99\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
        if (z.format === "ends_with") return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B9A\u0BB0\u0BAE\u0BCD: "${z.suffix}" \u0B87\u0BB2\u0BCD \u0BAE\u0BC1\u0B9F\u0BBF\u0BB5\u0B9F\u0BC8\u0BAF \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
        if (z.format === "includes") return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B9A\u0BB0\u0BAE\u0BCD: "${z.includes}" \u0B90 \u0B89\u0BB3\u0BCD\u0BB3\u0B9F\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
        if (z.format === "regex") return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B9A\u0BB0\u0BAE\u0BCD: ${z.pattern} \u0BAE\u0BC1\u0BB1\u0BC8\u0BAA\u0BBE\u0B9F\u0BCD\u0B9F\u0BC1\u0B9F\u0BA9\u0BCD \u0BAA\u0BCA\u0BB0\u0BC1\u0BA8\u0BCD\u0BA4 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
        return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 ${Q[z.format] ?? Y.format}`;
      }
      case "not_multiple_of":
        return `\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B8E\u0BA3\u0BCD: ${Y.divisor} \u0B87\u0BA9\u0BCD \u0BAA\u0BB2\u0BAE\u0BBE\u0B95 \u0B87\u0BB0\u0BC1\u0B95\u0BCD\u0B95 \u0BB5\u0BC7\u0BA3\u0BCD\u0B9F\u0BC1\u0BAE\u0BCD`;
      case "unrecognized_keys":
        return `\u0B85\u0B9F\u0BC8\u0BAF\u0BBE\u0BB3\u0BAE\u0BCD \u0BA4\u0BC6\u0BB0\u0BBF\u0BAF\u0BBE\u0BA4 \u0BB5\u0BBF\u0B9A\u0BC8${Y.keys.length > 1 ? "\u0B95\u0BB3\u0BCD" : ""}: ${I(Y.keys, ", ")}`;
      case "invalid_key":
        return `${Y.origin} \u0B87\u0BB2\u0BCD \u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0BB5\u0BBF\u0B9A\u0BC8`;
      case "invalid_union":
        return "\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B89\u0BB3\u0BCD\u0BB3\u0BC0\u0B9F\u0BC1";
      case "invalid_element":
        return `${Y.origin} \u0B87\u0BB2\u0BCD \u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0BAE\u0BA4\u0BBF\u0BAA\u0BCD\u0BAA\u0BC1`;
      default:
        return "\u0BA4\u0BB5\u0BB1\u0BBE\u0BA9 \u0B89\u0BB3\u0BCD\u0BB3\u0BC0\u0B9F\u0BC1";
    }
  };
};
function hW() {
  return { localeError: kA() };
}
var _A = () => {
  let $ = { string: { unit: "\u0E15\u0E31\u0E27\u0E2D\u0E31\u0E01\u0E29\u0E23", verb: "\u0E04\u0E27\u0E23\u0E21\u0E35" }, file: { unit: "\u0E44\u0E1A\u0E15\u0E4C", verb: "\u0E04\u0E27\u0E23\u0E21\u0E35" }, array: { unit: "\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23", verb: "\u0E04\u0E27\u0E23\u0E21\u0E35" }, set: { unit: "\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23", verb: "\u0E04\u0E27\u0E23\u0E21\u0E35" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "\u0E44\u0E21\u0E48\u0E43\u0E0A\u0E48\u0E15\u0E31\u0E27\u0E40\u0E25\u0E02 (NaN)" : "\u0E15\u0E31\u0E27\u0E40\u0E25\u0E02";
      case "object": {
        if (Array.isArray(Y)) return "\u0E2D\u0E32\u0E23\u0E4C\u0E40\u0E23\u0E22\u0E4C (Array)";
        if (Y === null) return "\u0E44\u0E21\u0E48\u0E21\u0E35\u0E04\u0E48\u0E32 (null)";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E17\u0E35\u0E48\u0E1B\u0E49\u0E2D\u0E19", email: "\u0E17\u0E35\u0E48\u0E2D\u0E22\u0E39\u0E48\u0E2D\u0E35\u0E40\u0E21\u0E25", url: "URL", emoji: "\u0E2D\u0E34\u0E42\u0E21\u0E08\u0E34", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "\u0E27\u0E31\u0E19\u0E17\u0E35\u0E48\u0E40\u0E27\u0E25\u0E32\u0E41\u0E1A\u0E1A ISO", date: "\u0E27\u0E31\u0E19\u0E17\u0E35\u0E48\u0E41\u0E1A\u0E1A ISO", time: "\u0E40\u0E27\u0E25\u0E32\u0E41\u0E1A\u0E1A ISO", duration: "\u0E0A\u0E48\u0E27\u0E07\u0E40\u0E27\u0E25\u0E32\u0E41\u0E1A\u0E1A ISO", ipv4: "\u0E17\u0E35\u0E48\u0E2D\u0E22\u0E39\u0E48 IPv4", ipv6: "\u0E17\u0E35\u0E48\u0E2D\u0E22\u0E39\u0E48 IPv6", cidrv4: "\u0E0A\u0E48\u0E27\u0E07 IP \u0E41\u0E1A\u0E1A IPv4", cidrv6: "\u0E0A\u0E48\u0E27\u0E07 IP \u0E41\u0E1A\u0E1A IPv6", base64: "\u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E41\u0E1A\u0E1A Base64", base64url: "\u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E41\u0E1A\u0E1A Base64 \u0E2A\u0E33\u0E2B\u0E23\u0E31\u0E1A URL", json_string: "\u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E41\u0E1A\u0E1A JSON", e164: "\u0E40\u0E1A\u0E2D\u0E23\u0E4C\u0E42\u0E17\u0E23\u0E28\u0E31\u0E1E\u0E17\u0E4C\u0E23\u0E30\u0E2B\u0E27\u0E48\u0E32\u0E07\u0E1B\u0E23\u0E30\u0E40\u0E17\u0E28 (E.164)", jwt: "\u0E42\u0E17\u0E40\u0E04\u0E19 JWT", template_literal: "\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E17\u0E35\u0E48\u0E1B\u0E49\u0E2D\u0E19" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `\u0E1B\u0E23\u0E30\u0E40\u0E20\u0E17\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E04\u0E27\u0E23\u0E40\u0E1B\u0E47\u0E19 ${Y.expected} \u0E41\u0E15\u0E48\u0E44\u0E14\u0E49\u0E23\u0E31\u0E1A ${J(Y.input)}`;
      case "invalid_value":
        if (Y.values.length === 1) return `\u0E04\u0E48\u0E32\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E04\u0E27\u0E23\u0E40\u0E1B\u0E47\u0E19 ${S(Y.values[0])}`;
        return `\u0E15\u0E31\u0E27\u0E40\u0E25\u0E37\u0E2D\u0E01\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E04\u0E27\u0E23\u0E40\u0E1B\u0E47\u0E19\u0E2B\u0E19\u0E36\u0E48\u0E07\u0E43\u0E19 ${I(Y.values, "|")}`;
      case "too_big": {
        let z = Y.inclusive ? "\u0E44\u0E21\u0E48\u0E40\u0E01\u0E34\u0E19" : "\u0E19\u0E49\u0E2D\u0E22\u0E01\u0E27\u0E48\u0E32", W = X(Y.origin);
        if (W) return `\u0E40\u0E01\u0E34\u0E19\u0E01\u0E33\u0E2B\u0E19\u0E14: ${Y.origin ?? "\u0E04\u0E48\u0E32"} \u0E04\u0E27\u0E23\u0E21\u0E35${z} ${Y.maximum.toString()} ${W.unit ?? "\u0E23\u0E32\u0E22\u0E01\u0E32\u0E23"}`;
        return `\u0E40\u0E01\u0E34\u0E19\u0E01\u0E33\u0E2B\u0E19\u0E14: ${Y.origin ?? "\u0E04\u0E48\u0E32"} \u0E04\u0E27\u0E23\u0E21\u0E35${z} ${Y.maximum.toString()}`;
      }
      case "too_small": {
        let z = Y.inclusive ? "\u0E2D\u0E22\u0E48\u0E32\u0E07\u0E19\u0E49\u0E2D\u0E22" : "\u0E21\u0E32\u0E01\u0E01\u0E27\u0E48\u0E32", W = X(Y.origin);
        if (W) return `\u0E19\u0E49\u0E2D\u0E22\u0E01\u0E27\u0E48\u0E32\u0E01\u0E33\u0E2B\u0E19\u0E14: ${Y.origin} \u0E04\u0E27\u0E23\u0E21\u0E35${z} ${Y.minimum.toString()} ${W.unit}`;
        return `\u0E19\u0E49\u0E2D\u0E22\u0E01\u0E27\u0E48\u0E32\u0E01\u0E33\u0E2B\u0E19\u0E14: ${Y.origin} \u0E04\u0E27\u0E23\u0E21\u0E35${z} ${Y.minimum.toString()}`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E15\u0E49\u0E2D\u0E07\u0E02\u0E36\u0E49\u0E19\u0E15\u0E49\u0E19\u0E14\u0E49\u0E27\u0E22 "${z.prefix}"`;
        if (z.format === "ends_with") return `\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E15\u0E49\u0E2D\u0E07\u0E25\u0E07\u0E17\u0E49\u0E32\u0E22\u0E14\u0E49\u0E27\u0E22 "${z.suffix}"`;
        if (z.format === "includes") return `\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21\u0E15\u0E49\u0E2D\u0E07\u0E21\u0E35 "${z.includes}" \u0E2D\u0E22\u0E39\u0E48\u0E43\u0E19\u0E02\u0E49\u0E2D\u0E04\u0E27\u0E32\u0E21`;
        if (z.format === "regex") return `\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E15\u0E49\u0E2D\u0E07\u0E15\u0E23\u0E07\u0E01\u0E31\u0E1A\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E17\u0E35\u0E48\u0E01\u0E33\u0E2B\u0E19\u0E14 ${z.pattern}`;
        return `\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: ${Q[z.format] ?? Y.format}`;
      }
      case "not_multiple_of":
        return `\u0E15\u0E31\u0E27\u0E40\u0E25\u0E02\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E15\u0E49\u0E2D\u0E07\u0E40\u0E1B\u0E47\u0E19\u0E08\u0E33\u0E19\u0E27\u0E19\u0E17\u0E35\u0E48\u0E2B\u0E32\u0E23\u0E14\u0E49\u0E27\u0E22 ${Y.divisor} \u0E44\u0E14\u0E49\u0E25\u0E07\u0E15\u0E31\u0E27`;
      case "unrecognized_keys":
        return `\u0E1E\u0E1A\u0E04\u0E35\u0E22\u0E4C\u0E17\u0E35\u0E48\u0E44\u0E21\u0E48\u0E23\u0E39\u0E49\u0E08\u0E31\u0E01: ${I(Y.keys, ", ")}`;
      case "invalid_key":
        return `\u0E04\u0E35\u0E22\u0E4C\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07\u0E43\u0E19 ${Y.origin}`;
      case "invalid_union":
        return "\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07: \u0E44\u0E21\u0E48\u0E15\u0E23\u0E07\u0E01\u0E31\u0E1A\u0E23\u0E39\u0E1B\u0E41\u0E1A\u0E1A\u0E22\u0E39\u0E40\u0E19\u0E35\u0E22\u0E19\u0E17\u0E35\u0E48\u0E01\u0E33\u0E2B\u0E19\u0E14\u0E44\u0E27\u0E49";
      case "invalid_element":
        return `\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07\u0E43\u0E19 ${Y.origin}`;
      default:
        return "\u0E02\u0E49\u0E2D\u0E21\u0E39\u0E25\u0E44\u0E21\u0E48\u0E16\u0E39\u0E01\u0E15\u0E49\u0E2D\u0E07";
    }
  };
};
function uW() {
  return { localeError: _A() };
}
var xA = ($) => {
  let X = typeof $;
  switch (X) {
    case "number":
      return Number.isNaN($) ? "NaN" : "number";
    case "object": {
      if (Array.isArray($)) return "array";
      if ($ === null) return "null";
      if (Object.getPrototypeOf($) !== Object.prototype && $.constructor) return $.constructor.name;
    }
  }
  return X;
};
var TA = () => {
  let $ = { string: { unit: "karakter", verb: "olmal\u0131" }, file: { unit: "bayt", verb: "olmal\u0131" }, array: { unit: "\xF6\u011Fe", verb: "olmal\u0131" }, set: { unit: "\xF6\u011Fe", verb: "olmal\u0131" } };
  function X(Q) {
    return $[Q] ?? null;
  }
  let J = { regex: "girdi", email: "e-posta adresi", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO tarih ve saat", date: "ISO tarih", time: "ISO saat", duration: "ISO s\xFCre", ipv4: "IPv4 adresi", ipv6: "IPv6 adresi", cidrv4: "IPv4 aral\u0131\u011F\u0131", cidrv6: "IPv6 aral\u0131\u011F\u0131", base64: "base64 ile \u015Fifrelenmi\u015F metin", base64url: "base64url ile \u015Fifrelenmi\u015F metin", json_string: "JSON dizesi", e164: "E.164 say\u0131s\u0131", jwt: "JWT", template_literal: "\u015Eablon dizesi" };
  return (Q) => {
    switch (Q.code) {
      case "invalid_type":
        return `Ge\xE7ersiz de\u011Fer: beklenen ${Q.expected}, al\u0131nan ${xA(Q.input)}`;
      case "invalid_value":
        if (Q.values.length === 1) return `Ge\xE7ersiz de\u011Fer: beklenen ${S(Q.values[0])}`;
        return `Ge\xE7ersiz se\xE7enek: a\u015Fa\u011F\u0131dakilerden biri olmal\u0131: ${I(Q.values, "|")}`;
      case "too_big": {
        let Y = Q.inclusive ? "<=" : "<", z = X(Q.origin);
        if (z) return `\xC7ok b\xFCy\xFCk: beklenen ${Q.origin ?? "de\u011Fer"} ${Y}${Q.maximum.toString()} ${z.unit ?? "\xF6\u011Fe"}`;
        return `\xC7ok b\xFCy\xFCk: beklenen ${Q.origin ?? "de\u011Fer"} ${Y}${Q.maximum.toString()}`;
      }
      case "too_small": {
        let Y = Q.inclusive ? ">=" : ">", z = X(Q.origin);
        if (z) return `\xC7ok k\xFC\xE7\xFCk: beklenen ${Q.origin} ${Y}${Q.minimum.toString()} ${z.unit}`;
        return `\xC7ok k\xFC\xE7\xFCk: beklenen ${Q.origin} ${Y}${Q.minimum.toString()}`;
      }
      case "invalid_format": {
        let Y = Q;
        if (Y.format === "starts_with") return `Ge\xE7ersiz metin: "${Y.prefix}" ile ba\u015Flamal\u0131`;
        if (Y.format === "ends_with") return `Ge\xE7ersiz metin: "${Y.suffix}" ile bitmeli`;
        if (Y.format === "includes") return `Ge\xE7ersiz metin: "${Y.includes}" i\xE7ermeli`;
        if (Y.format === "regex") return `Ge\xE7ersiz metin: ${Y.pattern} desenine uymal\u0131`;
        return `Ge\xE7ersiz ${J[Y.format] ?? Q.format}`;
      }
      case "not_multiple_of":
        return `Ge\xE7ersiz say\u0131: ${Q.divisor} ile tam b\xF6l\xFCnebilmeli`;
      case "unrecognized_keys":
        return `Tan\u0131nmayan anahtar${Q.keys.length > 1 ? "lar" : ""}: ${I(Q.keys, ", ")}`;
      case "invalid_key":
        return `${Q.origin} i\xE7inde ge\xE7ersiz anahtar`;
      case "invalid_union":
        return "Ge\xE7ersiz de\u011Fer";
      case "invalid_element":
        return `${Q.origin} i\xE7inde ge\xE7ersiz de\u011Fer`;
      default:
        return "Ge\xE7ersiz de\u011Fer";
    }
  };
};
function mW() {
  return { localeError: TA() };
}
var yA = () => {
  let $ = { string: { unit: "\u0441\u0438\u043C\u0432\u043E\u043B\u0456\u0432", verb: "\u043C\u0430\u0442\u0438\u043C\u0435" }, file: { unit: "\u0431\u0430\u0439\u0442\u0456\u0432", verb: "\u043C\u0430\u0442\u0438\u043C\u0435" }, array: { unit: "\u0435\u043B\u0435\u043C\u0435\u043D\u0442\u0456\u0432", verb: "\u043C\u0430\u0442\u0438\u043C\u0435" }, set: { unit: "\u0435\u043B\u0435\u043C\u0435\u043D\u0442\u0456\u0432", verb: "\u043C\u0430\u0442\u0438\u043C\u0435" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "NaN" : "\u0447\u0438\u0441\u043B\u043E";
      case "object": {
        if (Array.isArray(Y)) return "\u043C\u0430\u0441\u0438\u0432";
        if (Y === null) return "null";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "\u0432\u0445\u0456\u0434\u043D\u0456 \u0434\u0430\u043D\u0456", email: "\u0430\u0434\u0440\u0435\u0441\u0430 \u0435\u043B\u0435\u043A\u0442\u0440\u043E\u043D\u043D\u043E\u0457 \u043F\u043E\u0448\u0442\u0438", url: "URL", emoji: "\u0435\u043C\u043E\u0434\u0437\u0456", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "\u0434\u0430\u0442\u0430 \u0442\u0430 \u0447\u0430\u0441 ISO", date: "\u0434\u0430\u0442\u0430 ISO", time: "\u0447\u0430\u0441 ISO", duration: "\u0442\u0440\u0438\u0432\u0430\u043B\u0456\u0441\u0442\u044C ISO", ipv4: "\u0430\u0434\u0440\u0435\u0441\u0430 IPv4", ipv6: "\u0430\u0434\u0440\u0435\u0441\u0430 IPv6", cidrv4: "\u0434\u0456\u0430\u043F\u0430\u0437\u043E\u043D IPv4", cidrv6: "\u0434\u0456\u0430\u043F\u0430\u0437\u043E\u043D IPv6", base64: "\u0440\u044F\u0434\u043E\u043A \u0443 \u043A\u043E\u0434\u0443\u0432\u0430\u043D\u043D\u0456 base64", base64url: "\u0440\u044F\u0434\u043E\u043A \u0443 \u043A\u043E\u0434\u0443\u0432\u0430\u043D\u043D\u0456 base64url", json_string: "\u0440\u044F\u0434\u043E\u043A JSON", e164: "\u043D\u043E\u043C\u0435\u0440 E.164", jwt: "JWT", template_literal: "\u0432\u0445\u0456\u0434\u043D\u0456 \u0434\u0430\u043D\u0456" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0456 \u0432\u0445\u0456\u0434\u043D\u0456 \u0434\u0430\u043D\u0456: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F ${Y.expected}, \u043E\u0442\u0440\u0438\u043C\u0430\u043D\u043E ${J(Y.input)}`;
      case "invalid_value":
        if (Y.values.length === 1) return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0456 \u0432\u0445\u0456\u0434\u043D\u0456 \u0434\u0430\u043D\u0456: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F ${S(Y.values[0])}`;
        return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0430 \u043E\u043F\u0446\u0456\u044F: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F \u043E\u0434\u043D\u0435 \u0437 ${I(Y.values, "|")}`;
      case "too_big": {
        let z = Y.inclusive ? "<=" : "<", W = X(Y.origin);
        if (W) return `\u0417\u0430\u043D\u0430\u0434\u0442\u043E \u0432\u0435\u043B\u0438\u043A\u0435: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F, \u0449\u043E ${Y.origin ?? "\u0437\u043D\u0430\u0447\u0435\u043D\u043D\u044F"} ${W.verb} ${z}${Y.maximum.toString()} ${W.unit ?? "\u0435\u043B\u0435\u043C\u0435\u043D\u0442\u0456\u0432"}`;
        return `\u0417\u0430\u043D\u0430\u0434\u0442\u043E \u0432\u0435\u043B\u0438\u043A\u0435: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F, \u0449\u043E ${Y.origin ?? "\u0437\u043D\u0430\u0447\u0435\u043D\u043D\u044F"} \u0431\u0443\u0434\u0435 ${z}${Y.maximum.toString()}`;
      }
      case "too_small": {
        let z = Y.inclusive ? ">=" : ">", W = X(Y.origin);
        if (W) return `\u0417\u0430\u043D\u0430\u0434\u0442\u043E \u043C\u0430\u043B\u0435: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F, \u0449\u043E ${Y.origin} ${W.verb} ${z}${Y.minimum.toString()} ${W.unit}`;
        return `\u0417\u0430\u043D\u0430\u0434\u0442\u043E \u043C\u0430\u043B\u0435: \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F, \u0449\u043E ${Y.origin} \u0431\u0443\u0434\u0435 ${z}${Y.minimum.toString()}`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0438\u0439 \u0440\u044F\u0434\u043E\u043A: \u043F\u043E\u0432\u0438\u043D\u0435\u043D \u043F\u043E\u0447\u0438\u043D\u0430\u0442\u0438\u0441\u044F \u0437 "${z.prefix}"`;
        if (z.format === "ends_with") return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0438\u0439 \u0440\u044F\u0434\u043E\u043A: \u043F\u043E\u0432\u0438\u043D\u0435\u043D \u0437\u0430\u043A\u0456\u043D\u0447\u0443\u0432\u0430\u0442\u0438\u0441\u044F \u043D\u0430 "${z.suffix}"`;
        if (z.format === "includes") return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0438\u0439 \u0440\u044F\u0434\u043E\u043A: \u043F\u043E\u0432\u0438\u043D\u0435\u043D \u043C\u0456\u0441\u0442\u0438\u0442\u0438 "${z.includes}"`;
        if (z.format === "regex") return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0438\u0439 \u0440\u044F\u0434\u043E\u043A: \u043F\u043E\u0432\u0438\u043D\u0435\u043D \u0432\u0456\u0434\u043F\u043E\u0432\u0456\u0434\u0430\u0442\u0438 \u0448\u0430\u0431\u043B\u043E\u043D\u0443 ${z.pattern}`;
        return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0438\u0439 ${Q[z.format] ?? Y.format}`;
      }
      case "not_multiple_of":
        return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0435 \u0447\u0438\u0441\u043B\u043E: \u043F\u043E\u0432\u0438\u043D\u043D\u043E \u0431\u0443\u0442\u0438 \u043A\u0440\u0430\u0442\u043D\u0438\u043C ${Y.divisor}`;
      case "unrecognized_keys":
        return `\u041D\u0435\u0440\u043E\u0437\u043F\u0456\u0437\u043D\u0430\u043D\u0438\u0439 \u043A\u043B\u044E\u0447${Y.keys.length > 1 ? "\u0456" : ""}: ${I(Y.keys, ", ")}`;
      case "invalid_key":
        return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0438\u0439 \u043A\u043B\u044E\u0447 \u0443 ${Y.origin}`;
      case "invalid_union":
        return "\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0456 \u0432\u0445\u0456\u0434\u043D\u0456 \u0434\u0430\u043D\u0456";
      case "invalid_element":
        return `\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u043D\u044F \u0443 ${Y.origin}`;
      default:
        return "\u041D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u0456 \u0432\u0445\u0456\u0434\u043D\u0456 \u0434\u0430\u043D\u0456";
    }
  };
};
function lW() {
  return { localeError: yA() };
}
var gA = () => {
  let $ = { string: { unit: "\u062D\u0631\u0648\u0641", verb: "\u06C1\u0648\u0646\u0627" }, file: { unit: "\u0628\u0627\u0626\u0679\u0633", verb: "\u06C1\u0648\u0646\u0627" }, array: { unit: "\u0622\u0626\u0679\u0645\u0632", verb: "\u06C1\u0648\u0646\u0627" }, set: { unit: "\u0622\u0626\u0679\u0645\u0632", verb: "\u06C1\u0648\u0646\u0627" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "NaN" : "\u0646\u0645\u0628\u0631";
      case "object": {
        if (Array.isArray(Y)) return "\u0622\u0631\u06D2";
        if (Y === null) return "\u0646\u0644";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "\u0627\u0646 \u067E\u0679", email: "\u0627\u06CC \u0645\u06CC\u0644 \u0627\u06CC\u0688\u0631\u06CC\u0633", url: "\u06CC\u0648 \u0622\u0631 \u0627\u06CC\u0644", emoji: "\u0627\u06CC\u0645\u0648\u062C\u06CC", uuid: "\u06CC\u0648 \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC", uuidv4: "\u06CC\u0648 \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC \u0648\u06CC 4", uuidv6: "\u06CC\u0648 \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC \u0648\u06CC 6", nanoid: "\u0646\u06CC\u0646\u0648 \u0622\u0626\u06CC \u0688\u06CC", guid: "\u062C\u06CC \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC", cuid: "\u0633\u06CC \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC", cuid2: "\u0633\u06CC \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC 2", ulid: "\u06CC\u0648 \u0627\u06CC\u0644 \u0622\u0626\u06CC \u0688\u06CC", xid: "\u0627\u06CC\u06A9\u0633 \u0622\u0626\u06CC \u0688\u06CC", ksuid: "\u06A9\u06D2 \u0627\u06CC\u0633 \u06CC\u0648 \u0622\u0626\u06CC \u0688\u06CC", datetime: "\u0622\u0626\u06CC \u0627\u06CC\u0633 \u0627\u0648 \u0688\u06CC\u0679 \u0679\u0627\u0626\u0645", date: "\u0622\u0626\u06CC \u0627\u06CC\u0633 \u0627\u0648 \u062A\u0627\u0631\u06CC\u062E", time: "\u0622\u0626\u06CC \u0627\u06CC\u0633 \u0627\u0648 \u0648\u0642\u062A", duration: "\u0622\u0626\u06CC \u0627\u06CC\u0633 \u0627\u0648 \u0645\u062F\u062A", ipv4: "\u0622\u0626\u06CC \u067E\u06CC \u0648\u06CC 4 \u0627\u06CC\u0688\u0631\u06CC\u0633", ipv6: "\u0622\u0626\u06CC \u067E\u06CC \u0648\u06CC 6 \u0627\u06CC\u0688\u0631\u06CC\u0633", cidrv4: "\u0622\u0626\u06CC \u067E\u06CC \u0648\u06CC 4 \u0631\u06CC\u0646\u062C", cidrv6: "\u0622\u0626\u06CC \u067E\u06CC \u0648\u06CC 6 \u0631\u06CC\u0646\u062C", base64: "\u0628\u06CC\u0633 64 \u0627\u0646 \u06A9\u0648\u0688\u0688 \u0633\u0679\u0631\u0646\u06AF", base64url: "\u0628\u06CC\u0633 64 \u06CC\u0648 \u0622\u0631 \u0627\u06CC\u0644 \u0627\u0646 \u06A9\u0648\u0688\u0688 \u0633\u0679\u0631\u0646\u06AF", json_string: "\u062C\u06D2 \u0627\u06CC\u0633 \u0627\u0648 \u0627\u06CC\u0646 \u0633\u0679\u0631\u0646\u06AF", e164: "\u0627\u06CC 164 \u0646\u0645\u0628\u0631", jwt: "\u062C\u06D2 \u0688\u0628\u0644\u06CC\u0648 \u0679\u06CC", template_literal: "\u0627\u0646 \u067E\u0679" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `\u063A\u0644\u0637 \u0627\u0646 \u067E\u0679: ${Y.expected} \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u0627\u060C ${J(Y.input)} \u0645\u0648\u0635\u0648\u0644 \u06C1\u0648\u0627`;
      case "invalid_value":
        if (Y.values.length === 1) return `\u063A\u0644\u0637 \u0627\u0646 \u067E\u0679: ${S(Y.values[0])} \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u0627`;
        return `\u063A\u0644\u0637 \u0622\u067E\u0634\u0646: ${I(Y.values, "|")} \u0645\u06CC\u06BA \u0633\u06D2 \u0627\u06CC\u06A9 \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u0627`;
      case "too_big": {
        let z = Y.inclusive ? "<=" : "<", W = X(Y.origin);
        if (W) return `\u0628\u06C1\u062A \u0628\u0691\u0627: ${Y.origin ?? "\u0648\u06CC\u0644\u06CC\u0648"} \u06A9\u06D2 ${z}${Y.maximum.toString()} ${W.unit ?? "\u0639\u0646\u0627\u0635\u0631"} \u06C1\u0648\u0646\u06D2 \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u06D2`;
        return `\u0628\u06C1\u062A \u0628\u0691\u0627: ${Y.origin ?? "\u0648\u06CC\u0644\u06CC\u0648"} \u06A9\u0627 ${z}${Y.maximum.toString()} \u06C1\u0648\u0646\u0627 \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u0627`;
      }
      case "too_small": {
        let z = Y.inclusive ? ">=" : ">", W = X(Y.origin);
        if (W) return `\u0628\u06C1\u062A \u0686\u06BE\u0648\u0679\u0627: ${Y.origin} \u06A9\u06D2 ${z}${Y.minimum.toString()} ${W.unit} \u06C1\u0648\u0646\u06D2 \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u06D2`;
        return `\u0628\u06C1\u062A \u0686\u06BE\u0648\u0679\u0627: ${Y.origin} \u06A9\u0627 ${z}${Y.minimum.toString()} \u06C1\u0648\u0646\u0627 \u0645\u062A\u0648\u0642\u0639 \u062A\u06BE\u0627`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `\u063A\u0644\u0637 \u0633\u0679\u0631\u0646\u06AF: "${z.prefix}" \u0633\u06D2 \u0634\u0631\u0648\u0639 \u06C1\u0648\u0646\u0627 \u0686\u0627\u06C1\u06CC\u06D2`;
        if (z.format === "ends_with") return `\u063A\u0644\u0637 \u0633\u0679\u0631\u0646\u06AF: "${z.suffix}" \u067E\u0631 \u062E\u062A\u0645 \u06C1\u0648\u0646\u0627 \u0686\u0627\u06C1\u06CC\u06D2`;
        if (z.format === "includes") return `\u063A\u0644\u0637 \u0633\u0679\u0631\u0646\u06AF: "${z.includes}" \u0634\u0627\u0645\u0644 \u06C1\u0648\u0646\u0627 \u0686\u0627\u06C1\u06CC\u06D2`;
        if (z.format === "regex") return `\u063A\u0644\u0637 \u0633\u0679\u0631\u0646\u06AF: \u067E\u06CC\u0679\u0631\u0646 ${z.pattern} \u0633\u06D2 \u0645\u06CC\u0686 \u06C1\u0648\u0646\u0627 \u0686\u0627\u06C1\u06CC\u06D2`;
        return `\u063A\u0644\u0637 ${Q[z.format] ?? Y.format}`;
      }
      case "not_multiple_of":
        return `\u063A\u0644\u0637 \u0646\u0645\u0628\u0631: ${Y.divisor} \u06A9\u0627 \u0645\u0636\u0627\u0639\u0641 \u06C1\u0648\u0646\u0627 \u0686\u0627\u06C1\u06CC\u06D2`;
      case "unrecognized_keys":
        return `\u063A\u06CC\u0631 \u062A\u0633\u0644\u06CC\u0645 \u0634\u062F\u06C1 \u06A9\u06CC${Y.keys.length > 1 ? "\u0632" : ""}: ${I(Y.keys, "\u060C ")}`;
      case "invalid_key":
        return `${Y.origin} \u0645\u06CC\u06BA \u063A\u0644\u0637 \u06A9\u06CC`;
      case "invalid_union":
        return "\u063A\u0644\u0637 \u0627\u0646 \u067E\u0679";
      case "invalid_element":
        return `${Y.origin} \u0645\u06CC\u06BA \u063A\u0644\u0637 \u0648\u06CC\u0644\u06CC\u0648`;
      default:
        return "\u063A\u0644\u0637 \u0627\u0646 \u067E\u0679";
    }
  };
};
function cW() {
  return { localeError: gA() };
}
var fA = () => {
  let $ = { string: { unit: "k\xFD t\u1EF1", verb: "c\xF3" }, file: { unit: "byte", verb: "c\xF3" }, array: { unit: "ph\u1EA7n t\u1EED", verb: "c\xF3" }, set: { unit: "ph\u1EA7n t\u1EED", verb: "c\xF3" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "NaN" : "s\u1ED1";
      case "object": {
        if (Array.isArray(Y)) return "m\u1EA3ng";
        if (Y === null) return "null";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "\u0111\u1EA7u v\xE0o", email: "\u0111\u1ECBa ch\u1EC9 email", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ng\xE0y gi\u1EDD ISO", date: "ng\xE0y ISO", time: "gi\u1EDD ISO", duration: "kho\u1EA3ng th\u1EDDi gian ISO", ipv4: "\u0111\u1ECBa ch\u1EC9 IPv4", ipv6: "\u0111\u1ECBa ch\u1EC9 IPv6", cidrv4: "d\u1EA3i IPv4", cidrv6: "d\u1EA3i IPv6", base64: "chu\u1ED7i m\xE3 h\xF3a base64", base64url: "chu\u1ED7i m\xE3 h\xF3a base64url", json_string: "chu\u1ED7i JSON", e164: "s\u1ED1 E.164", jwt: "JWT", template_literal: "\u0111\u1EA7u v\xE0o" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `\u0110\u1EA7u v\xE0o kh\xF4ng h\u1EE3p l\u1EC7: mong \u0111\u1EE3i ${Y.expected}, nh\u1EADn \u0111\u01B0\u1EE3c ${J(Y.input)}`;
      case "invalid_value":
        if (Y.values.length === 1) return `\u0110\u1EA7u v\xE0o kh\xF4ng h\u1EE3p l\u1EC7: mong \u0111\u1EE3i ${S(Y.values[0])}`;
        return `T\xF9y ch\u1ECDn kh\xF4ng h\u1EE3p l\u1EC7: mong \u0111\u1EE3i m\u1ED9t trong c\xE1c gi\xE1 tr\u1ECB ${I(Y.values, "|")}`;
      case "too_big": {
        let z = Y.inclusive ? "<=" : "<", W = X(Y.origin);
        if (W) return `Qu\xE1 l\u1EDBn: mong \u0111\u1EE3i ${Y.origin ?? "gi\xE1 tr\u1ECB"} ${W.verb} ${z}${Y.maximum.toString()} ${W.unit ?? "ph\u1EA7n t\u1EED"}`;
        return `Qu\xE1 l\u1EDBn: mong \u0111\u1EE3i ${Y.origin ?? "gi\xE1 tr\u1ECB"} ${z}${Y.maximum.toString()}`;
      }
      case "too_small": {
        let z = Y.inclusive ? ">=" : ">", W = X(Y.origin);
        if (W) return `Qu\xE1 nh\u1ECF: mong \u0111\u1EE3i ${Y.origin} ${W.verb} ${z}${Y.minimum.toString()} ${W.unit}`;
        return `Qu\xE1 nh\u1ECF: mong \u0111\u1EE3i ${Y.origin} ${z}${Y.minimum.toString()}`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `Chu\u1ED7i kh\xF4ng h\u1EE3p l\u1EC7: ph\u1EA3i b\u1EAFt \u0111\u1EA7u b\u1EB1ng "${z.prefix}"`;
        if (z.format === "ends_with") return `Chu\u1ED7i kh\xF4ng h\u1EE3p l\u1EC7: ph\u1EA3i k\u1EBFt th\xFAc b\u1EB1ng "${z.suffix}"`;
        if (z.format === "includes") return `Chu\u1ED7i kh\xF4ng h\u1EE3p l\u1EC7: ph\u1EA3i bao g\u1ED3m "${z.includes}"`;
        if (z.format === "regex") return `Chu\u1ED7i kh\xF4ng h\u1EE3p l\u1EC7: ph\u1EA3i kh\u1EDBp v\u1EDBi m\u1EABu ${z.pattern}`;
        return `${Q[z.format] ?? Y.format} kh\xF4ng h\u1EE3p l\u1EC7`;
      }
      case "not_multiple_of":
        return `S\u1ED1 kh\xF4ng h\u1EE3p l\u1EC7: ph\u1EA3i l\xE0 b\u1ED9i s\u1ED1 c\u1EE7a ${Y.divisor}`;
      case "unrecognized_keys":
        return `Kh\xF3a kh\xF4ng \u0111\u01B0\u1EE3c nh\u1EADn d\u1EA1ng: ${I(Y.keys, ", ")}`;
      case "invalid_key":
        return `Kh\xF3a kh\xF4ng h\u1EE3p l\u1EC7 trong ${Y.origin}`;
      case "invalid_union":
        return "\u0110\u1EA7u v\xE0o kh\xF4ng h\u1EE3p l\u1EC7";
      case "invalid_element":
        return `Gi\xE1 tr\u1ECB kh\xF4ng h\u1EE3p l\u1EC7 trong ${Y.origin}`;
      default:
        return "\u0110\u1EA7u v\xE0o kh\xF4ng h\u1EE3p l\u1EC7";
    }
  };
};
function iW() {
  return { localeError: fA() };
}
var hA = () => {
  let $ = { string: { unit: "\u5B57\u7B26", verb: "\u5305\u542B" }, file: { unit: "\u5B57\u8282", verb: "\u5305\u542B" }, array: { unit: "\u9879", verb: "\u5305\u542B" }, set: { unit: "\u9879", verb: "\u5305\u542B" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "\u975E\u6570\u5B57(NaN)" : "\u6570\u5B57";
      case "object": {
        if (Array.isArray(Y)) return "\u6570\u7EC4";
        if (Y === null) return "\u7A7A\u503C(null)";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "\u8F93\u5165", email: "\u7535\u5B50\u90AE\u4EF6", url: "URL", emoji: "\u8868\u60C5\u7B26\u53F7", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO\u65E5\u671F\u65F6\u95F4", date: "ISO\u65E5\u671F", time: "ISO\u65F6\u95F4", duration: "ISO\u65F6\u957F", ipv4: "IPv4\u5730\u5740", ipv6: "IPv6\u5730\u5740", cidrv4: "IPv4\u7F51\u6BB5", cidrv6: "IPv6\u7F51\u6BB5", base64: "base64\u7F16\u7801\u5B57\u7B26\u4E32", base64url: "base64url\u7F16\u7801\u5B57\u7B26\u4E32", json_string: "JSON\u5B57\u7B26\u4E32", e164: "E.164\u53F7\u7801", jwt: "JWT", template_literal: "\u8F93\u5165" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `\u65E0\u6548\u8F93\u5165\uFF1A\u671F\u671B ${Y.expected}\uFF0C\u5B9E\u9645\u63A5\u6536 ${J(Y.input)}`;
      case "invalid_value":
        if (Y.values.length === 1) return `\u65E0\u6548\u8F93\u5165\uFF1A\u671F\u671B ${S(Y.values[0])}`;
        return `\u65E0\u6548\u9009\u9879\uFF1A\u671F\u671B\u4EE5\u4E0B\u4E4B\u4E00 ${I(Y.values, "|")}`;
      case "too_big": {
        let z = Y.inclusive ? "<=" : "<", W = X(Y.origin);
        if (W) return `\u6570\u503C\u8FC7\u5927\uFF1A\u671F\u671B ${Y.origin ?? "\u503C"} ${z}${Y.maximum.toString()} ${W.unit ?? "\u4E2A\u5143\u7D20"}`;
        return `\u6570\u503C\u8FC7\u5927\uFF1A\u671F\u671B ${Y.origin ?? "\u503C"} ${z}${Y.maximum.toString()}`;
      }
      case "too_small": {
        let z = Y.inclusive ? ">=" : ">", W = X(Y.origin);
        if (W) return `\u6570\u503C\u8FC7\u5C0F\uFF1A\u671F\u671B ${Y.origin} ${z}${Y.minimum.toString()} ${W.unit}`;
        return `\u6570\u503C\u8FC7\u5C0F\uFF1A\u671F\u671B ${Y.origin} ${z}${Y.minimum.toString()}`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `\u65E0\u6548\u5B57\u7B26\u4E32\uFF1A\u5FC5\u987B\u4EE5 "${z.prefix}" \u5F00\u5934`;
        if (z.format === "ends_with") return `\u65E0\u6548\u5B57\u7B26\u4E32\uFF1A\u5FC5\u987B\u4EE5 "${z.suffix}" \u7ED3\u5C3E`;
        if (z.format === "includes") return `\u65E0\u6548\u5B57\u7B26\u4E32\uFF1A\u5FC5\u987B\u5305\u542B "${z.includes}"`;
        if (z.format === "regex") return `\u65E0\u6548\u5B57\u7B26\u4E32\uFF1A\u5FC5\u987B\u6EE1\u8DB3\u6B63\u5219\u8868\u8FBE\u5F0F ${z.pattern}`;
        return `\u65E0\u6548${Q[z.format] ?? Y.format}`;
      }
      case "not_multiple_of":
        return `\u65E0\u6548\u6570\u5B57\uFF1A\u5FC5\u987B\u662F ${Y.divisor} \u7684\u500D\u6570`;
      case "unrecognized_keys":
        return `\u51FA\u73B0\u672A\u77E5\u7684\u952E(key): ${I(Y.keys, ", ")}`;
      case "invalid_key":
        return `${Y.origin} \u4E2D\u7684\u952E(key)\u65E0\u6548`;
      case "invalid_union":
        return "\u65E0\u6548\u8F93\u5165";
      case "invalid_element":
        return `${Y.origin} \u4E2D\u5305\u542B\u65E0\u6548\u503C(value)`;
      default:
        return "\u65E0\u6548\u8F93\u5165";
    }
  };
};
function pW() {
  return { localeError: hA() };
}
var uA = () => {
  let $ = { string: { unit: "\u5B57\u5143", verb: "\u64C1\u6709" }, file: { unit: "\u4F4D\u5143\u7D44", verb: "\u64C1\u6709" }, array: { unit: "\u9805\u76EE", verb: "\u64C1\u6709" }, set: { unit: "\u9805\u76EE", verb: "\u64C1\u6709" } };
  function X(Y) {
    return $[Y] ?? null;
  }
  let J = (Y) => {
    let z = typeof Y;
    switch (z) {
      case "number":
        return Number.isNaN(Y) ? "NaN" : "number";
      case "object": {
        if (Array.isArray(Y)) return "array";
        if (Y === null) return "null";
        if (Object.getPrototypeOf(Y) !== Object.prototype && Y.constructor) return Y.constructor.name;
      }
    }
    return z;
  }, Q = { regex: "\u8F38\u5165", email: "\u90F5\u4EF6\u5730\u5740", url: "URL", emoji: "emoji", uuid: "UUID", uuidv4: "UUIDv4", uuidv6: "UUIDv6", nanoid: "nanoid", guid: "GUID", cuid: "cuid", cuid2: "cuid2", ulid: "ULID", xid: "XID", ksuid: "KSUID", datetime: "ISO \u65E5\u671F\u6642\u9593", date: "ISO \u65E5\u671F", time: "ISO \u6642\u9593", duration: "ISO \u671F\u9593", ipv4: "IPv4 \u4F4D\u5740", ipv6: "IPv6 \u4F4D\u5740", cidrv4: "IPv4 \u7BC4\u570D", cidrv6: "IPv6 \u7BC4\u570D", base64: "base64 \u7DE8\u78BC\u5B57\u4E32", base64url: "base64url \u7DE8\u78BC\u5B57\u4E32", json_string: "JSON \u5B57\u4E32", e164: "E.164 \u6578\u503C", jwt: "JWT", template_literal: "\u8F38\u5165" };
  return (Y) => {
    switch (Y.code) {
      case "invalid_type":
        return `\u7121\u6548\u7684\u8F38\u5165\u503C\uFF1A\u9810\u671F\u70BA ${Y.expected}\uFF0C\u4F46\u6536\u5230 ${J(Y.input)}`;
      case "invalid_value":
        if (Y.values.length === 1) return `\u7121\u6548\u7684\u8F38\u5165\u503C\uFF1A\u9810\u671F\u70BA ${S(Y.values[0])}`;
        return `\u7121\u6548\u7684\u9078\u9805\uFF1A\u9810\u671F\u70BA\u4EE5\u4E0B\u5176\u4E2D\u4E4B\u4E00 ${I(Y.values, "|")}`;
      case "too_big": {
        let z = Y.inclusive ? "<=" : "<", W = X(Y.origin);
        if (W) return `\u6578\u503C\u904E\u5927\uFF1A\u9810\u671F ${Y.origin ?? "\u503C"} \u61C9\u70BA ${z}${Y.maximum.toString()} ${W.unit ?? "\u500B\u5143\u7D20"}`;
        return `\u6578\u503C\u904E\u5927\uFF1A\u9810\u671F ${Y.origin ?? "\u503C"} \u61C9\u70BA ${z}${Y.maximum.toString()}`;
      }
      case "too_small": {
        let z = Y.inclusive ? ">=" : ">", W = X(Y.origin);
        if (W) return `\u6578\u503C\u904E\u5C0F\uFF1A\u9810\u671F ${Y.origin} \u61C9\u70BA ${z}${Y.minimum.toString()} ${W.unit}`;
        return `\u6578\u503C\u904E\u5C0F\uFF1A\u9810\u671F ${Y.origin} \u61C9\u70BA ${z}${Y.minimum.toString()}`;
      }
      case "invalid_format": {
        let z = Y;
        if (z.format === "starts_with") return `\u7121\u6548\u7684\u5B57\u4E32\uFF1A\u5FC5\u9808\u4EE5 "${z.prefix}" \u958B\u982D`;
        if (z.format === "ends_with") return `\u7121\u6548\u7684\u5B57\u4E32\uFF1A\u5FC5\u9808\u4EE5 "${z.suffix}" \u7D50\u5C3E`;
        if (z.format === "includes") return `\u7121\u6548\u7684\u5B57\u4E32\uFF1A\u5FC5\u9808\u5305\u542B "${z.includes}"`;
        if (z.format === "regex") return `\u7121\u6548\u7684\u5B57\u4E32\uFF1A\u5FC5\u9808\u7B26\u5408\u683C\u5F0F ${z.pattern}`;
        return `\u7121\u6548\u7684 ${Q[z.format] ?? Y.format}`;
      }
      case "not_multiple_of":
        return `\u7121\u6548\u7684\u6578\u5B57\uFF1A\u5FC5\u9808\u70BA ${Y.divisor} \u7684\u500D\u6578`;
      case "unrecognized_keys":
        return `\u7121\u6CD5\u8B58\u5225\u7684\u9375\u503C${Y.keys.length > 1 ? "\u5011" : ""}\uFF1A${I(Y.keys, "\u3001")}`;
      case "invalid_key":
        return `${Y.origin} \u4E2D\u6709\u7121\u6548\u7684\u9375\u503C`;
      case "invalid_union":
        return "\u7121\u6548\u7684\u8F38\u5165\u503C";
      case "invalid_element":
        return `${Y.origin} \u4E2D\u6709\u7121\u6548\u7684\u503C`;
      default:
        return "\u7121\u6548\u7684\u8F38\u5165\u503C";
    }
  };
};
function nW() {
  return { localeError: uA() };
}
var sY = /* @__PURE__ */ Symbol("ZodOutput");
var eY = /* @__PURE__ */ Symbol("ZodInput");
var I8 = class {
  constructor() {
    this._map = /* @__PURE__ */ new WeakMap(), this._idmap = /* @__PURE__ */ new Map();
  }
  add($, ...X) {
    let J = X[0];
    if (this._map.set($, J), J && typeof J === "object" && "id" in J) {
      if (this._idmap.has(J.id)) throw Error(`ID ${J.id} already exists in the registry`);
      this._idmap.set(J.id, $);
    }
    return this;
  }
  remove($) {
    return this._map.delete($), this;
  }
  get($) {
    let X = $._zod.parent;
    if (X) {
      let J = { ...this.get(X) ?? {} };
      return delete J.id, { ...J, ...this._map.get($) };
    }
    return this._map.get($);
  }
  has($) {
    return this._map.has($);
  }
};
function M8() {
  return new I8();
}
var E6 = M8();
function $Q($, X) {
  return new $({ type: "string", ...Z(X) });
}
function dW($, X) {
  return new $({ type: "string", coerce: true, ...Z(X) });
}
function A8($, X) {
  return new $({ type: "string", format: "email", check: "string_format", abort: false, ...Z(X) });
}
function M0($, X) {
  return new $({ type: "string", format: "guid", check: "string_format", abort: false, ...Z(X) });
}
function b8($, X) {
  return new $({ type: "string", format: "uuid", check: "string_format", abort: false, ...Z(X) });
}
function P8($, X) {
  return new $({ type: "string", format: "uuid", check: "string_format", abort: false, version: "v4", ...Z(X) });
}
function Z8($, X) {
  return new $({ type: "string", format: "uuid", check: "string_format", abort: false, version: "v6", ...Z(X) });
}
function E8($, X) {
  return new $({ type: "string", format: "uuid", check: "string_format", abort: false, version: "v7", ...Z(X) });
}
function R8($, X) {
  return new $({ type: "string", format: "url", check: "string_format", abort: false, ...Z(X) });
}
function S8($, X) {
  return new $({ type: "string", format: "emoji", check: "string_format", abort: false, ...Z(X) });
}
function v8($, X) {
  return new $({ type: "string", format: "nanoid", check: "string_format", abort: false, ...Z(X) });
}
function C8($, X) {
  return new $({ type: "string", format: "cuid", check: "string_format", abort: false, ...Z(X) });
}
function k8($, X) {
  return new $({ type: "string", format: "cuid2", check: "string_format", abort: false, ...Z(X) });
}
function _8($, X) {
  return new $({ type: "string", format: "ulid", check: "string_format", abort: false, ...Z(X) });
}
function x8($, X) {
  return new $({ type: "string", format: "xid", check: "string_format", abort: false, ...Z(X) });
}
function T8($, X) {
  return new $({ type: "string", format: "ksuid", check: "string_format", abort: false, ...Z(X) });
}
function y8($, X) {
  return new $({ type: "string", format: "ipv4", check: "string_format", abort: false, ...Z(X) });
}
function g8($, X) {
  return new $({ type: "string", format: "ipv6", check: "string_format", abort: false, ...Z(X) });
}
function f8($, X) {
  return new $({ type: "string", format: "cidrv4", check: "string_format", abort: false, ...Z(X) });
}
function h8($, X) {
  return new $({ type: "string", format: "cidrv6", check: "string_format", abort: false, ...Z(X) });
}
function u8($, X) {
  return new $({ type: "string", format: "base64", check: "string_format", abort: false, ...Z(X) });
}
function m8($, X) {
  return new $({ type: "string", format: "base64url", check: "string_format", abort: false, ...Z(X) });
}
function l8($, X) {
  return new $({ type: "string", format: "e164", check: "string_format", abort: false, ...Z(X) });
}
function c8($, X) {
  return new $({ type: "string", format: "jwt", check: "string_format", abort: false, ...Z(X) });
}
var XQ = { Any: null, Minute: -1, Second: 0, Millisecond: 3, Microsecond: 6 };
function rW($, X) {
  return new $({ type: "string", format: "datetime", check: "string_format", offset: false, local: false, precision: null, ...Z(X) });
}
function oW($, X) {
  return new $({ type: "string", format: "date", check: "string_format", ...Z(X) });
}
function tW($, X) {
  return new $({ type: "string", format: "time", check: "string_format", precision: null, ...Z(X) });
}
function aW($, X) {
  return new $({ type: "string", format: "duration", check: "string_format", ...Z(X) });
}
function JQ($, X) {
  return new $({ type: "number", checks: [], ...Z(X) });
}
function sW($, X) {
  return new $({ type: "number", coerce: true, checks: [], ...Z(X) });
}
function YQ($, X) {
  return new $({ type: "number", check: "number_format", abort: false, format: "safeint", ...Z(X) });
}
function QQ($, X) {
  return new $({ type: "number", check: "number_format", abort: false, format: "float32", ...Z(X) });
}
function zQ($, X) {
  return new $({ type: "number", check: "number_format", abort: false, format: "float64", ...Z(X) });
}
function WQ($, X) {
  return new $({ type: "number", check: "number_format", abort: false, format: "int32", ...Z(X) });
}
function GQ($, X) {
  return new $({ type: "number", check: "number_format", abort: false, format: "uint32", ...Z(X) });
}
function UQ($, X) {
  return new $({ type: "boolean", ...Z(X) });
}
function eW($, X) {
  return new $({ type: "boolean", coerce: true, ...Z(X) });
}
function HQ($, X) {
  return new $({ type: "bigint", ...Z(X) });
}
function $G($, X) {
  return new $({ type: "bigint", coerce: true, ...Z(X) });
}
function KQ($, X) {
  return new $({ type: "bigint", check: "bigint_format", abort: false, format: "int64", ...Z(X) });
}
function NQ($, X) {
  return new $({ type: "bigint", check: "bigint_format", abort: false, format: "uint64", ...Z(X) });
}
function VQ($, X) {
  return new $({ type: "symbol", ...Z(X) });
}
function OQ($, X) {
  return new $({ type: "undefined", ...Z(X) });
}
function wQ($, X) {
  return new $({ type: "null", ...Z(X) });
}
function BQ($) {
  return new $({ type: "any" });
}
function M1($) {
  return new $({ type: "unknown" });
}
function qQ($, X) {
  return new $({ type: "never", ...Z(X) });
}
function DQ($, X) {
  return new $({ type: "void", ...Z(X) });
}
function LQ($, X) {
  return new $({ type: "date", ...Z(X) });
}
function XG($, X) {
  return new $({ type: "date", coerce: true, ...Z(X) });
}
function jQ($, X) {
  return new $({ type: "nan", ...Z(X) });
}
function H4($, X) {
  return new aJ({ check: "less_than", ...Z(X), value: $, inclusive: false });
}
function L6($, X) {
  return new aJ({ check: "less_than", ...Z(X), value: $, inclusive: true });
}
function K4($, X) {
  return new sJ({ check: "greater_than", ...Z(X), value: $, inclusive: false });
}
function e$($, X) {
  return new sJ({ check: "greater_than", ...Z(X), value: $, inclusive: true });
}
function JG($) {
  return K4(0, $);
}
function YG($) {
  return H4(0, $);
}
function QG($) {
  return L6(0, $);
}
function zG($) {
  return e$(0, $);
}
function A1($, X) {
  return new f5({ check: "multiple_of", ...Z(X), value: $ });
}
function A0($, X) {
  return new m5({ check: "max_size", ...Z(X), maximum: $ });
}
function b1($, X) {
  return new l5({ check: "min_size", ...Z(X), minimum: $ });
}
function i8($, X) {
  return new c5({ check: "size_equals", ...Z(X), size: $ });
}
function b0($, X) {
  return new i5({ check: "max_length", ...Z(X), maximum: $ });
}
function y4($, X) {
  return new p5({ check: "min_length", ...Z(X), minimum: $ });
}
function P0($, X) {
  return new n5({ check: "length_equals", ...Z(X), length: $ });
}
function p8($, X) {
  return new d5({ check: "string_format", format: "regex", ...Z(X), pattern: $ });
}
function n8($) {
  return new r5({ check: "string_format", format: "lowercase", ...Z($) });
}
function d8($) {
  return new o5({ check: "string_format", format: "uppercase", ...Z($) });
}
function r8($, X) {
  return new t5({ check: "string_format", format: "includes", ...Z(X), includes: $ });
}
function o8($, X) {
  return new a5({ check: "string_format", format: "starts_with", ...Z(X), prefix: $ });
}
function t8($, X) {
  return new s5({ check: "string_format", format: "ends_with", ...Z(X), suffix: $ });
}
function WG($, X, J) {
  return new e5({ check: "property", property: $, schema: X, ...Z(J) });
}
function a8($, X) {
  return new $W({ check: "mime_type", mime: $, ...Z(X) });
}
function N4($) {
  return new XW({ check: "overwrite", tx: $ });
}
function s8($) {
  return N4((X) => X.normalize($));
}
function e8() {
  return N4(($) => $.trim());
}
function $9() {
  return N4(($) => $.toLowerCase());
}
function X9() {
  return N4(($) => $.toUpperCase());
}
function J9($, X, J) {
  return new $({ type: "array", element: X, ...Z(J) });
}
function mA($, X, J) {
  return new $({ type: "union", options: X, ...Z(J) });
}
function lA($, X, J, Q) {
  return new $({ type: "union", options: J, discriminator: X, ...Z(Q) });
}
function cA($, X, J) {
  return new $({ type: "intersection", left: X, right: J });
}
function GG($, X, J, Q) {
  let Y = J instanceof i;
  return new $({ type: "tuple", items: X, rest: Y ? J : null, ...Z(Y ? Q : J) });
}
function iA($, X, J, Q) {
  return new $({ type: "record", keyType: X, valueType: J, ...Z(Q) });
}
function pA($, X, J, Q) {
  return new $({ type: "map", keyType: X, valueType: J, ...Z(Q) });
}
function nA($, X, J) {
  return new $({ type: "set", valueType: X, ...Z(J) });
}
function dA($, X, J) {
  let Q = Array.isArray(X) ? Object.fromEntries(X.map((Y) => [Y, Y])) : X;
  return new $({ type: "enum", entries: Q, ...Z(J) });
}
function rA($, X, J) {
  return new $({ type: "enum", entries: X, ...Z(J) });
}
function oA($, X, J) {
  return new $({ type: "literal", values: Array.isArray(X) ? X : [X], ...Z(J) });
}
function FQ($, X) {
  return new $({ type: "file", ...Z(X) });
}
function tA($, X) {
  return new $({ type: "transform", transform: X });
}
function aA($, X) {
  return new $({ type: "optional", innerType: X });
}
function sA($, X) {
  return new $({ type: "nullable", innerType: X });
}
function eA($, X, J) {
  return new $({ type: "default", innerType: X, get defaultValue() {
    return typeof J === "function" ? J() : J;
  } });
}
function $2($, X, J) {
  return new $({ type: "nonoptional", innerType: X, ...Z(J) });
}
function X2($, X) {
  return new $({ type: "success", innerType: X });
}
function J2($, X, J) {
  return new $({ type: "catch", innerType: X, catchValue: typeof J === "function" ? J : () => J });
}
function Y2($, X, J) {
  return new $({ type: "pipe", in: X, out: J });
}
function Q2($, X) {
  return new $({ type: "readonly", innerType: X });
}
function z2($, X, J) {
  return new $({ type: "template_literal", parts: X, ...Z(J) });
}
function W2($, X) {
  return new $({ type: "lazy", getter: X });
}
function G2($, X) {
  return new $({ type: "promise", innerType: X });
}
function IQ($, X, J) {
  let Q = Z(J);
  return Q.abort ?? (Q.abort = true), new $({ type: "custom", check: "custom", fn: X, ...Q });
}
function MQ($, X, J) {
  return new $({ type: "custom", check: "custom", fn: X, ...Z(J) });
}
function AQ($, X) {
  let J = Z(X), Q = J.truthy ?? ["true", "1", "yes", "on", "y", "enabled"], Y = J.falsy ?? ["false", "0", "no", "off", "n", "disabled"];
  if (J.case !== "sensitive") Q = Q.map((w) => typeof w === "string" ? w.toLowerCase() : w), Y = Y.map((w) => typeof w === "string" ? w.toLowerCase() : w);
  let z = new Set(Q), W = new Set(Y), G = $.Pipe ?? F0, U = $.Boolean ?? D0, H = $.String ?? x4, V = new ($.Transform ?? j0)({ type: "transform", transform: (w, B) => {
    let L = w;
    if (J.case !== "sensitive") L = L.toLowerCase();
    if (z.has(L)) return true;
    else if (W.has(L)) return false;
    else return B.issues.push({ code: "invalid_value", expected: "stringbool", values: [...z, ...W], input: B.value, inst: V }), {};
  }, error: J.error }), O = new G({ type: "pipe", in: new H({ type: "string", error: J.error }), out: V, error: J.error });
  return new G({ type: "pipe", in: O, out: new U({ type: "boolean", error: J.error }), error: J.error });
}
function bQ($, X, J, Q = {}) {
  let Y = Z(Q), z = { ...Z(Q), check: "string_format", type: "string", format: X, fn: typeof J === "function" ? J : (G) => J.test(G), ...Y };
  if (J instanceof RegExp) z.pattern = J;
  return new $(z);
}
var UG = class {
  constructor($) {
    this._def = $, this.def = $;
  }
  implement($) {
    if (typeof $ !== "function") throw Error("implement() must be called with a function");
    let X = (...J) => {
      let Q = this._def.input ? L1(this._def.input, J, void 0, { callee: X }) : J;
      if (!Array.isArray(Q)) throw Error("Invalid arguments schema: not an array or tuple schema.");
      let Y = $(...Q);
      return this._def.output ? L1(this._def.output, Y, void 0, { callee: X }) : Y;
    };
    return X;
  }
  implementAsync($) {
    if (typeof $ !== "function") throw Error("implement() must be called with a function");
    let X = async (...J) => {
      let Q = this._def.input ? await j1(this._def.input, J, void 0, { callee: X }) : J;
      if (!Array.isArray(Q)) throw Error("Invalid arguments schema: not an array or tuple schema.");
      let Y = await $(...Q);
      return this._def.output ? j1(this._def.output, Y, void 0, { callee: X }) : Y;
    };
    return X;
  }
  input(...$) {
    let X = this.constructor;
    if (Array.isArray($[0])) return new X({ type: "function", input: new T4({ type: "tuple", items: $[0], rest: $[1] }), output: this._def.output });
    return new X({ type: "function", input: $[0], output: this._def.output });
  }
  output($) {
    return new this.constructor({ type: "function", input: this._def.input, output: $ });
  }
};
function PQ($) {
  return new UG({ type: "function", input: Array.isArray($?.input) ? GG(T4, $?.input) : $?.input ?? J9(L0, M1(I1)), output: $?.output ?? M1(I1) });
}
var ZQ = class {
  constructor($) {
    this.counter = 0, this.metadataRegistry = $?.metadata ?? E6, this.target = $?.target ?? "draft-2020-12", this.unrepresentable = $?.unrepresentable ?? "throw", this.override = $?.override ?? (() => {
    }), this.io = $?.io ?? "output", this.seen = /* @__PURE__ */ new Map();
  }
  process($, X = { path: [], schemaPath: [] }) {
    var J;
    let Q = $._zod.def, Y = { guid: "uuid", url: "uri", datetime: "date-time", json_string: "json-string", regex: "" }, z = this.seen.get($);
    if (z) {
      if (z.count++, X.schemaPath.includes($)) z.cycle = X.path;
      return z.schema;
    }
    let W = { schema: {}, count: 1, cycle: void 0, path: X.path };
    this.seen.set($, W);
    let G = $._zod.toJSONSchema?.();
    if (G) W.schema = G;
    else {
      let K = { ...X, schemaPath: [...X.schemaPath, $], path: X.path }, V = $._zod.parent;
      if (V) W.ref = V, this.process(V, K), this.seen.get(V).isParent = true;
      else {
        let O = W.schema;
        switch (Q.type) {
          case "string": {
            let N = O;
            N.type = "string";
            let { minimum: w, maximum: B, format: L, patterns: j, contentEncoding: M } = $._zod.bag;
            if (typeof w === "number") N.minLength = w;
            if (typeof B === "number") N.maxLength = B;
            if (L) {
              if (N.format = Y[L] ?? L, N.format === "") delete N.format;
            }
            if (M) N.contentEncoding = M;
            if (j && j.size > 0) {
              let b = [...j];
              if (b.length === 1) N.pattern = b[0].source;
              else if (b.length > 1) W.schema.allOf = [...b.map((x) => ({ ...this.target === "draft-7" ? { type: "string" } : {}, pattern: x.source }))];
            }
            break;
          }
          case "number": {
            let N = O, { minimum: w, maximum: B, format: L, multipleOf: j, exclusiveMaximum: M, exclusiveMinimum: b } = $._zod.bag;
            if (typeof L === "string" && L.includes("int")) N.type = "integer";
            else N.type = "number";
            if (typeof b === "number") N.exclusiveMinimum = b;
            if (typeof w === "number") {
              if (N.minimum = w, typeof b === "number") if (b >= w) delete N.minimum;
              else delete N.exclusiveMinimum;
            }
            if (typeof M === "number") N.exclusiveMaximum = M;
            if (typeof B === "number") {
              if (N.maximum = B, typeof M === "number") if (M <= B) delete N.maximum;
              else delete N.exclusiveMaximum;
            }
            if (typeof j === "number") N.multipleOf = j;
            break;
          }
          case "boolean": {
            let N = O;
            N.type = "boolean";
            break;
          }
          case "bigint": {
            if (this.unrepresentable === "throw") throw Error("BigInt cannot be represented in JSON Schema");
            break;
          }
          case "symbol": {
            if (this.unrepresentable === "throw") throw Error("Symbols cannot be represented in JSON Schema");
            break;
          }
          case "null": {
            O.type = "null";
            break;
          }
          case "any":
            break;
          case "unknown":
            break;
          case "undefined":
          case "never": {
            O.not = {};
            break;
          }
          case "void": {
            if (this.unrepresentable === "throw") throw Error("Void cannot be represented in JSON Schema");
            break;
          }
          case "date": {
            if (this.unrepresentable === "throw") throw Error("Date cannot be represented in JSON Schema");
            break;
          }
          case "array": {
            let N = O, { minimum: w, maximum: B } = $._zod.bag;
            if (typeof w === "number") N.minItems = w;
            if (typeof B === "number") N.maxItems = B;
            N.type = "array", N.items = this.process(Q.element, { ...K, path: [...K.path, "items"] });
            break;
          }
          case "object": {
            let N = O;
            N.type = "object", N.properties = {};
            let w = Q.shape;
            for (let j in w) N.properties[j] = this.process(w[j], { ...K, path: [...K.path, "properties", j] });
            let B = new Set(Object.keys(w)), L = new Set([...B].filter((j) => {
              let M = Q.shape[j]._zod;
              if (this.io === "input") return M.optin === void 0;
              else return M.optout === void 0;
            }));
            if (L.size > 0) N.required = Array.from(L);
            if (Q.catchall?._zod.def.type === "never") N.additionalProperties = false;
            else if (!Q.catchall) {
              if (this.io === "output") N.additionalProperties = false;
            } else if (Q.catchall) N.additionalProperties = this.process(Q.catchall, { ...K, path: [...K.path, "additionalProperties"] });
            break;
          }
          case "union": {
            let N = O;
            N.anyOf = Q.options.map((w, B) => this.process(w, { ...K, path: [...K.path, "anyOf", B] }));
            break;
          }
          case "intersection": {
            let N = O, w = this.process(Q.left, { ...K, path: [...K.path, "allOf", 0] }), B = this.process(Q.right, { ...K, path: [...K.path, "allOf", 1] }), L = (M) => "allOf" in M && Object.keys(M).length === 1, j = [...L(w) ? w.allOf : [w], ...L(B) ? B.allOf : [B]];
            N.allOf = j;
            break;
          }
          case "tuple": {
            let N = O;
            N.type = "array";
            let w = Q.items.map((j, M) => this.process(j, { ...K, path: [...K.path, "prefixItems", M] }));
            if (this.target === "draft-2020-12") N.prefixItems = w;
            else N.items = w;
            if (Q.rest) {
              let j = this.process(Q.rest, { ...K, path: [...K.path, "items"] });
              if (this.target === "draft-2020-12") N.items = j;
              else N.additionalItems = j;
            }
            if (Q.rest) N.items = this.process(Q.rest, { ...K, path: [...K.path, "items"] });
            let { minimum: B, maximum: L } = $._zod.bag;
            if (typeof B === "number") N.minItems = B;
            if (typeof L === "number") N.maxItems = L;
            break;
          }
          case "record": {
            let N = O;
            N.type = "object", N.propertyNames = this.process(Q.keyType, { ...K, path: [...K.path, "propertyNames"] }), N.additionalProperties = this.process(Q.valueType, { ...K, path: [...K.path, "additionalProperties"] });
            break;
          }
          case "map": {
            if (this.unrepresentable === "throw") throw Error("Map cannot be represented in JSON Schema");
            break;
          }
          case "set": {
            if (this.unrepresentable === "throw") throw Error("Set cannot be represented in JSON Schema");
            break;
          }
          case "enum": {
            let N = O, w = H8(Q.entries);
            if (w.every((B) => typeof B === "number")) N.type = "number";
            if (w.every((B) => typeof B === "string")) N.type = "string";
            N.enum = w;
            break;
          }
          case "literal": {
            let N = O, w = [];
            for (let B of Q.values) if (B === void 0) {
              if (this.unrepresentable === "throw") throw Error("Literal `undefined` cannot be represented in JSON Schema");
            } else if (typeof B === "bigint") if (this.unrepresentable === "throw") throw Error("BigInt literals cannot be represented in JSON Schema");
            else w.push(Number(B));
            else w.push(B);
            if (w.length === 0) ;
            else if (w.length === 1) {
              let B = w[0];
              N.type = B === null ? "null" : typeof B, N.const = B;
            } else {
              if (w.every((B) => typeof B === "number")) N.type = "number";
              if (w.every((B) => typeof B === "string")) N.type = "string";
              if (w.every((B) => typeof B === "boolean")) N.type = "string";
              if (w.every((B) => B === null)) N.type = "null";
              N.enum = w;
            }
            break;
          }
          case "file": {
            let N = O, w = { type: "string", format: "binary", contentEncoding: "binary" }, { minimum: B, maximum: L, mime: j } = $._zod.bag;
            if (B !== void 0) w.minLength = B;
            if (L !== void 0) w.maxLength = L;
            if (j) if (j.length === 1) w.contentMediaType = j[0], Object.assign(N, w);
            else N.anyOf = j.map((M) => {
              return { ...w, contentMediaType: M };
            });
            else Object.assign(N, w);
            break;
          }
          case "transform": {
            if (this.unrepresentable === "throw") throw Error("Transforms cannot be represented in JSON Schema");
            break;
          }
          case "nullable": {
            let N = this.process(Q.innerType, K);
            O.anyOf = [N, { type: "null" }];
            break;
          }
          case "nonoptional": {
            this.process(Q.innerType, K), W.ref = Q.innerType;
            break;
          }
          case "success": {
            let N = O;
            N.type = "boolean";
            break;
          }
          case "default": {
            this.process(Q.innerType, K), W.ref = Q.innerType, O.default = JSON.parse(JSON.stringify(Q.defaultValue));
            break;
          }
          case "prefault": {
            if (this.process(Q.innerType, K), W.ref = Q.innerType, this.io === "input") O._prefault = JSON.parse(JSON.stringify(Q.defaultValue));
            break;
          }
          case "catch": {
            this.process(Q.innerType, K), W.ref = Q.innerType;
            let N;
            try {
              N = Q.catchValue(void 0);
            } catch {
              throw Error("Dynamic catch values are not supported in JSON Schema");
            }
            O.default = N;
            break;
          }
          case "nan": {
            if (this.unrepresentable === "throw") throw Error("NaN cannot be represented in JSON Schema");
            break;
          }
          case "template_literal": {
            let N = O, w = $._zod.pattern;
            if (!w) throw Error("Pattern not found in template literal");
            N.type = "string", N.pattern = w.source;
            break;
          }
          case "pipe": {
            let N = this.io === "input" ? Q.in._zod.def.type === "transform" ? Q.out : Q.in : Q.out;
            this.process(N, K), W.ref = N;
            break;
          }
          case "readonly": {
            this.process(Q.innerType, K), W.ref = Q.innerType, O.readOnly = true;
            break;
          }
          case "promise": {
            this.process(Q.innerType, K), W.ref = Q.innerType;
            break;
          }
          case "optional": {
            this.process(Q.innerType, K), W.ref = Q.innerType;
            break;
          }
          case "lazy": {
            let N = $._zod.innerType;
            this.process(N, K), W.ref = N;
            break;
          }
          case "custom": {
            if (this.unrepresentable === "throw") throw Error("Custom types cannot be represented in JSON Schema");
            break;
          }
          default:
        }
      }
    }
    let U = this.metadataRegistry.get($);
    if (U) Object.assign(W.schema, U);
    if (this.io === "input" && k$($)) delete W.schema.examples, delete W.schema.default;
    if (this.io === "input" && W.schema._prefault) (J = W.schema).default ?? (J.default = W.schema._prefault);
    return delete W.schema._prefault, this.seen.get($).schema;
  }
  emit($, X) {
    let J = { cycles: X?.cycles ?? "ref", reused: X?.reused ?? "inline", external: X?.external ?? void 0 }, Q = this.seen.get($);
    if (!Q) throw Error("Unprocessed schema. This is a bug in Zod.");
    let Y = (H) => {
      let K = this.target === "draft-2020-12" ? "$defs" : "definitions";
      if (J.external) {
        let w = J.external.registry.get(H[0])?.id;
        if (w) return { ref: J.external.uri(w) };
        let B = H[1].defId ?? H[1].schema.id ?? `schema${this.counter++}`;
        return H[1].defId = B, { defId: B, ref: `${J.external.uri("__shared")}#/${K}/${B}` };
      }
      if (H[1] === Q) return { ref: "#" };
      let O = `${"#"}/${K}/`, N = H[1].schema.id ?? `__schema${this.counter++}`;
      return { defId: N, ref: O + N };
    }, z = (H) => {
      if (H[1].schema.$ref) return;
      let K = H[1], { ref: V, defId: O } = Y(H);
      if (K.def = { ...K.schema }, O) K.defId = O;
      let N = K.schema;
      for (let w in N) delete N[w];
      N.$ref = V;
    };
    for (let H of this.seen.entries()) {
      let K = H[1];
      if ($ === H[0]) {
        z(H);
        continue;
      }
      if (J.external) {
        let O = J.external.registry.get(H[0])?.id;
        if ($ !== H[0] && O) {
          z(H);
          continue;
        }
      }
      if (this.metadataRegistry.get(H[0])?.id) {
        z(H);
        continue;
      }
      if (K.cycle) {
        if (J.cycles === "throw") throw Error(`Cycle detected: #/${K.cycle?.join("/")}/<root>

Set the \`cycles\` parameter to \`"ref"\` to resolve cyclical schemas with defs.`);
        else if (J.cycles === "ref") z(H);
        continue;
      }
      if (K.count > 1) {
        if (J.reused === "ref") {
          z(H);
          continue;
        }
      }
    }
    let W = (H, K) => {
      let V = this.seen.get(H), O = V.def ?? V.schema, N = { ...O };
      if (V.ref === null) return;
      let w = V.ref;
      if (V.ref = null, w) {
        W(w, K);
        let B = this.seen.get(w).schema;
        if (B.$ref && K.target === "draft-7") O.allOf = O.allOf ?? [], O.allOf.push(B);
        else Object.assign(O, B), Object.assign(O, N);
      }
      if (!V.isParent) this.override({ zodSchema: H, jsonSchema: O, path: V.path ?? [] });
    };
    for (let H of [...this.seen.entries()].reverse()) W(H[0], { target: this.target });
    let G = {};
    if (this.target === "draft-2020-12") G.$schema = "https://json-schema.org/draft/2020-12/schema";
    else if (this.target === "draft-7") G.$schema = "http://json-schema.org/draft-07/schema#";
    else console.warn(`Invalid target: ${this.target}`);
    Object.assign(G, Q.def);
    let U = J.external?.defs ?? {};
    for (let H of this.seen.entries()) {
      let K = H[1];
      if (K.def && K.defId) U[K.defId] = K.def;
    }
    if (!J.external && Object.keys(U).length > 0) if (this.target === "draft-2020-12") G.$defs = U;
    else G.definitions = U;
    try {
      return JSON.parse(JSON.stringify(G));
    } catch (H) {
      throw Error("Error converting schema to JSON.");
    }
  }
};
function Z0($, X) {
  if ($ instanceof I8) {
    let Q = new ZQ(X), Y = {};
    for (let G of $._idmap.entries()) {
      let [U, H] = G;
      Q.process(H);
    }
    let z = {}, W = { registry: $, uri: X?.uri || ((G) => G), defs: Y };
    for (let G of $._idmap.entries()) {
      let [U, H] = G;
      z[U] = Q.emit(H, { ...X, external: W });
    }
    if (Object.keys(Y).length > 0) {
      let G = Q.target === "draft-2020-12" ? "$defs" : "definitions";
      z.__shared = { [G]: Y };
    }
    return { schemas: z };
  }
  let J = new ZQ(X);
  return J.process($), J.emit($, X);
}
function k$($, X) {
  let J = X ?? { seen: /* @__PURE__ */ new Set() };
  if (J.seen.has($)) return false;
  J.seen.add($);
  let Y = $._zod.def;
  switch (Y.type) {
    case "string":
    case "number":
    case "bigint":
    case "boolean":
    case "date":
    case "symbol":
    case "undefined":
    case "null":
    case "any":
    case "unknown":
    case "never":
    case "void":
    case "literal":
    case "enum":
    case "nan":
    case "file":
    case "template_literal":
      return false;
    case "array":
      return k$(Y.element, J);
    case "object": {
      for (let z in Y.shape) if (k$(Y.shape[z], J)) return true;
      return false;
    }
    case "union": {
      for (let z of Y.options) if (k$(z, J)) return true;
      return false;
    }
    case "intersection":
      return k$(Y.left, J) || k$(Y.right, J);
    case "tuple": {
      for (let z of Y.items) if (k$(z, J)) return true;
      if (Y.rest && k$(Y.rest, J)) return true;
      return false;
    }
    case "record":
      return k$(Y.keyType, J) || k$(Y.valueType, J);
    case "map":
      return k$(Y.keyType, J) || k$(Y.valueType, J);
    case "set":
      return k$(Y.valueType, J);
    case "promise":
    case "optional":
    case "nonoptional":
    case "nullable":
    case "readonly":
      return k$(Y.innerType, J);
    case "lazy":
      return k$(Y.getter(), J);
    case "default":
      return k$(Y.innerType, J);
    case "prefault":
      return k$(Y.innerType, J);
    case "custom":
      return false;
    case "transform":
      return true;
    case "pipe":
      return k$(Y.in, J) || k$(Y.out, J);
    case "success":
      return false;
    case "catch":
      return false;
    default:
  }
  throw Error(`Unknown schema type: ${Y.type}`);
}
var LN = {};
var H2 = q("ZodMiniType", ($, X) => {
  if (!$._zod) throw Error("Uninitialized schema in ZodMiniType.");
  i.init($, X), $.def = X, $.parse = (J, Q) => L1($, J, Q, { callee: $.parse }), $.safeParse = (J, Q) => C4($, J, Q), $.parseAsync = async (J, Q) => j1($, J, Q, { callee: $.parseAsync }), $.safeParseAsync = async (J, Q) => k4($, J, Q), $.check = (...J) => {
    return $.clone({ ...X, checks: [...X.checks ?? [], ...J.map((Q) => typeof Q === "function" ? { _zod: { check: Q, def: { check: "custom" }, onattach: [] } } : Q)] });
  }, $.clone = (J, Q) => m$($, J, Q), $.brand = () => $, $.register = (J, Q) => {
    return J.add($, Q), $;
  };
});
var K2 = q("ZodMiniObject", ($, X) => {
  L8.init($, X), H2.init($, X), E.defineLazy($, "shape", () => X.shape);
});
var h4 = {};
e4(h4, { xid: () => E2, void: () => r2, uuidv7: () => F2, uuidv6: () => j2, uuidv4: () => L2, uuid: () => D2, url: () => I2, uppercase: () => d8, unknown: () => D$, union: () => U$, undefined: () => n2, ulid: () => Z2, uint64: () => i2, uint32: () => m2, tuple: () => s2, trim: () => e8, treeifyError: () => iJ, transform: () => mG, toUpperCase: () => X9, toLowerCase: () => $9, toJSONSchema: () => Z0, templateLiteral: () => Gb, symbol: () => p2, superRefine: () => YV, success: () => zb, stringbool: () => Kb, stringFormat: () => g2, string: () => F, strictObject: () => a2, startsWith: () => o8, size: () => i8, setErrorMap: () => Ob, set: () => Xb, safeParseAsync: () => DG, safeParse: () => qG, registry: () => M8, regexes: () => _4, regex: () => p8, refine: () => JV, record: () => w$, readonly: () => tN, property: () => WG, promise: () => Ub, prettifyError: () => pJ, preprocess: () => lQ, prefault: () => cN, positive: () => JG, pipe: () => yQ, partialRecord: () => e2, parseAsync: () => BG, parse: () => wG, overwrite: () => N4, optional: () => L$, object: () => _, number: () => G$, nullish: () => Qb, nullable: () => TQ, null: () => U9, normalize: () => s8, nonpositive: () => QG, nonoptional: () => iN, nonnegative: () => zG, never: () => gQ, negative: () => YG, nativeEnum: () => Jb, nanoid: () => A2, nan: () => Wb, multipleOf: () => A1, minSize: () => b1, minLength: () => y4, mime: () => a8, maxSize: () => A0, maxLength: () => b0, map: () => $b, lte: () => L6, lt: () => H4, lowercase: () => n8, looseObject: () => l$, locales: () => I0, literal: () => g, length: () => P0, lazy: () => eN, ksuid: () => R2, keyof: () => t2, jwt: () => y2, json: () => Nb, iso: () => R0, ipv6: () => v2, ipv4: () => S2, intersection: () => H9, int64: () => c2, int32: () => u2, int: () => LG, instanceof: () => Hb, includes: () => r8, guid: () => q2, gte: () => e$, gt: () => K4, globalRegistry: () => E6, getErrorMap: () => wb, function: () => PQ, formatError: () => B0, float64: () => h2, float32: () => f2, flattenError: () => w0, file: () => Yb, enum: () => n$, endsWith: () => t8, emoji: () => M2, email: () => B2, e164: () => T2, discriminatedUnion: () => uQ, date: () => o2, custom: () => pG, cuid2: () => P2, cuid: () => b2, core: () => R6, config: () => E$, coerce: () => nG, clone: () => m$, cidrv6: () => k2, cidrv4: () => C2, check: () => XV, catch: () => dN, boolean: () => S$, bigint: () => l2, base64url: () => x2, base64: () => _2, array: () => $$, any: () => d2, _default: () => mN, _ZodString: () => jG, ZodXID: () => EG, ZodVoid: () => vN, ZodUnknown: () => RN, ZodUnion: () => fG, ZodUndefined: () => PN, ZodUUID: () => V4, ZodURL: () => IG, ZodULID: () => ZG, ZodType: () => s, ZodTuple: () => xN, ZodTransform: () => uG, ZodTemplateLiteral: () => aN, ZodSymbol: () => bN, ZodSuccess: () => pN, ZodStringFormat: () => O$, ZodString: () => Q9, ZodSet: () => yN, ZodRecord: () => hG, ZodRealError: () => S0, ZodReadonly: () => oN, ZodPromise: () => $V, ZodPrefault: () => lN, ZodPipe: () => iG, ZodOptional: () => lG, ZodObject: () => hQ, ZodNumberFormat: () => v0, ZodNumber: () => z9, ZodNullable: () => hN, ZodNull: () => ZN, ZodNonOptional: () => cG, ZodNever: () => SN, ZodNanoID: () => AG, ZodNaN: () => rN, ZodMap: () => TN, ZodLiteral: () => gN, ZodLazy: () => sN, ZodKSUID: () => RG, ZodJWT: () => yG, ZodIssueCode: () => Vb, ZodIntersection: () => _N, ZodISOTime: () => kQ, ZodISODuration: () => _Q, ZodISODateTime: () => vQ, ZodISODate: () => CQ, ZodIPv6: () => vG, ZodIPv4: () => SG, ZodGUID: () => xQ, ZodFile: () => fN, ZodError: () => O2, ZodEnum: () => Y9, ZodEmoji: () => MG, ZodEmail: () => FG, ZodE164: () => TG, ZodDiscriminatedUnion: () => kN, ZodDefault: () => uN, ZodDate: () => fQ, ZodCustomStringFormat: () => AN, ZodCustom: () => mQ, ZodCatch: () => nN, ZodCUID2: () => PG, ZodCUID: () => bG, ZodCIDRv6: () => kG, ZodCIDRv4: () => CG, ZodBoolean: () => W9, ZodBigIntFormat: () => gG, ZodBigInt: () => G9, ZodBase64URL: () => xG, ZodBase64: () => _G, ZodArray: () => CN, ZodAny: () => EN, TimePrecision: () => XQ, NEVER: () => mJ, $output: () => sY, $input: () => eY, $brand: () => lJ });
var R0 = {};
e4(R0, { time: () => VG, duration: () => OG, datetime: () => KG, date: () => NG, ZodISOTime: () => kQ, ZodISODuration: () => _Q, ZodISODateTime: () => vQ, ZodISODate: () => CQ });
var vQ = q("ZodISODateTime", ($, X) => {
  QW.init($, X), O$.init($, X);
});
function KG($) {
  return rW(vQ, $);
}
var CQ = q("ZodISODate", ($, X) => {
  zW.init($, X), O$.init($, X);
});
function NG($) {
  return oW(CQ, $);
}
var kQ = q("ZodISOTime", ($, X) => {
  WW.init($, X), O$.init($, X);
});
function VG($) {
  return tW(kQ, $);
}
var _Q = q("ZodISODuration", ($, X) => {
  GW.init($, X), O$.init($, X);
});
function OG($) {
  return aW(_Q, $);
}
var MN = ($, X) => {
  B8.init($, X), $.name = "ZodError", Object.defineProperties($, { format: { value: (J) => B0($, J) }, flatten: { value: (J) => w0($, J) }, addIssue: { value: (J) => $.issues.push(J) }, addIssues: { value: (J) => $.issues.push(...J) }, isEmpty: { get() {
    return $.issues.length === 0;
  } } });
};
var O2 = q("ZodError", MN);
var S0 = q("ZodError", MN, { Parent: Error });
var wG = nJ(S0);
var BG = dJ(S0);
var qG = rJ(S0);
var DG = oJ(S0);
var s = q("ZodType", ($, X) => {
  return i.init($, X), $.def = X, Object.defineProperty($, "_def", { value: X }), $.check = (...J) => {
    return $.clone({ ...X, checks: [...X.checks ?? [], ...J.map((Q) => typeof Q === "function" ? { _zod: { check: Q, def: { check: "custom" }, onattach: [] } } : Q)] });
  }, $.clone = (J, Q) => m$($, J, Q), $.brand = () => $, $.register = (J, Q) => {
    return J.add($, Q), $;
  }, $.parse = (J, Q) => wG($, J, Q, { callee: $.parse }), $.safeParse = (J, Q) => qG($, J, Q), $.parseAsync = async (J, Q) => BG($, J, Q, { callee: $.parseAsync }), $.safeParseAsync = async (J, Q) => DG($, J, Q), $.spa = $.safeParseAsync, $.refine = (J, Q) => $.check(JV(J, Q)), $.superRefine = (J) => $.check(YV(J)), $.overwrite = (J) => $.check(N4(J)), $.optional = () => L$($), $.nullable = () => TQ($), $.nullish = () => L$(TQ($)), $.nonoptional = (J) => iN($, J), $.array = () => $$($), $.or = (J) => U$([$, J]), $.and = (J) => H9($, J), $.transform = (J) => yQ($, mG(J)), $.default = (J) => mN($, J), $.prefault = (J) => cN($, J), $.catch = (J) => dN($, J), $.pipe = (J) => yQ($, J), $.readonly = () => tN($), $.describe = (J) => {
    let Q = $.clone();
    return E6.add(Q, { description: J }), Q;
  }, Object.defineProperty($, "description", { get() {
    return E6.get($)?.description;
  }, configurable: true }), $.meta = (...J) => {
    if (J.length === 0) return E6.get($);
    let Q = $.clone();
    return E6.add(Q, J[0]), Q;
  }, $.isOptional = () => $.safeParse(void 0).success, $.isNullable = () => $.safeParse(null).success, $;
});
var jG = q("_ZodString", ($, X) => {
  x4.init($, X), s.init($, X);
  let J = $._zod.bag;
  $.format = J.format ?? null, $.minLength = J.minimum ?? null, $.maxLength = J.maximum ?? null, $.regex = (...Q) => $.check(p8(...Q)), $.includes = (...Q) => $.check(r8(...Q)), $.startsWith = (...Q) => $.check(o8(...Q)), $.endsWith = (...Q) => $.check(t8(...Q)), $.min = (...Q) => $.check(y4(...Q)), $.max = (...Q) => $.check(b0(...Q)), $.length = (...Q) => $.check(P0(...Q)), $.nonempty = (...Q) => $.check(y4(1, ...Q)), $.lowercase = (Q) => $.check(n8(Q)), $.uppercase = (Q) => $.check(d8(Q)), $.trim = () => $.check(e8()), $.normalize = (...Q) => $.check(s8(...Q)), $.toLowerCase = () => $.check($9()), $.toUpperCase = () => $.check(X9());
});
var Q9 = q("ZodString", ($, X) => {
  x4.init($, X), jG.init($, X), $.email = (J) => $.check(A8(FG, J)), $.url = (J) => $.check(R8(IG, J)), $.jwt = (J) => $.check(c8(yG, J)), $.emoji = (J) => $.check(S8(MG, J)), $.guid = (J) => $.check(M0(xQ, J)), $.uuid = (J) => $.check(b8(V4, J)), $.uuidv4 = (J) => $.check(P8(V4, J)), $.uuidv6 = (J) => $.check(Z8(V4, J)), $.uuidv7 = (J) => $.check(E8(V4, J)), $.nanoid = (J) => $.check(v8(AG, J)), $.guid = (J) => $.check(M0(xQ, J)), $.cuid = (J) => $.check(C8(bG, J)), $.cuid2 = (J) => $.check(k8(PG, J)), $.ulid = (J) => $.check(_8(ZG, J)), $.base64 = (J) => $.check(u8(_G, J)), $.base64url = (J) => $.check(m8(xG, J)), $.xid = (J) => $.check(x8(EG, J)), $.ksuid = (J) => $.check(T8(RG, J)), $.ipv4 = (J) => $.check(y8(SG, J)), $.ipv6 = (J) => $.check(g8(vG, J)), $.cidrv4 = (J) => $.check(f8(CG, J)), $.cidrv6 = (J) => $.check(h8(kG, J)), $.e164 = (J) => $.check(l8(TG, J)), $.datetime = (J) => $.check(KG(J)), $.date = (J) => $.check(NG(J)), $.time = (J) => $.check(VG(J)), $.duration = (J) => $.check(OG(J));
});
function F($) {
  return $Q(Q9, $);
}
var O$ = q("ZodStringFormat", ($, X) => {
  H$.init($, X), jG.init($, X);
});
var FG = q("ZodEmail", ($, X) => {
  QY.init($, X), O$.init($, X);
});
function B2($) {
  return A8(FG, $);
}
var xQ = q("ZodGUID", ($, X) => {
  JY.init($, X), O$.init($, X);
});
function q2($) {
  return M0(xQ, $);
}
var V4 = q("ZodUUID", ($, X) => {
  YY.init($, X), O$.init($, X);
});
function D2($) {
  return b8(V4, $);
}
function L2($) {
  return P8(V4, $);
}
function j2($) {
  return Z8(V4, $);
}
function F2($) {
  return E8(V4, $);
}
var IG = q("ZodURL", ($, X) => {
  zY.init($, X), O$.init($, X);
});
function I2($) {
  return R8(IG, $);
}
var MG = q("ZodEmoji", ($, X) => {
  WY.init($, X), O$.init($, X);
});
function M2($) {
  return S8(MG, $);
}
var AG = q("ZodNanoID", ($, X) => {
  GY.init($, X), O$.init($, X);
});
function A2($) {
  return v8(AG, $);
}
var bG = q("ZodCUID", ($, X) => {
  UY.init($, X), O$.init($, X);
});
function b2($) {
  return C8(bG, $);
}
var PG = q("ZodCUID2", ($, X) => {
  HY.init($, X), O$.init($, X);
});
function P2($) {
  return k8(PG, $);
}
var ZG = q("ZodULID", ($, X) => {
  KY.init($, X), O$.init($, X);
});
function Z2($) {
  return _8(ZG, $);
}
var EG = q("ZodXID", ($, X) => {
  NY.init($, X), O$.init($, X);
});
function E2($) {
  return x8(EG, $);
}
var RG = q("ZodKSUID", ($, X) => {
  VY.init($, X), O$.init($, X);
});
function R2($) {
  return T8(RG, $);
}
var SG = q("ZodIPv4", ($, X) => {
  OY.init($, X), O$.init($, X);
});
function S2($) {
  return y8(SG, $);
}
var vG = q("ZodIPv6", ($, X) => {
  wY.init($, X), O$.init($, X);
});
function v2($) {
  return g8(vG, $);
}
var CG = q("ZodCIDRv4", ($, X) => {
  BY.init($, X), O$.init($, X);
});
function C2($) {
  return f8(CG, $);
}
var kG = q("ZodCIDRv6", ($, X) => {
  qY.init($, X), O$.init($, X);
});
function k2($) {
  return h8(kG, $);
}
var _G = q("ZodBase64", ($, X) => {
  DY.init($, X), O$.init($, X);
});
function _2($) {
  return u8(_G, $);
}
var xG = q("ZodBase64URL", ($, X) => {
  LY.init($, X), O$.init($, X);
});
function x2($) {
  return m8(xG, $);
}
var TG = q("ZodE164", ($, X) => {
  jY.init($, X), O$.init($, X);
});
function T2($) {
  return l8(TG, $);
}
var yG = q("ZodJWT", ($, X) => {
  FY.init($, X), O$.init($, X);
});
function y2($) {
  return c8(yG, $);
}
var AN = q("ZodCustomStringFormat", ($, X) => {
  IY.init($, X), O$.init($, X);
});
function g2($, X, J = {}) {
  return bQ(AN, $, X, J);
}
var z9 = q("ZodNumber", ($, X) => {
  q8.init($, X), s.init($, X), $.gt = (Q, Y) => $.check(K4(Q, Y)), $.gte = (Q, Y) => $.check(e$(Q, Y)), $.min = (Q, Y) => $.check(e$(Q, Y)), $.lt = (Q, Y) => $.check(H4(Q, Y)), $.lte = (Q, Y) => $.check(L6(Q, Y)), $.max = (Q, Y) => $.check(L6(Q, Y)), $.int = (Q) => $.check(LG(Q)), $.safe = (Q) => $.check(LG(Q)), $.positive = (Q) => $.check(K4(0, Q)), $.nonnegative = (Q) => $.check(e$(0, Q)), $.negative = (Q) => $.check(H4(0, Q)), $.nonpositive = (Q) => $.check(L6(0, Q)), $.multipleOf = (Q, Y) => $.check(A1(Q, Y)), $.step = (Q, Y) => $.check(A1(Q, Y)), $.finite = () => $;
  let J = $._zod.bag;
  $.minValue = Math.max(J.minimum ?? Number.NEGATIVE_INFINITY, J.exclusiveMinimum ?? Number.NEGATIVE_INFINITY) ?? null, $.maxValue = Math.min(J.maximum ?? Number.POSITIVE_INFINITY, J.exclusiveMaximum ?? Number.POSITIVE_INFINITY) ?? null, $.isInt = (J.format ?? "").includes("int") || Number.isSafeInteger(J.multipleOf ?? 0.5), $.isFinite = true, $.format = J.format ?? null;
});
function G$($) {
  return JQ(z9, $);
}
var v0 = q("ZodNumberFormat", ($, X) => {
  MY.init($, X), z9.init($, X);
});
function LG($) {
  return YQ(v0, $);
}
function f2($) {
  return QQ(v0, $);
}
function h2($) {
  return zQ(v0, $);
}
function u2($) {
  return WQ(v0, $);
}
function m2($) {
  return GQ(v0, $);
}
var W9 = q("ZodBoolean", ($, X) => {
  D0.init($, X), s.init($, X);
});
function S$($) {
  return UQ(W9, $);
}
var G9 = q("ZodBigInt", ($, X) => {
  D8.init($, X), s.init($, X), $.gte = (Q, Y) => $.check(e$(Q, Y)), $.min = (Q, Y) => $.check(e$(Q, Y)), $.gt = (Q, Y) => $.check(K4(Q, Y)), $.gte = (Q, Y) => $.check(e$(Q, Y)), $.min = (Q, Y) => $.check(e$(Q, Y)), $.lt = (Q, Y) => $.check(H4(Q, Y)), $.lte = (Q, Y) => $.check(L6(Q, Y)), $.max = (Q, Y) => $.check(L6(Q, Y)), $.positive = (Q) => $.check(K4(BigInt(0), Q)), $.negative = (Q) => $.check(H4(BigInt(0), Q)), $.nonpositive = (Q) => $.check(L6(BigInt(0), Q)), $.nonnegative = (Q) => $.check(e$(BigInt(0), Q)), $.multipleOf = (Q, Y) => $.check(A1(Q, Y));
  let J = $._zod.bag;
  $.minValue = J.minimum ?? null, $.maxValue = J.maximum ?? null, $.format = J.format ?? null;
});
function l2($) {
  return HQ(G9, $);
}
var gG = q("ZodBigIntFormat", ($, X) => {
  AY.init($, X), G9.init($, X);
});
function c2($) {
  return KQ(gG, $);
}
function i2($) {
  return NQ(gG, $);
}
var bN = q("ZodSymbol", ($, X) => {
  bY.init($, X), s.init($, X);
});
function p2($) {
  return VQ(bN, $);
}
var PN = q("ZodUndefined", ($, X) => {
  PY.init($, X), s.init($, X);
});
function n2($) {
  return OQ(PN, $);
}
var ZN = q("ZodNull", ($, X) => {
  ZY.init($, X), s.init($, X);
});
function U9($) {
  return wQ(ZN, $);
}
var EN = q("ZodAny", ($, X) => {
  EY.init($, X), s.init($, X);
});
function d2() {
  return BQ(EN);
}
var RN = q("ZodUnknown", ($, X) => {
  I1.init($, X), s.init($, X);
});
function D$() {
  return M1(RN);
}
var SN = q("ZodNever", ($, X) => {
  RY.init($, X), s.init($, X);
});
function gQ($) {
  return qQ(SN, $);
}
var vN = q("ZodVoid", ($, X) => {
  SY.init($, X), s.init($, X);
});
function r2($) {
  return DQ(vN, $);
}
var fQ = q("ZodDate", ($, X) => {
  vY.init($, X), s.init($, X), $.min = (Q, Y) => $.check(e$(Q, Y)), $.max = (Q, Y) => $.check(L6(Q, Y));
  let J = $._zod.bag;
  $.minDate = J.minimum ? new Date(J.minimum) : null, $.maxDate = J.maximum ? new Date(J.maximum) : null;
});
function o2($) {
  return LQ(fQ, $);
}
var CN = q("ZodArray", ($, X) => {
  L0.init($, X), s.init($, X), $.element = X.element, $.min = (J, Q) => $.check(y4(J, Q)), $.nonempty = (J) => $.check(y4(1, J)), $.max = (J, Q) => $.check(b0(J, Q)), $.length = (J, Q) => $.check(P0(J, Q)), $.unwrap = () => $.element;
});
function $$($, X) {
  return J9(CN, $, X);
}
function t2($) {
  let X = $._zod.def.shape;
  return g(Object.keys(X));
}
var hQ = q("ZodObject", ($, X) => {
  L8.init($, X), s.init($, X), E.defineLazy($, "shape", () => X.shape), $.keyof = () => n$(Object.keys($._zod.def.shape)), $.catchall = (J) => $.clone({ ...$._zod.def, catchall: J }), $.passthrough = () => $.clone({ ...$._zod.def, catchall: D$() }), $.loose = () => $.clone({ ...$._zod.def, catchall: D$() }), $.strict = () => $.clone({ ...$._zod.def, catchall: gQ() }), $.strip = () => $.clone({ ...$._zod.def, catchall: void 0 }), $.extend = (J) => {
    return E.extend($, J);
  }, $.merge = (J) => E.merge($, J), $.pick = (J) => E.pick($, J), $.omit = (J) => E.omit($, J), $.partial = (...J) => E.partial(lG, $, J[0]), $.required = (...J) => E.required(cG, $, J[0]);
});
function _($, X) {
  let J = { type: "object", get shape() {
    return E.assignProp(this, "shape", { ...$ }), this.shape;
  }, ...E.normalizeParams(X) };
  return new hQ(J);
}
function a2($, X) {
  return new hQ({ type: "object", get shape() {
    return E.assignProp(this, "shape", { ...$ }), this.shape;
  }, catchall: gQ(), ...E.normalizeParams(X) });
}
function l$($, X) {
  return new hQ({ type: "object", get shape() {
    return E.assignProp(this, "shape", { ...$ }), this.shape;
  }, catchall: D$(), ...E.normalizeParams(X) });
}
var fG = q("ZodUnion", ($, X) => {
  j8.init($, X), s.init($, X), $.options = X.options;
});
function U$($, X) {
  return new fG({ type: "union", options: $, ...E.normalizeParams(X) });
}
var kN = q("ZodDiscriminatedUnion", ($, X) => {
  fG.init($, X), CY.init($, X);
});
function uQ($, X, J) {
  return new kN({ type: "union", options: X, discriminator: $, ...E.normalizeParams(J) });
}
var _N = q("ZodIntersection", ($, X) => {
  kY.init($, X), s.init($, X);
});
function H9($, X) {
  return new _N({ type: "intersection", left: $, right: X });
}
var xN = q("ZodTuple", ($, X) => {
  T4.init($, X), s.init($, X), $.rest = (J) => $.clone({ ...$._zod.def, rest: J });
});
function s2($, X, J) {
  let Q = X instanceof i, Y = Q ? J : X;
  return new xN({ type: "tuple", items: $, rest: Q ? X : null, ...E.normalizeParams(Y) });
}
var hG = q("ZodRecord", ($, X) => {
  _Y.init($, X), s.init($, X), $.keyType = X.keyType, $.valueType = X.valueType;
});
function w$($, X, J) {
  return new hG({ type: "record", keyType: $, valueType: X, ...E.normalizeParams(J) });
}
function e2($, X, J) {
  return new hG({ type: "record", keyType: U$([$, gQ()]), valueType: X, ...E.normalizeParams(J) });
}
var TN = q("ZodMap", ($, X) => {
  xY.init($, X), s.init($, X), $.keyType = X.keyType, $.valueType = X.valueType;
});
function $b($, X, J) {
  return new TN({ type: "map", keyType: $, valueType: X, ...E.normalizeParams(J) });
}
var yN = q("ZodSet", ($, X) => {
  TY.init($, X), s.init($, X), $.min = (...J) => $.check(b1(...J)), $.nonempty = (J) => $.check(b1(1, J)), $.max = (...J) => $.check(A0(...J)), $.size = (...J) => $.check(i8(...J));
});
function Xb($, X) {
  return new yN({ type: "set", valueType: $, ...E.normalizeParams(X) });
}
var Y9 = q("ZodEnum", ($, X) => {
  yY.init($, X), s.init($, X), $.enum = X.entries, $.options = Object.values(X.entries);
  let J = new Set(Object.keys(X.entries));
  $.extract = (Q, Y) => {
    let z = {};
    for (let W of Q) if (J.has(W)) z[W] = X.entries[W];
    else throw Error(`Key ${W} not found in enum`);
    return new Y9({ ...X, checks: [], ...E.normalizeParams(Y), entries: z });
  }, $.exclude = (Q, Y) => {
    let z = { ...X.entries };
    for (let W of Q) if (J.has(W)) delete z[W];
    else throw Error(`Key ${W} not found in enum`);
    return new Y9({ ...X, checks: [], ...E.normalizeParams(Y), entries: z });
  };
});
function n$($, X) {
  let J = Array.isArray($) ? Object.fromEntries($.map((Q) => [Q, Q])) : $;
  return new Y9({ type: "enum", entries: J, ...E.normalizeParams(X) });
}
function Jb($, X) {
  return new Y9({ type: "enum", entries: $, ...E.normalizeParams(X) });
}
var gN = q("ZodLiteral", ($, X) => {
  gY.init($, X), s.init($, X), $.values = new Set(X.values), Object.defineProperty($, "value", { get() {
    if (X.values.length > 1) throw Error("This schema contains multiple valid literal values. Use `.values` instead.");
    return X.values[0];
  } });
});
function g($, X) {
  return new gN({ type: "literal", values: Array.isArray($) ? $ : [$], ...E.normalizeParams(X) });
}
var fN = q("ZodFile", ($, X) => {
  fY.init($, X), s.init($, X), $.min = (J, Q) => $.check(b1(J, Q)), $.max = (J, Q) => $.check(A0(J, Q)), $.mime = (J, Q) => $.check(a8(Array.isArray(J) ? J : [J], Q));
});
function Yb($) {
  return FQ(fN, $);
}
var uG = q("ZodTransform", ($, X) => {
  j0.init($, X), s.init($, X), $._zod.parse = (J, Q) => {
    J.addIssue = (z) => {
      if (typeof z === "string") J.issues.push(E.issue(z, J.value, X));
      else {
        let W = z;
        if (W.fatal) W.continue = false;
        W.code ?? (W.code = "custom"), W.input ?? (W.input = J.value), W.inst ?? (W.inst = $), W.continue ?? (W.continue = true), J.issues.push(E.issue(W));
      }
    };
    let Y = X.transform(J.value, J);
    if (Y instanceof Promise) return Y.then((z) => {
      return J.value = z, J;
    });
    return J.value = Y, J;
  };
});
function mG($) {
  return new uG({ type: "transform", transform: $ });
}
var lG = q("ZodOptional", ($, X) => {
  hY.init($, X), s.init($, X), $.unwrap = () => $._zod.def.innerType;
});
function L$($) {
  return new lG({ type: "optional", innerType: $ });
}
var hN = q("ZodNullable", ($, X) => {
  uY.init($, X), s.init($, X), $.unwrap = () => $._zod.def.innerType;
});
function TQ($) {
  return new hN({ type: "nullable", innerType: $ });
}
function Qb($) {
  return L$(TQ($));
}
var uN = q("ZodDefault", ($, X) => {
  mY.init($, X), s.init($, X), $.unwrap = () => $._zod.def.innerType, $.removeDefault = $.unwrap;
});
function mN($, X) {
  return new uN({ type: "default", innerType: $, get defaultValue() {
    return typeof X === "function" ? X() : X;
  } });
}
var lN = q("ZodPrefault", ($, X) => {
  lY.init($, X), s.init($, X), $.unwrap = () => $._zod.def.innerType;
});
function cN($, X) {
  return new lN({ type: "prefault", innerType: $, get defaultValue() {
    return typeof X === "function" ? X() : X;
  } });
}
var cG = q("ZodNonOptional", ($, X) => {
  cY.init($, X), s.init($, X), $.unwrap = () => $._zod.def.innerType;
});
function iN($, X) {
  return new cG({ type: "nonoptional", innerType: $, ...E.normalizeParams(X) });
}
var pN = q("ZodSuccess", ($, X) => {
  iY.init($, X), s.init($, X), $.unwrap = () => $._zod.def.innerType;
});
function zb($) {
  return new pN({ type: "success", innerType: $ });
}
var nN = q("ZodCatch", ($, X) => {
  pY.init($, X), s.init($, X), $.unwrap = () => $._zod.def.innerType, $.removeCatch = $.unwrap;
});
function dN($, X) {
  return new nN({ type: "catch", innerType: $, catchValue: typeof X === "function" ? X : () => X });
}
var rN = q("ZodNaN", ($, X) => {
  nY.init($, X), s.init($, X);
});
function Wb($) {
  return jQ(rN, $);
}
var iG = q("ZodPipe", ($, X) => {
  F0.init($, X), s.init($, X), $.in = X.in, $.out = X.out;
});
function yQ($, X) {
  return new iG({ type: "pipe", in: $, out: X });
}
var oN = q("ZodReadonly", ($, X) => {
  dY.init($, X), s.init($, X);
});
function tN($) {
  return new oN({ type: "readonly", innerType: $ });
}
var aN = q("ZodTemplateLiteral", ($, X) => {
  rY.init($, X), s.init($, X);
});
function Gb($, X) {
  return new aN({ type: "template_literal", parts: $, ...E.normalizeParams(X) });
}
var sN = q("ZodLazy", ($, X) => {
  tY.init($, X), s.init($, X), $.unwrap = () => $._zod.def.getter();
});
function eN($) {
  return new sN({ type: "lazy", getter: $ });
}
var $V = q("ZodPromise", ($, X) => {
  oY.init($, X), s.init($, X), $.unwrap = () => $._zod.def.innerType;
});
function Ub($) {
  return new $V({ type: "promise", innerType: $ });
}
var mQ = q("ZodCustom", ($, X) => {
  aY.init($, X), s.init($, X);
});
function XV($, X) {
  let J = new I$({ check: "custom", ...E.normalizeParams(X) });
  return J._zod.check = $, J;
}
function pG($, X) {
  return IQ(mQ, $ ?? (() => true), X);
}
function JV($, X = {}) {
  return MQ(mQ, $, X);
}
function YV($, X) {
  let J = XV((Q) => {
    return Q.addIssue = (Y) => {
      if (typeof Y === "string") Q.issues.push(E.issue(Y, Q.value, J._zod.def));
      else {
        let z = Y;
        if (z.fatal) z.continue = false;
        z.code ?? (z.code = "custom"), z.input ?? (z.input = Q.value), z.inst ?? (z.inst = J), z.continue ?? (z.continue = !J._zod.def.abort), Q.issues.push(E.issue(z));
      }
    }, $(Q.value, Q);
  }, X);
  return J;
}
function Hb($, X = { error: `Input not instance of ${$.name}` }) {
  let J = new mQ({ type: "custom", check: "custom", fn: (Q) => Q instanceof $, abort: true, ...E.normalizeParams(X) });
  return J._zod.bag.Class = $, J;
}
var Kb = (...$) => AQ({ Pipe: iG, Boolean: W9, String: Q9, Transform: uG }, ...$);
function Nb($) {
  let X = eN(() => {
    return U$([F($), G$(), S$(), U9(), $$(X), w$(F(), X)]);
  });
  return X;
}
function lQ($, X) {
  return yQ(mG($), X);
}
var Vb = { invalid_type: "invalid_type", too_big: "too_big", too_small: "too_small", invalid_format: "invalid_format", not_multiple_of: "not_multiple_of", unrecognized_keys: "unrecognized_keys", invalid_union: "invalid_union", invalid_key: "invalid_key", invalid_element: "invalid_element", invalid_value: "invalid_value", custom: "custom" };
function Ob($) {
  E$({ customError: $ });
}
function wb() {
  return E$().customError;
}
var nG = {};
e4(nG, { string: () => Bb, number: () => qb, date: () => jb, boolean: () => Db, bigint: () => Lb });
function Bb($) {
  return dW(Q9, $);
}
function qb($) {
  return sW(z9, $);
}
function Db($) {
  return eW(W9, $);
}
function Lb($) {
  return $G(G9, $);
}
function jb($) {
  return XG(fQ, $);
}
E$(F8());
var u4 = "io.modelcontextprotocol/related-task";
var iQ = "2.0";
var y$ = pG(($) => $ !== null && (typeof $ === "object" || typeof $ === "function"));
var zV = U$([F(), G$().int()]);
var WV = F();
var bp = l$({ ttl: U$([G$(), U9()]).optional(), pollInterval: G$().optional() });
var Fb = _({ ttl: G$().optional() });
var Ib = _({ taskId: F() });
var rG = l$({ progressToken: zV.optional(), [u4]: Ib.optional() });
var N6 = _({ _meta: rG.optional() });
var K9 = N6.extend({ task: Fb.optional() });
var g$ = _({ method: F(), params: N6.loose().optional() });
var F6 = _({ _meta: rG.optional() });
var I6 = _({ method: F(), params: F6.loose().optional() });
var f$ = l$({ _meta: rG.optional() });
var pQ = U$([F(), G$().int()]);
var UV = _({ jsonrpc: g(iQ), id: pQ, ...g$.shape }).strict();
var HV = _({ jsonrpc: g(iQ), ...I6.shape }).strict();
var tG = _({ jsonrpc: g(iQ), id: pQ, result: f$ }).strict();
var m;
(function($) {
  $[$.ConnectionClosed = -32e3] = "ConnectionClosed", $[$.RequestTimeout = -32001] = "RequestTimeout", $[$.ParseError = -32700] = "ParseError", $[$.InvalidRequest = -32600] = "InvalidRequest", $[$.MethodNotFound = -32601] = "MethodNotFound", $[$.InvalidParams = -32602] = "InvalidParams", $[$.InternalError = -32603] = "InternalError", $[$.UrlElicitationRequired = -32042] = "UrlElicitationRequired";
})(m || (m = {}));
var aG = _({ jsonrpc: g(iQ), id: pQ.optional(), error: _({ code: G$().int(), message: F(), data: D$().optional() }) }).strict();
var Pp = U$([UV, HV, tG, aG]);
var Zp = U$([tG, aG]);
var nQ = f$.strict();
var Mb = F6.extend({ requestId: pQ.optional(), reason: F().optional() });
var dQ = I6.extend({ method: g("notifications/cancelled"), params: Mb });
var Ab = _({ src: F(), mimeType: F().optional(), sizes: $$(F()).optional(), theme: n$(["light", "dark"]).optional() });
var V9 = _({ icons: $$(Ab).optional() });
var C0 = _({ name: F(), title: F().optional() });
var VV = C0.extend({ ...C0.shape, ...V9.shape, version: F(), websiteUrl: F().optional(), description: F().optional() });
var bb = H9(_({ applyDefaults: S$().optional() }), w$(F(), D$()));
var Pb = lQ(($) => {
  if ($ && typeof $ === "object" && !Array.isArray($)) {
    if (Object.keys($).length === 0) return { form: {} };
  }
  return $;
}, H9(_({ form: bb.optional(), url: y$.optional() }), w$(F(), D$()).optional()));
var Zb = l$({ list: y$.optional(), cancel: y$.optional(), requests: l$({ sampling: l$({ createMessage: y$.optional() }).optional(), elicitation: l$({ create: y$.optional() }).optional() }).optional() });
var Eb = l$({ list: y$.optional(), cancel: y$.optional(), requests: l$({ tools: l$({ call: y$.optional() }).optional() }).optional() });
var Rb = _({ experimental: w$(F(), y$).optional(), sampling: _({ context: y$.optional(), tools: y$.optional() }).optional(), elicitation: Pb.optional(), roots: _({ listChanged: S$().optional() }).optional(), tasks: Zb.optional() });
var Sb = N6.extend({ protocolVersion: F(), capabilities: Rb, clientInfo: VV });
var sG = g$.extend({ method: g("initialize"), params: Sb });
var vb = _({ experimental: w$(F(), y$).optional(), logging: y$.optional(), completions: y$.optional(), prompts: _({ listChanged: S$().optional() }).optional(), resources: _({ subscribe: S$().optional(), listChanged: S$().optional() }).optional(), tools: _({ listChanged: S$().optional() }).optional(), tasks: Eb.optional() });
var Cb = f$.extend({ protocolVersion: F(), capabilities: vb, serverInfo: VV, instructions: F().optional() });
var eG = I6.extend({ method: g("notifications/initialized"), params: F6.optional() });
var rQ = g$.extend({ method: g("ping"), params: N6.optional() });
var kb = _({ progress: G$(), total: L$(G$()), message: L$(F()) });
var _b = _({ ...F6.shape, ...kb.shape, progressToken: zV });
var oQ = I6.extend({ method: g("notifications/progress"), params: _b });
var xb = N6.extend({ cursor: WV.optional() });
var O9 = g$.extend({ params: xb.optional() });
var w9 = f$.extend({ nextCursor: WV.optional() });
var Tb = n$(["working", "input_required", "completed", "failed", "cancelled"]);
var B9 = _({ taskId: F(), status: Tb, ttl: U$([G$(), U9()]), createdAt: F(), lastUpdatedAt: F(), pollInterval: L$(G$()), statusMessage: L$(F()) });
var k0 = f$.extend({ task: B9 });
var yb = F6.merge(B9);
var q9 = I6.extend({ method: g("notifications/tasks/status"), params: yb });
var tQ = g$.extend({ method: g("tasks/get"), params: N6.extend({ taskId: F() }) });
var aQ = f$.merge(B9);
var sQ = g$.extend({ method: g("tasks/result"), params: N6.extend({ taskId: F() }) });
var Ep = f$.loose();
var eQ = O9.extend({ method: g("tasks/list") });
var $7 = w9.extend({ tasks: $$(B9) });
var X7 = g$.extend({ method: g("tasks/cancel"), params: N6.extend({ taskId: F() }) });
var OV = f$.merge(B9);
var wV = _({ uri: F(), mimeType: L$(F()), _meta: w$(F(), D$()).optional() });
var BV = wV.extend({ text: F() });
var $3 = F().refine(($) => {
  try {
    return atob($), true;
  } catch {
    return false;
  }
}, { message: "Invalid Base64 string" });
var qV = wV.extend({ blob: $3 });
var D9 = n$(["user", "assistant"]);
var _0 = _({ audience: $$(D9).optional(), priority: G$().min(0).max(1).optional(), lastModified: R0.datetime({ offset: true }).optional() });
var DV = _({ ...C0.shape, ...V9.shape, uri: F(), description: L$(F()), mimeType: L$(F()), annotations: _0.optional(), _meta: L$(l$({})) });
var gb = _({ ...C0.shape, ...V9.shape, uriTemplate: F(), description: L$(F()), mimeType: L$(F()), annotations: _0.optional(), _meta: L$(l$({})) });
var J7 = O9.extend({ method: g("resources/list") });
var fb = w9.extend({ resources: $$(DV) });
var Y7 = O9.extend({ method: g("resources/templates/list") });
var hb = w9.extend({ resourceTemplates: $$(gb) });
var X3 = N6.extend({ uri: F() });
var ub = X3;
var Q7 = g$.extend({ method: g("resources/read"), params: ub });
var mb = f$.extend({ contents: $$(U$([BV, qV])) });
var lb = I6.extend({ method: g("notifications/resources/list_changed"), params: F6.optional() });
var cb = X3;
var ib = g$.extend({ method: g("resources/subscribe"), params: cb });
var pb = X3;
var nb = g$.extend({ method: g("resources/unsubscribe"), params: pb });
var db = F6.extend({ uri: F() });
var rb = I6.extend({ method: g("notifications/resources/updated"), params: db });
var ob = _({ name: F(), description: L$(F()), required: L$(S$()) });
var tb = _({ ...C0.shape, ...V9.shape, description: L$(F()), arguments: L$($$(ob)), _meta: L$(l$({})) });
var z7 = O9.extend({ method: g("prompts/list") });
var ab = w9.extend({ prompts: $$(tb) });
var sb = N6.extend({ name: F(), arguments: w$(F(), F()).optional() });
var W7 = g$.extend({ method: g("prompts/get"), params: sb });
var J3 = _({ type: g("text"), text: F(), annotations: _0.optional(), _meta: w$(F(), D$()).optional() });
var Y3 = _({ type: g("image"), data: $3, mimeType: F(), annotations: _0.optional(), _meta: w$(F(), D$()).optional() });
var Q3 = _({ type: g("audio"), data: $3, mimeType: F(), annotations: _0.optional(), _meta: w$(F(), D$()).optional() });
var eb = _({ type: g("tool_use"), name: F(), id: F(), input: w$(F(), D$()), _meta: w$(F(), D$()).optional() });
var $P = _({ type: g("resource"), resource: U$([BV, qV]), annotations: _0.optional(), _meta: w$(F(), D$()).optional() });
var XP = DV.extend({ type: g("resource_link") });
var z3 = U$([J3, Y3, Q3, XP, $P]);
var JP = _({ role: D9, content: z3 });
var YP = f$.extend({ description: F().optional(), messages: $$(JP) });
var QP = I6.extend({ method: g("notifications/prompts/list_changed"), params: F6.optional() });
var zP = _({ title: F().optional(), readOnlyHint: S$().optional(), destructiveHint: S$().optional(), idempotentHint: S$().optional(), openWorldHint: S$().optional() });
var WP = _({ taskSupport: n$(["required", "optional", "forbidden"]).optional() });
var LV = _({ ...C0.shape, ...V9.shape, description: F().optional(), inputSchema: _({ type: g("object"), properties: w$(F(), y$).optional(), required: $$(F()).optional() }).catchall(D$()), outputSchema: _({ type: g("object"), properties: w$(F(), y$).optional(), required: $$(F()).optional() }).catchall(D$()).optional(), annotations: zP.optional(), execution: WP.optional(), _meta: w$(F(), D$()).optional() });
var G7 = O9.extend({ method: g("tools/list") });
var GP = w9.extend({ tools: $$(LV) });
var U7 = f$.extend({ content: $$(z3).default([]), structuredContent: w$(F(), D$()).optional(), isError: S$().optional() });
var Rp = U7.or(f$.extend({ toolResult: D$() }));
var UP = K9.extend({ name: F(), arguments: w$(F(), D$()).optional() });
var x0 = g$.extend({ method: g("tools/call"), params: UP });
var HP = I6.extend({ method: g("notifications/tools/list_changed"), params: F6.optional() });
var Sp = _({ autoRefresh: S$().default(true), debounceMs: G$().int().nonnegative().default(300) });
var L9 = n$(["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"]);
var KP = N6.extend({ level: L9 });
var W3 = g$.extend({ method: g("logging/setLevel"), params: KP });
var NP = F6.extend({ level: L9, logger: F().optional(), data: D$() });
var VP = I6.extend({ method: g("notifications/message"), params: NP });
var OP = _({ name: F().optional() });
var wP = _({ hints: $$(OP).optional(), costPriority: G$().min(0).max(1).optional(), speedPriority: G$().min(0).max(1).optional(), intelligencePriority: G$().min(0).max(1).optional() });
var BP = _({ mode: n$(["auto", "required", "none"]).optional() });
var qP = _({ type: g("tool_result"), toolUseId: F().describe("The unique identifier for the corresponding tool call."), content: $$(z3).default([]), structuredContent: _({}).loose().optional(), isError: S$().optional(), _meta: w$(F(), D$()).optional() });
var DP = uQ("type", [J3, Y3, Q3]);
var cQ = uQ("type", [J3, Y3, Q3, eb, qP]);
var LP = _({ role: D9, content: U$([cQ, $$(cQ)]), _meta: w$(F(), D$()).optional() });
var jP = K9.extend({ messages: $$(LP), modelPreferences: wP.optional(), systemPrompt: F().optional(), includeContext: n$(["none", "thisServer", "allServers"]).optional(), temperature: G$().optional(), maxTokens: G$().int(), stopSequences: $$(F()).optional(), metadata: y$.optional(), tools: $$(LV).optional(), toolChoice: BP.optional() });
var FP = g$.extend({ method: g("sampling/createMessage"), params: jP });
var j9 = f$.extend({ model: F(), stopReason: L$(n$(["endTurn", "stopSequence", "maxTokens"]).or(F())), role: D9, content: DP });
var G3 = f$.extend({ model: F(), stopReason: L$(n$(["endTurn", "stopSequence", "maxTokens", "toolUse"]).or(F())), role: D9, content: U$([cQ, $$(cQ)]) });
var IP = _({ type: g("boolean"), title: F().optional(), description: F().optional(), default: S$().optional() });
var MP = _({ type: g("string"), title: F().optional(), description: F().optional(), minLength: G$().optional(), maxLength: G$().optional(), format: n$(["email", "uri", "date", "date-time"]).optional(), default: F().optional() });
var AP = _({ type: n$(["number", "integer"]), title: F().optional(), description: F().optional(), minimum: G$().optional(), maximum: G$().optional(), default: G$().optional() });
var bP = _({ type: g("string"), title: F().optional(), description: F().optional(), enum: $$(F()), default: F().optional() });
var PP = _({ type: g("string"), title: F().optional(), description: F().optional(), oneOf: $$(_({ const: F(), title: F() })), default: F().optional() });
var ZP = _({ type: g("string"), title: F().optional(), description: F().optional(), enum: $$(F()), enumNames: $$(F()).optional(), default: F().optional() });
var EP = U$([bP, PP]);
var RP = _({ type: g("array"), title: F().optional(), description: F().optional(), minItems: G$().optional(), maxItems: G$().optional(), items: _({ type: g("string"), enum: $$(F()) }), default: $$(F()).optional() });
var SP = _({ type: g("array"), title: F().optional(), description: F().optional(), minItems: G$().optional(), maxItems: G$().optional(), items: _({ anyOf: $$(_({ const: F(), title: F() })) }), default: $$(F()).optional() });
var vP = U$([RP, SP]);
var CP = U$([ZP, EP, vP]);
var kP = U$([CP, IP, MP, AP]);
var _P = K9.extend({ mode: g("form").optional(), message: F(), requestedSchema: _({ type: g("object"), properties: w$(F(), kP), required: $$(F()).optional() }) });
var xP = K9.extend({ mode: g("url"), message: F(), elicitationId: F(), url: F().url() });
var TP = U$([_P, xP]);
var yP = g$.extend({ method: g("elicitation/create"), params: TP });
var gP = F6.extend({ elicitationId: F() });
var fP = I6.extend({ method: g("notifications/elicitation/complete"), params: gP });
var T0 = f$.extend({ action: n$(["accept", "decline", "cancel"]), content: lQ(($) => $ === null ? void 0 : $, w$(F(), U$([F(), G$(), S$(), $$(F())])).optional()) });
var hP = _({ type: g("ref/resource"), uri: F() });
var uP = _({ type: g("ref/prompt"), name: F() });
var mP = N6.extend({ ref: U$([uP, hP]), argument: _({ name: F(), value: F() }), context: _({ arguments: w$(F(), F()).optional() }).optional() });
var H7 = g$.extend({ method: g("completion/complete"), params: mP });
var lP = f$.extend({ completion: l$({ values: $$(F()).max(100), total: L$(G$().int()), hasMore: L$(S$()) }) });
var cP = _({ uri: F().startsWith("file://"), name: F().optional(), _meta: w$(F(), D$()).optional() });
var iP = g$.extend({ method: g("roots/list"), params: N6.optional() });
var U3 = f$.extend({ roots: $$(cP) });
var pP = I6.extend({ method: g("notifications/roots/list_changed"), params: F6.optional() });
var vp = U$([rQ, sG, H7, W3, W7, z7, J7, Y7, Q7, ib, nb, x0, G7, tQ, sQ, eQ, X7]);
var Cp = U$([dQ, oQ, eG, pP, q9]);
var kp = U$([nQ, j9, G3, T0, U3, aQ, $7, k0]);
var _p = U$([rQ, FP, yP, iP, tQ, sQ, eQ, X7]);
var xp = U$([dQ, oQ, VP, rb, lb, HP, QP, q9, fP]);
var Tp = U$([nQ, Cb, lP, YP, ab, fb, hb, mb, U7, GP, aQ, $7, k0]);
var rP = new Set("ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvxyz0123456789");
var fD = xU(KU(), 1);
var hD = xU(gD(), 1);
var lD;
(function($) {
  $.Completable = "McpCompletable";
})(lD || (lD = {}));
function rD($) {
  let X;
  return () => X ??= $();
}
var jx = rD(() => h4.object({ session_id: h4.string(), ws_url: h4.string(), work_dir: h4.string().optional(), session_key: h4.string().optional() }));
function ba($) {
  return gz($);
}
function Pa($, X) {
  return PK($, X);
}

// src/session-manager.ts
var DEFAULT_CONVERSATION = "default";
var SessionManager = class {
  conversations = /* @__PURE__ */ new Map();
  workspaceDir;
  sessionsDir;
  maxSessions;
  defaultContextWindow;
  defaultModel;
  buildOptions;
  idleTimeoutMs;
  idleTimer = null;
  constructor(opts) {
    this.workspaceDir = opts.workspaceDir;
    this.sessionsDir = path2.join(opts.workspaceDir, ".sessions");
    this.maxSessions = opts.maxSessions ?? 5;
    this.defaultContextWindow = opts.defaultContextWindow;
    this.defaultModel = opts.defaultModel;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 10 * 60 * 1e3;
    this.buildOptions = opts.buildOptions;
    this.idleTimer = setInterval(() => this.evictIdle(), 6e4);
  }
  // ─── Get or Create ──────────────────────────────────
  /**
   * Get or create a conversation context for the given ID.
   * Creates a new V2 session or resumes from disk.
   */
  getOrCreate(conversationId, assistantName, mode, model) {
    const id = conversationId || DEFAULT_CONVERSATION;
    const effectiveMode = mode || "agent";
    const effectiveModel = model || this.defaultModel;
    const existing = this.conversations.get(id);
    if (existing) {
      if (existing.mode !== effectiveMode || existing.model !== effectiveModel) {
        log(`[session-mgr] Mode/model changed for ${id} (${existing.mode}/${existing.model} \u2192 ${effectiveMode}/${effectiveModel}), recreating session`);
        try {
          existing.session.close();
        } catch {
        }
        this.conversations.delete(id);
      } else {
        existing.lastUsed = Date.now();
        return existing;
      }
    }
    if (this.conversations.size >= this.maxSessions) {
      this.evictOldest();
    }
    const persisted = this.readPersistedSession(id);
    const loopTracker = new ToolCallTracker();
    const contextTracker = new ContextWindowTracker();
    contextTracker.contextWindow = this.defaultContextWindow;
    const options = this.buildOptions(loopTracker, contextTracker, assistantName, effectiveMode, effectiveModel);
    const modeModelChanged = existing !== void 0;
    let session;
    if (persisted && !modeModelChanged) {
      try {
        log(`[session-mgr] Resuming session for ${id}: ${persisted.sessionId}`);
        session = Pa(persisted.sessionId, options);
      } catch (err) {
        log(`[session-mgr] Resume failed for ${id}, creating fresh: ${err}`);
        this.deletePersistedSession(id);
        session = ba(options);
      }
    } else {
      log(`[session-mgr] Creating new session for ${id} (mode=${effectiveMode}, model=${effectiveModel})`);
      session = ba(options);
    }
    const ctx = {
      session,
      sessionId: persisted?.sessionId ?? "",
      loopTracker,
      contextTracker,
      lastUsed: Date.now(),
      mode: effectiveMode,
      model: effectiveModel,
      lockPromise: Promise.resolve(),
      lockRelease: null
    };
    this.conversations.set(id, ctx);
    return ctx;
  }
  // ─── Per-Conversation Lock ──────────────────────────
  /**
   * Acquire the message lock for a conversation.
   * Returns a release function that MUST be called when done.
   */
  async acquireLock(conversationId) {
    const id = conversationId || DEFAULT_CONVERSATION;
    const ctx = this.conversations.get(id);
    if (!ctx) throw new Error(`No conversation context for ${id}`);
    await ctx.lockPromise;
    let release;
    ctx.lockPromise = new Promise((resolve) => {
      release = () => {
        ctx.lockRelease = null;
        resolve();
      };
    });
    ctx.lockRelease = release;
    return release;
  }
  // ─── Session ID Persistence ─────────────────────────
  /**
   * Persist the session ID for a conversation after session init.
   * Called when we get session_id from the SDK's system/init message.
   */
  persistSessionId(conversationId, sessionId) {
    const id = conversationId || DEFAULT_CONVERSATION;
    const ctx = this.conversations.get(id);
    if (ctx) ctx.sessionId = sessionId;
    const data = {
      sessionId,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      lastMessageAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    try {
      fs2.mkdirSync(this.sessionsDir, { recursive: true });
      fs2.writeFileSync(
        path2.join(this.sessionsDir, `${id}.json`),
        JSON.stringify(data, null, 2)
      );
    } catch {
    }
  }
  /**
   * Update lastMessageAt timestamp for a conversation.
   */
  touchSession(conversationId) {
    const id = conversationId || DEFAULT_CONVERSATION;
    const filePath = path2.join(this.sessionsDir, `${id}.json`);
    try {
      if (!fs2.existsSync(filePath)) return;
      const data = JSON.parse(fs2.readFileSync(filePath, "utf-8"));
      data.lastMessageAt = (/* @__PURE__ */ new Date()).toISOString();
      fs2.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch {
    }
  }
  // ─── LRU Eviction ──────────────────────────────────
  evictOldest() {
    let oldestId = null;
    let oldestTime = Infinity;
    for (const [id, ctx] of this.conversations) {
      if (ctx.lockRelease !== null) continue;
      if (ctx.lastUsed < oldestTime) {
        oldestTime = ctx.lastUsed;
        oldestId = id;
      }
    }
    if (oldestId) {
      this.closeConversation(oldestId);
      log(`[session-mgr] Evicted conversation ${oldestId} (LRU)`);
    } else {
      log(`[session-mgr] WARNING: Cannot evict \u2014 all ${this.conversations.size} sessions are locked`);
    }
  }
  /** Close sessions that have been idle longer than idleTimeoutMs. */
  evictIdle() {
    const now = Date.now();
    for (const [id, ctx] of this.conversations) {
      if (ctx.lockRelease !== null) continue;
      if (now - ctx.lastUsed > this.idleTimeoutMs) {
        this.closeConversation(id);
        log(`[session-mgr] Evicted idle conversation ${id} (idle ${Math.round((now - ctx.lastUsed) / 6e4)}min)`);
      }
    }
  }
  // ─── Cleanup ────────────────────────────────────────
  /**
   * Close a specific conversation's session (frees subprocess memory).
   * The session can be resumed later from disk.
   */
  closeConversation(conversationId) {
    const ctx = this.conversations.get(conversationId);
    if (!ctx) return;
    try {
      ctx.session.close();
    } catch {
    }
    this.conversations.delete(conversationId);
  }
  /**
   * Close all sessions. Called on SIGTERM before exit.
   */
  closeAll() {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    for (const [id, ctx] of this.conversations) {
      try {
        ctx.session.close();
      } catch {
      }
      log(`[session-mgr] Closed session for ${id}`);
    }
    this.conversations.clear();
  }
  /**
   * Handle session error — close and remove so next message creates fresh.
   */
  handleError(conversationId) {
    const id = conversationId || DEFAULT_CONVERSATION;
    const ctx = this.conversations.get(id);
    if (!ctx) return;
    try {
      ctx.session.close();
    } catch {
    }
    this.conversations.delete(id);
    log(`[session-mgr] Session closed due to error for ${id}`);
  }
  // ─── Migration ──────────────────────────────────────
  /**
   * Migrate old single-session file to multi-session format.
   * Called once on first use.
   */
  migrateFromLegacy() {
    const legacyFile = path2.join(this.workspaceDir, ".current-session-id");
    try {
      if (!fs2.existsSync(legacyFile)) return;
      if (fs2.existsSync(this.sessionsDir)) return;
      const sessionId = fs2.readFileSync(legacyFile, "utf-8").trim();
      if (!sessionId) return;
      log(`[session-mgr] Migrating legacy session ${sessionId} \u2192 .sessions/default.json`);
      this.persistSessionId(DEFAULT_CONVERSATION, sessionId);
      fs2.unlinkSync(legacyFile);
    } catch {
      log(`[session-mgr] Legacy migration failed (non-fatal)`);
    }
  }
  // ─── Internal ───────────────────────────────────────
  readPersistedSession(conversationId) {
    try {
      const filePath = path2.join(this.sessionsDir, `${conversationId}.json`);
      if (!fs2.existsSync(filePath)) return null;
      return JSON.parse(fs2.readFileSync(filePath, "utf-8"));
    } catch {
      return null;
    }
  }
  deletePersistedSession(conversationId) {
    try {
      const filePath = path2.join(this.sessionsDir, `${conversationId}.json`);
      if (fs2.existsSync(filePath)) fs2.unlinkSync(filePath);
    } catch {
    }
  }
  // ─── Stats ──────────────────────────────────────────
  get activeCount() {
    return this.conversations.size;
  }
  getConversationIds() {
    return Array.from(this.conversations.keys());
  }
};
function log(message) {
  console.error(message);
}

// src/agent.ts
var WORKSPACE_DIR = process.env.CLAW_WORKSPACE_DIR || "/home/sprite/workspace";
var MCP_CONFIG_FILE = path3.join(WORKSPACE_DIR, ".mcp.json");
var MODEL = process.env.CLAW_MODEL || "claude-opus-4-6";
function log2(message) {
  console.error(`[claw] ${message}`);
}
var BILLING_MARKUP = 3;
function estimateCostUsd(inputTokens, outputTokens, model, cacheReadTokens = 0, cacheCreationTokens = 0) {
  const m3 = (model || MODEL).toLowerCase();
  let inputRate;
  let outputRate;
  if (m3.includes("haiku")) {
    inputRate = 1;
    outputRate = 5;
  } else if (m3.includes("sonnet")) {
    inputRate = 3;
    outputRate = 15;
  } else if (m3.includes("opus")) {
    inputRate = 5;
    outputRate = 25;
  } else {
    inputRate = 3;
    outputRate = 15;
  }
  const uncachedInput = Math.max(0, inputTokens - cacheReadTokens - cacheCreationTokens);
  const providerCost = (uncachedInput * inputRate + cacheReadTokens * inputRate * 0.1 + cacheCreationTokens * inputRate * 1.25 + outputTokens * outputRate) / 1e6;
  return providerCost * BILLING_MARKUP;
}
function getDefaultContextWindow(model) {
  const m3 = model.toLowerCase();
  if (m3.includes("opus-4-6") || m3.includes("opus-4.6") || m3.includes("sonnet-4-6") || m3.includes("sonnet-4.6")) return 1e6;
  if (m3.includes("claude") || m3.startsWith("anthropic/")) return 2e5;
  if (m3.includes("gpt-5")) return 256e3;
  if (m3.includes("gpt-4")) return 128e3;
  if (m3.includes("gemini-3") || m3.includes("gemini-2.5")) return 1e6;
  if (m3.includes("deepseek")) return 128e3;
  return 128e3;
}
function loadMcpConfig() {
  try {
    if (!fs3.existsSync(MCP_CONFIG_FILE)) return { toolPatterns: [] };
    const config = JSON.parse(fs3.readFileSync(MCP_CONFIG_FILE, "utf-8"));
    const servers = config.mcpServers || {};
    const names = Object.keys(servers);
    if (names.length > 0) {
      log2(`[mcp] Found ${names.length} customer MCP servers: ${names.join(", ")}`);
      for (const name of names) {
        const s3 = servers[name];
        log2(`[mcp]   ${name}: type=${s3.type ?? "stdio"}, ${s3.url ? `url=${s3.url}` : `cmd=${s3.command}`}`);
      }
    }
    return {
      toolPatterns: names.map((name) => `mcp__${name}__*`)
    };
  } catch (err) {
    log2(`[mcp] Failed to read ${MCP_CONFIG_FILE}: ${err instanceof Error ? err.message : err}`);
    return { toolPatterns: [] };
  }
}
var activityPoster = null;
var activeCancelRef = { current: null };
var sessionManager = new SessionManager({
  workspaceDir: WORKSPACE_DIR,
  maxSessions: 5,
  defaultContextWindow: getDefaultContextWindow(MODEL),
  defaultModel: MODEL,
  buildOptions: (loopTracker, contextTracker, assistantName, mode, model) => {
    const __dirname = path3.dirname(fileURLToPath(import.meta.url));
    const mcp = loadMcpConfig();
    return {
      model: model || MODEL,
      // Use cli-wrapper.js which injects --mcp-config from .mcp.json.
      // V2 sessions hardcode settingSources=[] and mcpServers={}, so the real
      // cli.js never loads project MCP config. The wrapper fixes this.
      pathToClaudeCodeExecutable: path3.join(__dirname, "cli-wrapper.js"),
      env: { ...process.env },
      allowedTools: [
        "Bash",
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep",
        "WebSearch",
        "WebFetch",
        "Task",
        "TaskOutput",
        "TaskStop",
        "NotebookEdit",
        ...mcp.toolPatterns
      ],
      permissionMode: mode === "plan" ? "plan" : "acceptEdits",
      // Capture CLI subprocess stderr — SDK defaults to "ignore" which swallows all MCP errors
      stderr: (data) => {
        const line = data.trim();
        if (line) log2(`[sdk-stderr] ${line}`);
      },
      includePartialMessages: true,
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook(WORKSPACE_DIR, assistantName, log2)] }],
        PreToolUse: [
          // Cancel check — abort before starting tool execution if user cancelled
          { hooks: [async () => {
            if (activeCancelRef.current?.cancelled) {
              return { decision: "block", reason: "Cancelled by user" };
            }
            return {};
          }] },
          { matcher: "Bash", hooks: [createSanitizeBashHook()] },
          { hooks: [createLoopDetectionHook(loopTracker, log2)] },
          { hooks: [createContextSafetyHook(contextTracker, activityPoster, log2, WORKSPACE_DIR)] }
        ]
      }
    };
  }
});
sessionManager.migrateFromLegacy();
function ensureActivityPoster(agentId) {
  if (!activityPoster) {
    activityPoster = new ActivityPoster(
      process.env.GALLERY_CONVEX_URL || null,
      process.env.GALLERY_GATEWAY_TOKEN || process.env.GALLERY_TOKEN || null,
      agentId
    );
    log2("[activity] Gallery activity posting enabled");
  }
  return activityPoster;
}
async function processMessage(params, writer, cancelSignal) {
  const conversationId = params.sessionId || "default";
  const ctx = sessionManager.getOrCreate(conversationId, params.assistantName, params.mode, params.model);
  const releaseLock = await sessionManager.acquireLock(conversationId);
  try {
    return await processMessageInner(params, writer, cancelSignal, ctx);
  } finally {
    activeCancelRef.current = null;
    releaseLock();
  }
}
async function processMessageInner(params, writer, cancelSignal, ctx) {
  const { message, isScheduledTask, assistantName } = params;
  const conversationId = params.sessionId || "default";
  const agentId = process.env.AGENT_ID || assistantName || "unknown";
  ensureActivityPoster(agentId);
  activityPoster.post("status", "Processing message");
  activeCancelRef.current = cancelSignal ?? null;
  const tz2 = process.env.AGENT_TIMEZONE || "UTC";
  const localTime = (/* @__PURE__ */ new Date()).toLocaleString("en-US", {
    timeZone: tz2,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  });
  if (message.length > 5e5) {
    throw new Error("Message too large (max 500KB)");
  }
  let workspaceState = "";
  const convexUrl = process.env.GALLERY_CONVEX_URL;
  const gwToken = process.env.GALLERY_GATEWAY_TOKEN;
  if (convexUrl && gwToken) {
    try {
      const [tasksRes, agentsRes, reviewsRes] = await Promise.allSettled([
        fetch(`${convexUrl}/api/query`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: "mcpInternal:listTasks", args: { token: gwToken } }),
          signal: AbortSignal.timeout(5e3)
        }).then((r3) => r3.ok ? r3.json() : null),
        fetch(`${convexUrl}/api/query`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: "mcpInternal:listAgents", args: { token: gwToken } }),
          signal: AbortSignal.timeout(5e3)
        }).then((r3) => r3.ok ? r3.json() : null),
        fetch(`${convexUrl}/api/query`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: "mcpInternal:listReviews", args: { token: gwToken, status: "pending" } }),
          signal: AbortSignal.timeout(5e3)
        }).then((r3) => r3.ok ? r3.json() : null)
      ]);
      const tasks = tasksRes.status === "fulfilled" ? tasksRes.value?.value ?? tasksRes.value ?? [] : [];
      const agents = agentsRes.status === "fulfilled" ? agentsRes.value?.value ?? agentsRes.value ?? [] : [];
      const reviews = reviewsRes.status === "fulfilled" ? reviewsRes.value?.value ?? reviewsRes.value ?? [] : [];
      if (Array.isArray(tasks) || Array.isArray(agents) || Array.isArray(reviews)) {
        const parts = [];
        if (Array.isArray(agents) && agents.length > 0) {
          const active = agents.filter((a3) => a3.status === "active");
          const unhealthy = agents.filter((a3) => (a3.healthFailures ?? 0) > 2);
          parts.push(`Agents: ${active.length} active${unhealthy.length > 0 ? `, ${unhealthy.length} UNHEALTHY (${unhealthy.map((a3) => a3.name).join(", ")})` : ""}`);
        }
        if (Array.isArray(tasks) && tasks.length > 0) {
          const inProgress = tasks.filter((t) => t.status === "in_progress").length;
          const blocked = tasks.filter((t) => t.status === "blocked" || t.status === "in_review").length;
          parts.push(`Tasks: ${tasks.length} total, ${inProgress} in progress${blocked > 0 ? `, ${blocked} blocked/in-review` : ""}`);
        }
        if (Array.isArray(reviews) && reviews.length > 0) {
          parts.push(`Pending reviews: ${reviews.length}`);
        }
        if (parts.length > 0) {
          workspaceState = `<workspace-state>
${parts.join("\n")}
</workspace-state>

`;
        }
      }
    } catch {
    }
  }
  let prompt = `<context timezone="${tz2}" localTime="${localTime}" />

${workspaceState}`;
  if (isScheduledTask) {
    prompt += `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user.]

`;
  }
  prompt += message;
  let currentSessionId = ctx?.sessionId || "";
  const resultTexts = [];
  let messageCount = 0;
  let streamEventCount = 0;
  let usageInfo;
  let lastEmittedToolOutput = false;
  const maxTurns = params.maxTurns ?? 200;
  const maxBudgetUsd = params.maxBudgetUsd ?? 10;
  let turnCount = 0;
  let accumulatedCostUsd = 0;
  let limitHit = false;
  if (writer) {
    await writer.start(generateMessageId());
    await writer.startStep();
  }
  try {
    if (!ctx) throw new Error("No conversation context");
    const sess = ctx.session;
    sessionManager.touchSession(conversationId);
    await sess.send(prompt);
    for await (const msg of sess.stream()) {
      if (cancelSignal?.cancelled) {
        log2("[cancel] Stream cancelled by user");
        if (writer) {
          await writer.abort("User cancelled");
          writer.done();
        }
        break;
      }
      messageCount++;
      const msgType = msg.type === "system" ? `system/${msg.subtype}` : msg.type;
      if (msgType !== "stream_event") log2(`[msg #${messageCount}] type=${msgType}`);
      if (msg.type === "stream_event") {
        streamEventCount++;
        const event = msg.event;
        if (event?.type === "content_block_delta") {
          const delta = event.delta;
          if (delta?.type === "text_delta" && delta.text && writer) {
            if (lastEmittedToolOutput) {
              await writer.emitStepBoundary();
              lastEmittedToolOutput = false;
            }
            await writer.textDelta(delta.text);
          } else if (delta?.type === "thinking_delta" && delta.thinking && writer) {
            if (lastEmittedToolOutput) {
              await writer.emitStepBoundary();
              lastEmittedToolOutput = false;
            }
            await writer.reasoningDelta(delta.thinking);
          }
        } else if (event?.type === "content_block_start") {
          const block = event.content_block;
          if (block?.type === "tool_use" && writer) {
            await writer.closeOpenBlocks();
            await writer.toolInputStart(block.id, block.name);
          }
        } else if (event?.type === "content_block_stop" && writer) {
          await writer.closeOpenBlocks();
        }
        continue;
      }
      if (msg.type === "assistant") {
        const msgUsage = msg.message?.usage;
        if (msgUsage && ctx) {
          ctx.contextTracker.update(
            msgUsage.input_tokens ?? 0,
            msgUsage.output_tokens ?? 0,
            void 0,
            msgUsage.cache_read_input_tokens ?? 0,
            msgUsage.cache_creation_input_tokens ?? 0
          );
          writeContextUsage(WORKSPACE_DIR, ctx.contextTracker);
        }
        const hadStreamEvents = streamEventCount > 0;
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              activityPoster.post("output", block.text);
              if (!hadStreamEvents && writer) {
                await writer.textStart();
                await writer.textDelta(block.text);
                await writer.textEnd();
              }
            } else if (block.type === "tool_use") {
              activityPoster.post("tool_use", `${block.name}(${JSON.stringify(block.input).slice(0, 200)})`);
              if (writer) {
                await writer.toolInputAvailable(block.id, block.name, block.input);
              }
            } else if (block.type === "tool_result") {
              const rawContent = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
              const injections = scanForInjection(rawContent);
              if (injections.length > 0) {
                activityPoster.post("error", `\u26A0 Prompt injection detected in tool output: ${injections.join(", ")}`);
                log2?.(`WARNING: Prompt injection patterns detected in tool result: ${injections.join(", ")}`);
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
            } else if (block.type === "thinking" && block.thinking) {
              activityPoster.post("thinking", block.thinking.slice(0, 500));
              if (!hadStreamEvents && writer) {
                await writer.reasoningStart();
                await writer.reasoningDelta(block.thinking);
                await writer.reasoningEnd();
              }
            }
          }
          const hasToolUse = content.some((b) => b.type === "tool_use");
          if (hasToolUse) turnCount++;
          if (msgUsage) {
            accumulatedCostUsd += estimateCostUsd(
              msgUsage.input_tokens ?? 0,
              msgUsage.output_tokens ?? 0,
              MODEL,
              msgUsage.cache_read_input_tokens ?? 0,
              msgUsage.cache_creation_input_tokens ?? 0
            );
          }
          if (turnCount >= maxTurns) {
            log2(`[limits] Turn limit hit: ${turnCount}/${maxTurns}`);
            if (writer) {
              await writer.finish("max_turns");
              writer.done();
            }
            limitHit = true;
            break;
          }
          if (accumulatedCostUsd >= maxBudgetUsd) {
            log2(`[limits] Budget limit hit: $${accumulatedCostUsd.toFixed(4)} >= $${maxBudgetUsd}`);
            if (writer) {
              await writer.finish("budget_exceeded");
              writer.done();
            }
            limitHit = true;
            break;
          }
          streamEventCount = 0;
        }
      }
      if (msg.type === "system" && msg.subtype === "init") {
        currentSessionId = msg.session_id;
        log2(`Session initialized: ${currentSessionId} (conversation: ${conversationId})`);
        const initKeys = Object.keys(msg).filter((k6) => k6 !== "type" && k6 !== "subtype");
        log2(`[init] keys: ${initKeys.join(", ")}`);
        const mcpServers = msg.mcp_servers;
        if (mcpServers && Array.isArray(mcpServers)) {
          if (mcpServers.length > 0) {
            const mcpStatus = mcpServers.map((s3) => `${s3.name}:${s3.status}`).join(", ");
            log2(`[mcp] Server status: ${mcpStatus}`);
          } else {
            log2(`[mcp] WARNING: mcp_servers array is empty \u2014 no MCP servers connected`);
          }
        } else {
          log2(`[mcp] WARNING: no mcp_servers field in init message (mcpServers=${typeof mcpServers})`);
        }
        const tools = msg.tools;
        if (tools && Array.isArray(tools)) {
          const mcpTools = tools.filter((t) => typeof t === "string" && t.startsWith("mcp__"));
          const builtinTools = tools.filter((t) => typeof t === "string" && !t.startsWith("mcp__"));
          log2(`[init] tools: ${builtinTools.length} built-in, ${mcpTools.length} MCP ${mcpTools.length > 0 ? `(${mcpTools.slice(0, 5).join(", ")}${mcpTools.length > 5 ? "..." : ""})` : ""}`);
        }
        activityPoster.post("status", `Session initialized: ${currentSessionId}`);
        sessionManager.persistSessionId(conversationId, currentSessionId);
      }
      if (msg.type === "system" && msg.subtype === "task_notification") {
        const tn = msg;
        log2(`Task notification: task=${tn.task_id} status=${tn.status}`);
        activityPoster.post("status", `Task ${tn.status}: ${tn.summary}`);
      }
      if (msg.type === "result") {
        const textResult = "result" in msg ? msg.result : null;
        log2(`Result #${resultTexts.length + 1}: ${textResult ? textResult.slice(0, 200) : "(no text)"}`);
        activityPoster.post("output", textResult ? textResult.slice(0, 500) : "Query completed");
        if (textResult) resultTexts.push(textResult);
        const resultMsg = msg;
        if (resultMsg.usage || resultMsg.modelUsage) {
          const modelEntries = resultMsg.modelUsage ? Object.values(resultMsg.modelUsage) : [];
          const contextWindow = modelEntries[0]?.contextWindow ?? (ctx?.contextTracker.contextWindow ?? 2e5);
          if (contextWindow > 0 && ctx) ctx.contextTracker.contextWindow = contextWindow;
          const inputTokens = resultMsg.usage?.input_tokens ?? 0;
          const outputTokens = resultMsg.usage?.output_tokens ?? 0;
          const contextPercentage = contextWindow > 0 ? Math.round((inputTokens + outputTokens) / contextWindow * 100) : 0;
          usageInfo = {
            inputTokens,
            outputTokens,
            cacheReadTokens: resultMsg.usage?.cache_read_input_tokens ?? 0,
            cacheCreationTokens: resultMsg.usage?.cache_creation_input_tokens ?? 0,
            totalCostUsd: resultMsg.total_cost_usd ?? 0,
            numTurns: resultMsg.num_turns ?? 0,
            durationMs: resultMsg.duration_ms ?? 0,
            contextWindow,
            contextPercentage
          };
          log2(`[usage] ${inputTokens} in / ${outputTokens} out | context: ${contextPercentage}% of ${contextWindow}`);
          activityPoster.post("status", `Context: ${contextPercentage}% used (${inputTokens} in / ${outputTokens} out)`, { usage: usageInfo });
          if (writer) {
            await writer.messageMetadata({
              usage: { promptTokens: inputTokens, completionTokens: outputTokens, cacheReadTokens: usageInfo.cacheReadTokens, cacheCreationTokens: usageInfo.cacheCreationTokens },
              cost: { usd: usageInfo.totalCostUsd },
              model: MODEL,
              sessionId: currentSessionId
            });
          }
        }
        if (writer) {
          await writer.finish("stop");
          writer.done();
        }
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const isCreditError = /CREDITS_EXHAUSTED|Credit limit reached|NO_BILLING_PROFILE|Payment Required/i.test(errorMessage);
    if (isCreditError) {
      log2("Credit limit reached \u2014 stopping agent");
      activityPoster.post("error", "Credit limit reached. Add more credits in billing settings.");
      if (writer) {
        await writer.error("Credit limit reached. Add more credits in billing settings.");
        writer.done();
      }
      sessionManager.handleError(conversationId);
      return {
        status: "error",
        result: null,
        sessionId: currentSessionId,
        error: "CREDITS_EXHAUSTED"
      };
    }
    log2(`Agent error: ${errorMessage}`);
    activityPoster.post("error", errorMessage);
    if (writer) {
      await writer.error(errorMessage);
      writer.done();
    }
    sessionManager.handleError(conversationId);
    return {
      status: "error",
      result: null,
      sessionId: currentSessionId,
      error: errorMessage
    };
  }
  if (!currentSessionId && ctx?.session) {
    try {
      currentSessionId = ctx.session.sessionId;
      sessionManager.persistSessionId(conversationId, currentSessionId);
    } catch {
    }
  }
  const resultText = resultTexts.length > 0 ? resultTexts.join("\n\n") : null;
  const statusMsg = limitHit ? `Query stopped (limit hit after ${turnCount} turns, $${accumulatedCostUsd.toFixed(4)})` : `Query done. Messages: ${messageCount}, results: ${resultTexts.length}`;
  log2(`${statusMsg}, sessionId: ${currentSessionId}`);
  activityPoster.post("status", limitHit ? statusMsg : "Message processed");
  if (resultText && process.env.CLAW_AUTO_MEMORY !== "false") {
    extractMemory(message, resultText).catch((err) => {
      log2(`Memory extraction failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    });
  }
  return {
    status: limitHit ? "error" : "success",
    result: resultText,
    sessionId: currentSessionId,
    error: limitHit ? turnCount >= maxTurns ? "max_turns" : "budget_exceeded" : void 0,
    usage: usageInfo ?? (limitHit ? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: accumulatedCostUsd,
      numTurns: turnCount,
      durationMs: 0,
      contextWindow: ctx?.contextTracker.contextWindow ?? 2e5,
      contextPercentage: 0
    } : void 0)
  };
}
var memoryWriteLock = Promise.resolve();
async function extractMemory(userMessage, assistantResult) {
  const prev = memoryWriteLock;
  let release;
  memoryWriteLock = new Promise((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    await extractMemoryInner(userMessage, assistantResult);
  } finally {
    release();
  }
}
async function extractMemoryInner(userMessage, assistantResult) {
  const memoryFile = path3.join(WORKSPACE_DIR, "MEMORY.md");
  const existing = fs3.existsSync(memoryFile) ? fs3.readFileSync(memoryFile, "utf-8") : "";
  if (userMessage.length < 20 && assistantResult.length < 100) return;
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!baseUrl || !apiKey) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15e3);
  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "x-gallery-agent-id": process.env.AGENT_ID || ""
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 800,
        messages: [{
          role: "user",
          content: `Extract information worth remembering from this conversation. Be selective \u2014 only extract genuinely useful facts, not routine exchanges.

EXISTING MEMORY (do NOT repeat what's already here):
${existing.slice(0, 2e3)}

CONVERSATION:
User: ${userMessage.slice(0, 3e3)}
Assistant: ${assistantResult.slice(0, 3e3)}

Extract into these categories (skip empty categories, skip if nothing new):

**User preferences/habits:** Communication style, working hours, tool preferences, aesthetic preferences, things they dislike
**Decisions made:** What was decided, why, any tradeoffs noted
**Key facts:** Important project details, agent configurations, codebase facts, user context
**Things that didn't work:** Only persistent architectural limitations or wrong approaches \u2014 NOT transient errors like timeouts, connection failures, rate limits, or MCP disconnects. Those are temporary and must not be recorded.

Respond ONLY with bullet points under category headers, or "NONE" if nothing worth remembering.
No timestamps. No headers beyond the category names. Just bullet points.`
        }]
      })
    });
    if (!response.ok) {
      log2(`[memory] API returned ${response.status}`);
      return;
    }
    const data = await response.json();
    const text = data.content?.[0]?.type === "text" ? data.content[0].text?.trim() : "";
    if (!text || text === "NONE" || text.length < 5) return;
    const filtered = filterTransientErrors(text);
    if (!filtered || filtered.length < 5) {
      log2("[memory] All extracted facts were transient errors \u2014 skipping MEMORY.md write");
      return;
    }
    const date = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
    const header = `## Auto-extracted (${date})`;
    if (existing.includes(header)) {
      fs3.appendFileSync(memoryFile, `
${filtered}
`);
    } else {
      fs3.appendFileSync(memoryFile, `

${header}
${filtered}
`);
    }
    log2(`[memory] Extracted ${filtered.split("\n").length} facts to MEMORY.md`);
  } catch (err) {
    log2(`[memory] Extraction failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeout);
  }
}
async function shutdown() {
  sessionManager.closeAll();
  if (activityPoster) {
    activityPoster.post("status", "Sprite shutting down");
    await activityPoster.stop();
  }
}
function getActivityMetrics() {
  return {
    activityQueueSize: activityPoster?.getQueueSize() ?? 0,
    activityDropped: activityPoster?.getDroppedCount() ?? 0
  };
}
function getStatus() {
  const memoryFiles = [];
  const memoryDir = path3.join(WORKSPACE_DIR, "memory");
  if (fs3.existsSync(path3.join(WORKSPACE_DIR, "MEMORY.md"))) {
    memoryFiles.push("MEMORY.md");
  }
  if (fs3.existsSync(memoryDir)) {
    try {
      const files = fs3.readdirSync(memoryDir).filter((f) => !f.startsWith("."));
      memoryFiles.push(...files.map((f) => `memory/${f}`));
    } catch {
    }
  }
  return {
    workspaceDir: WORKSPACE_DIR,
    memoryFiles,
    uptime: process.uptime(),
    activeConversations: sessionManager.activeCount,
    conversationIds: sessionManager.getConversationIds()
  };
}

// src/server.ts
var PORT = parseInt(process.env.PORT || "8080", 10);
var MAX_QUEUE_SIZE = parseInt(process.env.CLAW_MAX_QUEUE_SIZE || "50", 10);
var REQUEST_TIMEOUT_MS = parseInt(process.env.CLAW_REQUEST_TIMEOUT_MS || "1800000", 10);
var AUTH_TOKEN = process.env.CLAW_AUTH_TOKEN || process.env.GALLERY_GATEWAY_TOKEN || "";
var activeStreams = /* @__PURE__ */ new Map();
function log3(message) {
  console.error(`[claw-server] ${message}`);
}
if (!AUTH_TOKEN) {
  log3("WARNING: No CLAW_AUTH_TOKEN or GALLERY_GATEWAY_TOKEN set \u2014 all requests will be accepted without auth");
}
function requireAuth(req, res) {
  if (!AUTH_TOKEN) return true;
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    sendJson(res, 401, { error: "Missing Authorization header" });
    return false;
  }
  const token = authHeader.slice(7);
  if (token !== AUTH_TOKEN) {
    log3(`Auth failed: invalid token from ${req.socket.remoteAddress}`);
    sendJson(res, 401, { error: "Invalid token" });
    return false;
  }
  return true;
}
var processing = false;
var requestQueue = [];
async function enqueueMessage(params) {
  if (requestQueue.length >= MAX_QUEUE_SIZE) {
    throw new Error("QUEUE_FULL");
  }
  return new Promise((resolve, reject) => {
    requestQueue.push({ params, resolve, reject });
    processQueue();
  });
}
async function processQueue() {
  if (processing || requestQueue.length === 0) return;
  processing = true;
  const first = requestQueue.shift();
  const items = [first];
  const isTask = first.params.isScheduledTask;
  const sessionId = first.params.sessionId;
  while (requestQueue.length > 0 && requestQueue[0].params.isScheduledTask === isTask && requestQueue[0].params.sessionId === sessionId) {
    items.push(requestQueue.shift());
  }
  let params;
  if (items.length === 1) {
    params = items[0].params;
  } else {
    const combined = items.map(
      (item, i3) => `[Message ${i3 + 1}]: ${item.params.message}`
    ).join("\n\n");
    params = {
      message: combined,
      sessionId: first.params.sessionId,
      isScheduledTask: isTask,
      assistantName: first.params.assistantName
    };
    log3(`Batched ${items.length} queued ${isTask ? "tasks" : "messages"} into single prompt`);
  }
  let timer;
  try {
    const timeoutPromise = new Promise((_3, rej) => {
      timer = setTimeout(() => rej(new Error("REQUEST_TIMEOUT")), REQUEST_TIMEOUT_MS);
    });
    const result = await Promise.race([processMessage(params), timeoutPromise]);
    for (const item of items) {
      item.resolve(result);
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    for (const item of items) {
      item.reject(error);
    }
  } finally {
    if (timer) clearTimeout(timer);
    processing = false;
    if (requestQueue.length > 0) {
      processQueue();
    }
  }
}
var MAX_BODY_BYTES = 1024 * 1024;
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("BODY_TOO_LARGE"));
        return;
      }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}
var version = true ? "1.0.0" : "dev";
var buildTime = true ? "2026-04-06T02:56:42.082Z" : "";
var ready = false;
setTimeout(() => {
  ready = true;
}, 1e4);
function markReady() {
  ready = true;
}
function errorStatus(msg) {
  if (msg === "QUEUE_FULL") return 503;
  if (msg === "REQUEST_TIMEOUT") return 504;
  if (msg === "BODY_TOO_LARGE") return 413;
  return 500;
}
async function handleMessage(req, res) {
  const body = await readBody(req);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON" });
    return;
  }
  if (!parsed.message || typeof parsed.message !== "string") {
    sendJson(res, 400, { error: "Missing required field: message (string)" });
    return;
  }
  const params = {
    message: parsed.message,
    sessionId: parsed.sessionId,
    isScheduledTask: false,
    assistantName: parsed.assistantName,
    maxTurns: typeof parsed.maxTurns === "number" ? parsed.maxTurns : void 0,
    maxBudgetUsd: typeof parsed.maxBudgetUsd === "number" ? parsed.maxBudgetUsd : void 0,
    mode: parsed.mode === "plan" ? "plan" : void 0,
    model: typeof parsed.model === "string" ? parsed.model : void 0
  };
  const wantSSE = (req.headers["accept"] || "").includes("text/event-stream");
  log3(`POST /message (${params.message.length} chars, queue: ${requestQueue.length}, sse: ${wantSSE})`);
  if (wantSSE) {
    const writer = new UIStreamWriter(res);
    const streamId = generateStreamId();
    const streamState = { cancelled: false };
    activeStreams.set(streamId, streamState);
    await writer.galleryStreamId(streamId);
    try {
      const result = await processMessage(params, writer, streamState);
      markReady();
      if (!writer.isEnded && !res.destroyed) {
        await writer.finish("stop");
        writer.done();
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log3(`Error processing message (AI SDK): ${errMsg}`);
      if (!writer.isEnded && !res.destroyed) {
        await writer.error(errMsg);
        writer.done();
      }
    } finally {
      activeStreams.delete(streamId);
    }
  } else {
    try {
      const result = await enqueueMessage(params);
      markReady();
      sendJson(res, 200, result);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log3(`Error processing message: ${errMsg}`);
      sendJson(res, errorStatus(errMsg), {
        status: "error",
        result: null,
        sessionId: "",
        error: errMsg
      });
    }
  }
}
function handleCancel(req, res) {
  const url = req.url || "";
  const match = url.match(/^\/message\/(stream_[a-f0-9]+)$/);
  if (!match) {
    sendJson(res, 400, { error: "Invalid stream ID format" });
    return;
  }
  const streamId = match[1];
  const stream = activeStreams.get(streamId);
  if (!stream) {
    sendJson(res, 404, { error: "Stream not found or already completed" });
    return;
  }
  stream.cancelled = true;
  activeStreams.delete(streamId);
  log3(`Stream ${streamId} cancelled`);
  res.writeHead(204);
  res.end();
}
async function handleTask(req, res) {
  const body = await readBody(req);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON" });
    return;
  }
  if (!parsed.message || typeof parsed.message !== "string") {
    sendJson(res, 400, { error: "Missing required field: message (string)" });
    return;
  }
  const params = {
    message: parsed.message,
    sessionId: parsed.sessionId,
    isScheduledTask: true,
    assistantName: parsed.assistantName
  };
  log3(`POST /task (${params.message.length} chars, queue: ${requestQueue.length})`);
  const fireAndForget = req.headers["x-fire-and-forget"] === "true";
  if (fireAndForget) {
    if (requestQueue.length >= MAX_QUEUE_SIZE) {
      sendJson(res, 503, { error: "Queue full", queueLength: requestQueue.length });
      return;
    }
    enqueueMessage(params).catch((err) => {
      log3(`Task error (fire-and-forget): ${err instanceof Error ? err.message : String(err)}`);
    });
    sendJson(res, 202, { status: "accepted", queueLength: requestQueue.length + 1 });
    return;
  }
  try {
    const result = await enqueueMessage(params);
    sendJson(res, 200, result);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log3(`Error processing task: ${errMsg}`);
    sendJson(res, errorStatus(errMsg), {
      status: "error",
      result: null,
      sessionId: "",
      error: errMsg
    });
  }
}
function handleHealth(_req, res) {
  sendJson(res, 200, {
    status: "ok",
    version,
    buildTime,
    uptime: process.uptime(),
    ready,
    queueLength: requestQueue.length,
    maxQueueSize: MAX_QUEUE_SIZE,
    processing,
    ...getActivityMetrics()
  });
}
function handleReady(_req, res) {
  if (ready) {
    sendJson(res, 200, { status: "ready" });
  } else {
    sendJson(res, 503, { status: "not_ready" });
  }
}
function handleStatus(_req, res) {
  const status = getStatus();
  sendJson(res, 200, {
    ...status,
    version,
    queueLength: requestQueue.length,
    processing
  });
}
var WORKSPACE_DIR2 = process.env.CLAW_WORKSPACE_DIR || "/home/sprite/workspace";
try {
  const fs4 = await import("fs");
  fs4.mkdirSync(WORKSPACE_DIR2, { recursive: true });
  process.chdir(WORKSPACE_DIR2);
  log3(`Working directory set to ${WORKSPACE_DIR2}`);
} catch (err) {
  log3(`Warning: Could not chdir to ${WORKSPACE_DIR2}: ${err instanceof Error ? err.message : String(err)}`);
}
var server = http.createServer(async (req, res) => {
  const method = req.method || "GET";
  const url = req.url || "/";
  try {
    if (method === "POST" && url === "/message") {
      if (!requireAuth(req, res)) return;
      await handleMessage(req, res);
    } else if (method === "DELETE" && url.startsWith("/message/")) {
      if (!requireAuth(req, res)) return;
      handleCancel(req, res);
    } else if (method === "POST" && url === "/task") {
      if (!requireAuth(req, res)) return;
      await handleTask(req, res);
    } else if (method === "GET" && url === "/health") {
      if (!requireAuth(req, res)) return;
      handleHealth(req, res);
    } else if (method === "GET" && url === "/ready") {
      handleReady(req, res);
    } else if (method === "GET" && url === "/status") {
      if (!requireAuth(req, res)) return;
      handleStatus(req, res);
    } else {
      sendJson(res, 404, { error: "Not found" });
    }
  } catch (err) {
    log3(`Unhandled error: ${err instanceof Error ? err.message : String(err)}`);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "Internal server error" });
    }
  }
});
server.listen(PORT, "0.0.0.0", () => {
  log3(`Claw agent service running on 0.0.0.0:${PORT}`);
});
process.on("SIGTERM", async () => {
  log3("SIGTERM received, shutting down...");
  server.close();
  await shutdown();
  process.exit(0);
});
