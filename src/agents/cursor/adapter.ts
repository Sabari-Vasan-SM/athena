import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentAdapter, PlannedFileChange } from '../../core/agents/adapter.js';
import { readTextIfExists } from '../../core/util/fs.js';
import { athenaInstructions } from '../common/instructions.js';
import { OWNED_HEADER, planOwned, removeOwned, userEvidence } from '../common/files.js';
import { CURSOR_HOOK_EVENTS } from '../common/hook-events.js';
import { isAthenaEntry, hookScript, mergeMcpServers, planJsonChange, pruneEmpty, removeJsonHooks, stripMcpServers } from '../common/hooks.js';

const RULE_FILE = '.cursor/rules/athena.mdc';
const HOOKS_FILE = '.cursor/hooks.json';
const HOOK_DIR = '.cursor/hooks';
const MCP_FILE = '.cursor/mcp.json';

/**
 * Cursor:
 * - rules: .cursor/rules/athena.mdc with frontmatter (alwaysApply)
 * - activity: .cursor/hooks.json ({ version: 1, hooks: { <event>: [{ command }] } })
 *   per https://cursor.com/docs/agent/hooks (checked 2026-09). Cursor runs a script
 *   path, so Athena writes a small forwarding script for the current platform.
 */
export const cursorAdapter: AgentAdapter = {
  id: 'cursor',
  displayName: 'Cursor',
  capabilities: { instructionsFile: true, scopedRules: true, hooks: true, mcp: true },
  supportNote: 'Uses an Athena-owned project rule at .cursor/rules/athena.mdc, hooks in .cursor/hooks.json that report activity, and an MCP server entry in .cursor/mcp.json.',
  async detectPresence(root) {
    const evidence = await userEvidence(root, { files: ['.cursorrules'], dirs: ['.cursor'], athenaOwned: [RULE_FILE, `${HOOK_DIR}/athena-hook.sh`, `${HOOK_DIR}/athena-hook.cmd`], athenaOwnedJson: [HOOKS_FILE, MCP_FILE] });
    return { detectedInProject: evidence.length > 0, evidence };
  },
  async plan(ctx) {
    const content = ['---', 'description: Athena project intelligence — how to use .athena/ knowledge and project rules', 'globs:', 'alwaysApply: true', '---', OWNED_HEADER, '', athenaInstructions({ heading: '#' }), ''].join('\n');
    const changes: PlannedFileChange[] = [await planOwned(ctx.root, RULE_FILE, content)];

    const script = hookScript('cursor');
    const scriptRel = `${HOOK_DIR}/${script.file}`;
    changes.push(await planOwned(ctx.root, scriptRel, script.content));
    changes.push(
      await planJsonChange(ctx.root, HOOKS_FILE, (data) => {
        data.version = typeof data.version === 'number' ? data.version : 1;
        const hooks = (data.hooks && typeof data.hooks === 'object' && !Array.isArray(data.hooks) ? data.hooks : {}) as Record<string, Array<Record<string, unknown>>>;
        for (const event of CURSOR_HOOK_EVENTS) {
          const list = (Array.isArray(hooks[event]) ? hooks[event] : []).filter((e) => !isAthenaEntry(e));
          list.push({ command: `./${scriptRel} ${event} --athena-hook`, timeout: 10 });
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
    if (await removeOwned(root, RULE_FILE)) touched.push(RULE_FILE);
    if (await removeJsonHooks(root, MCP_FILE, stripMcpServers, (d) => Object.keys(d).length === 0)) touched.push(MCP_FILE);
    for (const f of ['athena-hook.sh', 'athena-hook.cmd']) {
      if (await removeOwned(root, `${HOOK_DIR}/${f}`)) touched.push(`${HOOK_DIR}/${f}`);
    }
    const removed = await removeJsonHooks(
      root,
      HOOKS_FILE,
      (data) => {
        const hooks = data.hooks as Record<string, Array<Record<string, unknown>>> | undefined;
        if (!hooks) return;
        for (const event of Object.keys(hooks)) {
          hooks[event] = (hooks[event] ?? []).filter((e) => !isAthenaEntry(e));
          if (!hooks[event]!.length) delete hooks[event];
        }
        pruneEmpty(data, 'hooks');
        if (Object.keys(data).length === 1 && 'version' in data) delete data.version;
      },
      (data) => Object.keys(data).length === 0,
    );
    if (removed) touched.push(HOOKS_FILE);
    await fs.rm(path.join(root, HOOK_DIR), { recursive: true, force: true }).catch(() => {});
    return touched;
  },
  async check(root) {
    const text = await readTextIfExists(path.join(root, RULE_FILE));
    const checks = [];
    if (text === null) checks.push({ ok: false, level: 'warn' as const, message: `Cursor: ${RULE_FILE} not found` });
    else if (!/^---[\s\S]*?alwaysApply:\s*true[\s\S]*?---/.test(text)) checks.push({ ok: false, level: 'warn' as const, message: `Cursor: ${RULE_FILE} frontmatter was modified (alwaysApply is not true)` });
    else checks.push({ ok: true, level: 'ok' as const, message: `Cursor: ${RULE_FILE}` });

    const hooks = await readTextIfExists(path.join(root, HOOKS_FILE));
    if (hooks === null) checks.push({ ok: false, level: 'warn' as const, message: `Cursor: ${HOOKS_FILE} not found — activity reporting is off` });
    else if (!hooks.includes('--athena-hook')) checks.push({ ok: false, level: 'warn' as const, message: `Cursor: no Athena hooks in ${HOOKS_FILE}` });
    else checks.push({ ok: true, level: 'ok' as const, message: `Cursor: activity hooks installed (${CURSOR_HOOK_EVENTS.length} events)` });
    return checks;
  },
};
