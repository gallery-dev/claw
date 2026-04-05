#!/usr/bin/env node
/**
 * CLI Wrapper — injects MCP server config into the Claude Code CLI.
 *
 * The V2 Session API (unstable_v2_createSession) hardcodes settingSources=[]
 * and mcpServers={}, which prevents the CLI from loading project .mcp.json.
 * This wrapper reads .mcp.json from cwd and injects --mcp-config into argv
 * before loading the real CLI, bypassing the V2 Session limitation.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// Inject --mcp-config from .mcp.json if it exists in cwd
const mcpJsonPath = join(process.cwd(), '.mcp.json');
if (existsSync(mcpJsonPath)) {
  try {
    const mcpJson = readFileSync(mcpJsonPath, 'utf-8');
    // Validate it's parseable JSON with mcpServers
    const parsed = JSON.parse(mcpJson);
    if (parsed.mcpServers && Object.keys(parsed.mcpServers).length > 0) {
      process.argv.push('--mcp-config', mcpJson);
    }
  } catch {
    // Silently continue — CLI will work without MCP servers
  }
}

// Load the real CLI
await import('./cli.js');
