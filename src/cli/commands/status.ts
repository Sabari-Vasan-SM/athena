import { buildStatus } from '../../services/status.js';
import { requireProjectRoot, type GlobalOptions } from '../context.js';
import * as ui from '../ui/term.js';

export async function statusCommand(opts: GlobalOptions & { signal?: AbortSignal }): Promise<void> {
  const root = await requireProjectRoot(opts);
  const report = await buildStatus(root, opts.signal);
  if (ui.isJson()) {
    ui.json(report);
    return;
  }
  const healthLabel = report.health === 'healthy' ? ui.c.green('Healthy') : report.health === 'needs-update' ? ui.c.yellow('Needs update') : ui.c.red('Degraded (missing knowledge files)');
  ui.heading('Athena Status');
  ui.line();
  ui.line(`Project:  ${ui.c.bold(report.project)}`);
  ui.line(`Athena:   ${healthLabel}`);
  ui.line(`Analyzed: ${ui.relativeTime(report.analyzedAt)}${report.git.branch ? ui.dim(` · branch ${report.git.branch}`) : ''}`);
  ui.line();
  ui.heading('Knowledge');
  for (const d of report.documents) {
    if (!d.present) ui.fail(`${d.title} ${ui.dim(`— ${d.file} missing`)}`);
    else if (d.editedBlocks.length) ui.ok(`${d.title} ${ui.dim(`— developer-edited sections: ${d.editedBlocks.join(', ')}`)}`);
    else ui.ok(d.title);
  }
  ui.line();
  const total = report.changes.added.length + report.changes.modified.length + report.changes.deleted.length;
  ui.heading('Changes since last analysis');
  if (!total) ui.line(ui.dim('No file changes detected.'));
  else {
    ui.line(`${total} file${total === 1 ? '' : 's'} changed ${ui.dim(`(${report.changes.modified.length} modified, ${report.changes.added.length} added, ${report.changes.deleted.length} deleted)`)}`);
    const sample = [...report.changes.modified, ...report.changes.added, ...report.changes.deleted].slice(0, 8);
    for (const p of sample) ui.line(`  ${ui.dim(p)}`);
    if (total > sample.length) ui.line(ui.dim(`  +${total - sample.length} more`));
  }
  if (report.git.uncommitted !== null) ui.line(ui.dim(`Git: ${report.git.uncommitted} uncommitted change(s) in the working tree`));
  if (report.affectedDocuments.length) {
    ui.line();
    ui.heading('Potentially affected');
    for (const a of report.affectedDocuments) ui.bullet(`${a.file} ${ui.dim(`(${a.reasons.join(', ')})`)}`);
  }
  ui.line();
  ui.line(`Synchronization: ${report.sync === 'up-to-date' ? ui.c.green('Up to date') : `${ui.c.yellow('Needs update')} ${ui.dim('— run `athena sync` to review')}`}`);
}
