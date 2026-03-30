/**
 * Claw HTTP Server — Entry point for Sprite Service
 * Runs on port 8080, auto-starts on sprite wake.
 *
 * Routes:
 *   POST /message  — process a user message
 *   POST /task     — process a scheduled/delegated task
 *   GET  /health   — health check
 *   GET  /status   — agent status info
 */

import http from 'http';
import { processMessage, getStatus, getActivityMetrics, shutdown, type MessageParams, type StreamEvent } from './agent.js';
import { UIStreamWriter, generateStreamId, isAiSdkEnabled } from './ui-stream.js';

const PORT = parseInt(process.env.PORT || '8080', 10);
const MAX_QUEUE_SIZE = parseInt(process.env.CLAW_MAX_QUEUE_SIZE || '50', 10);
const REQUEST_TIMEOUT_MS = parseInt(process.env.CLAW_REQUEST_TIMEOUT_MS || '600000', 10);
const AUTH_TOKEN = process.env.CLAW_AUTH_TOKEN || process.env.GALLERY_GATEWAY_TOKEN || '';

// Active SSE streams — keyed by streamId for cancel support
const activeStreams = new Map<string, { cancelled: boolean }>();

function log(message: string): void {
  console.error(`[claw-server] ${message}`);
}

// Warn at startup if auth is disabled
if (!AUTH_TOKEN) {
  log('WARNING: No CLAW_AUTH_TOKEN or GALLERY_GATEWAY_TOKEN set — all requests will be accepted without auth');
}

// ─── Auth ────────────────────────────────────────────────

/**
 * Validate Bearer token on protected endpoints.
 * Returns true if authorized, false (and sends 401) if not.
 * If no AUTH_TOKEN is configured, all requests are allowed (logged warning at startup).
 */
function requireAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (!AUTH_TOKEN) return true;

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    sendJson(res, 401, { error: 'Missing Authorization header' });
    return false;
  }

  const token = authHeader.slice(7);
  if (token !== AUTH_TOKEN) {
    log(`Auth failed: invalid token from ${req.socket.remoteAddress}`);
    sendJson(res, 401, { error: 'Invalid token' });
    return false;
  }

  return true;
}

// ─── Request Queue (one query at a time) ─────────────────

let processing = false;
const requestQueue: Array<{
  params: MessageParams;
  resolve: (result: any) => void;
  reject: (err: Error) => void;
}> = [];

async function enqueueMessage(params: MessageParams): Promise<any> {
  if (requestQueue.length >= MAX_QUEUE_SIZE) {
    throw new Error('QUEUE_FULL');
  }
  return new Promise((resolve, reject) => {
    requestQueue.push({ params, resolve, reject });
    processQueue();
  });
}

async function processQueue(): Promise<void> {
  if (processing || requestQueue.length === 0) return;

  processing = true;

  // Take the first item, then batch any queued items of the same type
  // (don't mix tasks with regular messages — they have different semantics)
  const first = requestQueue.shift()!;
  const items = [first];
  const isTask = first.params.isScheduledTask;

  // Collect same-type items from the front of the queue
  while (requestQueue.length > 0 && requestQueue[0].params.isScheduledTask === isTask) {
    items.push(requestQueue.shift()!);
  }

  let params: MessageParams;

  if (items.length === 1) {
    params = items[0].params;
  } else {
    // Merge messages into one prompt, preserve metadata from first item
    const combined = items.map((item, i) =>
      `[Message ${i + 1}]: ${item.params.message}`
    ).join('\n\n');
    params = {
      message: combined,
      sessionId: first.params.sessionId,
      isScheduledTask: isTask,
      assistantName: first.params.assistantName,
    };
    log(`Batched ${items.length} queued ${isTask ? 'tasks' : 'messages'} into single prompt`);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error('REQUEST_TIMEOUT')), REQUEST_TIMEOUT_MS);
    });
    const result = await Promise.race([processMessage(params), timeoutPromise]);
    // Resolve all batched requests with the same result
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
    // Process next batch if more arrived while processing
    if (requestQueue.length > 0) {
      processQueue();
    }
  }
}

// ─── HTTP Request Helpers ────────────────────────────────

const MAX_BODY_BYTES = 1024 * 1024; // 1MB

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', (chunk: Buffer | string) => {
      bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('BODY_TOO_LARGE'));
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ─── Version (injected by esbuild at build time) ────────
declare const CLAW_VERSION: string | undefined;
declare const CLAW_BUILD_TIME: string | undefined;
const version = typeof CLAW_VERSION !== 'undefined' ? CLAW_VERSION : 'dev';
const buildTime = typeof CLAW_BUILD_TIME !== 'undefined' ? CLAW_BUILD_TIME : '';

// ─── Readiness tracking ─────────────────────────────────
let ready = false;
setTimeout(() => { ready = true; }, 10_000); // ready after 10s warmup

function markReady(): void { ready = true; }

function errorStatus(msg: string): number {
  if (msg === 'QUEUE_FULL') return 503;
  if (msg === 'REQUEST_TIMEOUT') return 504;
  if (msg === 'BODY_TOO_LARGE') return 413;
  return 500;
}

// ─── Route Handlers ──────────────────────────────────────

async function handleMessage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readBody(req);
  let parsed: any;

  try {
    parsed = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON' });
    return;
  }

  if (!parsed.message || typeof parsed.message !== 'string') {
    sendJson(res, 400, { error: 'Missing required field: message (string)' });
    return;
  }

  const params: MessageParams = {
    message: parsed.message,
    sessionId: parsed.sessionId,
    isScheduledTask: false,
    assistantName: parsed.assistantName,
    maxTurns: typeof parsed.maxTurns === 'number' ? parsed.maxTurns : undefined,
    maxBudgetUsd: typeof parsed.maxBudgetUsd === 'number' ? parsed.maxBudgetUsd : undefined,
    mode: parsed.mode === 'plan' ? 'plan' : undefined,
    model: typeof parsed.model === 'string' ? parsed.model : undefined,
  };

  const wantSSE = (req.headers['accept'] || '').includes('text/event-stream');
  const useAiSdk = isAiSdkEnabled();
  log(`POST /message (${params.message.length} chars, queue: ${requestQueue.length}, sse: ${wantSSE}, aisdk: ${useAiSdk})`);

  if (wantSSE && useAiSdk) {
    // ─── AI SDK UI Message Stream Protocol v1 ──────
    const writer = new UIStreamWriter(res);
    const streamId = generateStreamId();
    const streamState = { cancelled: false };
    activeStreams.set(streamId, streamState);

    // Emit stream ID so frontend can cancel
    writer.galleryStreamId(streamId);

    try {
      const result = await processMessage(params, undefined, writer, streamState);
      markReady();
      // writer.finish() + writer.done() are called inside processMessage when it sees 'result'
      // If processMessage returned without emitting done (edge case), ensure stream ends
      if (!writer.isEnded && !res.destroyed) {
        writer.finish('stop');
        writer.done();
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Error processing message (AI SDK): ${errMsg}`);
      if (!writer.isEnded && !res.destroyed) {
        writer.error(errMsg);
        writer.done();
      }
    } finally {
      activeStreams.delete(streamId);
    }
  } else if (wantSSE) {
    // ─── Legacy SSE format ──────────────────────────
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const onEvent = (event: StreamEvent) => {
      if (res.destroyed) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      const result = await processMessage(params, onEvent);
      markReady();
      if (!res.destroyed) {
        res.write(`data: ${JSON.stringify({ type: 'result', data: result })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Error processing message (SSE): ${errMsg}`);
      if (!res.destroyed) {
        res.write(`data: ${JSON.stringify({ type: 'error', data: { error: errMsg } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }
  } else {
    // ─── JSON mode — queue and wait for full result ─
    try {
      const result = await enqueueMessage(params);
      markReady();
      sendJson(res, 200, result);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Error processing message: ${errMsg}`);
      sendJson(res, errorStatus(errMsg), {
        status: 'error',
        result: null,
        sessionId: '',
        error: errMsg,
      });
    }
  }
}

// ─── Stream Cancel ──────────────────────────────────────

function handleCancel(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = req.url || '';
  const match = url.match(/^\/message\/(stream_[a-f0-9]+)$/);
  if (!match) {
    sendJson(res, 400, { error: 'Invalid stream ID format' });
    return;
  }

  const streamId = match[1];
  const stream = activeStreams.get(streamId);
  if (!stream) {
    sendJson(res, 404, { error: 'Stream not found or already completed' });
    return;
  }

  stream.cancelled = true;
  activeStreams.delete(streamId);
  log(`Stream ${streamId} cancelled`);
  res.writeHead(204);
  res.end();
}

async function handleTask(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readBody(req);
  let parsed: any;

  try {
    parsed = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON' });
    return;
  }

  if (!parsed.message || typeof parsed.message !== 'string') {
    sendJson(res, 400, { error: 'Missing required field: message (string)' });
    return;
  }

  const params: MessageParams = {
    message: parsed.message,
    sessionId: parsed.sessionId,
    isScheduledTask: true,
    assistantName: parsed.assistantName,
  };

  log(`POST /task (${params.message.length} chars, queue: ${requestQueue.length})`);

  try {
    const result = await enqueueMessage(params);
    sendJson(res, 200, result);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Error processing task: ${errMsg}`);
    sendJson(res, errorStatus(errMsg), {
      status: 'error',
      result: null,
      sessionId: '',
      error: errMsg,
    });
  }
}

function handleHealth(_req: http.IncomingMessage, res: http.ServerResponse): void {
  sendJson(res, 200, {
    status: 'ok',
    version,
    buildTime,
    uptime: process.uptime(),
    ready,
    queueLength: requestQueue.length,
    maxQueueSize: MAX_QUEUE_SIZE,
    processing,
    ...getActivityMetrics(),
  });
}

function handleReady(_req: http.IncomingMessage, res: http.ServerResponse): void {
  if (ready) {
    sendJson(res, 200, { status: 'ready' });
  } else {
    sendJson(res, 503, { status: 'not_ready' });
  }
}

function handleStatus(_req: http.IncomingMessage, res: http.ServerResponse): void {
  const status = getStatus();
  sendJson(res, 200, {
    ...status,
    version,
    queueLength: requestQueue.length,
    processing,
  });
}

// ─── Server ──────────────────────────────────────────────

// Set working directory so V2 session inherits correct cwd
// (V2 SDKSessionOptions doesn't have a cwd option — it uses process.cwd())
const WORKSPACE_DIR = process.env.CLAW_WORKSPACE_DIR || '/home/sprite/workspace';
try {
  const fs = await import('fs');
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  process.chdir(WORKSPACE_DIR);
  log(`Working directory set to ${WORKSPACE_DIR}`);
} catch (err) {
  log(`Warning: Could not chdir to ${WORKSPACE_DIR}: ${err instanceof Error ? err.message : String(err)}`);
}

const server = http.createServer(async (req, res) => {
  const method = req.method || 'GET';
  const url = req.url || '/';

  try {
    if (method === 'POST' && url === '/message') {
      if (!requireAuth(req, res)) return;
      await handleMessage(req, res);
    } else if (method === 'DELETE' && url.startsWith('/message/')) {
      if (!requireAuth(req, res)) return;
      handleCancel(req, res);
    } else if (method === 'POST' && url === '/task') {
      if (!requireAuth(req, res)) return;
      await handleTask(req, res);
    } else if (method === 'GET' && url === '/health') {
      handleHealth(req, res);
    } else if (method === 'GET' && url === '/ready') {
      handleReady(req, res);
    } else if (method === 'GET' && url === '/status') {
      handleStatus(req, res);
    } else {
      sendJson(res, 404, { error: 'Not found' });
    }
  } catch (err) {
    log(`Unhandled error: ${err instanceof Error ? err.message : String(err)}`);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'Internal server error' });
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  log(`Claw agent service running on 0.0.0.0:${PORT}`);
});

// Graceful shutdown — flush activity poster before sprite sleeps
process.on('SIGTERM', async () => {
  log('SIGTERM received, shutting down...');
  server.close();
  await shutdown();
  process.exit(0);
});
