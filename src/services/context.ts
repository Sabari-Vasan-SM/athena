import path from 'node:path';
import { analyzeProject } from '../core/analyzer/analyze.js';
import { buildGraph, GRAPH_FILE, saveGraph, type ProjectGraph } from '../core/graph/graph.js';
import { KNOWLEDGE_DOCS, type DocId } from '../core/knowledge/documents.js';
import { CONTEXT_MEMORY_LIMIT, documentSections, formatContext, selectContext, type ContextMemory, type RelevantContext } from '../core/context/context-engine.js';
import { recall } from '../core/memory/memory.js';
import { athenaDir } from '../core/state/state.js';
import { readTextIfExists } from '../core/util/fs.js';
import { AthenaError } from './errors.js';
import { listMemory } from './memory.js';
import { projectSession } from './project-session.js';

export { formatContext } from '../core/context/context-engine.js';
export type { ContextMemory, RelevantContext } from '../core/context/context-engine.js';

/** Build (or rebuild) the project graph from the current analysis. */
export async function refreshGraph(root: string, opts: { signal?: AbortSignal } = {}): Promise<ProjectGraph> {
  const session = projectSession(root);
  const st = await session.state();
  const analysis = await analyzeProject(root, { signal: opts.signal });
  const files = analysis.files.map((f) => f.path);
  const graph = await buildGraph(analysis.model, {
    files,
    signal: opts.signal,
    read: async (rel) => readTextIfExists(path.join(root, rel)).catch(() => null),
  });
  await saveGraph(root, graph);
  await session.remember(GRAPH_FILE, graph);
  return graph;
}

export async function getGraph(root: string, opts: { build?: boolean; signal?: AbortSignal } = {}): Promise<ProjectGraph | null> {
  const existing = await projectSession(root).graph();
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
    memories: await memoriesFor(root, task),
  });
}

/**
 * Recall project memories for a task: flagged (possible prompt-injection) entries are
 * excluded, confirmed ones come first. Memory is optional — a broken or missing store
 * never fails context selection.
 */
export async function memoriesFor(root: string, task: string, files: string[] = []): Promise<ContextMemory[]> {
  let hits;
  try {
    hits = recall(await listMemory(root), { task, files, limit: CONTEXT_MEMORY_LIMIT * 2 });
  } catch {
    return [];
  }
  const rank = (s: string) => (s === 'confirmed' ? 0 : 1);
  return hits
    .map((h, i) => ({ h, i }))
    .sort((a, b) => rank(a.h.entry.status) - rank(b.h.entry.status) || a.i - b.i)
    .slice(0, CONTEXT_MEMORY_LIMIT)
    .map(({ h: { entry: e, why } }) => ({
      id: e.id,
      kind: e.kind,
      status: e.status === 'confirmed' ? 'confirmed' : 'unreviewed',
      label: e.label,
      stale: e.stale,
      changedFiles: e.changedFiles,
      source: e.source,
      title: e.title,
      details: e.details,
      files: e.files,
      evidence: e.evidence,
      why,
    }));
}

/** Summary of the project graph for the UI/CLI. */
export async function graphSummary(root: string): Promise<{ built: boolean; builtAt: string | null; stats: ProjectGraph['stats'] | null; model: { hasModel: boolean } }> {
  const session = projectSession(root);
  // hasModel only needs a stat; parsing the whole model here was wasted work.
  const [graph, hasModel] = await Promise.all([session.graph(), session.hasModel()]);
  return { built: Boolean(graph), builtAt: graph?.builtAt ?? null, stats: graph?.stats ?? null, model: { hasModel } };
}
