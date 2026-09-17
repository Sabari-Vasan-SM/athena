import { applySync, fileChangeCount, needsIndexRefreshOnly, planSync, summarizePlan, type SyncPlan } from '../../services/sync.js';
import { EXIT } from '../../services/errors.js';
import { requireProjectRoot, type GlobalOptions } from '../context.js';
import { confirm } from './clean.js';
import * as ui from '../ui/term.js';

export interface SyncOptions extends GlobalOptions {
  yes?: boolean;
  dryRun?: boolean;
  check?: boolean;
  diff?: boolean;
  force?: boolean;
  signal?: AbortSignal;
}

export function colorDiff(patch: string): string {
  return patch
    .split('\n')
    .map((l) => (l.startsWith('+++') || l.startsWith('---') ? ui.c.bold(l) : l.startsWith('+') ? ui.c.green(l) : l.startsWith('-') ? ui.c.red(l) : l.startsWith('@@') ? ui.c.cyan(l) : l))
    .join('\n');
}

export function printPlan(plan: SyncPlan, opts: { diff?: boolean } = {}): void {
  const fc = plan.fileChanges;
  const count = fileChangeCount(plan);
  ui.heading('Changes since last analysis');
  if (count) {
    const parts = [fc.modified.length && `${fc.modified.length} modified`, fc.added.length && `${fc.added.length} added`, fc.deleted.length && `${fc.deleted.length} deleted`, fc.renamed.length && `${fc.renamed.length} renamed`].filter(Boolean);
    ui.line(`  ${count} file${count === 1 ? '' : 's'} ${ui.dim(`(${parts.join(' · ')})`)}`);
    const sample = [...fc.modified.map((p) => `M ${p}`), ...fc.added.map((p) => `A ${p}`), ...fc.deleted.map((p) => `D ${p}`), ...fc.renamed.map((r) => `R ${r.from} → ${r.to}`)];
    for (const s of sample.slice(0, 8)) ui.line(`  ${ui.dim(s)}`);
    if (sample.length > 8) ui.line(ui.dim(`  +${sample.length - 8} more`));
  } else {
    ui.line(ui.dim('  No file changes.'));
  }
  const g = plan.git;
  if (g.isRepo && g.previousHead && g.head && g.previousHead !== g.head) {
    if (g.branchChanged) ui.line(`  Git: branch changed ${ui.c.bold(g.previousBranch ?? '?')} → ${ui.c.bold(g.branch ?? '?')}`);
    if (g.diverged) ui.line(`  Git: HEAD moved to ${g.head.slice(0, 8)} ${ui.dim('(not a descendant of the last analyzed commit — rebase, reset or checkout)')}`);
    else if (g.commits.length) {
      ui.line(`  Git: ${g.commits.length}${g.truncated ? '+' : ''} new commit${g.commits.length === 1 ? '' : 's'}`);
      for (const c of g.commits.slice(0, 5)) ui.line(`  ${ui.dim(`${c.sha.slice(0, 8)} ${c.subject}`)}`);
    }
  }

  if (plan.modelChanges.length) {
    ui.line();
    ui.heading('Detected project changes');
    for (const m of plan.modelChanges) ui.bullet(`${m.label}: ${ui.dim(m.summary)}`);
  }

  ui.line();
  if (plan.upToDate) {
    ui.ok('Knowledge already reflects these changes — no document needs updating.');
    if (plan.checkedUnchanged.length) ui.line(ui.dim(`  Checked: ${plan.checkedUnchanged.join(', ')}`));
    return;
  }
  ui.heading('Knowledge to update');
  const width = Math.max(...plan.documents.map((d) => d.file.length));
  for (const d of plan.documents) {
    const sign = d.status === 'created' ? ui.c.green('+') : ui.c.yellow('~');
    ui.line(`  ${sign} ${d.file.padEnd(width)}  ${ui.c.green(`+${d.additions}`)} ${ui.c.red(`−${d.deletions}`)}  ${ui.dim(d.changedSections.join(', '))}`);
    for (const r of d.reasons.slice(0, 3)) ui.line(`      ${ui.dim(`${ui.sym.arrow} ${r}`)}`);
    if (d.preservedSections.length) ui.line(`      ${ui.c.yellow(ui.sym.warn)} ${ui.dim(`your edits kept in: ${d.preservedSections.join(', ')}`)}`);
  }
  if (plan.checkedUnchanged.length) ui.line(ui.dim(`  Checked and unchanged: ${plan.checkedUnchanged.join(', ')}`));
  if (plan.ignored) ui.line(ui.dim('  (You previously ignored this exact proposal.)'));
  if (opts.diff) {
    for (const d of plan.documents) {
      ui.line();
      ui.line(colorDiff(d.diff.replace(/^=+\n/m, '')));
    }
  }
}

export async function syncCommand(opts: SyncOptions): Promise<number> {
  const root = await requireProjectRoot(opts);
  const sp = ui.spinner('Checking for changes...');
  let plan: SyncPlan;
  try {
    plan = await planSync(root, { signal: opts.signal, force: opts.force });
    sp.stop();
  } catch (err) {
    sp.stop();
    throw err;
  }

  if (ui.isJson() && (opts.dryRun || opts.check)) {
    ui.json({ ...summarizePlan(plan), ...(opts.diff ? { diffs: Object.fromEntries(plan.documents.map((d) => [d.file, d.diff])) } : {}) });
    return opts.check && !plan.upToDate ? 1 : EXIT.OK;
  }
  if (!ui.isJson() && !ui.isQuiet()) {
    ui.heading('Athena Sync');
    ui.line();
    printPlan(plan, { diff: opts.diff });
    ui.line();
  } else if (!ui.isJson() && !plan.upToDate) {
    ui.line(`Proposed: ${plan.documents.map((d) => d.file).join(', ')}`);
  }

  if (opts.check) {
    if (!ui.isJson()) ui.line(plan.upToDate ? ui.c.green('Knowledge is synchronized.') : ui.c.yellow('Knowledge is out of date. Run `athena sync` to review and apply.'));
    return plan.upToDate ? EXIT.OK : 1;
  }
  if (opts.dryRun) {
    if (!ui.isJson()) ui.line(ui.dim('Dry run — nothing was written.'));
    return EXIT.OK;
  }

  if (plan.upToDate) {
    if (needsIndexRefreshOnly(plan)) {
      const r = await applySync(root, plan);
      if (ui.isJson()) ui.json({ ...summarizePlan(plan), applied: r });
      else ui.info(ui.dim('File index refreshed.'));
    } else if (ui.isJson()) ui.json(summarizePlan(plan));
    return EXIT.OK;
  }

  let approved = Boolean(opts.yes);
  if (!approved) {
    if (!process.stdin.isTTY) {
      if (ui.isJson()) ui.json(summarizePlan(plan));
      else ui.line(ui.c.yellow('Not applied: confirmation required. Re-run with --yes to apply, or --diff to inspect changes.'));
      return EXIT.OK;
    }
    approved = await confirm(`Apply updates to ${plan.documents.length} document${plan.documents.length === 1 ? '' : 's'}?`);
  }
  if (!approved) {
    ui.line('Not applied.');
    return EXIT.OK;
  }
  const result = await applySync(root, plan);
  if (ui.isJson()) ui.json({ ...summarizePlan(plan), applied: result });
  else {
    ui.ok(`Updated ${result.applied.join(', ')}`);
    for (const p of result.preserved) ui.warn(`${p.file}: kept your edits in ${p.sections.join(', ')} ${ui.dim('(use `athena analyze --force` to regenerate)')}`);
  }
  return EXIT.OK;
}
