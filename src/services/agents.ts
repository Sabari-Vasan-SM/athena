import { ADAPTERS, applyChanges, resolveAdapters } from '../agents/registry.js';
import type { IntegrationCheck } from '../core/agents/adapter.js';
import { athenaDir, readState, writeState } from '../core/state/state.js';
import { AthenaError } from './errors.js';

function resolve(names: string[]) {
  try {
    return names.length === 1 && names[0] === 'all' ? ADAPTERS : resolveAdapters(names);
  } catch (err) {
    throw new AthenaError((err as Error).message);
  }
}

export interface AgentView {
  id: string;
  name: string;
  configured: boolean;
  configuredAt: string | null;
  files: string[];
  detectedInProject: boolean;
  evidence: string[];
  note: string;
  capabilities: { instructionsFile: boolean; scopedRules: boolean; hooks: boolean; mcp: boolean };
  checks: IntegrationCheck[];
  /** Athena cannot observe agent activity until hook integrations ship. */
  activityObservation: 'not-available';
}

export async function listAgents(root: string): Promise<AgentView[]> {
  const st = await readState(athenaDir(root));
  const out: AgentView[] = [];
  for (const a of ADAPTERS) {
    const presence = await a.detectPresence(root);
    const s = st.kind === 'ok' ? st.state.agents[a.id] : undefined;
    out.push({
      id: a.id,
      name: a.displayName,
      configured: Boolean(s?.configured),
      configuredAt: s?.configuredAt ?? null,
      files: s?.files ?? [],
      detectedInProject: presence.detectedInProject,
      evidence: presence.evidence,
      note: a.supportNote,
      capabilities: a.capabilities,
      checks: s?.configured ? await a.check(root) : [],
      activityObservation: 'not-available',
    });
  }
  return out;
}

export async function configureAgents(root: string, names: string[]): Promise<Array<{ id: string; files: Array<{ path: string; action: string }> }>> {
  const st = await readState(athenaDir(root));
  if (st.kind !== 'ok') throw new AthenaError('state.json is missing or corrupted.', 'Run `athena analyze` first.');
  const adapters = resolve(names);
  const results = [];
  for (const a of adapters) {
    const planned = await a.plan({ root, projectName: st.state.projectName });
    await applyChanges(root, planned);
    st.state.agents[a.id] = { configured: true, files: planned.map((p) => p.path), configuredAt: new Date().toISOString() };
    results.push({ id: a.id, files: planned.map((p) => ({ path: p.path, action: p.action })) });
  }
  await writeState(athenaDir(root), st.state);
  return results;
}

export async function removeAgents(root: string, names: string[]): Promise<string[]> {
  const st = await readState(athenaDir(root));
  const removed: string[] = [];
  for (const a of resolve(names)) {
    removed.push(...(await a.remove(root)));
    if (st.kind === 'ok') delete st.state.agents[a.id];
  }
  if (st.kind === 'ok') await writeState(athenaDir(root), st.state);
  return removed;
}
