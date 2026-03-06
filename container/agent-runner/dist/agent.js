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
// ─── Configuration ──────────────────────────────────────
const WORKSPACE_DIR = process.env.CLAW_WORKSPACE_DIR || '/home/sprite/workspace';
const SESSION_ID_FILE = path.join(WORKSPACE_DIR, '.current-session-id');
const RESUME_AT_FILE = path.join(WORKSPACE_DIR, '.resume-at');
function log(message) {
    console.error(`[claw] ${message}`);
}
// ─── Session Management ──────────────────────────────────
function getPersistedSessionId() {
    try {
        if (fs.existsSync(SESSION_ID_FILE)) {
            return fs.readFileSync(SESSION_ID_FILE, 'utf-8').trim() || undefined;
        }
    }
    catch { /* ignore */ }
    return undefined;
}
function persistSessionId(sessionId) {
    try {
        fs.mkdirSync(path.dirname(SESSION_ID_FILE), { recursive: true });
        fs.writeFileSync(SESSION_ID_FILE, sessionId);
    }
    catch { /* non-fatal */ }
}
function getPersistedResumeAt() {
    try {
        if (fs.existsSync(RESUME_AT_FILE)) {
            return fs.readFileSync(RESUME_AT_FILE, 'utf-8').trim() || undefined;
        }
    }
    catch { /* ignore */ }
    return undefined;
}
function persistResumeAt(resumeAt) {
    try {
        fs.writeFileSync(RESUME_AT_FILE, resumeAt);
    }
    catch { /* non-fatal */ }
}
function getSessionSummary(sessionId, transcriptPath) {
    const projectDir = path.dirname(transcriptPath);
    const indexPath = path.join(projectDir, 'sessions-index.json');
    if (!fs.existsSync(indexPath))
        return null;
    try {
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        const entry = index.entries.find(e => e.sessionId === sessionId);
        if (entry?.summary)
            return entry.summary;
    }
    catch { /* ignore */ }
    return null;
}
function parseTranscript(content) {
    const messages = [];
    for (const line of content.split('\n')) {
        if (!line.trim())
            continue;
        try {
            const entry = JSON.parse(line);
            if (entry.type === 'user' && entry.message?.content) {
                const text = typeof entry.message.content === 'string'
                    ? entry.message.content
                    : entry.message.content.map((c) => c.text || '').join('');
                if (text)
                    messages.push({ role: 'user', content: text });
            }
            else if (entry.type === 'assistant' && entry.message?.content) {
                const textParts = entry.message.content
                    .filter((c) => c.type === 'text')
                    .map((c) => c.text);
                const text = textParts.join('');
                if (text)
                    messages.push({ role: 'assistant', content: text });
            }
        }
        catch { /* skip unparseable lines */ }
    }
    return messages;
}
function sanitizeFilename(summary) {
    return summary
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50);
}
function generateFallbackName() {
    const time = new Date();
    return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}
function formatTranscriptMarkdown(messages, title, assistantName) {
    const now = new Date();
    const formatDateTime = (d) => d.toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true
    });
    const lines = [];
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
// ─── Hooks ──────────────────────────────────────────────
/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName) {
    return async (input, _toolUseId, _context) => {
        const preCompact = input;
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
            const conversationsDir = path.join(WORKSPACE_DIR, 'conversations');
            fs.mkdirSync(conversationsDir, { recursive: true });
            const date = new Date().toISOString().split('T')[0];
            const filename = `${date}-${name}.md`;
            const filePath = path.join(conversationsDir, filename);
            const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
            fs.writeFileSync(filePath, markdown);
            log(`Archived conversation to ${filePath}`);
            // Write compaction marker to daily memory log
            const memoryDir = path.join(WORKSPACE_DIR, 'memory');
            fs.mkdirSync(memoryDir, { recursive: true });
            const dailyFile = path.join(memoryDir, `${date}.md`);
            const timestamp = new Date().toISOString().split('T')[1].replace(/\.\d+Z$/, '');
            const marker = `\n## Context compacted at ${timestamp}\n\nConversation archived to \`conversations/${filename}\`${summary ? `\nSummary: ${summary}` : ''}\n`;
            fs.appendFileSync(dailyFile, marker);
            log(`Wrote compaction marker to memory/${date}.md`);
        }
        catch (err) {
            log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
        }
        return {};
    };
}
const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];
function createSanitizeBashHook() {
    return async (input, _toolUseId, _context) => {
        const preInput = input;
        const command = preInput.tool_input?.command;
        if (!command)
            return {};
        const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
        return {
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                updatedInput: {
                    ...preInput.tool_input,
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
class ToolCallTracker {
    history = [];
    warningIssued = false;
    hashInput(input) {
        const str = JSON.stringify(input);
        let hash = 5381;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
        }
        return (hash >>> 0).toString(36);
    }
    track(toolName, toolInput) {
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
        return { loopDetected: false, shouldStop: false };
    }
    countConsecutiveSame() {
        if (this.history.length === 0)
            return 0;
        const last = this.history[this.history.length - 1];
        let count = 0;
        for (let i = this.history.length - 1; i >= 0; i--) {
            if (this.history[i].toolName === last.toolName && this.history[i].inputHash === last.inputHash) {
                count++;
            }
            else {
                break;
            }
        }
        return count;
    }
    detectCycle(cycleLength) {
        if (this.history.length < cycleLength * 2)
            return 0;
        const recent = this.history.slice(-cycleLength);
        let repetitions = 1;
        for (let offset = cycleLength; offset <= this.history.length - cycleLength; offset += cycleLength) {
            const segment = this.history.slice(-(offset + cycleLength), -offset);
            if (segment.length !== cycleLength)
                break;
            const matches = segment.every((rec, i) => rec.toolName === recent[i].toolName && rec.inputHash === recent[i].inputHash);
            if (matches)
                repetitions++;
            else
                break;
        }
        return repetitions;
    }
    resetWarning() { this.warningIssued = false; }
    hasIssuedWarning() { return this.warningIssued; }
    markWarningIssued() { this.warningIssued = true; }
}
function createLoopDetectionHook(tracker) {
    return async (input, _toolUseId, _context) => {
        const preInput = input;
        const toolName = preInput.tool_name || 'unknown';
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
class ActivityPoster {
    convexUrl;
    token;
    agentId;
    queue = [];
    timer = null;
    constructor(agentId) {
        this.convexUrl = process.env.GALLERY_CONVEX_URL || null;
        this.token = process.env.GALLERY_GATEWAY_TOKEN || null;
        this.agentId = agentId;
        if (this.convexUrl && this.token) {
            this.timer = setInterval(() => this.flush(), 2000);
            log('[activity] Gallery activity posting enabled');
        }
    }
    post(type, content, metadata) {
        if (!this.convexUrl || !this.token)
            return;
        this.queue.push({ type, content: content.slice(0, 4000), metadata });
    }
    async flush() {
        if (this.queue.length === 0 || !this.convexUrl || !this.token)
            return;
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
            }
            catch {
                // non-fatal — dashboard activity is best-effort
            }
        }
    }
    async stop() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
        while (this.queue.length > 0) {
            await this.flush();
        }
    }
}
// Persistent state across requests (sprite stays alive between requests)
// On sleep/wake, the process restarts — read from disk to survive hibernation
let activityPoster = null;
let lastResumeAt = getPersistedResumeAt();
export async function processMessage(params) {
    const { message, isScheduledTask, assistantName } = params;
    // Use provided sessionId, or fall back to persisted one
    let sessionId = params.sessionId || getPersistedSessionId();
    // Initialize activity poster on first call
    const agentId = process.env.AGENT_ID || assistantName || 'unknown';
    if (!activityPoster) {
        activityPoster = new ActivityPoster(agentId);
    }
    activityPoster.post('status', 'Processing message');
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    // Try bundled file first, fall back to tsc output
    const mcpBundlePath = path.join(__dirname, 'mcp-tools.bundle.js');
    const mcpTscPath = path.join(__dirname, 'mcp-tools.js');
    const mcpToolsPath = fs.existsSync(mcpBundlePath) ? mcpBundlePath : mcpTscPath;
    // Ensure workspace exists
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    // Build prompt
    let prompt = message;
    if (isScheduledTask) {
        prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user.]\n\n${prompt}`;
    }
    // Build SDK env from process.env
    const sdkEnv = { ...process.env };
    const loopTracker = new ToolCallTracker();
    let newSessionId;
    let lastAssistantUuid;
    const resultTexts = [];
    let messageCount = 0;
    try {
        for await (const msg of query({
            prompt,
            options: {
                cwd: WORKSPACE_DIR,
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
                        },
                    },
                    ...(process.env.GALLERY_MCP_URL && process.env.GALLERY_TOKEN ? {
                        gallery: {
                            type: 'http',
                            url: process.env.GALLERY_MCP_URL,
                            headers: { Authorization: `Bearer ${process.env.GALLERY_TOKEN}` },
                        },
                    } : {}),
                },
                hooks: {
                    PreCompact: [{ hooks: [createPreCompactHook(assistantName)] }],
                    PreToolUse: [
                        { matcher: 'Bash', hooks: [createSanitizeBashHook()] },
                        { hooks: [createLoopDetectionHook(loopTracker)] },
                    ],
                },
            }
        })) {
            messageCount++;
            const msgType = msg.type === 'system' ? `system/${msg.subtype}` : msg.type;
            log(`[msg #${messageCount}] type=${msgType}`);
            if (msg.type === 'assistant' && 'uuid' in msg) {
                lastAssistantUuid = msg.uuid;
                const content = msg.message?.content;
                if (Array.isArray(content)) {
                    for (const block of content) {
                        if (block.type === 'text' && block.text) {
                            activityPoster.post('output', block.text);
                        }
                        else if (block.type === 'tool_use') {
                            activityPoster.post('tool_use', `${block.name}(${JSON.stringify(block.input).slice(0, 200)})`);
                        }
                        else if (block.type === 'thinking' && block.thinking) {
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
            if (msg.type === 'system' && msg.subtype === 'task_notification') {
                const tn = msg;
                log(`Task notification: task=${tn.task_id} status=${tn.status}`);
                activityPoster.post('status', `Task ${tn.status}: ${tn.summary}`);
            }
            if (msg.type === 'result') {
                const textResult = 'result' in msg ? msg.result : null;
                log(`Result #${resultTexts.length + 1}: ${textResult ? textResult.slice(0, 200) : '(no text)'}`);
                activityPoster.post('output', textResult ? textResult.slice(0, 500) : 'Query completed');
                if (textResult)
                    resultTexts.push(textResult);
            }
        }
    }
    catch (err) {
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
    // Update resume point for next request (persist to survive sleep/wake)
    if (lastAssistantUuid) {
        lastResumeAt = lastAssistantUuid;
        persistResumeAt(lastAssistantUuid);
    }
    const finalSessionId = newSessionId || sessionId || '';
    const resultText = resultTexts.length > 0 ? resultTexts.join('\n\n') : null;
    log(`Query done. Messages: ${messageCount}, results: ${resultTexts.length}, sessionId: ${finalSessionId}`);
    activityPoster.post('status', 'Message processed');
    return {
        status: 'success',
        result: resultText,
        sessionId: finalSessionId,
    };
}
/**
 * Flush pending activity events. Call on SIGTERM before exit.
 */
export async function shutdown() {
    if (activityPoster) {
        activityPoster.post('status', 'Sprite shutting down');
        await activityPoster.stop();
    }
}
/**
 * Get current agent status.
 */
export function getStatus() {
    const sessionId = getPersistedSessionId();
    const memoryFiles = [];
    const memoryDir = path.join(WORKSPACE_DIR, 'memory');
    if (fs.existsSync(path.join(WORKSPACE_DIR, 'MEMORY.md'))) {
        memoryFiles.push('MEMORY.md');
    }
    if (fs.existsSync(memoryDir)) {
        try {
            const files = fs.readdirSync(memoryDir).filter(f => !f.startsWith('.'));
            memoryFiles.push(...files.map(f => `memory/${f}`));
        }
        catch { /* ignore */ }
    }
    return {
        sessionId,
        workspaceDir: WORKSPACE_DIR,
        memoryFiles,
        uptime: process.uptime(),
    };
}
