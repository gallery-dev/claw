/**
 * esbuild config — bundles agent-runner into self-contained JS files.
 *
 * Produces two bundles in dist/:
 *   server.bundle.js    — main HTTP service (server.ts + agent.ts)
 *   gallery-cli.bundle.js — Gallery CLI tools (agent calls via Bash)
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
    'CLAW_VERSION': JSON.stringify(process.env.CLAW_VERSION || pkg.version),
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

  // Bundle 2: Gallery CLI (fallback — agent can also call via Bash)
  await build({
    ...shared,
    entryPoints: ['src/gallery-cli.ts'],
    outfile: 'dist/gallery-cli.bundle.js',
    outdir: undefined,
  });

  // Bundle 3: MCP stdio server (primary tool delivery — loaded by SDK via .mcp.json)
  await build({
    ...shared,
    entryPoints: ['src/mcp-tools.ts'],
    outfile: 'dist/mcp-tools.bundle.js',
    outdir: undefined,
  });

  // Bundle 4: Composio SSE-to-stdio proxy — bridges CLI's stdio transport to
  // Composio's SSE MCP endpoint. Needed because the CLI's SSE client fails
  // silently in container environments.
  await build({
    ...shared,
    entryPoints: ['src/composio-proxy.ts'],
    outfile: 'dist/composio-proxy.bundle.js',
    outdir: undefined,
  });

  // Copy cli.js from SDK — the Claude Agent SDK spawns this as a subprocess.
  // query() resolves cli.js relative to import.meta.url at runtime, so it must
  // sit next to server.bundle.js in dist/.
  const sdkCliPath = join(dirname(fileURLToPath(import.meta.url)), 'node_modules/@anthropic-ai/claude-agent-sdk/cli.js');
  mkdirSync('dist', { recursive: true });
  copyFileSync(sdkCliPath, 'dist/cli.js');

  // Copy cli-wrapper.js — injects --mcp-config from .mcp.json before loading
  // the real CLI. Needed because V2 sessions hardcode settingSources=[] and
  // mcpServers={}, preventing the CLI from loading project MCP config.
  copyFileSync('src/cli-wrapper.js', 'dist/cli-wrapper.js');

  console.log('✓ Bundled server.bundle.js + gallery-cli.bundle.js + mcp-tools.bundle.js + composio-proxy.bundle.js + cli.js + cli-wrapper.js');
}

run().catch((err) => {
  console.error('Bundle failed:', err);
  process.exit(1);
});
