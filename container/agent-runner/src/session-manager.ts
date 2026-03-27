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
  private buildOptions: (loopTracker: ToolCallTracker, contextTracker: ContextWindowTracker, assistantName?: string) => SDKSessionOptions;

  constructor(opts: {
    workspaceDir: string;
    maxSessions?: number;
    defaultContextWindow: number;
    buildOptions: (loopTracker: ToolCallTracker, contextTracker: ContextWindowTracker, assistantName?: string) => SDKSessionOptions;
  }) {
    this.workspaceDir = opts.workspaceDir;
    this.sessionsDir = path.join(opts.workspaceDir, '.sessions');
    this.maxSessions = opts.maxSessions ?? 5;
    this.defaultContextWindow = opts.defaultContextWindow;
    this.buildOptions = opts.buildOptions;
  }

  // ─── Get or Create ──────────────────────────────────

  /**
   * Get or create a conversation context for the given ID.
   * Creates a new V2 session or resumes from disk.
   */
  getOrCreate(conversationId?: string, assistantName?: string): ConversationContext {
    const id = conversationId || DEFAULT_CONVERSATION;

    // Return existing active context
    const existing = this.conversations.get(id);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing;
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
    const options = this.buildOptions(loopTracker, contextTracker, assistantName);

    let session: SDKSession;
    if (persisted) {
      try {
        log(`[session-mgr] Resuming session for ${id}: ${persisted.sessionId}`);
        session = unstable_v2_resumeSession(persisted.sessionId, options);
      } catch (err) {
        log(`[session-mgr] Resume failed for ${id}, creating fresh: ${err}`);
        this.deletePersistedSession(id);
        session = unstable_v2_createSession(options);
      }
    } else {
      log(`[session-mgr] Creating new session for ${id}`);
      session = unstable_v2_createSession(options);
    }

    const ctx: ConversationContext = {
      session,
      sessionId: session.sessionId ?? persisted?.sessionId ?? '',
      loopTracker,
      contextTracker,
      lastUsed: Date.now(),
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

    // Create new lock
    let release!: () => void;
    ctx.lockPromise = new Promise(resolve => { release = resolve; });
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
      if (ctx.lastUsed < oldestTime) {
        oldestTime = ctx.lastUsed;
        oldestId = id;
      }
    }

    if (oldestId) {
      this.closeConversation(oldestId);
      log(`[session-mgr] Evicted conversation ${oldestId} (LRU)`);
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
