import { configureAgents, listAgents, removeAgents } from '../../services/agents.js';
import { requireProjectRoot, type GlobalOptions } from '../context.js';
import * as ui from '../ui/term.js';

export async function agentsListCommand(opts: GlobalOptions): Promise<void> {
  const root = await requireProjectRoot(opts);
  const rows = await listAgents(root);
  if (ui.isJson()) {
    ui.json(rows);
    return;
  }
  ui.heading('AI Agent Integrations');
  ui.line();
  for (const r of rows) {
    const icon = r.configured ? ui.c.green(ui.sym.dot) : ui.c.dim(ui.sym.ring);
    ui.line(`${icon} ${ui.c.bold(r.name)} ${ui.dim(`(${r.id})`)} — ${r.configured ? 'configured' : 'not configured'}${r.detectedInProject ? ui.dim(` · detected: ${r.evidence.join(', ')}`) : ''}`);
    ui.line(`  ${ui.dim(r.note)}`);
  }
  ui.line();
  ui.line(ui.dim('"Configured" means Athena instruction files are in place. Athena cannot observe agent activity yet (planned for Phase 4).'));
}

export async function agentsAddCommand(names: string[], opts: GlobalOptions): Promise<void> {
  const root = await requireProjectRoot(opts);
  const results = await configureAgents(root, names);
  if (ui.isJson()) ui.json({ ok: true, agents: results });
  else for (const r of results) ui.ok(`${r.id}: ${r.files.map((f) => `${f.path} (${f.action})`).join(', ')}`);
}

export async function agentsRemoveCommand(names: string[], opts: GlobalOptions): Promise<void> {
  const root = await requireProjectRoot(opts);
  const removed = await removeAgents(root, names);
  if (ui.isJson()) ui.json({ ok: true, removed });
  else ui.ok(removed.length ? `Removed Athena integration from ${removed.join(', ')}` : 'Nothing to remove');
}
