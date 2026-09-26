import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { analyzeProject, type AnalysisResult } from '../core/analyzer/analyze.js';
import { KNOWLEDGE_DOCS, type GeneratedDocId } from '../core/knowledge/documents.js';
import { ensureRules, planKnowledge, writePlannedKnowledge, type DocPlan } from '../core/knowledge/generate.js';
import { diffModels, type ModelChange } from '../core/impact/model-diff.js';
import { impactOf } from '../core/impact/impact.js';
import { ProjectModel } from '../core/model/project-model.js';
import { headMovement, type CommitSummary } from '../core/git/git.js';
import { athenaDir, backupCorruptedState, buildFileIndex, diffFileIndex, readState, writeState, type AthenaState } from '../core/state/state.js';
import { readTextIfExists, sha256, writeFileAtomic } from '../core/util/fs.js';
import { AthenaError, conflict } from './errors.js';
import { composeState, indexWithIntegrations } from './pipeline.js';

const IGNORE_FILE = '.sync-ignore.json';
const MAX_DIFF_CHARS = 60_000;

export interface FileChanges {
  added: string[];
  modified: string[];
  deleted: string[];
  /** Detected by identical content hash between a deleted and an added path. */
  renamed: Array<{ from: string; to: string }>;
}

export interface GitMovement {
  isRepo: boolean;
  previousHead: string | null;
  head: string | null;
  previousBranch: string | null;
  branch: string | null;
  branchChanged: boolean;
  commits: CommitSummary[];
  diverged: boolean;
  truncated: boolean;
}

export interface ProposedDocument {
  id: GeneratedDocId;
  file: string;
  title: string;
  status: 'created' | 'updated';
  /** Why this document is affected: model evidence first, then path heuristics. */
  reasons: string[];
  changedSections: string[];
  /** Developer-edited sections that stay untouched. */
  preservedSections: string[];
  /** Unified diff of the file (truncated for very large changes). */
  diff: string;
  diffTruncated: boolean;
  additions: number;
  deletions: number;
  /** Hash of the file when the plan was made; apply refuses if it changed. */
  baseHash: string | null;
}

export interface SyncPlan {
  /** Stable fingerprint of the proposed document contents. */
  id: string;
  createdAt: string;
  previousAnalysisAt: string | null;
  upToDate: boolean;
  fileChanges: FileChanges;
  git: GitMovement;
  modelChanges: ModelChange[];
  documents: ProposedDocument[];
  /** Documents that path heuristics flagged but whose content did not actually change. */
  checkedUnchanged: string[];
  ignored: boolean;
  durationMs: number;
  warnings: string[];
}

interface PlanInternals {
  analysis: AnalysisResult;
  plans: DocPlan[];
  prevState: AthenaState | null;
}

const internals = new WeakMap<SyncPlan, PlanInternals>();

const hashOf = (text: string | null) => (text === null ? null : sha256(text).slice(0, 16));

function countLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

function detectRenames(prev: AthenaState['fileIndex'], next: AthenaState['fileIndex'], added: string[], deleted: string[]): FileChanges {
  const byHash = new Map<string, string[]>();
  for (const d of deleted) {
    const h = prev[d]?.h;
    if (h && !h.startsWith('meta:')) byHash.set(h, [...(byHash.get(h) ?? []), d]);
  }
  const renamed: FileChanges['renamed'] = [];
  const remainingAdded: string[] = [];
  const usedDeleted = new Set<string>();
  for (const a of added) {
    const candidates = byHash.get(next[a]?.h ?? '')?.filter((d) => !usedDeleted.has(d));
    if (candidates?.length) {
      usedDeleted.add(candidates[0]!);
      renamed.push({ from: candidates[0]!, to: a });
    } else remainingAdded.push(a);
  }
  return { added: remainingAdded, modified: [], deleted: deleted.filter((d) => !usedDeleted.has(d)), renamed };
}

async function readPreviousModel(dir: string): Promise<ProjectModel | null> {
  const raw = await readTextIfExists(path.join(dir, 'model.json'));
  if (!raw) return null;
  try {
    const parsed = ProjectModel.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function readIgnored(dir: string): Promise<string | null> {
  const raw = await readTextIfExists(path.join(dir, IGNORE_FILE));
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as { planId?: unknown };
    return typeof j.planId === 'string' ? j.planId : null;
  } catch {
    return null;
  }
}

export interface PlanOptions {
  signal?: AbortSignal;
  force?: boolean;
}

/**
 * Compute what synchronizing knowledge would change — without writing anything.
 * Only documents whose generated content would actually differ are proposed.
 */
export async function planSync(root: string, opts: PlanOptions = {}): Promise<SyncPlan> {
  const started = Date.now();
  const dir = athenaDir(root);
  const st = await readState(dir);
  if (st.kind === 'missing' && !(await readTextIfExists(path.join(dir, 'rules.md')))) {
    throw new AthenaError('Athena is not initialized in this project.', 'Run `athena init` first.', 3);
  }
  const prevState = st.kind === 'ok' ? st.state : null;
  const warnings: string[] = [];
  if (st.kind === 'corrupted') warnings.push(`state.json is corrupted (${st.reason}); it will be rebuilt on apply.`);

  const [prevModel, analysis] = await Promise.all([readPreviousModel(dir), analyzeProject(root, { signal: opts.signal, reuse: prevState?.fileIndex })]);
  opts.signal?.throwIfAborted();

  const previousBlocks = prevState ? Object.fromEntries(Object.entries(prevState.documents).map(([k, v]) => [k, v.blocks])) : undefined;
  const plans = await planKnowledge(dir, analysis.model, { force: opts.force, previousBlocks });

  const nextIndex = buildFileIndex(analysis.files);
  const prevIndex = prevState?.fileIndex ?? {};
  const rawDiff = diffFileIndex(prevIndex, nextIndex);
  // Agent integration files that Athena manages are tracked by state; don't report them as developer changes.
  const managed = new Set(Object.values(prevState?.agents ?? {}).flatMap((a) => a.files));
  const idxChanges = { added: rawDiff.added.filter((p) => !managed.has(p)), modified: rawDiff.modified.filter((p) => !managed.has(p)), deleted: rawDiff.deleted.filter((p) => !managed.has(p)) };
  const renames = detectRenames(prevIndex, nextIndex, idxChanges.added, idxChanges.deleted);
  const fileChanges: FileChanges = { ...renames, modified: idxChanges.modified };

  const modelChanges = diffModels(prevModel, analysis.model);
  const allPaths = [...fileChanges.added, ...fileChanges.modified, ...fileChanges.deleted, ...fileChanges.renamed.flatMap((r) => [r.from, r.to])];
  const pathImpact = impactOf(allPaths, { structural: [...fileChanges.added, ...fileChanges.deleted, ...fileChanges.renamed.map((r) => r.to)] });

  const documents: ProposedDocument[] = [];
  for (const p of plans) {
    if (p.status === 'unchanged') continue;
    const doc = KNOWLEDGE_DOCS.find((d) => d.id === p.id)!;
    const reasons = [
      ...modelChanges.filter((c) => c.docs.includes(p.id)).map((c) => `${c.label}: ${c.summary}`),
      ...(pathImpact.reasons[p.id] ?? []).map((r) => `Changed files (${r})`),
    ];
    if (p.status === 'created') reasons.unshift('Document is missing and will be recreated');
    if (!reasons.length) reasons.push('Rendered content differs from the file on disk (for example after an Athena upgrade or a manual edit outside sections)');
    let patch = createTwoFilesPatch(`a/.athena/${p.file}`, `b/.athena/${p.file}`, p.before ?? '', p.after, undefined, undefined, { context: 3 });
    const counts = countLines(patch);
    const diffTruncated = patch.length > MAX_DIFF_CHARS;
    if (diffTruncated) patch = `${patch.slice(0, MAX_DIFF_CHARS)}\n… diff truncated …\n`;
    documents.push({
      id: p.id,
      file: p.file,
      title: doc.title,
      status: p.status,
      reasons: [...new Set(reasons)],
      changedSections: p.changedBlocks,
      preservedSections: p.preservedModified,
      diff: patch,
      diffTruncated,
      ...counts,
      baseHash: hashOf(p.before),
    });
  }

  const git: GitMovement = {
    isRepo: analysis.model.git.isRepo,
    previousHead: prevState?.git.head ?? null,
    head: analysis.model.git.head ?? null,
    previousBranch: prevState?.git.branch ?? null,
    branch: analysis.model.git.branch ?? null,
    branchChanged: Boolean(prevState?.git.branch && analysis.model.git.branch && prevState.git.branch !== analysis.model.git.branch),
    commits: [],
    diverged: false,
    truncated: false,
  };
  if (git.isRepo && git.previousHead && git.head && git.previousHead !== git.head) {
    const mv = await headMovement(root, git.previousHead, git.head);
    if (mv) Object.assign(git, { commits: mv.commits, diverged: mv.diverged, truncated: mv.truncated });
  }

  const id = sha256(JSON.stringify(documents.map((d) => [d.file, d.baseHash, hashOf(plans.find((p) => p.id === d.id)!.after)]))).slice(0, 16);
  const upToDate = documents.length === 0;
  const plan: SyncPlan = {
    id,
    createdAt: new Date().toISOString(),
    previousAnalysisAt: prevState?.analyzedAt ?? null,
    upToDate,
    fileChanges,
    git,
    modelChanges: prevModel ? modelChanges : [],
    documents,
    checkedUnchanged: pathImpact.docs.map((d) => KNOWLEDGE_DOCS.find((k) => k.id === d)!.file).filter((f) => !documents.some((d) => d.file === f)),
    ignored: !upToDate && (await readIgnored(dir)) === id,
    durationMs: Date.now() - started,
    warnings,
  };
  internals.set(plan, { analysis, plans, prevState });
  return plan;
}

export interface ApplyResult {
  applied: string[];
  preserved: Array<{ file: string; sections: string[] }>;
  analyzedAt: string;
}

/**
 * Apply a plan produced by planSync. Refuses (409) if any affected document changed
 * on disk after the plan was made. Always refreshes the file index and model so
 * the project is marked synchronized.
 */
export async function applySync(root: string, plan: SyncPlan): Promise<ApplyResult> {
  const inner = internals.get(plan);
  if (!inner) throw new AthenaError('This sync plan is no longer available.', 'Create a new plan and try again.', 1, 'conflict');
  const dir = athenaDir(root);

  for (const d of plan.documents) {
    const current = hashOf(await readTextIfExists(path.join(dir, d.file)));
    if (current !== d.baseHash) {
      throw conflict(`${d.file} changed after the sync plan was created.`, 'Review the new plan before applying.', { file: d.file });
    }
  }

  const st = await readState(dir);
  if (st.kind === 'corrupted') await backupCorruptedState(dir);
  const prevState = st.kind === 'ok' ? st.state : inner.prevState;

  await fs.mkdir(dir, { recursive: true });
  const docs = await writePlannedKnowledge(dir, inner.plans);
  docs.push(await ensureRules(dir, inner.analysis.model));
  await writeFileAtomic(path.join(dir, 'model.json'), `${JSON.stringify(inner.analysis.model, null, 2)}\n`);
  const managedFiles = Object.values(prevState?.agents ?? {}).flatMap((a) => a.files);
  const state = composeState({
    prevState,
    analysis: inner.analysis,
    docs,
    agents: prevState?.agents ?? {},
    fileIndex: await indexWithIntegrations(root, inner.analysis.files, managedFiles),
  });
  await writeState(dir, state);
  await fs.rm(path.join(dir, IGNORE_FILE), { force: true });
  internals.delete(plan);
  return {
    applied: plan.documents.map((d) => d.file),
    preserved: plan.documents.filter((d) => d.preservedSections.length).map((d) => ({ file: d.file, sections: d.preservedSections })),
    analyzedAt: state.analyzedAt,
  };
}

/** Remember that the developer dismissed this exact proposal; it resurfaces once content changes again. */
export async function ignorePlan(root: string, planId: string): Promise<void> {
  if (!/^[a-f0-9]{16}$/.test(planId)) throw new AthenaError('Invalid plan id');
  await writeFileAtomic(path.join(athenaDir(root), IGNORE_FILE), `${JSON.stringify({ planId, ignoredAt: new Date().toISOString() }, null, 2)}\n`);
}

export function fileChangeCount(plan: SyncPlan): number {
  const c = plan.fileChanges;
  return c.added.length + c.modified.length + c.deleted.length + c.renamed.length;
}

/** True when files changed but no knowledge document needs updating: only the index/model need refreshing. */
export function needsIndexRefreshOnly(plan: SyncPlan): boolean {
  return plan.upToDate && (fileChangeCount(plan) > 0 || plan.git.head !== plan.git.previousHead);
}

export function summarizePlan(plan: SyncPlan) {
  const { documents, ...rest } = plan;
  return { ...rest, documents: documents.map(({ diff: _diff, ...d }) => d) };
}

/**
 * Sections rendered from Git history rather than from the code. They change with
 * every commit (and as the history window moves), so `sync --check` does not
 * treat them as stale knowledge; `athena sync` still refreshes them.
 */
export const HISTORY_SECTIONS: ReadonlySet<string> = new Set(['hotspots']);

/** Documents that make `athena sync --check` fail: any change beyond history-derived sections. */
export function staleForCheck(plan: SyncPlan): ProposedDocument[] {
  return plan.documents.filter((d) => d.status === 'created' || !d.changedSections.length || d.changedSections.some((s) => !HISTORY_SECTIONS.has(s)));
}
