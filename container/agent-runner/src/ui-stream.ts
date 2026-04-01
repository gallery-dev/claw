/**
 * UI Message Stream Protocol v1 — AI SDK compatible SSE writer.
 *
 * Emits named JSON types over SSE that `useChat()` from `@ai-sdk/react`
 * can parse natively.
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

  private backpressureWarned = false;

  private async write(chunk: Record<string, unknown>): Promise<void> {
    if (this.ended || this.res.destroyed) return;
    const ok = this.res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    if (!ok) {
      if (!this.backpressureWarned) {
        this.backpressureWarned = true;
        console.error('[ui-stream] Backpressure detected — pausing until drain');
      }
      // Wait for drain or connection close to avoid hanging if res is destroyed
      // between write() returning false and the drain event firing.
      await new Promise<void>((resolve) => {
        const cleanup = () => { this.res.off('drain', onDrain); this.res.off('close', onClose); this.res.off('error', onClose); };
        const onDrain = () => { cleanup(); resolve(); };
        const onClose = () => { cleanup(); resolve(); };
        this.res.once('drain', onDrain);
        this.res.once('close', onClose);
        this.res.once('error', onClose);
      });
    }
  }

  // ─── Message Lifecycle ──────────────────────────────

  async start(messageId?: string): Promise<void> {
    await this.write({
      type: 'start',
      ...(messageId ? { messageId } : {}),
    });
  }

  async finish(finishReason: string = 'stop', metadata?: MessageMetadata): Promise<void> {
    await this.closeOpenBlocks();
    if (this.stepOpen) {
      await this.finishStep();
    }
    await this.write({
      type: 'finish',
      finishReason,
      ...(metadata ? { messageMetadata: metadata } : {}),
    });
  }

  async startStep(): Promise<void> {
    await this.write({ type: 'start-step' });
    this.stepOpen = true;
  }

  async finishStep(): Promise<void> {
    await this.closeOpenBlocks();
    await this.write({ type: 'finish-step' });
    this.stepOpen = false;
  }

  // ─── Text Content ───────────────────────────────────

  get currentTextId(): string | null {
    return this._currentTextId;
  }

  async textStart(id?: string): Promise<string> {
    const blockId = id ?? `text-${++this.textIdCounter}`;
    this._currentTextId = blockId;
    await this.write({ type: 'text-start', id: blockId });
    return blockId;
  }

  async textDelta(delta: string, id?: string): Promise<void> {
    // Auto-open text block if needed
    if (!this._currentTextId) {
      await this.textStart(id);
    }
    await this.write({ type: 'text-delta', id: this._currentTextId, delta });
  }

  async textEnd(id?: string): Promise<void> {
    const blockId = id ?? this._currentTextId;
    if (!blockId) return;
    await this.write({ type: 'text-end', id: blockId });
    this._currentTextId = null;
  }

  // ─── Reasoning/Thinking ─────────────────────────────

  get currentReasoningId(): string | null {
    return this._currentReasoningId;
  }

  async reasoningStart(id?: string): Promise<string> {
    const blockId = id ?? `reasoning-${++this.reasoningIdCounter}`;
    this._currentReasoningId = blockId;
    await this.write({ type: 'reasoning-start', id: blockId });
    return blockId;
  }

  async reasoningDelta(delta: string, id?: string): Promise<void> {
    if (!this._currentReasoningId) {
      await this.reasoningStart(id);
    }
    await this.write({ type: 'reasoning-delta', id: this._currentReasoningId, delta });
  }

  async reasoningEnd(id?: string): Promise<void> {
    const blockId = id ?? this._currentReasoningId;
    if (!blockId) return;
    await this.write({ type: 'reasoning-end', id: blockId });
    this._currentReasoningId = null;
  }

  // ─── Tool Calls ─────────────────────────────────────

  async toolInputStart(toolCallId: string, toolName: string): Promise<void> {
    await this.closeOpenBlocks();
    await this.write({ type: 'tool-input-start', toolCallId, toolName });
  }

  async toolInputAvailable(toolCallId: string, toolName: string, input: unknown): Promise<void> {
    await this.write({ type: 'tool-input-available', toolCallId, toolName, input });
  }

  async toolOutputAvailable(toolCallId: string, output: unknown): Promise<void> {
    await this.write({ type: 'tool-output-available', toolCallId, output });
  }

  async toolOutputError(toolCallId: string, errorText: string): Promise<void> {
    await this.write({ type: 'tool-output-error', toolCallId, errorText });
  }

  // ─── Custom Gallery Data ────────────────────────────

  async galleryData(name: string, data: unknown): Promise<void> {
    await this.write({ type: `data-gallery-${name}`, data });
  }

  async galleryStreamId(streamId: string): Promise<void> {
    await this.galleryData('stream-id', { streamId });
  }

  async galleryProgress(data: { steps: string[]; current: number; status: string; note?: string }): Promise<void> {
    await this.galleryData('progress', data);
  }

  async galleryCompacting(status: 'started' | 'done'): Promise<void> {
    await this.galleryData('compacting', { status });
  }

  async galleryReview(data: { reviewId: string; reviewType: string }): Promise<void> {
    await this.galleryData('review', data);
  }

  // ─── Metadata ───────────────────────────────────────

  async messageMetadata(metadata: MessageMetadata): Promise<void> {
    await this.write({ type: 'message-metadata', messageMetadata: metadata });
  }

  // ─── Error / Abort ──────────────────────────────────

  async error(errorText: string): Promise<void> {
    await this.closeOpenBlocks();
    await this.write({ type: 'error', errorText });
  }

  async abort(reason?: string): Promise<void> {
    await this.closeOpenBlocks();
    await this.write({ type: 'abort', ...(reason ? { reason } : {}) });
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
  async closeOpenBlocks(): Promise<void> {
    if (this._currentTextId) await this.textEnd();
    if (this._currentReasoningId) await this.reasoningEnd();
  }

  /** Whether a step boundary is needed before the next content. */
  needsStepBoundary(lastEmittedToolOutput: boolean): boolean {
    return lastEmittedToolOutput && this.stepOpen;
  }

  /** Emit step boundary (finish current step, start new one). */
  async emitStepBoundary(): Promise<void> {
    await this.finishStep();
    await this.startStep();
  }
}

// ─── Utility ──────────────────────────────────────────

export function generateMessageId(): string {
  return `msg_${crypto.randomBytes(8).toString('hex')}`;
}

export function generateStreamId(): string {
  return `stream_${crypto.randomBytes(8).toString('hex')}`;
}

