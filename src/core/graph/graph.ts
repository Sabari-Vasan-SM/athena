import { z } from 'zod';
import path from 'node:path';
import { ProjectModel } from '../model/project-model.js';
import { readTextIfExists, writeFileAtomic } from '../util/fs.js';
import { athenaDir } from '../state/state.js';
import { toPosix } from '../util/paths.js';

/**
 * The project graph: a structured view of what the analysis found and how the
 * pieces connect. It is derived entirely from the model and the files the model
 * already points at — no claim here goes beyond DETECTED evidence.
 */

export const NodeKind = z.enum(['package', 'file', 'route', 'entity', 'framework', 'command', 'infra', 'doc']);
export type NodeKind = z.infer<typeof NodeKind>;

export const EdgeKind = z.enum(['contains', 'imports', 'handles', 'defines', 'depends_on', 'documents', 'runs']);
export type EdgeKind = z.infer<typeof EdgeKind>;

export const GraphNode = z.object({
  id: z.string(),
  kind: NodeKind,
  name: z.string(),
  path: z.string().optional(),
  meta: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});
export type GraphNode = z.infer<typeof GraphNode>;

export const GraphEdge = z.object({ from: z.string(), to: z.string(), kind: EdgeKind });
export type GraphEdge = z.infer<typeof GraphEdge>;

export const ProjectGraph = z.object({
  schemaVersion: z.literal(1),
  builtAt: z.string(),
  nodes: z.array(GraphNode),
  edges: z.array(GraphEdge),
  stats: z.object({ nodes: z.number(), edges: z.number(), byKind: z.record(z.string(), z.number()) }),
});
export type ProjectGraph = z.infer<typeof ProjectGraph>;

export const GRAPH_FILE = 'graph.json';

export const nodeId = (kind: NodeKind, key: string) => `${kind}:${key}`;

const IMPORT_RE = /^\s*(?:import\s[^'"]*from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|export\s[^'"]*from\s*['"]([^'"]+)['"]|(?:const|let|var)\s[^=]*=\s*require\(\s*['"]([^'"]+)['"]\s*\))/gm;
const PY_IMPORT_RE = /^\s*(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/gm;

export interface BuildOptions {
  /** Read a project file (repo-relative POSIX). */
  read(rel: string): Promise<string | null>;
  /** All indexed file paths, used to resolve imports. */
  files: string[];
  /** Maximum files to parse for import edges. */
  maxImportFiles?: number;
  signal?: AbortSignal;
}

function resolveImport(fromFile: string, spec: string, fileSet: Set<string>): string | null {
  if (!spec.startsWith('.')) return null; // package import, not a project file
  const base = toPosix(path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec)));
  const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.py', '.vue', '.svelte'].flatMap((ext) => [`${base}${ext}`, `${base}/index${ext}`, `${base}/__init__${ext}`])];
  return candidates.find((c) => fileSet.has(c)) ?? null;
}

/** Build the graph from an analyzed model. Import edges are parsed only for files the model references. */
export async function buildGraph(model: ProjectModel, opts: BuildOptions): Promise<ProjectGraph> {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const fileSet = new Set(opts.files);
  const addNode = (n: GraphNode) => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
    return n.id;
  };
  const addEdge = (from: string, to: string, kind: EdgeKind) => {
    if (from === to || !nodes.has(from) || !nodes.has(to)) return;
    if (!edges.some((e) => e.from === from && e.to === to && e.kind === kind)) edges.push({ from, to, kind });
  };
  const fileNode = (p: string) => addNode({ id: nodeId('file', p), kind: 'file', name: path.posix.basename(p), path: p, meta: {} });

  // Packages
  for (const pkg of model.workspace.packages) {
    addNode({ id: nodeId('package', pkg.name), kind: 'package', name: pkg.name, path: pkg.path, meta: { kind: pkg.kind, ecosystem: pkg.ecosystem } });
  }
  for (const pkg of model.workspace.packages) {
    for (const dep of pkg.internalDependencies) addEdge(nodeId('package', pkg.name), nodeId('package', dep), 'depends_on');
  }

  // Frameworks
  for (const f of model.frameworks) {
    const id = addNode({ id: nodeId('framework', `${f.name}@${f.root}`), kind: 'framework', name: f.name, path: f.root, meta: { category: f.category, status: f.provenance.status, confidence: f.provenance.confidence } });
    const owner = model.workspace.packages.find((p) => p.path === f.root);
    if (owner) addEdge(nodeId('package', owner.name), id, 'contains');
  }

  // Routes → handler files
  for (const r of model.routes) {
    const id = addNode({ id: nodeId('route', `${r.method} ${r.path} ${r.file}`), kind: 'route', name: `${r.method} ${r.path}`, path: r.file, meta: { method: r.method, framework: r.framework, ...(r.line ? { line: r.line } : {}) } });
    addEdge(id, fileNode(r.file), 'handles');
  }

  // Entities → defining files
  for (const e of model.dbEntities) {
    const id = addNode({ id: nodeId('entity', `${e.name}@${e.file}`), kind: 'entity', name: e.name, path: e.file, meta: { kind: e.kind, fields: e.fields.length, indexes: e.indexes.length } });
    addEdge(id, fileNode(e.file), 'defines');
    for (const rel of e.relations) {
      const target = rel.split('→')[1]?.trim();
      const other = target ? model.dbEntities.find((x) => x.name.toLowerCase() === target.toLowerCase()) : undefined;
      if (other) addEdge(id, nodeId('entity', `${other.name}@${other.file}`), 'depends_on');
    }
  }

  // Entry points, commands, infrastructure
  for (const e of model.entryPoints) fileNode(e.path);
  for (const c of model.commands) {
    const id = addNode({ id: nodeId('command', `${c.source}:${c.name}`), kind: 'command', name: c.name, path: c.source, meta: { purpose: c.purpose, command: c.command.slice(0, 120) } });
    addEdge(id, fileNode(c.source), 'runs');
  }
  for (const i of model.infrastructure) addNode({ id: nodeId('infra', `${i.name}@${i.file}`), kind: 'infra', name: i.name, path: i.file, meta: { kind: i.kind } });
  for (const d of model.containers.dockerfiles) addNode({ id: nodeId('infra', `Dockerfile@${d.path}`), kind: 'infra', name: 'Dockerfile', path: d.path, meta: { kind: 'container' } });
  for (const s of model.containers.services) addNode({ id: nodeId('infra', `service:${s.name}@${s.file}`), kind: 'infra', name: s.name, path: s.file, meta: { kind: 'service', image: s.image ?? '' } });

  // File → package membership
  for (const n of [...nodes.values()].filter((x) => x.kind === 'file' && x.path)) {
    const owner = model.workspace.packages
      .filter((p) => p.path !== '.' && n.path!.startsWith(`${p.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (owner) addEdge(nodeId('package', owner.name), n.id, 'contains');
  }

  // Import edges between files the graph already knows about
  const maxImportFiles = opts.maxImportFiles ?? 2000;
  const queue = [...nodes.values()].filter((n) => n.kind === 'file').map((n) => n.path!);
  const parsed = new Set<string>();
  while (queue.length && parsed.size < maxImportFiles) {
    opts.signal?.throwIfAborted();
    const p = queue.shift()!;
    if (parsed.has(p)) continue;
    parsed.add(p);
    const n = { id: nodeId('file', p) };
    if (!/\.(m|c)?(t|j)sx?$|\.py$/.test(p)) continue;
    const text = await opts.read(p);
    if (!text) continue;
    const specs: string[] = [];
    for (const m of text.matchAll(IMPORT_RE)) specs.push((m[1] ?? m[2] ?? m[3] ?? m[4])!);
    if (p.endsWith('.py')) for (const m of text.matchAll(PY_IMPORT_RE)) specs.push(((m[1] ?? m[2])!).replace(/\./g, '/'));
    for (const spec of specs.slice(0, 200)) {
      const target = resolveImport(p, spec, fileSet);
      // Imported project files become nodes too, so the graph reaches beyond the
      // files the model happened to reference directly.
      if (!target) continue;
      addEdge(n.id, fileNode(target), 'imports');
      if (!parsed.has(target)) queue.push(target);
    }
  }

  const byKind: Record<string, number> = {};
  for (const n of nodes.values()) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
  return {
    schemaVersion: 1,
    builtAt: new Date().toISOString(),
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    stats: { nodes: nodes.size, edges: edges.length, byKind },
  };
}

export async function saveGraph(root: string, graph: ProjectGraph): Promise<void> {
  await writeFileAtomic(path.join(athenaDir(root), GRAPH_FILE), `${JSON.stringify(graph, null, 2)}\n`);
}

export async function loadGraph(root: string): Promise<ProjectGraph | null> {
  const raw = await readTextIfExists(path.join(athenaDir(root), GRAPH_FILE));
  if (!raw) return null;
  try {
    const parsed = ProjectGraph.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface Neighborhood {
  node: GraphNode;
  edges: Array<{ edge: GraphEdge; other: GraphNode; direction: 'out' | 'in' }>;
}

/** Nodes directly connected to `id`, in both directions. */
export function neighbors(graph: ProjectGraph, id: string): Neighborhood | null {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) return null;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out: Neighborhood['edges'] = [];
  for (const e of graph.edges) {
    if (e.from === id && byId.has(e.to)) out.push({ edge: e, other: byId.get(e.to)!, direction: 'out' });
    else if (e.to === id && byId.has(e.from)) out.push({ edge: e, other: byId.get(e.from)!, direction: 'in' });
  }
  return { node, edges: out };
}

/** Nodes within `depth` hops of any of the given files (used to expand task context). */
export function expandFromFiles(graph: ProjectGraph, files: string[], depth = 1, limit = 40): GraphNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const seed = graph.nodes.filter((n) => n.path && files.includes(n.path));
  const seen = new Set(seed.map((n) => n.id));
  let frontier = [...seen];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const e of graph.edges) {
      if (frontier.includes(e.from) && !seen.has(e.to)) {
        seen.add(e.to);
        next.push(e.to);
      } else if (frontier.includes(e.to) && !seen.has(e.from)) {
        seen.add(e.from);
        next.push(e.from);
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return [...seen]
    .map((id) => byId.get(id))
    .filter((n): n is GraphNode => Boolean(n))
    .slice(0, limit);
}
