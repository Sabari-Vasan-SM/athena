import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentAdapter, IntegrationCheck, PlannedFileChange } from '../../core/agents/adapter.js';
import { readTextIfExists } from '../../core/util/fs.js';
import { athenaInstructions } from '../common/instructions.js';
import { checkBlock, planBlock, removeBlockFrom, userEvidence } from '../common/files.js';
import { GEMINI_HOOK_EVENTS } from '../common/hook-events.js';
import { ATHENA_MARK, hookCommand, isAthenaEntry, mergeMcpServers, planJsonChange, pruneEmpty, readJsonFile, removeJsonHooks, stripMcpServers } from '../common/hooks.js';

const CONTEXT = 'GEMINI.md';
const SETTINGS = '.gemini/settings.json';

interface HookEntry {
  matcher?: string;
  hooks?: Array<Record<string, unknown>>;
}

/**
 * Gemini CLI. Checked 2026-09 against:
 * - https://geminicli.com/docs/cli/gemini-md/ — GEMINI.md is the default project context file → marked block.
 * - https://geminicli.com/docs/tools/mcp-server/ — project MCP servers under `mcpServers` in .gemini/settings.json
 *   (`command` + `args` means stdio; there is no `type` field).
 * - https://geminicli.com/docs/hooks/ and https://geminicli.com/docs/hooks/reference/ — hooks in the same file:
 *   hooks.<Event>[] = { matcher?, hooks: [{ name, type: "command", command, timeout (ms) }] }, payload on stdin
 *   (session_id, hook_event_name, cwd, tool_name, tool_input). Exit codes other than 0/2 are warnings only,
 *   and empty stdout is accepted (github.com/google-gemini/gemini-cli packages/core/src/hooks/hookRunner.ts).
 *   Hooks are on by default (hooksConfig.enabled); Gemini warns once about new project-level hooks.
 * - https://geminicli.com/docs/cli/trusted-folders/ — with folder trust enabled (off by default), an untrusted
 *   folder's .gemini/settings.json is not loaded, so MCP and hooks are ignored there.
 */
export const geminiCliAdapter: AgentAdapter = {
  id: 'gemini-cli',
  displayName: 'Gemini CLI',
  capabilities: { instructionsFile: true, scopedRules: false, hooks: true, mcp: true },
  supportNote: 'Uses the Athena block in GEMINI.md, plus an MCP server entry and hooks that report activity in .gemini/settings.json. Gemini CLI ignores .gemini/settings.json in folders it does not trust (when folder trust is enabled).',
  async detectPresence(root) {
    const evidence = await userEvidence(root, { files: [CONTEXT], dirs: ['.gemini'], athenaOwnedJson: [SETTINGS] });
    return { detectedInProject: evidence.length > 0, evidence };
  },
  async plan(ctx) {
    const changes: PlannedFileChange[] = [await planBlock(ctx.root, CONTEXT, athenaInstructions({ heading: '##' }))];
    changes.push(
      await planJsonChange(ctx.root, SETTINGS, (data) => {
        mergeMcpServers(data);
        const hooks = (data.hooks && typeof data.hooks === 'object' && !Array.isArray(data.hooks) ? data.hooks : {}) as Record<string, HookEntry[]>;
        for (const event of GEMINI_HOOK_EVENTS) {
          const list = (Array.isArray(hooks[event]) ? hooks[event] : []).filter((e) => !isAthenaEntry(e));
          list.push({
            ...(event === 'BeforeTool' ? { matcher: '*' } : {}),
            hooks: [{ name: 'athena-activity', type: 'command', command: geminiHookCommand(event), timeout: 10_000 }],
          });
          hooks[event] = list;
        }
        data.hooks = hooks;
      }),
    );
    return changes;
  },
  async remove(root) {
    const touched: string[] = [];
    if (await removeBlockFrom(root, CONTEXT)) touched.push(CONTEXT);
    const removed = await removeJsonHooks(
      root,
      SETTINGS,
      (data) => {
        stripMcpServers(data);
        const hooks = data.hooks as Record<string, HookEntry[]> | undefined;
        if (!hooks || typeof hooks !== 'object') return;
        for (const event of Object.keys(hooks)) {
          if (!Array.isArray(hooks[event])) continue;
          hooks[event] = hooks[event]!.filter((e) => !isAthenaEntry(e));
          if (!hooks[event]!.length) delete hooks[event];
        }
        pruneEmpty(data, 'hooks');
      },
      (d) => Object.keys(d).length === 0,
    );
    if (removed) touched.push(SETTINGS);
    await fs.rmdir(path.join(root, '.gemini')).catch(() => {}); // only if Athena left it empty
    return touched;
  },
  async check(root) {
    const checks: IntegrationCheck[] = [await checkBlock(root, CONTEXT, 'Gemini CLI')];
    const settings = await readJsonFile(path.join(root, SETTINGS)).catch(() => null);
    if (!settings?.existed) {
      checks.push({ ok: false, level: 'warn', message: `Gemini CLI: ${SETTINGS} not found — no MCP server and activity reporting is off` });
      return checks;
    }
    if (settings.malformed) {
      checks.push({ ok: false, level: 'error', message: `Gemini CLI: ${SETTINGS} is not valid JSON` });
      return checks;
    }
    const servers = settings.data.mcpServers as Record<string, unknown> | undefined;
    checks.push(
      servers && typeof servers === 'object' && 'athena' in servers
        ? { ok: true, level: 'ok', message: `Gemini CLI: MCP server registered in ${SETTINGS}` }
        : { ok: false, level: 'warn', message: `Gemini CLI: no Athena MCP entry in ${SETTINGS} — re-run \`athena agents add gemini-cli\`` },
    );
    const text = (await readTextIfExists(path.join(root, SETTINGS))) ?? '';
    const hooks = (settings.data.hooks ?? {}) as Record<string, unknown>;
    const configured = GEMINI_HOOK_EVENTS.filter((e) => isAthenaEntry(hooks[e]));
    checks.push(
      configured.length === GEMINI_HOOK_EVENTS.length && text.includes(ATHENA_MARK)
        ? { ok: true, level: 'ok', message: `Gemini CLI: activity hooks installed (${configured.length} events)` }
        : { ok: false, level: 'warn', message: `Gemini CLI: only ${configured.length}/${GEMINI_HOOK_EVENTS.length} activity hooks installed — re-run \`athena agents add gemini-cli\`` },
    );
    // Trust is decided inside Gemini CLI; Athena cannot confirm it from project files.
    checks.push({ ok: true, level: 'warn', message: 'Gemini CLI: if folder trust is enabled, trust this folder — Gemini CLI ignores .gemini/settings.json (MCP, hooks) in untrusted folders' });
    return checks;
  },
};

function geminiHookCommand(event: string): string {
  const cmd = hookCommand();
  const exe = /[\s"'$`\\]/.test(cmd) ? JSON.stringify(cmd) : cmd;
  return `${exe} event ${ATHENA_MARK} --agent gemini-cli --hook ${event}`;
}
