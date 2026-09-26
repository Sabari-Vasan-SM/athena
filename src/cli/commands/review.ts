import { hasBlockers, reviewChanges, type ReviewFinding } from '../../services/review.js';
import { planSync, staleForCheck } from '../../services/sync.js';
import { EXIT } from '../../services/errors.js';
import { requireProjectRoot, type GlobalOptions } from '../context.js';
import * as ui from '../ui/term.js';

export interface ReviewOptions extends GlobalOptions {
  base?: string;
  noSync?: boolean;
  noFail?: boolean;
  signal?: AbortSignal;
}

const LEVEL: Record<ReviewFinding['level'], { icon: () => string; label: string }> = {
  blocker: { icon: () => ui.c.red(ui.sym.err), label: 'blocker' },
  warning: { icon: () => ui.c.yellow(ui.sym.warn), label: 'warning' },
  info: { icon: () => ui.c.cyan(ui.sym.info), label: 'info' },
};

export async function reviewCommand(opts: ReviewOptions): Promise<number> {
  const root = await requireProjectRoot(opts);
  const sp = ui.spinner('Reviewing changes...');
  let result;
  try {
    result = await reviewChanges(root, {
      base: opts.base,
      signal: opts.signal,
      checkSync: opts.noSync ? undefined : async (r) => staleForCheck(await planSync(r, { signal: opts.signal })).length === 0,
    });
    sp.stop();
  } catch (err) {
    sp.stop();
    throw err;
  }

  if (ui.isJson()) {
    ui.json(result);
    return !opts.noFail && hasBlockers(result) ? 1 : EXIT.OK;
  }

  ui.heading('Athena Review');
  ui.line();
  if (!result.changedFiles.length) {
    ui.line(ui.dim(opts.base ? `No changes between ${opts.base} and HEAD.` : 'No uncommitted changes.'));
    return EXIT.OK;
  }
  ui.line(`${result.stats.files} file${result.stats.files === 1 ? '' : 's'} changed ${ui.dim(`(${ui.c.green(`+${result.stats.added}`)} ${ui.c.red(`−${result.stats.removed}`)}${opts.base ? ` vs ${opts.base}` : ' in the working tree'})`)}`);
  ui.line();

  if (result.findings.length) {
    ui.heading('Automated checks');
    for (const f of result.findings) {
      ui.line(`${LEVEL[f.level].icon()} ${ui.c.bold(f.message)} ${ui.dim(`[${f.check}]`)}`);
      for (const file of f.files.slice(0, 6)) ui.line(`    ${ui.dim(file)}`);
      if (f.files.length > 6) ui.line(ui.dim(`    +${f.files.length - 6} more`));
      if (f.hint) ui.line(`    ${ui.dim(f.hint)}`);
    }
  } else {
    ui.ok('Automated checks found nothing to flag.');
  }

  if (result.rules.length) {
    ui.line();
    ui.heading('Project rules to verify (from rules.md)');
    for (const r of result.rules.slice(0, 20)) ui.line(`  ${ui.dim('[ ]')} ${r.text} ${ui.dim(`(${r.section})`)}`);
    if (result.rules.length > 20) ui.line(ui.dim(`  +${result.rules.length - 20} more`));
  }
  if (result.checklist.length) {
    ui.line();
    ui.heading('Review checklist (from code-review.md)');
    for (const c of result.checklist.slice(0, 12)) ui.line(`  ${ui.dim('[ ]')} ${c}`);
    if (result.checklist.length > 12) ui.line(ui.dim(`  +${result.checklist.length - 12} more`));
  }

  ui.line();
  ui.line(ui.dim('Athena checks facts about the diff. Rules and checklist items are for you or your agent to apply — Athena does not judge whether they are met.'));
  const blockers = result.findings.filter((f) => f.level === 'blocker').length;
  if (blockers) ui.line(ui.c.red(`\n${blockers} blocker${blockers === 1 ? '' : 's'} found.`));
  return !opts.noFail && hasBlockers(result) ? 1 : EXIT.OK;
}
