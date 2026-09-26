import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentAdapter, PlannedFileChange } from '../core/agents/adapter.js';
import { writeFileAtomic } from '../core/util/fs.js';
import { resolveInside } from '../core/util/paths.js';
import { claudeCodeAdapter } from './claude-code/adapter.js';
import { cursorAdapter } from './cursor/adapter.js';
import { antigravityAdapter } from './antigravity/adapter.js';
import { codexAdapter } from './codex/adapter.js';
import { windsurfAdapter } from './windsurf/adapter.js';
import { clineAdapter } from './cline/adapter.js';
import { agentsMdAdapter } from './agents-md/adapter.js';

export const ADAPTERS: AgentAdapter[] = [claudeCodeAdapter, cursorAdapter, codexAdapter, antigravityAdapter, windsurfAdapter, clineAdapter, agentsMdAdapter];

/** Accepts ids and friendly aliases. */
export function resolveAdapters(names: string[]): AgentAdapter[] {
  const alias: Record<string, string> = { claude: 'claude-code', claudecode: 'claude-code', agents: 'agents-md', 'agents.md': 'agents-md', gemini: 'antigravity', 'openai-codex': 'codex', 'codex-cli': 'codex', codeium: 'windsurf' };
  const out: AgentAdapter[] = [];
  for (const raw of names) {
    const n = raw.trim().toLowerCase();
    if (!n) continue;
    const id = alias[n] ?? n;
    const a = ADAPTERS.find((x) => x.id === id);
    if (!a) throw new Error(`Unknown agent "${raw}". Supported: ${ADAPTERS.map((x) => x.id).join(', ')}`);
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

export async function applyChanges(root: string, changes: PlannedFileChange[]): Promise<PlannedFileChange[]> {
  const applied: PlannedFileChange[] = [];
  for (const c of changes) {
    if (c.action === 'unchanged') continue;
    const abs = resolveInside(root, c.path);
    if (!abs) throw new Error(`Refusing to write outside the project: ${c.path}`);
    // Don't follow a symlink planted at an integration path.
    const st = await fs.lstat(abs).catch(() => null);
    if (st?.isSymbolicLink()) throw new Error(`Refusing to write through symlink: ${c.path}`);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await writeFileAtomic(abs, c.content);
    if (abs.endsWith('.sh')) await fs.chmod(abs, 0o755).catch(() => {});
    applied.push(c);
  }
  return applied;
}
