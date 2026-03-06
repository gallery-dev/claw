/**
 * Claw Agent — Core query logic for Sprites
 * Extracted from index.ts, adapted for HTTP service model.
 *
 * Differences from Docker (index.ts):
 * - No stdin/stdout protocol — called directly via processMessage()
 * - No IPC file polling — each HTTP request is one message
 * - Secrets from process.env, not stdin
 * - Working directory: /home/sprite/workspace (not /workspace/group)
 *
 * Required environment variables (set during sprite provisioning):
 *   ANTHROPIC_BASE_URL     — Gallery AI proxy URL (e.g., https://gallery.dev/api/ai)
 *   ANTHROPIC_API_KEY      — Workspace gateway token (= GALLERY_GATEWAY_TOKEN)
 *   GALLERY_GATEWAY_TOKEN  — Auth token for Gallery API (activity posting, auth)
 *   GALLERY_CONVEX_URL     — Convex deployment URL (activity posting)
 *   GALLERY_MCP_URL        — Gallery MCP server URL
 *   GALLERY_TOKEN          — Gallery MCP auth token
 *   GALLERY_API_URL        — Gallery API base URL (for claw MCP tools)
 *   AGENT_ID               — This agent's Convex document ID
 *
 * Note: Claude API calls go through Gallery's AI proxy (/api/ai) for billing.
 * No direct Anthropic API key needed — ANTHROPIC_API_KEY is the gateway token.
 */
export interface MessageParams {
    message: string;
    sessionId?: string;
    isScheduledTask?: boolean;
    assistantName?: string;
}
export interface MessageResult {
    status: 'success' | 'error';
    result: string | null;
    sessionId: string;
    error?: string;
}
export declare function processMessage(params: MessageParams): Promise<MessageResult>;
/**
 * Flush pending activity events. Call on SIGTERM before exit.
 */
export declare function shutdown(): Promise<void>;
/**
 * Get current agent status.
 */
export declare function getStatus(): {
    sessionId: string | undefined;
    workspaceDir: string;
    memoryFiles: string[];
    uptime: number;
};
