import crypto from 'node:crypto';

/**
 * Normalization of agent hook payloads into Athena activity events.
 *
 * Everything here is *observed*: it comes from a hook the agent itself fired.
 * Athena never infers what an agent is "thinking" — only which tool ran, on what,
 * and when. Unknown hooks are recorded generically rather than guessed at.
 */

export type AgentEventKind = 'session-start' | 'session-end' | 'prompt' | 'read' | 'edit' | 'command' | 'search' | 'tool' | 'stop' | 'subagent' | 'other';

/** Activity states Athena will display for an agent event. */
export type AgentActivityState = 'ANALYZING' | 'PLANNING' | 'CODING' | 'TESTING' | 'REVIEWING' | 'SUCCESS' | 'IDLE';

export interface AgentEvent {
  id: string;
  ts: string;
  agent: string;
  /** Agent-provided session/conversation id, when available. */
  session: string | null;
  hook: string;
  kind: AgentEventKind;
  state: AgentActivityState;
  message: string;
  /** Project-relative paths the agent touched, when the hook reports them. */
  files: string[];
  /** Shell command, truncated and never parsed for meaning. */
  command: string | null;
  tool: string | null;
}

const TEST_COMMAND = /\b(test|vitest|jest|pytest|go test|cargo test|mocha|rspec|phpunit|gradle test|mvn test|tox|playwright|cypress)\b/i;
const REVIEW_COMMAND = /\b(lint|eslint|ruff|clippy|tsc|typecheck|type-check|mypy|flake8|rubocop|golangci-lint|audit)\b/i;

// Gemini CLI built-in tool names per https://geminicli.com/docs/reference/tools/ (checked 2026-09).
const READ_TOOLS = new Set(['read', 'glob', 'grep', 'notebookread', 'webfetch', 'websearch', 'ls', 'searchreplace', 'read_file', 'read_many_files', 'list_directory', 'grep_search', 'web_fetch', 'google_web_search']);
const EDIT_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit', 'applypatch', 'apply_patch', 'create_diff', 'str_replace', 'write_file', 'replace']);
const SEARCH_TOOLS = new Set(['grep', 'glob', 'grep_search']);

function truncate(s: string, n = 160): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function filesFrom(input: Record<string, unknown> | null, payload: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const source of [input, payload]) {
    if (!source) continue;
    for (const key of ['file_path', 'filePath', 'path', 'notebook_path', 'target_file']) {
      const v = asString(source[key]);
      if (v) out.push(v);
    }
    const edits = source.edits;
    if (Array.isArray(edits)) {
      for (const e of edits) {
        const v = e && typeof e === 'object' ? asString((e as Record<string, unknown>).file_path) : null;
        if (v) out.push(v);
      }
    }
  }
  return [...new Set(out)];
}

/** File paths named in an apply_patch body (`*** Update File: path` and friends). */
export function patchFiles(patch: string): string[] {
  const out: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) {
    const f = (m[1] ?? m[2])!.trim();
    if (f) out.push(f);
  }
  return [...new Set(out)];
}

interface Classified {
  kind: AgentEventKind;
  state: AgentActivityState;
  message: string;
}

function classifyTool(tool: string, command: string | null, files: string[]): Classified {
  const t = tool.toLowerCase().replace(/^mcp__/, '');
  const where = files.length ? ` ${files.slice(0, 2).join(', ')}${files.length > 2 ? ` +${files.length - 2}` : ''}` : '';
  if (EDIT_TOOLS.has(t)) return { kind: 'edit', state: 'CODING', message: `Editing${where || ' files'}` };
  if (READ_TOOLS.has(t)) return { kind: SEARCH_TOOLS.has(t) ? 'search' : 'read', state: 'ANALYZING', message: `Reading${where || ` (${tool})`}` };
  if (t === 'bash' || t === 'shell' || t === 'powershell' || t === 'run_shell_command' || t.includes('terminal')) {
    if (command && TEST_COMMAND.test(command)) return { kind: 'command', state: 'TESTING', message: `Running tests: ${command}` };
    if (command && REVIEW_COMMAND.test(command)) return { kind: 'command', state: 'REVIEWING', message: `Running checks: ${command}` };
    return { kind: 'command', state: 'CODING', message: command ? `Running: ${command}` : 'Running a shell command' };
  }
  if (t === 'task' || t === 'agent') return { kind: 'subagent', state: 'PLANNING', message: 'Delegating to a subagent' };
  if (t === 'todowrite' || t === 'exitplanmode' || t === 'plan' || t === 'update_plan' || t === 'write_todos' || t === 'enter_plan_mode' || t === 'exit_plan_mode') return { kind: 'tool', state: 'PLANNING', message: 'Updating its plan' };
  return { kind: 'tool', state: 'CODING', message: `Using ${tool}` };
}

/**
 * Map a hook payload to an Athena event. Returns null for hooks that carry no
 * useful signal (so Athena stays quiet instead of inventing activity).
 */
export function normalizeHookEvent(agent: string, hookName: string, payload: Record<string, unknown>): AgentEvent | null {
  const hook = hookName || asString(payload.hook_event_name) || 'unknown';
  const h = hook.toLowerCase();
  const session = asString(payload.session_id) ?? asString(payload.conversation_id) ?? null;
  const toolInput = payload.tool_input && typeof payload.tool_input === 'object' ? (payload.tool_input as Record<string, unknown>) : null;
  const tool = asString(payload.tool_name) ?? asString(payload.tool) ?? null;
  // Codex's apply_patch carries the patch text in tool_input.command: report the
  // files it touches, never the patch body as if it were a shell command.
  const isPatch = tool?.toLowerCase() === 'apply_patch';
  const rawCommand = asString(toolInput?.command) ?? asString(payload.command);
  const command = rawCommand && !isPatch ? truncate(rawCommand) : null;
  const files = isPatch && rawCommand ? patchFiles(rawCommand) : filesFrom(toolInput, payload);

  let c: Classified | null = null;
  if (h === 'sessionstart' || h === 'workspaceopen') c = { kind: 'session-start', state: 'IDLE', message: 'Session started' };
  else if (h === 'sessionend') c = { kind: 'session-end', state: 'IDLE', message: 'Session ended' };
  // Gemini CLI: BeforeAgent fires after the developer submits a prompt; AfterAgent when the turn ends.
  else if (h === 'userpromptsubmit' || h === 'beforesubmitprompt' || h === 'beforeagent') c = { kind: 'prompt', state: 'PLANNING', message: 'Received a new task from the developer' };
  else if (h === 'stop' || h === 'afteragentresponse' || h === 'afteragent') c = { kind: 'stop', state: 'SUCCESS', message: 'Finished responding' };
  else if (h === 'subagentstart') c = { kind: 'subagent', state: 'PLANNING', message: 'Subagent started' };
  else if (h === 'subagentstop') c = { kind: 'subagent', state: 'CODING', message: 'Subagent finished' };
  else if (h === 'beforeshellexecution') c = classifyTool('bash', command, files);
  else if (h === 'aftershellexecution') return null; // the "before" event already reported it
  else if (h === 'beforereadfile' || h === 'beforetabfileread') c = classifyTool('read', null, files);
  else if (h === 'afterfileedit' || h === 'aftertabfileedit') c = classifyTool('edit', null, files);
  else if (h === 'pretooluse' || h === 'permissionrequest' || h === 'beforetool') c = tool ? classifyTool(tool, command, files) : null;
  else if (h === 'posttooluse' || h === 'posttoolusefailure' || h === 'aftertool') return null; // avoid duplicating PreToolUse
  else if (h === 'pretoolusefailure') return null;
  else c = { kind: 'other', state: 'CODING', message: `Hook: ${hook}` };

  if (!c) return null;
  return {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    agent,
    session,
    hook,
    kind: c.kind,
    state: c.state,
    message: c.message,
    files: files.slice(0, 10),
    command,
    tool,
  };
}

/** Hook events Athena installs, per agent. */
export const CLAUDE_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop', 'SessionEnd'] as const;
/** Codex hook events (https://learn.chatgpt.com/docs/hooks); names match Claude Code's. */
export const CODEX_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop', 'SessionEnd'] as const;
export const CURSOR_HOOK_EVENTS = ['sessionStart', 'beforeSubmitPrompt', 'beforeShellExecution', 'afterFileEdit', 'stop', 'sessionEnd'] as const;
/**
 * GitHub Copilot hook events (PascalCase form, accepted by Copilot CLI, cloud agent
 * and VS Code; payloads then use snake_case like Claude Code's). Limited to events
 * both https://docs.github.com/en/copilot/reference/hooks-reference and
 * https://code.visualstudio.com/docs/agents/reference/hooks-reference document.
 */
export const COPILOT_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'] as const;
/** Gemini CLI hook events (https://geminicli.com/docs/hooks/reference/). */
export const GEMINI_HOOK_EVENTS = ['SessionStart', 'BeforeAgent', 'BeforeTool', 'AfterAgent', 'SessionEnd'] as const;
