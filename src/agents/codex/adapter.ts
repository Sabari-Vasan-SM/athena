import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { AgentAdapter, IntegrationCheck, PlannedFileChange } from '../../core/agents/adapter.js';
import { readTextIfExists } from '../../core/util/fs.js';
import { athenaInstructions } from '../common/instructions.js';
import { checkBlock, planBlock, removeBlockFrom, userEvidence } from '../common/files.js';
import { CODEX_HOOK_EVENTS } from '../common/hook-events.js';
import { ATHENA_MARK, hookCommand, isAthenaEntry, planJsonChange, pruneEmpty, removeJsonHooks } from '../common/hooks.js';

const INSTRUCTIONS = 'AGENTS.md';
const CONFIG = '.codex/config.toml';
const HOOKS_FILE = '.codex/hooks.json';

const TOML_START = '# athena:start (managed by Athena; `athena agents remove codex` removes it)';
const TOML_END = '# athena:end';

interface HookEntry {
  matcher?: string;
  hooks?: Array<Record<string, unknown>>;
}

/**
 * OpenAI Codex (CLI, IDE extension and app), per https://learn.chatgpt.com/docs/hooks
 * and the Codex MCP/config docs (checked 2026-09):
 * - instructions: Codex reads AGENTS.md, so Athena manages its marked block there
 *   (the same block the AGENTS.md integration writes).
 * - MCP: a `[mcp_servers.athena]` table in the project's .codex/config.toml.
 * - activity: .codex/hooks.json, `hooks.<Event>[] = { matcher?, hooks: [{ type: "command", command, timeout }] }`.
 *   Codex runs `command` as a shell string and passes the payload on stdin.
 * Codex only loads a project's .codex/ layer once the project is trusted.
 */
export const codexAdapter: AgentAdapter = {
  id: 'codex',
  displayName: 'Codex',
  capabilities: { instructionsFile: true, scopedRules: false, hooks: true, mcp: true },
  supportNote: 'Uses the Athena block in AGENTS.md, an MCP server entry in .codex/config.toml, and hooks in .codex/hooks.json that report activity. Codex loads .codex/ only for trusted projects.',
  async detectPresence(root) {
    const athenaOwned = (await tomlOnlyAthena(path.join(root, CONFIG))) ? [CONFIG] : [];
    const evidence = await userEvidence(root, { dirs: ['.codex'], athenaOwned, athenaOwnedJson: [HOOKS_FILE] });
    return { detectedInProject: evidence.length > 0, evidence };
  },
  async plan(ctx) {
    const changes: PlannedFileChange[] = [await planBlock(ctx.root, INSTRUCTIONS, athenaInstructions({ heading: '##' }))];
    changes.push(await planConfig(ctx.root));
    changes.push(
      await planJsonChange(ctx.root, HOOKS_FILE, (data) => {
        const hooks = (data.hooks && typeof data.hooks === 'object' && !Array.isArray(data.hooks) ? data.hooks : {}) as Record<string, HookEntry[]>;
        for (const event of CODEX_HOOK_EVENTS) {
          const list = (Array.isArray(hooks[event]) ? hooks[event] : []).filter((e) => !isAthenaEntry(e));
          // No matcher: the hook fires for every tool.
          list.push({ hooks: [{ type: 'command', command: codexHookCommand(event), timeout: 10 }] });
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
    if (await removeConfigBlock(root)) touched.push(CONFIG);
    const removed = await removeJsonHooks(
      root,
      HOOKS_FILE,
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
    if (removed) touched.push(HOOKS_FILE);
    return touched;
  },
  async check(root) {
    const checks: IntegrationCheck[] = [await checkBlock(root, INSTRUCTIONS, 'Codex')];

    const config = await readTextIfExists(path.join(root, CONFIG));
    checks.push(
      config?.includes(TOML_START) && config.includes('[mcp_servers.athena]')
        ? { ok: true, level: 'ok', message: `Codex: MCP server registered in ${CONFIG}` }
        : { ok: false, level: 'warn', message: `Codex: no Athena MCP entry in ${CONFIG} — re-run \`athena agents add codex\`` },
    );

    const hooks = await readTextIfExists(path.join(root, HOOKS_FILE));
    if (hooks === null) checks.push({ ok: false, level: 'warn', message: `Codex: ${HOOKS_FILE} not found — activity reporting is off` });
    else {
      const configured = CODEX_HOOK_EVENTS.filter((e) => new RegExp(`"${e}"`).test(hooks) && hooks.includes(ATHENA_MARK));
      checks.push(
        configured.length === CODEX_HOOK_EVENTS.length
          ? { ok: true, level: 'ok', message: `Codex: activity hooks installed (${configured.length} events)` }
          : { ok: false, level: 'warn', message: `Codex: only ${configured.length}/${CODEX_HOOK_EVENTS.length} activity hooks installed — re-run \`athena agents add codex\`` },
      );
    }

    checks.push(await trustCheck(root));
    return checks;
  },
};

function codexHookCommand(event: string): string {
  const cmd = hookCommand();
  const exe = /[\s"'$`\\]/.test(cmd) ? JSON.stringify(cmd) : cmd;
  return `${exe} event ${ATHENA_MARK} --agent codex --hook ${event}`;
}

function mcpBlock(): string {
  // TOML basic strings accept the same escapes JSON.stringify produces for paths and names.
  return [TOML_START, '[mcp_servers.athena]', `command = ${JSON.stringify(hookCommand())}`, 'args = ["mcp"]', TOML_END].join('\n');
}

/** Remove Athena's marked block from TOML text; everything else is kept as written. */
export function stripTomlBlock(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (!inside && line.startsWith('# athena:start')) inside = true;
    else if (inside && line.trim() === TOML_END) inside = false;
    else if (!inside) out.push(line);
  }
  return out.join('\n');
}

function parseTomlOrThrow(text: string): Record<string, unknown> {
  try {
    return parseToml(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${CONFIG} is not valid TOML — fix it before configuring Codex`);
  }
}

async function planConfig(root: string): Promise<PlannedFileChange> {
  const existing = await readTextIfExists(path.join(root, CONFIG));
  const base = existing === null ? '' : stripTomlBlock(existing);
  const parsed = parseTomlOrThrow(base);
  const servers = parsed.mcp_servers as Record<string, unknown> | undefined;
  // The developer already registered a server named "athena": leave their config alone.
  if (servers && 'athena' in servers) return { path: CONFIG, ownership: 'block', action: 'unchanged', content: existing ?? '' };
  const head = base.trimEnd();
  const content = `${head ? `${head}\n\n` : ''}${mcpBlock()}\n`;
  return { path: CONFIG, ownership: 'block', action: existing === null ? 'create' : existing === content ? 'unchanged' : 'update', content };
}

async function removeConfigBlock(root: string): Promise<boolean> {
  const file = path.join(root, CONFIG);
  const existing = await readTextIfExists(file);
  if (existing === null || !existing.includes(TOML_START)) return false;
  const next = stripTomlBlock(existing).trimEnd();
  if (next.trim() === '') await fs.rm(file, { force: true });
  else await fs.writeFile(file, `${next}\n`, 'utf8');
  return true;
}

async function tomlOnlyAthena(file: string): Promise<boolean> {
  const text = await readTextIfExists(file).catch(() => null);
  return text !== null && text.includes(TOML_START) && stripTomlBlock(text).trim() === '';
}

/**
 * Codex ignores a project's .codex/ layer (config, hooks) until the project is
 * trusted. Trust lives in the user's Codex config, which Athena only reads.
 */
async function trustCheck(root: string): Promise<IntegrationCheck> {
  const home = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
  const hint = `Codex loads .codex/ only for trusted projects: trust this folder when Codex asks, or add [projects."${root}"] trust_level = "trusted" to ${path.join(home, 'config.toml')}`;
  const text = await readTextIfExists(path.join(home, 'config.toml')).catch(() => null);
  if (text === null) return { ok: false, level: 'warn', message: `Codex: could not confirm this project is trusted. ${hint}` };
  let projects: Record<string, { trust_level?: unknown }> = {};
  try {
    projects = ((parseToml(text) as Record<string, unknown>).projects ?? {}) as typeof projects;
  } catch {
    return { ok: false, level: 'warn', message: `Codex: could not read ${path.join(home, 'config.toml')} to confirm trust. ${hint}` };
  }
  for (let dir = root; ; dir = path.dirname(dir)) {
    const entry = projects[dir];
    if (entry?.trust_level === 'trusted') return { ok: true, level: 'ok', message: `Codex: project is trusted${dir === root ? '' : ` (via ${dir})`}` };
    if (entry?.trust_level === 'untrusted') return { ok: false, level: 'warn', message: `Codex: ${dir} is marked untrusted, so Codex ignores .codex/. ${hint}` };
    if (path.dirname(dir) === dir) break;
  }
  return { ok: false, level: 'warn', message: `Codex: this project is not trusted yet. ${hint}` };
}
