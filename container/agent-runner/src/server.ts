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
import { processMessage, getStatus, shutdown, type MessageParams } from './agent.js';

const PORT = parseInt(process.env.PORT || '8080', 10);

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
  return new Promise((resolve, reject) => {
    requestQueue.push({ params, resolve, reject });
    processQueue();
  });
}

async function processQueue(): Promise<void> {
  if (processing || requestQueue.length === 0) return;

  processing = true;
  const { params, resolve, reject } = requestQueue.shift()!;

  try {
    const result = await processMessage(params);
    resolve(result);
  } catch (err) {
    reject(err instanceof Error ? err : new Error(String(err)));
  } finally {
    processing = false;
    // Process next in queue
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
    sendJson(res, 200, result);
  } catch (err) {
    log(`Error processing message: ${err instanceof Error ? err.message : String(err)}`);
    sendJson(res, 500, {
      status: 'error',
      result: null,
      sessionId: '',
      error: err instanceof Error ? err.message : String(err),
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
    log(`Error processing task: ${err instanceof Error ? err.message : String(err)}`);
    sendJson(res, 500, {
      status: 'error',
      result: null,
      sessionId: '',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function handleHealth(_req: http.IncomingMessage, res: http.ServerResponse): void {
  sendJson(res, 200, {
    status: 'ok',
    uptime: process.uptime(),
    queueLength: requestQueue.length,
    processing,
  });
}

function handleStatus(_req: http.IncomingMessage, res: http.ServerResponse): void {
  const status = getStatus();
  sendJson(res, 200, {
    ...status,
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
