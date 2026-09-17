import path from 'node:path';
import { loadConfig } from '../../core/config.js';
import { walkProject } from '../../core/fs/walker.js';
import { impactOf } from '../../core/impact/impact.js';
import { KNOWLEDGE_DOCS } from '../../core/knowledge/documents.js';
import { isBlockModified, parseBlocks } from '../../core/knowledge/managed-blocks.js';
import { athenaDir, buildFileIndex, diffFileIndex, readState } from '../../core/state/state.js';
import { readTextIfExists } from '../../core/util/fs.js';
import { workingChanges } from '../../core/git/git.js';
import { requireProjectRoot, type GlobalOptions } from '../context.js';
import { AthenaError } from '../errors.js';
import * as ui from '../ui/term.js';

export interface DocStatus {
  file: string;
  title: string;
  present: boolean;
  editedBlocks: string[];
  lastChangedAt?: string;
}

export interface StatusReport {
  project: string;
  root: string;
  health: 'healthy' | 'needs-update' | 'degraded';
  analyzedAt: string;
  documents: DocStatus[];
  changes: { added: string[]; modified: string[]; deleted: string[] };
  git: { isRepo: boolean; branch?: string; headChanged: boolean; uncommitted: number | null };
  affectedDocuments: Array<{ file: string; reasons: string[] }>;
  sync: 'up-to-date' | 'needs-update';
}

export async function buildStatus(root: string, signal?: AbortSignal): Promise<StatusReport> {
  const dir = athenaDir(root);
  const st = await readState(dir);
  if (st.kind === 'missing') throw new AthenaError('.athena/state.json is missing.', 'Run `athena analyze` to rebuild it.');
  if (st.kind === 'corrupted') throw new AthenaError(`.athena/state.json is corrupted (${st.reason}).`, 'Run `athena analyze` — the corrupted file will be backed up and rebuilt.');
  const state = st.state;

  const documents: DocStatus[] = [];
  for (const d of KNOWLEDGE_DOCS) {
    const text = await readTextIfExists(path.join(dir, d.file));
    documents.push({
      file: d.file,
      title: d.title,
      present: text !== null,
      editedBlocks: text ? parseBlocks(text).filter(isBlockModified).map((b) => b.id) : [],
      lastChangedAt: state.documents[d.id]?.lastChangedAt,
    });
  }

  const { config } = await loadConfig(root);
  const walk = await walkProject(root, { config, signal, reuse: state.fileIndex });
  const changes = diffFileIndex(state.fileIndex, buildFileIndex(walk.files));

  const git = { isRepo: state.git.isRepo, branch: state.git.branch, headChanged: false, uncommitted: null as number | null };
  if (state.git.isRepo) {
    const wc = await workingChanges(root);
    git.uncommitted = wc ? wc.filter((f) => !f.path.startsWith('.athena/')).length : null;
  }

  const impact = impactOf([...changes.added, ...changes.modified, ...changes.deleted], { structural: [...changes.added, ...changes.deleted] });
  const affectedDocuments = impact.docs.map((id) => ({ file: KNOWLEDGE_DOCS.find((d) => d.id === id)!.file, reasons: impact.reasons[id] ?? [] }));
  const totalChanges = changes.added.length + changes.modified.length + changes.deleted.length;
  const missing = documents.some((d) => !d.present);
  return {
    project: state.projectName,
    root,
    health: missing ? 'degraded' : totalChanges ? 'needs-update' : 'healthy',
    analyzedAt: state.analyzedAt,
    documents,
    changes,
    git,
    affectedDocuments,
    sync: totalChanges ? 'needs-update' : 'up-to-date',
  };
}

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
  ui.line(`Synchronization: ${report.sync === 'up-to-date' ? ui.c.green('Up to date') : `${ui.c.yellow('Needs update')} ${ui.dim('— run `athena analyze`')}`}`);
}
