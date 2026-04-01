/**
 * SessionManager — Multi-conversation session management for Claw agents.
 *
 * Maps conversationId → V2 SDK session with per-conversation state:
 * - SDKSession (subprocess)
 * - messageLock (serialize send/stream per conversation)
 * - loopTracker (per-conversation loop detection)
 * - contextTracker (per-conversation token tracking)
 *
 * Idle sessions are closed to free memory (~50-80MB per subprocess).
 * Closed sessions resume from disk (SDK persists JSONL) on next message.
 *
 * Session files stored at: /mnt/r2/workspace/.sessions/{conversationId}.json
 */

import fs from 'fs';
import path from 'path';
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
} from '@anthropic-ai/claude-agent-sdk';
import type { SDKSession, SDKSessionOptions } from '@anthropic-ai/claude-agent-sdk';
import { ToolCallTracker, ContextWindowTracker } from './shared.js';

// ─── Types ──────────────────────────────────────────────

export interface ConversationContext {
  session: SDKSession;
  sessionId: string;
  loopTracker: ToolCallTracker;
  contextTracker: ContextWindowTracker;
  lastUsed: number;
  mode: 'agent' | 'plan';
  model: string;
  /** Per-conversation message lock — serialize send/stream cycles. */
  lockPromise: Promise<void>;
  lockRelease: (() => void) | null;
}

interface PersistedSession {
  sessionId: string;
  createdAt: string;
  lastMessageAt: string;
}

// ─── SessionManager ─────────────────────────────────────

const DEFAULT_CONVERSATION = 'default';

export class SessionManager {
  private conversations = new Map<string, ConversationContext>();
  private workspaceDir: string;
  private sessionsDir: string;
  private maxSessions: number;
  private defaultContextWindow: number;
  private defaultModel: string;
  private buildOptions: (loopTracker: ToolCallTracker, contextTracker: ContextWindowTracker, assistantName?: string, mode?: 'agent' | 'plan', model?: string) => SDKSessionOptions;

  private idleTimeoutMs: number;
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: {
    workspaceDir: string;
    maxSessions?: number;
    defaultContextWindow: number;
    defaultModel: string;
    idleTimeoutMs?: number;
    buildOptions: (loopTracker: ToolCallTracker, contextTracker: ContextWindowTracker, assistantName?: string, mode?: 'agent' | 'plan', model?: string) => SDKSessionOptions;
  }) {
    this.workspaceDir = opts.workspaceDir;
    this.sessionsDir = path.join(opts.workspaceDir, '.sessions');
    this.maxSessions = opts.maxSessions ?? 5;
    this.defaultContextWindow = opts.defaultContextWindow;
    this.defaultModel = opts.defaultModel;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 10 * 60 * 1000; // 10 minutes default
    this.buildOptions = opts.buildOptions;

    // Periodically close idle sessions to free memory (~50-80MB each)
    this.idleTimer = setInterval(() => this.evictIdle(), 60_000);
  }

  // ─── Get or Create ──────────────────────────────────

  /**
   * Get or create a conversation context for the given ID.
   * Creates a new V2 session or resumes from disk.
   */
  getOrCreate(conversationId?: string, assistantName?: string, mode?: 'agent' | 'plan', model?: string): ConversationContext {
    const id = conversationId || DEFAULT_CONVERSATION;
    const effectiveMode = mode || 'agent';
    const effectiveModel = model || this.defaultModel;

    // Return existing active context — but check for mode/model changes
    const existing = this.conversations.get(id);
    if (existing) {
      if (existing.mode !== effectiveMode || existing.model !== effectiveModel) {
        // Mode or model changed — close old session, create new one
        log(`[session-mgr] Mode/model changed for ${id} (${existing.mode}/${existing.model} → ${effectiveMode}/${effectiveModel}), recreating session`);
        try { existing.session.close(); } catch { /* ignore */ }
        this.conversations.delete(id);
        // Fall through to create new session
      } else {
        existing.lastUsed = Date.now();
        return existing;
      }
    }

    // Evict if at capacity
    if (this.conversations.size >= this.maxSessions) {
      this.evictOldest();
    }

    // Try to resume from persisted session ID
    const persisted = this.readPersistedSession(id);
    const loopTracker = new ToolCallTracker();
    const contextTracker = new ContextWindowTracker();
    contextTracker.contextWindow = this.defaultContextWindow;
    const options = this.buildOptions(loopTracker, contextTracker, assistantName, effectiveMode, effectiveModel);

    const modeModelChanged = existing !== undefined; // if existing was set, we deleted it above due to change
    let session: SDKSession;
    if (persisted && !modeModelChanged) {
      // Resume from disk — but not if we just closed due to mode/model change
      try {
        log(`[session-mgr] Resuming session for ${id}: ${persisted.sessionId}`);
        session = unstable_v2_resumeSession(persisted.sessionId, options);
      } catch (err) {
        log(`[session-mgr] Resume failed for ${id}, creating fresh: ${err}`);
        this.deletePersistedSession(id);
        session = unstable_v2_createSession(options);
      }
    } else {
      log(`[session-mgr] Creating new session for ${id} (mode=${effectiveMode}, model=${effectiveModel})`);
      session = unstable_v2_createSession(options);
    }

    // Don't access session.sessionId here — V2 SDK throws on fresh sessions
    // before the first send/stream cycle. We get the real ID from the system/init
    // message in processMessageInner and call persistSessionId() there.
    const ctx: ConversationContext = {
      session,
      sessionId: persisted?.sessionId ?? '',
      loopTracker,
      contextTracker,
      lastUsed: Date.now(),
      mode: effectiveMode,
      model: effectiveModel,
      lockPromise: Promise.resolve(),
      lockRelease: null,
    };

    this.conversations.set(id, ctx);
    return ctx;
  }

  // ─── Per-Conversation Lock ──────────────────────────

  /**
   * Acquire the message lock for a conversation.
   * Returns a release function that MUST be called when done.
   */
  async acquireLock(conversationId?: string): Promise<() => void> {
    const id = conversationId || DEFAULT_CONVERSATION;
    const ctx = this.conversations.get(id);
    if (!ctx) throw new Error(`No conversation context for ${id}`);

    // Wait for previous lock
    await ctx.lockPromise;

    // Create new lock and track it for eviction safety
    let release!: () => void;
    ctx.lockPromise = new Promise(resolve => {
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
  persistSessionId(conversationId: string | undefined, sessionId: string): void {
    const id = conversationId || DEFAULT_CONVERSATION;

    // Update in-memory context
    const ctx = this.conversations.get(id);
    if (ctx) ctx.sessionId = sessionId;

    // Write to disk
    const data: PersistedSession = {
      sessionId,
      createdAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
    };
    try {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
      fs.writeFileSync(
        path.join(this.sessionsDir, `${id}.json`),
        JSON.stringify(data, null, 2),
      );
    } catch { /* non-fatal */ }
  }

  /**
   * Update lastMessageAt timestamp for a conversation.
   */
  touchSession(conversationId?: string): void {
    const id = conversationId || DEFAULT_CONVERSATION;
    const filePath = path.join(this.sessionsDir, `${id}.json`);
    try {
      if (!fs.existsSync(filePath)) return;
      const data: PersistedSession = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      data.lastMessageAt = new Date().toISOString();
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch { /* non-fatal */ }
  }

  // ─── LRU Eviction ──────────────────────────────────

  private evictOldest(): void {
    let oldestId: string | null = null;
    let oldestTime = Infinity;

    for (const [id, ctx] of this.conversations) {
      // Skip conversations with an active lock — they're processing a message
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
      // All sessions are locked — log warning instead of silently failing
      log(`[session-mgr] WARNING: Cannot evict — all ${this.conversations.size} sessions are locked`);
    }
  }

  /** Close sessions that have been idle longer than idleTimeoutMs. */
  private evictIdle(): void {
    const now = Date.now();
    for (const [id, ctx] of this.conversations) {
      if (ctx.lockRelease !== null) continue; // skip locked sessions
      if (now - ctx.lastUsed > this.idleTimeoutMs) {
        this.closeConversation(id);
        log(`[session-mgr] Evicted idle conversation ${id} (idle ${Math.round((now - ctx.lastUsed) / 60_000)}min)`);
      }
    }
  }

  // ─── Cleanup ────────────────────────────────────────

  /**
   * Close a specific conversation's session (frees subprocess memory).
   * The session can be resumed later from disk.
   */
  closeConversation(conversationId: string): void {
    const ctx = this.conversations.get(conversationId);
    if (!ctx) return;

    try { ctx.session.close(); } catch { /* ignore */ }
    this.conversations.delete(conversationId);
  }

  /**
   * Close all sessions. Called on SIGTERM before exit.
   */
  closeAll(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    for (const [id, ctx] of this.conversations) {
      try { ctx.session.close(); } catch { /* ignore */ }
      log(`[session-mgr] Closed session for ${id}`);
    }
    this.conversations.clear();
  }

  /**
   * Handle session error — close and remove so next message creates fresh.
   */
  handleError(conversationId?: string): void {
    const id = conversationId || DEFAULT_CONVERSATION;
    const ctx = this.conversations.get(id);
    if (!ctx) return;

    try { ctx.session.close(); } catch { /* ignore */ }
    this.conversations.delete(id);
    log(`[session-mgr] Session closed due to error for ${id}`);
  }

  // ─── Migration ──────────────────────────────────────

  /**
   * Migrate old single-session file to multi-session format.
   * Called once on first use.
   */
  migrateFromLegacy(): void {
    const legacyFile = path.join(this.workspaceDir, '.current-session-id');
    try {
      if (!fs.existsSync(legacyFile)) return;
      if (fs.existsSync(this.sessionsDir)) return; // already migrated

      const sessionId = fs.readFileSync(legacyFile, 'utf-8').trim();
      if (!sessionId) return;

      log(`[session-mgr] Migrating legacy session ${sessionId} → .sessions/default.json`);
      this.persistSessionId(DEFAULT_CONVERSATION, sessionId);
      fs.unlinkSync(legacyFile);
    } catch {
      log(`[session-mgr] Legacy migration failed (non-fatal)`);
    }
  }

  // ─── Internal ───────────────────────────────────────

  private readPersistedSession(conversationId: string): PersistedSession | null {
    try {
      const filePath = path.join(this.sessionsDir, `${conversationId}.json`);
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch { return null; }
  }

  private deletePersistedSession(conversationId: string): void {
    try {
      const filePath = path.join(this.sessionsDir, `${conversationId}.json`);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch { /* non-fatal */ }
  }

  // ─── Stats ──────────────────────────────────────────

  get activeCount(): number {
    return this.conversations.size;
  }

  getConversationIds(): string[] {
    return Array.from(this.conversations.keys());
  }
}

// ─── Logging ──────────────────────────────────────────

function log(message: string): void {
  console.error(message);
}
