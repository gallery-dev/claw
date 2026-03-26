/**
 * esbuild config — bundles agent-runner into self-contained JS files.
 *
 * Produces two bundles in dist/:
 *   server.bundle.js    — main HTTP service (server.ts + agent.ts)
 *   mcp-tools.bundle.js — MCP stdio server (spawned as child process by SDK)
 *
 * All npm dependencies are inlined. No node_modules needed on the sprite.
 * Node built-ins (fs, path, http, etc.) are kept as external imports.
 */

import { build } from 'esbuild';
import { readFileSync, copyFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outdir: 'dist',
  sourcemap: false,
  minify: false, // keep readable for debugging on sprites
  define: {
    'CLAW_VERSION': JSON.stringify(pkg.version),
    'CLAW_BUILD_TIME': JSON.stringify(new Date().toISOString()),
  },
  // Node built-ins stay as imports — everything else gets bundled
  external: [
    'fs', 'path', 'http', 'https', 'url', 'net', 'tls', 'os', 'crypto',
    'stream', 'buffer', 'util', 'events', 'child_process', 'worker_threads',
    'readline', 'assert', 'zlib', 'string_decoder', 'querystring', 'module',
    'node:fs', 'node:path', 'node:http', 'node:https', 'node:url', 'node:net',
    'node:tls', 'node:os', 'node:crypto', 'node:stream', 'node:buffer',
    'node:util', 'node:events', 'node:child_process', 'node:worker_threads',
    'node:readline', 'node:assert', 'node:zlib', 'node:string_decoder',
    'node:querystring', 'node:module',
  ],
  // Banner to ensure import.meta.url works in bundled ESM
  banner: {
    js: '// Claw Agent Runner — bundled with esbuild',
  },
};

async function run() {
  // Bundle 1: Main HTTP service
  await build({
    ...shared,
    entryPoints: ['src/server.ts'],
    outfile: 'dist/server.bundle.js',
    outdir: undefined,
  });

  // Bundle 2: MCP tools (separate process, spawned by claude-agent-sdk)
  await build({
    ...shared,
    entryPoints: ['src/mcp-tools.ts'],
    outfile: 'dist/mcp-tools.bundle.js',
    outdir: undefined,
  });

  // Copy cli.js from SDK — the Claude Agent SDK spawns this as a subprocess.
  // query() resolves cli.js relative to import.meta.url at runtime, so it must
  // sit next to server.bundle.js in dist/.
  const sdkCliPath = join(dirname(fileURLToPath(import.meta.url)), 'node_modules/@anthropic-ai/claude-agent-sdk/cli.js');
  mkdirSync('dist', { recursive: true });
  copyFileSync(sdkCliPath, 'dist/cli.js');

  console.log('✓ Bundled server.bundle.js + mcp-tools.bundle.js + cli.js');
}

run().catch((err) => {
  console.error('Bundle failed:', err);
  process.exit(1);
});
