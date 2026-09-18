import path from 'node:path';
import { analyzeProject } from '../core/analyzer/analyze.js';
import { buildGraph, loadGraph, saveGraph, type ProjectGraph } from '../core/graph/graph.js';
import { KNOWLEDGE_DOCS, type DocId } from '../core/knowledge/documents.js';
import { documentSections, formatContext, selectContext, type RelevantContext } from '../core/context/context-engine.js';
import { ProjectModel } from '../core/model/project-model.js';
import { athenaDir, readState } from '../core/state/state.js';
import { readTextIfExists } from '../core/util/fs.js';
import { AthenaError } from './errors.js';

export { formatContext } from '../core/context/context-engine.js';
export type { RelevantContext } from '../core/context/context-engine.js';

async function loadModel(root: string): Promise<ProjectModel | null> {
  const raw = await readTextIfExists(path.join(athenaDir(root), 'model.json'));
  if (!raw) return null;
  try {
    const parsed = ProjectModel.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Build (or rebuild) the project graph from the current analysis. */
export async function refreshGraph(root: string, opts: { signal?: AbortSignal } = {}): Promise<ProjectGraph> {
  const st = await readState(athenaDir(root));
  const analysis = await analyzeProject(root, { signal: opts.signal, reuse: st.kind === 'ok' ? st.state.fileIndex : undefined });
  const files = analysis.files.map((f) => f.path);
  const graph = await buildGraph(analysis.model, {
    files,
    signal: opts.signal,
    read: async (rel) => readTextIfExists(path.join(root, rel)).catch(() => null),
  });
  await saveGraph(root, graph);
  return graph;
}

export async function getGraph(root: string, opts: { build?: boolean; signal?: AbortSignal } = {}): Promise<ProjectGraph | null> {
  const existing = await loadGraph(root);
  if (existing) return existing;
  return opts.build ? refreshGraph(root, { signal: opts.signal }) : null;
}

export interface ContextOptions {
  maxChars?: number;
  /** Build the graph if it is missing. */
  buildGraph?: boolean;
  signal?: AbortSignal;
}

/**
 * Pick the knowledge an agent should read for a task. Deterministic: same task,
 * same project state, same answer.
 */
export async function getRelevantContext(root: string, task: string, opts: ContextOptions = {}): Promise<RelevantContext> {
  if (!task.trim()) throw new AthenaError('Describe the task to get relevant context.', 'For example: athena context "add refunds to the payments API"');
  const dir = athenaDir(root);
  const documents: Array<{ id: DocId; file: string; sections: Array<{ id: string; content: string }> }> = [];
  for (const d of KNOWLEDGE_DOCS) {
    if (d.id === 'rules') continue;
    const text = await readTextIfExists(path.join(dir, d.file));
    if (text) documents.push({ id: d.id, file: d.file, sections: documentSections(text) });
  }
  if (!documents.length) throw new AthenaError('No knowledge documents found.', 'Run `athena init` first.', 3);

  return selectContext({
    task,
    documents,
    rulesMarkdown: await readTextIfExists(path.join(dir, 'rules.md')),
    graph: await getGraph(root, { build: opts.buildGraph, signal: opts.signal }),
    maxChars: opts.maxChars,
  });
}

/** Summary of the project graph for the UI/CLI. */
export async function graphSummary(root: string): Promise<{ built: boolean; builtAt: string | null; stats: ProjectGraph['stats'] | null; model: { hasModel: boolean } }> {
  const graph = await loadGraph(root);
  return { built: Boolean(graph), builtAt: graph?.builtAt ?? null, stats: graph?.stats ?? null, model: { hasModel: Boolean(await loadModel(root)) } };
}
