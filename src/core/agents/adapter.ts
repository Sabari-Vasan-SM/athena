/**
 * Agent-agnostic integration contract. Core knows nothing about specific agents;
 * adapters in src/agents/* implement this using each agent's own supported
 * instruction mechanism.
 */

export interface AgentCapabilities {
  /** Agent reads a project instruction file. */
  instructionsFile: boolean;
  /** Agent supports scoped/conditional rules (globs, descriptions). */
  scopedRules: boolean;
  /** Agent exposes lifecycle hooks Athena could use to observe activity (Phase 4). */
  hooks: boolean;
  /** Agent supports MCP servers (Phase 6). */
  mcp: boolean;
}

export interface AgentPresence {
  /** Evidence that this agent is used in the project (config dirs/files). */
  detectedInProject: boolean;
  evidence: string[];
}

export interface PlannedFileChange {
  /** Project-relative POSIX path. */
  path: string;
  /** "owned": Athena owns the whole file. "block": Athena manages a marked block inside a user-owned file. */
  ownership: 'owned' | 'block';
  action: 'create' | 'update' | 'unchanged';
  content: string;
}

export interface IntegrationCheck {
  ok: boolean;
  level: 'ok' | 'warn' | 'error';
  message: string;
}

export interface AgentContext {
  root: string;
  projectName: string;
}

export interface AgentAdapter {
  id: string;
  displayName: string;
  capabilities: AgentCapabilities;
  /** Short note on what is verified about this integration. Shown by doctor. */
  supportNote: string;
  detectPresence(root: string): Promise<AgentPresence>;
  plan(ctx: AgentContext): Promise<PlannedFileChange[]>;
  /** Remove Athena-managed files/blocks. Returns paths touched. */
  remove(root: string): Promise<string[]>;
  check(root: string): Promise<IntegrationCheck[]>;
}
