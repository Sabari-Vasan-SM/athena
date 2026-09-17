import path from 'node:path';
import { readState } from '../../core/state/state.js';
import { resolveAdapters, ADAPTERS } from '../../agents/registry.js';
import type { AgentAdapter } from '../../core/agents/adapter.js';
import { runPipeline, type PipelineResult } from '../pipeline.js';
import { resolveCwd, type GlobalOptions } from '../context.js';
import { AthenaError } from '../errors.js';
import * as ui from '../ui/term.js';

export interface InitOptions extends GlobalOptions {
  agents?: string;
  noAgents?: boolean;
  dryRun?: boolean;
  signal?: AbortSignal;
}

export function parseAgentsOption(value: string | undefined, disabled: boolean | undefined): AgentAdapter[] | undefined {
  if (disabled) return [];
  if (value === undefined) return undefined;
  if (value.trim().toLowerCase() === 'all') return [...ADAPTERS];
  if (value.trim().toLowerCase() === 'none') return [];
  try {
    return resolveAdapters(value.split(','));
  } catch (err) {
    throw new AthenaError((err as Error).message);
  }
}

export async function initCommand(opts: InitOptions): Promise<void> {
  const root = await resolveCwd(opts);
  const existing = await readState(path.join(root, '.athena'));
  if (existing.kind === 'ok') {
    throw new AthenaError('Athena is already initialized in this project.', 'Run `athena analyze` to refresh knowledge, or `athena clean` to start over.');
  }
  const agents = parseAgentsOption(opts.agents, opts.noAgents);

  ui.banner();
  const result = await runWithProgress(root, { mode: 'init', dryRun: opts.dryRun, agents, signal: opts.signal });

  if (ui.isJson()) {
    ui.json(summarize(result, root, Boolean(opts.dryRun)));
    return;
  }
  printSummary(result, Boolean(opts.dryRun), 'init');
}

export async function runWithProgress(root: string, o: { mode: 'init' | 'analyze'; dryRun?: boolean; force?: boolean; agents?: AgentAdapter[]; signal?: AbortSignal }): Promise<PipelineResult> {
  const sp = ui.spinner('Scanning project files...');
  const started = Date.now();
  try {
    const result = await runPipeline({
      root,
      mode: o.mode,
      dryRun: o.dryRun,
      force: o.force,
      agents: o.agents,
      signal: o.signal,
      onStage: (stage) => {
        const labels: Record<string, string> = { analyze: 'Scanning project files...', scan: 'Scanning project files...', detect: 'Detecting technologies, schema, routes and infrastructure...', git: 'Reading Git metadata...', finalize: 'Redacting and validating...', write: 'Writing knowledge...', agents: 'Configuring AI agents...' };
        sp.update(labels[stage] ?? stage);
      },
    });
    sp.succeed(`Analyzed ${result.analysis.model.stats.filesScanned} files in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return result;
  } catch (err) {
    sp.stop();
    throw err;
  }
}

function detectionLine(label: string, count: number, detail?: string): void {
  if (count > 0) ui.ok(`${label}${detail ? ui.dim(` — ${detail}`) : ''}`);
  else ui.line(`${ui.c.dim(ui.sym.ring)} ${ui.c.dim(`${label} — not detected`)}`);
}

export function printSummary(result: PipelineResult, dryRun: boolean, mode: 'init' | 'analyze'): void {
  const m = result.analysis.model;
  if (ui.isQuiet()) {
    for (const w of m.warnings) ui.warn(w);
    for (const n of result.notes) ui.warn(n);
    for (const d of result.docs.filter((x) => x.preservedModified.length)) ui.warn(`${d.file}: kept your edits in ${d.preservedModified.join(', ')}`);
    const changed = result.docs.filter((d) => d.status !== 'unchanged').map((d) => d.file);
    ui.line(dryRun ? 'Dry run: nothing written.' : changed.length ? `Updated: ${changed.join(', ')}` : 'Knowledge up to date.');
    return;
  }
  ui.line();
  const uniq = (xs: string[]) => [...new Set(xs)];
  detectionLine('Project', m.stats.filesScanned, `${m.name}${m.languages[0] ? ` · ${m.languages.slice(0, 3).map((l) => l.name).join(', ')}` : ''}`);
  detectionLine('Frameworks', m.frameworks.length, uniq(m.frameworks.map((f) => f.name)).slice(0, 5).join(', '));
  detectionLine('Workspace', m.workspace.isMonorepo ? m.workspace.packages.length : 0, m.workspace.isMonorepo ? `monorepo · ${m.workspace.packages.length} packages` : undefined);
  detectionLine('Database', m.databases.length + m.dbEntities.length, `${uniq(m.databases.map((d) => d.name)).slice(0, 3).join(', ')}${m.dbEntities.length ? ` · ${m.dbEntities.length} entities` : ''}`);
  detectionLine('API', m.routes.length + m.apiSpecs.length, `${m.routes.length} route${m.routes.length === 1 ? '' : 's'}${m.apiSpecs.length ? ` · ${m.apiSpecs.length} specs` : ''}`);
  detectionLine('Authentication', m.auth.length, uniq(m.auth.map((a) => a.name)).slice(0, 3).join(', '));
  detectionLine('Testing', m.tests.frameworks.length + m.tests.testFileCount, `${uniq(m.tests.frameworks.map((f) => f.name)).slice(0, 3).join(', ')} · ${m.tests.testFileCount} test files`);
  detectionLine('Deployment', m.containers.dockerfiles.length + m.ci.length + m.infrastructure.length, [m.containers.dockerfiles.length ? 'Docker' : '', m.ci.length ? uniq(m.ci.map((j) => j.system)).join(', ') : '', ...uniq(m.infrastructure.filter((i) => i.kind === 'hosting').map((i) => i.name))].filter(Boolean).slice(0, 4).join(', '));
  if (m.security.secrets.length) ui.warn(`Security — ${m.security.secrets.length} potential hardcoded secret(s); see .athena/security.md (values not stored)`);
  else ui.ok(`Security${ui.dim(' — no likely secrets matched')}`);

  if (m.warnings.length) {
    ui.line();
    for (const w of m.warnings.slice(0, 5)) ui.warn(ui.c.yellow(w));
    if (m.warnings.length > 5) ui.line(ui.dim(`  +${m.warnings.length - 5} more warnings (see .athena/project.md)`));
  }

  ui.line();
  if (dryRun) {
    ui.heading('Dry run — nothing was written.');
    ui.line('Would create .athena/ with 12 knowledge files, model.json and state.json.');
    for (const { adapter, changes } of result.agentChanges) for (const ch of changes) ui.bullet(`${adapter.displayName}: would ${ch.action} ${ch.path}`);
    return;
  }

  if (mode === 'init') {
    ui.tree(ui.c.bold('.athena/'), [...result.docs.map((d) => d.file), 'model.json', 'state.json']);
  } else {
    const changed = result.docs.filter((d) => d.status !== 'unchanged');
    if (changed.length) {
      ui.heading('Knowledge updated:');
      for (const d of changed) ui.bullet(`${d.file} ${ui.dim(`(${d.status})`)}`);
    } else ui.ok('Knowledge already up to date.');
  }
  const preserved = result.docs.filter((d) => d.preservedModified.length);
  if (preserved.length) {
    ui.line();
    for (const d of preserved) ui.warn(`${d.file}: kept your edits in ${d.preservedModified.join(', ')} ${ui.dim('(use --force to regenerate)')}`);
  }

  ui.line();
  if (result.agentChanges.length) {
    for (const { adapter, changes } of result.agentChanges) {
      const touched = changes.filter((c) => c.action !== 'unchanged').map((c) => `${c.path} (${c.action})`);
      ui.ok(`${adapter.displayName} integration${ui.dim(` — ${touched.length ? touched.join(', ') : changes.map((c) => c.path).join(', ') + ' (unchanged)'}`)}`);
    }
  } else if (mode === 'init') {
    ui.line(ui.dim('No agent integrations configured. Use `athena init --agents claude,cursor,antigravity` or `athena agents` later.'));
  }
  for (const n of result.notes) ui.warn(n);
  if (mode === 'init') {
    const unconfigured = ADAPTERS.filter((a) => !result.agentChanges.some((c) => c.adapter.id === a.id));
    if (unconfigured.length) ui.line(ui.dim(`Not configured: ${unconfigured.map((a) => a.displayName).join(', ')} (not detected in this project). Add with --agents.`));
  }

  ui.line();
  ui.line(ui.c.bold(ui.c.green(mode === 'init' ? 'Athena ready.' : 'Analysis complete.')));
  if (mode === 'init') {
    ui.line(ui.dim('Next: review .athena/rules.md and enable the rules that apply. Web UI (`athena open`) is planned for Phase 2.'));
  }
}

export function summarize(result: PipelineResult, root: string, dryRun: boolean) {
  const m = result.analysis.model;
  return {
    root,
    dryRun,
    project: m.name,
    filesScanned: m.stats.filesScanned,
    durationMs: result.analysis.durationMs,
    languages: m.languages.slice(0, 5).map((l) => l.name),
    frameworks: [...new Set(m.frameworks.map((f) => f.name))],
    monorepo: m.workspace.isMonorepo,
    databases: m.databases.map((d) => d.name),
    entities: m.dbEntities.length,
    routes: m.routes.length,
    testFiles: m.tests.testFileCount,
    potentialSecrets: m.security.secrets.length,
    documents: result.docs.map((d) => ({ file: d.file, status: d.status, preservedModified: d.preservedModified })),
    agents: result.agentChanges.map((a) => ({ id: a.adapter.id, files: a.changes.map((c) => ({ path: c.path, action: c.action })) })),
    warnings: m.warnings,
    notes: result.notes,
  };
}
