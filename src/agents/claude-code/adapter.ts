import path from 'node:path';
import type { AgentAdapter, PlannedFileChange } from '../../core/agents/adapter.js';
import { readTextIfExists } from '../../core/util/fs.js';
import { athenaInstructions } from '../common/instructions.js';
import { checkBlock, planBlock, removeBlockFrom, userEvidence } from '../common/files.js';
import { CLAUDE_HOOK_EVENTS } from '../common/hook-events.js';
import { hookArgs, hookCommand, isAthenaEntry, mergeMcpServers, planJsonChange, pruneEmpty, removeJsonHooks, stripMcpServers } from '../common/hooks.js';

const SETTINGS = '.claude/settings.json';
const MCP_FILE = '.mcp.json';

interface HookEntry {
  matcher?: string;
  hooks?: Array<Record<string, unknown>>;
}

/**
 * Claude Code:
 * - project memory: a marked block in CLAUDE.md, importing .athena/rules.md
 * - activity: hooks in .claude/settings.json calling `athena event`
 *   Format per https://code.claude.com/docs/en/hooks (checked 2026-09):
 *   hooks.<EventName>[] = { matcher, hooks: [{ type: "command", command, args, async, timeout }] }
 *   `args` uses exec form (no shell) and `async: true` keeps the agent unblocked.
 */
export const claudeCodeAdapter: AgentAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  capabilities: { instructionsFile: true, scopedRules: false, hooks: true, mcp: true },
  supportNote: 'Uses CLAUDE.md with an @-import of .athena/rules.md, hooks in .claude/settings.json that report activity, and an MCP server entry in .mcp.json.',
  async detectPresence(root) {
    const evidence = await userEvidence(root, { files: ['CLAUDE.md', 'CLAUDE.local.md'], dirs: ['.claude'], athenaOwnedJson: [SETTINGS, MCP_FILE] });
    return { detectedInProject: evidence.length > 0, evidence };
  },
  async plan(ctx) {
    const changes: PlannedFileChange[] = [await planBlock(ctx.root, 'CLAUDE.md', athenaInstructions({ heading: '##', rulesImport: '@.athena/rules.md' }))];
    changes.push(
      await planJsonChange(ctx.root, SETTINGS, (data) => {
        const hooks = (data.hooks && typeof data.hooks === 'object' && !Array.isArray(data.hooks) ? data.hooks : {}) as Record<string, HookEntry[]>;
        for (const event of CLAUDE_HOOK_EVENTS) {
          const list = (Array.isArray(hooks[event]) ? hooks[event] : []).filter((e) => !isAthenaEntry(e));
          list.push({
            ...(event === 'PreToolUse' ? { matcher: '*' } : {}),
            hooks: [{ type: 'command', command: hookCommand(), args: hookArgs('claude-code', event), async: true, timeout: 10 }],
          });
          hooks[event] = list;
        }
        data.hooks = hooks;
      }),
    );
    changes.push(await planJsonChange(ctx.root, MCP_FILE, mergeMcpServers));
    return changes;
  },
  async remove(root) {
    const touched: string[] = [];
    if (await removeBlockFrom(root, 'CLAUDE.md')) touched.push('CLAUDE.md');
    if (await removeJsonHooks(root, MCP_FILE, stripMcpServers, (d) => Object.keys(d).length === 0)) touched.push(MCP_FILE);
    const removed = await removeJsonHooks(
      root,
      SETTINGS,
      (data) => {
        const hooks = data.hooks as Record<string, HookEntry[]> | undefined;
        if (!hooks) return;
        for (const event of Object.keys(hooks)) {
          hooks[event] = (hooks[event] ?? []).filter((e) => !isAthenaEntry(e));
          if (!hooks[event]!.length) delete hooks[event];
        }
        pruneEmpty(data, 'hooks');
      },
      (data) => Object.keys(data).length === 0,
    );
    if (removed) touched.push(SETTINGS);
    return touched;
  },
  async check(root) {
    const checks = [await checkBlock(root, 'CLAUDE.md', 'Claude Code')];
    const text = await readTextIfExists(path.join(root, SETTINGS));
    if (text === null) checks.push({ ok: false, level: 'warn', message: `Claude Code: ${SETTINGS} not found — activity reporting is off` });
    else {
      const configured = CLAUDE_HOOK_EVENTS.filter((e) => new RegExp(`"${e}"`).test(text) && text.includes('--athena-hook'));
      checks.push(
        configured.length === CLAUDE_HOOK_EVENTS.length
          ? { ok: true, level: 'ok', message: `Claude Code: activity hooks installed (${configured.length} events)` }
          : { ok: false, level: 'warn', message: `Claude Code: only ${configured.length}/${CLAUDE_HOOK_EVENTS.length} activity hooks installed — re-run \`athena agents add claude-code\`` },
      );
    }
    return checks;
  },
};
