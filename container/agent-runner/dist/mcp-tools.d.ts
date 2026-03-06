/**
 * Claw MCP Tools — Stdio MCP Server for Sprites
 * Adapted from ipc-mcp-stdio.ts for the Sprites architecture.
 *
 * Changes from Docker version:
 * - Memory tools: paths updated (/workspace/group → /home/sprite/workspace)
 * - send_message: POST to Gallery API instead of filesystem IPC
 * - Scheduling tools: stubbed (wired to Gallery in Phase 2)
 * - Removed: register_group, list_sessions, send_to_group, close_group_session
 */
export {};
