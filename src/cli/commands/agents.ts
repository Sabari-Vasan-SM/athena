import { ADAPTERS, applyChanges, resolveAdapters } from '../../agents/registry.js';
import { athenaDir, readState, writeState } from '../../core/state/state.js';
import { requireProjectRoot, type GlobalOptions } from '../context.js';
import { AthenaError } from '../errors.js';
import * as ui from '../ui/term.js';

export async function agentsListCommand(opts: GlobalOptions): Promise<void> {
  const root = await requireProjectRoot(opts);
  const st = await readState(athenaDir(root));
  const rows = [];
  for (const a of ADAPTERS) {
    const presence = await a.detectPresence(root);
    rows.push({ id: a.id, name: a.displayName, configured: st.kind === 'ok' && Boolean(st.state.agents[a.id]?.configured), detectedInProject: presence.detectedInProject, evidence: presence.evidence, note: a.supportNote });
  }
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
  const dir = athenaDir(root);
  const st = await readState(dir);
  if (st.kind !== 'ok') throw new AthenaError('state.json is missing or corrupted.', 'Run `athena analyze` first.');
  let adapters;
  try {
    adapters = names.length === 1 && names[0] === 'all' ? ADAPTERS : resolveAdapters(names);
  } catch (err) {
    throw new AthenaError((err as Error).message);
  }
  const state = st.state;
  const results = [];
  for (const a of adapters) {
    const planned = await a.plan({ root, projectName: state.projectName });
    await applyChanges(root, planned);
    state.agents[a.id] = { configured: true, files: planned.map((p) => p.path), configuredAt: new Date().toISOString() };
    results.push({ id: a.id, files: planned.map((p) => ({ path: p.path, action: p.action })) });
    if (!ui.isJson()) ui.ok(`${a.displayName}: ${planned.map((p) => `${p.path} (${p.action})`).join(', ')}`);
  }
  await writeState(dir, state);
  if (ui.isJson()) ui.json({ ok: true, agents: results });
}

export async function agentsRemoveCommand(names: string[], opts: GlobalOptions): Promise<void> {
  const root = await requireProjectRoot(opts);
  const dir = athenaDir(root);
  const st = await readState(dir);
  let adapters;
  try {
    adapters = resolveAdapters(names);
  } catch (err) {
    throw new AthenaError((err as Error).message);
  }
  const removed: string[] = [];
  for (const a of adapters) {
    const touched = await a.remove(root);
    removed.push(...touched);
    if (st.kind === 'ok') delete st.state.agents[a.id];
    if (!ui.isJson()) ui.ok(`${a.displayName}: ${touched.length ? `removed from ${touched.join(', ')}` : 'nothing to remove'}`);
  }
  if (st.kind === 'ok') await writeState(dir, st.state);
  if (ui.isJson()) ui.json({ ok: true, removed });
}
