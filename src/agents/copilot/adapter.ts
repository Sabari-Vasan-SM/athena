import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentAdapter, IntegrationCheck, PlannedFileChange } from '../../core/agents/adapter.js';
import { exists, readTextIfExists } from '../../core/util/fs.js';
import { athenaInstructions } from '../common/instructions.js';
import { checkBlock, jsonOnlyAthena, planBlock, removeBlockFrom, userEvidence } from '../common/files.js';
import { COPILOT_HOOK_EVENTS } from '../common/hook-events.js';
import { ATHENA_MARK, hookCommand, isAthenaEntry, planJsonChange, pruneEmpty, readJsonFile, removeJsonHooks } from '../common/hooks.js';

const INSTRUCTIONS = '.github/copilot-instructions.md';
const MCP_FILE = '.vscode/mcp.json';
const HOOKS_DIR = '.github/hooks';
const HOOKS_FILE = `${HOOKS_DIR}/athena.json`;

/**
 * GitHub Copilot (VS Code agent mode, Copilot CLI, Copilot cloud agent). Checked 2026-09 against:
 * - https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions
 *   repository-wide instructions live in .github/copilot-instructions.md → Athena manages a marked block.
 * - https://code.visualstudio.com/docs/copilot/customization/mcp-servers
 *   workspace MCP config is .vscode/mcp.json with a top-level `servers` object (not `mcpServers`).
 * - https://docs.github.com/en/copilot/reference/hooks-reference and
 *   https://code.visualstudio.com/docs/agents/reference/hooks-reference
 *   repository hooks are .github/hooks/*.json: `{ version: 1, hooks: { <Event>: [{ type: "command", bash, powershell, timeoutSec }] } }`.
 *   PascalCase event names make Copilot send snake_case payloads (session_id, tool_name, tool_input),
 *   and VS Code maps `bash`/`powershell` to its OS-specific commands. VS Code hooks are in Preview.
 * Copilot CLI and the cloud agent deny the tool call when a PreToolUse command exits non-zero, and the
 * cloud agent runs these hooks where Athena is usually not installed — so every command ends with an
 * explicit success exit. Athena writes its own hooks file and never edits the developer's.
 */
export const copilotAdapter: AgentAdapter = {
  id: 'copilot',
  displayName: 'GitHub Copilot',
  capabilities: { instructionsFile: true, scopedRules: false, hooks: true, mcp: true },
  supportNote: 'Uses the Athena block in .github/copilot-instructions.md, an MCP server entry in .vscode/mcp.json (VS Code), and hooks in .github/hooks/athena.json that report activity (VS Code hooks are in Preview; Copilot CLI reads the same file).',
  async detectPresence(root) {
    const evidence = await userEvidence(root, { files: [INSTRUCTIONS], dirs: ['.github/instructions', HOOKS_DIR], athenaOwnedJson: [HOOKS_FILE] });
    if ((await exists(path.join(root, MCP_FILE))) && !(await jsonOnlyAthena(path.join(root, MCP_FILE)))) evidence.push(MCP_FILE);
    return { detectedInProject: evidence.length > 0, evidence };
  },
  async plan(ctx) {
    const changes: PlannedFileChange[] = [await planBlock(ctx.root, INSTRUCTIONS, athenaInstructions({ heading: '##' }))];
    changes.push(
      await planJsonChange(ctx.root, MCP_FILE, (data) => {
        const servers = (data.servers && typeof data.servers === 'object' && !Array.isArray(data.servers) ? data.servers : {}) as Record<string, unknown>;
        servers.athena = { type: 'stdio', command: hookCommand(), args: ['mcp'] };
        data.servers = servers;
      }),
    );
    changes.push(
      await planJsonChange(ctx.root, HOOKS_FILE, (data) => {
        data.version = typeof data.version === 'number' ? data.version : 1;
        const hooks = (data.hooks && typeof data.hooks === 'object' && !Array.isArray(data.hooks) ? data.hooks : {}) as Record<string, unknown[]>;
        for (const event of COPILOT_HOOK_EVENTS) {
          const list = (Array.isArray(hooks[event]) ? hooks[event] : []).filter((e) => !isAthenaEntry(e));
          list.push({ type: 'command', bash: posixCommand(event), powershell: powershellCommand(event), timeoutSec: 10 });
          hooks[event] = list;
        }
        data.hooks = hooks;
      }),
    );
    return changes;
  },
  async remove(root) {
    const touched: string[] = [];
    if (await removeBlockFrom(root, INSTRUCTIONS)) touched.push(INSTRUCTIONS);
    const mcpRemoved = await removeJsonHooks(
      root,
      MCP_FILE,
      (data) => {
        const servers = data.servers as Record<string, unknown> | undefined;
        if (!servers || typeof servers !== 'object') return;
        delete servers.athena;
        pruneEmpty(data, 'servers');
      },
      (d) => Object.keys(d).length === 0,
    );
    if (mcpRemoved) touched.push(MCP_FILE);
    const hooksRemoved = await removeJsonHooks(
      root,
      HOOKS_FILE,
      (data) => {
        const hooks = data.hooks as Record<string, unknown[]> | undefined;
        if (!hooks || typeof hooks !== 'object') return;
        for (const event of Object.keys(hooks)) {
          if (!Array.isArray(hooks[event])) continue;
          hooks[event] = hooks[event]!.filter((e) => !isAthenaEntry(e));
          if (!hooks[event]!.length) delete hooks[event];
        }
        pruneEmpty(data, 'hooks');
        if (Object.keys(data).length === 1 && 'version' in data) delete data.version;
      },
      (d) => Object.keys(d).length === 0,
    );
    if (hooksRemoved) touched.push(HOOKS_FILE);
    // Drop directories Athena created, only if nothing else lives there.
    for (const dir of [HOOKS_DIR, '.vscode']) await fs.rmdir(path.join(root, dir)).catch(() => {});
    return touched;
  },
  async check(root) {
    const checks: IntegrationCheck[] = [await checkBlock(root, INSTRUCTIONS, 'GitHub Copilot')];

    const mcp = await readJsonFile(path.join(root, MCP_FILE)).catch(() => null);
    const servers = mcp?.data.servers as Record<string, unknown> | undefined;
    if (mcp?.malformed) checks.push({ ok: false, level: 'error', message: `GitHub Copilot: ${MCP_FILE} is not valid JSON` });
    else
      checks.push(
        servers && typeof servers === 'object' && 'athena' in servers
          ? { ok: true, level: 'ok', message: `GitHub Copilot: MCP server registered in ${MCP_FILE} (VS Code)` }
          : { ok: false, level: 'warn', message: `GitHub Copilot: no Athena MCP entry in ${MCP_FILE} — re-run \`athena agents add copilot\`` },
      );

    const hooks = await readTextIfExists(path.join(root, HOOKS_FILE));
    if (hooks === null) checks.push({ ok: false, level: 'warn', message: `GitHub Copilot: ${HOOKS_FILE} not found — activity reporting is off` });
    else {
      const configured = COPILOT_HOOK_EVENTS.filter((e) => new RegExp(`"${e}"`).test(hooks) && hooks.includes(ATHENA_MARK));
      checks.push(
        configured.length === COPILOT_HOOK_EVENTS.length
          ? { ok: true, level: 'ok', message: `GitHub Copilot: activity hooks installed (${configured.length} events)` }
          : { ok: false, level: 'warn', message: `GitHub Copilot: only ${configured.length}/${COPILOT_HOOK_EVENTS.length} activity hooks installed — re-run \`athena agents add copilot\`` },
      );
    }
    return checks;
  },
};

/** bash/sh: never fail, so a missing `athena` cannot deny Copilot's tool calls. */
function posixCommand(event: string): string {
  const cmd = hookCommand();
  const exe = /[\s"'$`\\]/.test(cmd) ? `'${cmd.replace(/'/g, `'\\''`)}'` : cmd;
  return `${exe} event ${ATHENA_MARK} --agent copilot --hook ${event} 2>/dev/null || true`;
}

/** PowerShell: call operator plus an explicit `exit 0` for the same reason. */
function powershellCommand(event: string): string {
  const exe = `'${hookCommand().replace(/'/g, "''")}'`;
  return `& ${exe} event ${ATHENA_MARK} --agent copilot --hook ${event} 2>$null; exit 0`;
}
