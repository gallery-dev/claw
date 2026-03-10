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
import { processMessage, getStatus, getActivityMetrics, shutdown, type MessageParams } from './agent.js';

const PORT = parseInt(process.env.PORT || '8080', 10);
const MAX_QUEUE_SIZE = parseInt(process.env.CLAW_MAX_QUEUE_SIZE || '50', 10);
const REQUEST_TIMEOUT_MS = parseInt(process.env.CLAW_REQUEST_TIMEOUT_MS || '600000', 10);

function log(message: string): void {
  console.error(`[claw-server] ${message}`);
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

  // Batch: if multiple messages queued, combine into single prompt
  // This avoids N sequential agent invocations for rapid-fire messages
  const items = requestQueue.splice(0, requestQueue.length);
  let params: MessageParams;

  if (items.length === 1) {
    params = items[0].params;
  } else {
    // Merge messages into one prompt, preserve metadata from first item
    const first = items[0].params;
    const combined = items.map((item, i) =>
      `[Message ${i + 1}]: ${item.params.message}`
    ).join('\n\n');
    params = {
      message: combined,
      sessionId: first.sessionId,
      isScheduledTask: first.isScheduledTask,
      assistantName: first.assistantName,
    };
    log(`Batched ${items.length} queued messages into single prompt`);
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

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: string) => { body += chunk; });
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
  };

  log(`POST /message (${params.message.length} chars, queue: ${requestQueue.length})`);

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

const server = http.createServer(async (req, res) => {
  const method = req.method || 'GET';
  const url = req.url || '/';

  try {
    if (method === 'POST' && url === '/message') {
      await handleMessage(req, res);
    } else if (method === 'POST' && url === '/task') {
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
