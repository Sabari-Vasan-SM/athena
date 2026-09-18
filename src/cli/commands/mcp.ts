import { runMcpServer } from '../../mcp/server.js';
import { requireProjectRoot, type GlobalOptions } from '../context.js';

export interface McpCommandOptions extends GlobalOptions {
  allowWrite?: boolean;
  signal?: AbortSignal;
}

/**
 * Serve Athena knowledge over MCP on stdio. Nothing may be written to stdout
 * except protocol messages, so this command prints no banner or logs.
 */
export async function mcpCommand(opts: McpCommandOptions): Promise<void> {
  const root = await requireProjectRoot(opts);
  await runMcpServer({ root, allowWrite: opts.allowWrite, signal: opts.signal });
}
