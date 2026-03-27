/**
 * UI Message Stream Protocol v1 — AI SDK compatible SSE writer.
 *
 * Emits named JSON types over SSE that `useChat()` from `@ai-sdk/react`
 * can parse natively. Replaces our custom SSE format when SSE_FORMAT=aisdk.
 *
 * Protocol: https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol
 * Required header: X-Vercel-AI-UI-Message-Stream: v1
 */

import type http from 'http';
import crypto from 'crypto';

// ─── Types ──────────────────────────────────────────────

export interface UsageMeta {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface CostMeta {
  usd: number;
}

export interface MessageMetadata {
  usage?: UsageMeta;
  cost?: CostMeta;
  model?: string;
  sessionId?: string;
  [key: string]: unknown;
}

// ─── UIStreamWriter ─────────────────────────────────────

export class UIStreamWriter {
  private res: http.ServerResponse;
  private ended = false;
  private textIdCounter = 0;
  private reasoningIdCounter = 0;
  private _currentTextId: string | null = null;
  private _currentReasoningId: string | null = null;
  private stepOpen = false;

  constructor(res: http.ServerResponse) {
    this.res = res;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Vercel-AI-UI-Message-Stream': 'v1',
      'X-Accel-Buffering': 'no',
    });
  }

  // ─── Low-level ──────────────────────────────────────

  private write(chunk: Record<string, unknown>): void {
    if (this.ended || this.res.destroyed) return;
    this.res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }

  // ─── Message Lifecycle ──────────────────────────────

  start(messageId?: string): void {
    this.write({
      type: 'start',
      ...(messageId ? { messageId } : {}),
    });
  }

  finish(finishReason: string = 'stop', metadata?: MessageMetadata): void {
    this.closeOpenBlocks();
    if (this.stepOpen) {
      this.finishStep();
    }
    this.write({
      type: 'finish',
      finishReason,
      ...(metadata ? { messageMetadata: metadata } : {}),
    });
  }

  startStep(): void {
    this.write({ type: 'start-step' });
    this.stepOpen = true;
  }

  finishStep(): void {
    this.closeOpenBlocks();
    this.write({ type: 'finish-step' });
    this.stepOpen = false;
  }

  // ─── Text Content ───────────────────────────────────

  get currentTextId(): string | null {
    return this._currentTextId;
  }

  textStart(id?: string): string {
    const blockId = id ?? `text-${++this.textIdCounter}`;
    this._currentTextId = blockId;
    this.write({ type: 'text-start', id: blockId });
    return blockId;
  }

  textDelta(delta: string, id?: string): void {
    // Auto-open text block if needed
    if (!this._currentTextId) {
      this.textStart(id);
    }
    this.write({ type: 'text-delta', id: this._currentTextId, delta });
  }

  textEnd(id?: string): void {
    const blockId = id ?? this._currentTextId;
    if (!blockId) return;
    this.write({ type: 'text-end', id: blockId });
    this._currentTextId = null;
  }

  // ─── Reasoning/Thinking ─────────────────────────────

  get currentReasoningId(): string | null {
    return this._currentReasoningId;
  }

  reasoningStart(id?: string): string {
    const blockId = id ?? `reasoning-${++this.reasoningIdCounter}`;
    this._currentReasoningId = blockId;
    this.write({ type: 'reasoning-start', id: blockId });
    return blockId;
  }

  reasoningDelta(delta: string, id?: string): void {
    if (!this._currentReasoningId) {
      this.reasoningStart(id);
    }
    this.write({ type: 'reasoning-delta', id: this._currentReasoningId, delta });
  }

  reasoningEnd(id?: string): void {
    const blockId = id ?? this._currentReasoningId;
    if (!blockId) return;
    this.write({ type: 'reasoning-end', id: blockId });
    this._currentReasoningId = null;
  }

  // ─── Tool Calls ─────────────────────────────────────

  toolInputStart(toolCallId: string, toolName: string): void {
    this.closeOpenBlocks();
    this.write({ type: 'tool-input-start', toolCallId, toolName });
  }

  toolInputAvailable(toolCallId: string, toolName: string, input: unknown): void {
    this.write({ type: 'tool-input-available', toolCallId, toolName, input });
  }

  toolOutputAvailable(toolCallId: string, output: unknown): void {
    this.write({ type: 'tool-output-available', toolCallId, output });
  }

  toolOutputError(toolCallId: string, errorText: string): void {
    this.write({ type: 'tool-output-error', toolCallId, errorText });
  }

  // ─── Custom Gallery Data ────────────────────────────

  galleryData(name: string, data: unknown): void {
    this.write({ type: `data-gallery-${name}`, data });
  }

  galleryStreamId(streamId: string): void {
    this.galleryData('stream-id', { streamId });
  }

  galleryProgress(data: { steps: string[]; current: number; status: string; note?: string }): void {
    this.galleryData('progress', data);
  }

  galleryCompacting(status: 'started' | 'done'): void {
    this.galleryData('compacting', { status });
  }

  galleryReview(data: { reviewId: string; reviewType: string }): void {
    this.galleryData('review', data);
  }

  // ─── Metadata ───────────────────────────────────────

  messageMetadata(metadata: MessageMetadata): void {
    this.write({ type: 'message-metadata', messageMetadata: metadata });
  }

  // ─── Error / Abort ──────────────────────────────────

  error(errorText: string): void {
    this.closeOpenBlocks();
    this.write({ type: 'error', errorText });
  }

  abort(reason?: string): void {
    this.closeOpenBlocks();
    this.write({ type: 'abort', ...(reason ? { reason } : {}) });
  }

  // ─── Stream Termination ─────────────────────────────

  done(): void {
    if (this.ended) return;
    this.ended = true;
    if (!this.res.destroyed) {
      this.res.write('data: [DONE]\n\n');
      this.res.end();
    }
  }

  get isEnded(): boolean {
    return this.ended;
  }

  // ─── Helpers ────────────────────────────────────────

  /** Close any open text or reasoning blocks. */
  closeOpenBlocks(): void {
    if (this._currentTextId) this.textEnd();
    if (this._currentReasoningId) this.reasoningEnd();
  }

  /** Whether a step boundary is needed before the next content. */
  needsStepBoundary(lastEmittedToolOutput: boolean): boolean {
    return lastEmittedToolOutput && this.stepOpen;
  }

  /** Emit step boundary (finish current step, start new one). */
  emitStepBoundary(): void {
    this.finishStep();
    this.startStep();
  }
}

// ─── Utility ──────────────────────────────────────────

export function generateMessageId(): string {
  return `msg_${crypto.randomBytes(8).toString('hex')}`;
}

export function generateStreamId(): string {
  return `stream_${crypto.randomBytes(8).toString('hex')}`;
}

/** Check if AI SDK UI Message Stream format is enabled. */
export function isAiSdkEnabled(): boolean {
  return process.env.SSE_FORMAT === 'aisdk';
}
