import path from 'node:path';
import { loadConfig } from '../core/config.js';
import { walkProject } from '../core/fs/walker.js';
import { impactOf } from '../core/impact/impact.js';
import { KNOWLEDGE_DOCS } from '../core/knowledge/documents.js';
import { isBlockModified, parseBlocks } from '../core/knowledge/managed-blocks.js';
import { athenaDir, buildFileIndex, diffFileIndex, readState } from '../core/state/state.js';
import { readTextIfExists } from '../core/util/fs.js';
import { workingChanges } from '../core/git/git.js';
import { AthenaError } from './errors.js';

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
  const raw = diffFileIndex(state.fileIndex, buildFileIndex(walk.files));
  // Files Athena manages for agent integrations are not developer changes.
  const managed = new Set(Object.values(state.agents).flatMap((a) => a.files));
  const keep = (p: string) => !managed.has(p);
  const changes = { added: raw.added.filter(keep), modified: raw.modified.filter(keep), deleted: raw.deleted.filter(keep) };

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

