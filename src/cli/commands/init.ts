import path from 'node:path';
import { readState } from '../../core/state/state.js';
import { resolveAdapters, ADAPTERS } from '../../agents/registry.js';
import type { AgentAdapter } from '../../core/agents/adapter.js';
import { runPipeline, type PipelineResult } from '../../services/pipeline.js';
import { resolveCwd, type GlobalOptions } from '../context.js';
import { AthenaError } from '../../services/errors.js';
import { KNOWLEDGE_DOCS } from '../../core/knowledge/documents.js';
import * as ui from '../ui/term.js';
import * as dash from '../ui/dashboard.js';
import { footer, printHeader } from '../ui/brand.js';
import { StageBoard, type StageId, type StageResult } from '../ui/stages.js';

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

  printHeader();
  const result = await runWithProgress(root, { mode: 'init', dryRun: opts.dryRun, agents, signal: opts.signal });

  if (ui.isJson()) {
    ui.json(summarize(result, root, Boolean(opts.dryRun)));
    return;
  }
  printSummary(result, Boolean(opts.dryRun), 'init');
}

export async function runWithProgress(root: string, o: { mode: 'init' | 'analyze'; dryRun?: boolean; force?: boolean; agents?: AgentAdapter[]; signal?: AbortSignal }): Promise<PipelineResult> {
  const board = new StageBoard();
  board.start();
  try {
    const result = await runPipeline({
      root,
      mode: o.mode,
      dryRun: o.dryRun,
      force: o.force,
      agents: o.agents,
      signal: o.signal,
      onStage: (stage) => board.enter(stage),
    });
    board.finish(stageResults(result, o.mode, Boolean(o.dryRun)));
    return result;
  } catch (err) {
    board.fail();
    throw err;
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function stageResults(result: PipelineResult, mode: 'init' | 'analyze', dryRun: boolean): Partial<Record<StageId, StageResult>> {
  const m = result.analysis.model;
  const skipped = m.stats.skippedBinary + m.stats.skippedLarge + m.stats.skippedUnreadable;
  const found = [
    m.frameworks.length && plural(new Set(m.frameworks.map((f) => f.name)).size, 'framework'),
    m.dbEntities.length && plural(m.dbEntities.length, 'entity').replace('entitys', 'entities'),
    m.routes.length && plural(m.routes.length, 'route'),
    m.auth.length && 'auth',
  ].filter(Boolean);
  const changed = result.docs.filter((d) => d.status !== 'unchanged').length;
  const agents = result.agentChanges.map((a) => a.adapter.displayName);
  return {
    scan: { text: `Found ${plural(m.stats.filesScanned, 'file')}${skipped ? ` · ${skipped} skipped` : ''}` },
    detect: found.length ? { text: found.join(' · ') } : { text: 'No frameworks detected', tone: 'dim' },
    git: m.git.isRepo ? { text: `On ${m.git.branch ?? 'detached HEAD'}${m.git.head ? ` @ ${m.git.head.slice(0, 7)}` : ''}` } : { text: m.git.available ? 'Not a Git repository' : 'Git not installed', tone: 'dim' },
    finalize: m.security.secrets.length ? { text: `${plural(m.security.secrets.length, 'potential secret')} (values redacted)`, tone: 'warn' } : { text: 'No likely secrets found' },
    write: dryRun ? { text: 'Dry run — nothing written', tone: 'dim' } : { text: mode === 'init' ? `${plural(result.docs.length, 'document')} generated` : changed ? `${changed} updated · ${result.docs.length - changed} unchanged` : 'Already up to date' },
    agents: agents.length ? { text: agents.join(', ') } : { text: 'None configured', tone: 'dim' },
  };
}

const DOC_NOTES: Record<string, string> = {
  'project.md': 'Project overview',
  'architecture.md': 'System architecture',
  'database.md': 'Database schema',
  'api.md': 'API reference',
  'auth.md': 'Authentication flow',
  'security.md': 'Security analysis',
  'testing.md': 'Testing strategy',
  'debugging.md': 'Debugging guide',
  'performance.md': 'Performance notes',
  'code-review.md': 'Review checklist',
  'deployment.md': 'Deployment guide',
  'rules.md': 'Your project rules',
};

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
  const uniq = (xs: string[]) => [...new Set(xs)];
  const list = (xs: string[], n = 4) => uniq(xs).slice(0, n).join(' · ');

  ui.line();
  for (const l of dash.sectionTitle(dryRun ? 'Dry Run Complete' : 'Analysis Complete!')) ui.line(l);
  ui.line(`  Analyzed ${dash.accent(String(m.stats.filesScanned))} files in ${dash.accent(`${(result.analysis.durationMs / 1000).toFixed(1)}s`)}`);
  ui.line();

  const overview: dash.Row[] = [
    ['Project', `${m.name}${m.languages[0] ? ` · ${list(m.languages.map((l) => l.name), 3)}` : ''}`],
    ['Frameworks', list(m.frameworks.map((f) => f.name), 5)],
    ['Workspace', m.workspace.isMonorepo ? `monorepo · ${plural(m.workspace.packages.length, 'package')}` : ''],
    ['Database', m.databases.length + m.dbEntities.length ? [list(m.databases.map((d) => d.name), 3), m.dbEntities.length ? plural(m.dbEntities.length, 'entity').replace('entitys', 'entities') : ''].filter(Boolean).join(' · ') : ''],
    ['API', m.routes.length + m.apiSpecs.length ? [m.routes.length ? plural(m.routes.length, 'route') : '', m.apiSpecs.length ? plural(m.apiSpecs.length, 'spec') : ''].filter(Boolean).join(' · ') : ''],
    ['Auth', list(m.auth.map((a) => a.name), 3)],
    ['Testing', m.tests.frameworks.length + m.tests.testFileCount ? [list(m.tests.frameworks.map((f) => f.name), 3), plural(m.tests.testFileCount, 'test file')].filter(Boolean).join(' · ') : ''],
    ['Deployment', [m.containers.dockerfiles.length ? 'Docker' : '', ...uniq(m.ci.map((j) => j.system)), ...uniq(m.infrastructure.filter((i) => i.kind === 'hosting').map((i) => i.name))].filter(Boolean).slice(0, 4).join(' · ')],
    ['Security', m.security.secrets.length ? dash.warnText(`${plural(m.security.secrets.length, 'potential secret')} — see security.md`) : 'No likely secrets matched'],
  ];

  const files = dryRun
    ? ['Would create .athena/ with:', ...[...KNOWLEDGE_DOCS.map((d) => d.file), 'model.json', 'state.json'].map((f) => `  ${f}`)]
    : dash.fileTree(
        '.athena/',
        result.docs.map((d) => ({ name: d.file, note: mode === 'init' ? DOC_NOTES[d.file] ?? '' : d.status, highlight: mode === 'analyze' && d.status !== 'unchanged' })),
      );

  const configured = result.agentChanges.length > 0;
  const steps = dryRun
    ? ['Run `athena init` without --dry-run to write the files']
    : mode === 'init'
      ? [
          'Review `.athena/rules.md` and enable the rules that apply',
          'Run `athena open` to browse and edit in the web UI',
          configured ? 'Your agents now read `.athena/` — watch with `athena activity`' : 'Connect an agent: `athena agents add claude-code`',
          'After code changes run `athena sync` to keep docs current',
          'Share feedback and star on GitHub ★',
        ]
      : ['Review changes with `git diff .athena/`', 'Run `athena open` to browse in the web UI', 'Use `athena sync --watch` to stay current'];

  for (const l of dash.panels([
    { title: 'Project Overview', icon: '◆', color: dash.C.blue, body: dash.rows(overview) },
    { title: mode === 'init' ? 'Generated Files' : 'Knowledge Files', icon: '▤', color: dash.C.violet, body: files },
    { title: 'Next Steps', icon: '➜', color: dash.C.green, body: mode === 'init' && !dryRun ? [dash.numbered(steps), [''], dash.quote('Better documentation leads to better software.')] : dash.numbered(steps) },
  ]))
    ui.line(l);

  const preserved = result.docs.filter((d) => d.preservedModified.length);
  const notes = [
    ...m.warnings.slice(0, 5).map((w) => () => ui.warn(ui.c.yellow(w))),
    ...(m.warnings.length > 5 ? [() => ui.line(ui.dim(`  +${m.warnings.length - 5} more warnings (see .athena/project.md)`))] : []),
    ...preserved.map((d) => () => ui.warn(`${d.file}: kept your edits in ${d.preservedModified.join(', ')} ${ui.dim('(use --force to regenerate)')}`)),
    ...(dryRun ? [] : result.agentChanges).map(({ adapter, changes }) => () => {
      const touched = changes.filter((c) => c.action !== 'unchanged').map((c) => `${c.path} (${c.action})`);
      ui.ok(`${adapter.displayName} integration${ui.dim(` — ${touched.length ? touched.join(', ') : changes.map((c) => c.path).join(', ') + ' (unchanged)'}`)}`);
    }),
    ...(mode === 'init' && !dryRun
      ? (() => {
          const unconfigured = ADAPTERS.filter((a) => !result.agentChanges.some((c) => c.adapter.id === a.id));
          return unconfigured.length ? [() => ui.line(ui.dim(`Not configured: ${unconfigured.map((a) => a.displayName).join(', ')} — not detected; add with \`athena agents add <id>\``))] : [];
        })()
      : []),
    ...(dryRun ? result.agentChanges.flatMap(({ adapter, changes }) => changes.map((ch) => () => ui.bullet(`${adapter.displayName}: would ${ch.action} ${ch.path}`))) : []),
    ...result.notes.map((n) => () => ui.warn(n)),
  ];
  if (notes.length) {
    ui.line();
    for (const print of notes) print();
  }

  ui.line();
  const lines = dryRun
    ? footer('Dry run — nothing was written.', 'Re-run without --dry-run to create .athena/', 'warn')
    : mode === 'init'
      ? footer('Athena is ready!', `Your project intelligence is ready in ${dash.accent('.athena/')}`)
      : footer('Analysis complete.', `Knowledge in ${dash.accent('.athena/')} is up to date with your code`);
  for (const l of lines) ui.line(l);
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
