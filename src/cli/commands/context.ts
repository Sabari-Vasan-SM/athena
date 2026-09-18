import { formatContext, getRelevantContext, graphSummary, refreshGraph } from '../../services/context.js';
import { loadGraph, neighbors } from '../../core/graph/graph.js';
import { AthenaError } from '../../services/errors.js';
import { requireProjectRoot, type GlobalOptions } from '../context.js';
import * as ui from '../ui/term.js';

export interface ContextCommandOptions extends GlobalOptions {
  maxChars?: string;
  full?: boolean;
  signal?: AbortSignal;
}

export async function contextCommand(task: string, opts: ContextCommandOptions): Promise<void> {
  const root = await requireProjectRoot(opts);
  const maxChars = opts.maxChars ? Number(opts.maxChars) : undefined;
  if (maxChars !== undefined && (!Number.isInteger(maxChars) || maxChars < 500)) throw new AthenaError('--max-chars must be an integer of at least 500');
  const ctx = await getRelevantContext(root, task, { maxChars, buildGraph: true, signal: opts.signal });

  if (ui.isJson()) {
    ui.json(ctx);
    return;
  }
  if (opts.full) {
    ui.line(formatContext(ctx));
    return;
  }
  ui.heading(`Context for: ${task}`);
  ui.line();
  ui.heading('Documents to read');
  for (const a of ctx.areas) ui.bullet(`${ui.c.bold(a.id)} ${ui.dim(`— ${a.why.join('; ')}`)}`);
  if (ctx.mentionedFiles.length) {
    ui.line();
    ui.heading('Files named in the task');
    for (const f of ctx.mentionedFiles) ui.line(`  ${ui.dim(f)}`);
  }
  if (ctx.graphNodes.length) {
    ui.line();
    ui.heading('Related code (project graph)');
    for (const n of ctx.graphNodes.slice(0, 12)) ui.line(`  ${ui.dim(`${n.kind}:`)} ${n.name}${n.path ? ui.dim(` (${n.path})`) : ''}`);
    if (ctx.graphNodes.length > 12) ui.line(ui.dim(`  +${ctx.graphNodes.length - 12} more`));
  }
  ui.line();
  ui.heading('Sections selected');
  for (const s of ctx.sections) ui.line(`  ${ui.dim(`${s.file} →`)} ${s.section}`);
  ui.line();
  ui.line(ui.dim(`${ctx.sections.length} sections · ~${ctx.approxChars} characters · ${ctx.rules.length} rules${ctx.truncated ? ' · some sections omitted for budget' : ''}`));
  ui.line(ui.dim('Use --full to print the context an agent would read, or --json for tooling.'));
}

export interface GraphCommandOptions extends GlobalOptions {
  build?: boolean;
  node?: string;
  kind?: string;
  search?: string;
  signal?: AbortSignal;
}

export async function graphCommand(opts: GraphCommandOptions): Promise<void> {
  const root = await requireProjectRoot(opts);
  if (opts.build) {
    const sp = ui.spinner('Building project graph...');
    try {
      const graph = await refreshGraph(root, { signal: opts.signal });
      sp.succeed(`Graph built: ${graph.stats.nodes} nodes, ${graph.stats.edges} relationships`);
    } catch (err) {
      sp.stop();
      throw err;
    }
  }
  const graph = await loadGraph(root);
  if (!graph) throw new AthenaError('No project graph yet.', 'Run `athena graph --build`.');

  if (opts.node) {
    const hood = neighbors(graph, opts.node) ?? neighbors(graph, graph.nodes.find((n) => n.name === opts.node || n.path === opts.node)?.id ?? '');
    if (!hood) throw new AthenaError(`No graph node matches "${opts.node}".`, 'Use `athena graph --search <term>` to find one.');
    if (ui.isJson()) {
      ui.json(hood);
      return;
    }
    ui.heading(`${hood.node.kind}: ${hood.node.name}`);
    if (hood.node.path) ui.line(ui.dim(hood.node.path));
    ui.line();
    for (const e of hood.edges) ui.line(`  ${e.direction === 'out' ? ui.sym.arrow : '←'} ${ui.dim(e.edge.kind)} ${e.other.kind}: ${e.other.name}${e.other.path ? ui.dim(` (${e.other.path})`) : ''}`);
    return;
  }

  const q = opts.search?.toLowerCase();
  const nodes = graph.nodes.filter((n) => (!opts.kind || n.kind === opts.kind) && (!q || `${n.name} ${n.path ?? ''}`.toLowerCase().includes(q)));
  if (ui.isJson()) {
    ui.json({ stats: graph.stats, builtAt: graph.builtAt, nodes: nodes.slice(0, 200) });
    return;
  }
  ui.heading('Project graph');
  ui.line(ui.dim(`Built ${ui.relativeTime(graph.builtAt)} · ${graph.stats.nodes} nodes · ${graph.stats.edges} relationships`));
  ui.line();
  for (const [kind, count] of Object.entries(graph.stats.byKind).sort((a, b) => b[1] - a[1])) ui.line(`  ${String(count).padStart(5)} ${kind}`);
  if (q || opts.kind) {
    ui.line();
    ui.heading(`Matching nodes (${nodes.length})`);
    for (const n of nodes.slice(0, 30)) ui.line(`  ${ui.dim(`${n.kind}:`)} ${n.name}${n.path ? ui.dim(` (${n.path})`) : ''}`);
    if (nodes.length > 30) ui.line(ui.dim(`  +${nodes.length - 30} more`));
  }
}

export async function architectureCommand(opts: GlobalOptions & { signal?: AbortSignal }): Promise<void> {
  const root = await requireProjectRoot(opts);
  const summary = await graphSummary(root);
  if (ui.isJson()) {
    ui.json(summary);
    return;
  }
  if (!summary.built) {
    ui.line(ui.dim('No project graph yet. Run `athena graph --build`.'));
    return;
  }
  ui.heading('Architecture (from the project graph)');
  ui.line(ui.dim(`Built ${ui.relativeTime(summary.builtAt!)}`));
  ui.line();
  for (const [kind, count] of Object.entries(summary.stats!.byKind).sort((a, b) => b[1] - a[1])) ui.line(`  ${String(count).padStart(5)} ${kind}`);
  ui.line();
  ui.line(ui.dim('See .athena/architecture.md for the written architecture, and `athena graph --search <term>` to explore.'));
}
