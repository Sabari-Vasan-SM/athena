import { promises as fs } from 'node:fs';
import path from 'node:path';
import { git, GitCommandError, gitOrThrow, isSafeRef, parseNameStatusZ, workingChanges, type ChangedFile, type GitRunOptions } from '../core/git/git.js';
import { manifestDependencyNames } from '../core/analyzer/detectors/manifests.js';
import { listRules, parseRules, type Rule } from '../core/knowledge/rules.js';
import { scanText } from '../core/security/secrets.js';
import { Coverage, dedupeFindings, Finding, type ScanResult } from '../core/findings/finding.js';
import { hitsFromMatches, type SecretHit } from '../core/scanners/secrets.js';
import { reviewCoverage, reviewFindings, reviewScanner, type ReviewLocation } from '../core/scanners/review.js';
import type { Scanner } from '../core/scanners/types.js';
import { athenaDir } from '../core/state/state.js';
import { readTextIfExists, readTextInsideRoot } from '../core/util/fs.js';
import { AthenaError, EXIT } from './errors.js';
import { loadScan } from '../core/model/security-scan.js';
import { API_ROUTE_PATH, AUTH_PATH, SCHEMA_PATH, SOURCE_FILE, TEST_FILE } from '../core/patterns.js';

export type FindingLevel = 'blocker' | 'warning' | 'info';

export interface ReviewFinding {
  level: FindingLevel;
  check: string;
  message: string;
  files: string[];
  hint?: string;
}

export type ReviewMode = 'working' | 'staged' | 'base';

export interface SkippedFile {
  path: string;
  /** Why the file's contents were not checked. */
  reason: 'outside-root' | 'too-large' | 'not-a-file' | 'unreadable' | 'budget';
}

export interface ReviewResult {
  base: string;
  /** What was compared: the working tree, the index (`--staged`) or `merge-base(base, HEAD)..HEAD`. */
  mode: ReviewMode;
  /** The merge base the range starts at (mode `base` only). */
  mergeBase?: string;
  changedFiles: ChangedFile[];
  findings: ReviewFinding[];
  /** Enabled rules from rules.md — a checklist for the human or agent, not automated. */
  rules: Rule[];
  checklist: string[];
  knowledgeInSync: boolean | null;
  stats: { added: number; removed: number; files: number };
  /** True when some changed files could not be checked (see `skipped`). */
  incomplete: boolean;
  skipped: SkippedFile[];
  /**
   * The same checks as unified findings (`review/<check>`, and `secret/*` at the exact
   * added line instead of the `secrets` check), with coverage. `findings` above keeps
   * the original check list for compatibility.
   */
  scan: ScanResult;
}

const ENV_FILE = /(^|\/)\.env(\.(local|production|development|prod|dev|staging))?$/;
const MANIFEST_FILE = /(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|go\.mod|Cargo\.toml|composer\.json|Gemfile|pubspec\.yaml|pom\.xml|build\.gradle(\.kts)?)$/;
/** Untracked files above this size are reported as large and not read. */
const LARGE_ADDED_BYTES = 512 * 1024;
/** Upper bound on the diff (and on untracked file contents) Athena reads. Larger changes fail the review. */
export const MAX_DIFF_BYTES = 64 * 1024 * 1024;
const REVIEW_GIT_TIMEOUT_MS = 120_000;
const FETCH_HINT = 'Make sure the base commit and the history back to the merge base are present. In GitHub Actions use `actions/checkout` with `fetch-depth: 0`; elsewhere run `git fetch --unshallow` or fetch the base branch.';

export interface AddedLine {
  file: string;
  line: number;
  text: string;
}

/** Undo git's C-style path quoting (`"a\tb"`, octal escapes for raw bytes). */
function unquoteGitPath(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const bytes: number[] = [];
  const body = p.slice(1, -1);
  const esc: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const next = body[i + 1] ?? '';
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(esc[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Added lines from a unified diff (content only, no metadata). Hunk line counts
 * are tracked so content lines that look like headers (`+++…`) are still read.
 */
export function addedLines(patch: string): AddedLine[] {
  const out: AddedLine[] = [];
  let file = '';
  let lineNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of patch.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      const c = raw[0];
      if (c === '+') {
        out.push({ file, line: lineNo++, text: raw.slice(1) });
        newLeft--;
        continue;
      }
      if (c === '-') {
        oldLeft--;
        continue;
      }
      if (c === ' ') {
        lineNo++;
        oldLeft--;
        newLeft--;
        continue;
      }
      if (c === '\\') continue;
      oldLeft = newLeft = 0;
    } else if (raw.startsWith('\\')) continue;
    if (raw.startsWith('diff --git ')) {
      file = '';
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const p = unquoteGitPath(raw.slice(4).replace(/\t$/, ''));
      file = p === '/dev/null' ? '' : p.startsWith('b/') ? p.slice(2) : p;
      continue;
    }
    const h = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (h) {
      oldLeft = h[1] === undefined ? 1 : Number(h[1]);
      lineNo = Number(h[2]);
      newLeft = h[3] === undefined ? 1 : Number(h[3]);
    }
  }
  return out;
}

/**
 * Secret matches in added lines. Consecutive added lines of a file are scanned as
 * one block so multi-line secrets (private keys) are found; each match is reported
 * at the real line where it starts. Values are never returned.
 */
export function scanAddedLines(lines: AddedLine[]): Array<{ type: string; file: string; line: number }> {
  return scanAddedLinesDetailed(lines).map((h) => ({ type: h.type, file: h.file, line: h.line }));
}

/**
 * Like scanAddedLines, with the column, the line's text and the matched span (for
 * masked fingerprints). The text stays in memory: it is never part of a result.
 */
export function scanAddedLinesDetailed(lines: AddedLine[]): SecretHit[] {
  const hits: SecretHit[] = [];
  let block: AddedLine[] = [];
  const flush = () => {
    if (!block.length) return;
    const b = block;
    block = [];
    const text = b.map((l) => l.text).join('\n');
    for (const h of hitsFromMatches('', text, scanText(text))) {
      const at = b[h.line - 1] ?? b[0]!;
      const endAt = h.endLine ? b[h.endLine - 1] : undefined;
      hits.push({ ...h, file: at.file, line: at.line, ...(endAt ? { endLine: endAt.line } : {}) });
    }
  };
  for (const l of lines) {
    const prev = block[block.length - 1];
    if (prev && (prev.file !== l.file || prev.line + 1 !== l.line)) flush();
    block.push(l);
  }
  flush();
  return hits;
}

export interface ReviewOptions {
  /** Git ref to compare against; default: working tree vs HEAD. */
  base?: string;
  /** Review what is staged for commit (the index vs HEAD) instead of the working tree. */
  staged?: boolean;
  signal?: AbortSignal;
  /** Whether knowledge sync state should be checked (can be slow). */
  checkSync?: (root: string) => Promise<boolean>;
  /** Override MAX_DIFF_BYTES (tests). */
  maxDiffBytes?: number;
}

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--relative', '--src-prefix=a/', '--dst-prefix=b/', '-M'];

/**
 * Deterministic pre-review of the current change. Athena runs no AI here: every
 * finding is a fact about the diff. The project's own rules and review checklist
 * are listed for the human (or agent) to apply.
 *
 * Fails closed: when Git can't produce the full change (unknown base, shallow
 * clone, oversized diff, any git error) this throws instead of returning a
 * result with fewer findings.
 */
export async function reviewChanges(root: string, opts: ReviewOptions = {}): Promise<ReviewResult> {
  try {
    return await review(root, opts);
  } catch (err) {
    if (err instanceof GitCommandError) {
      throw new AthenaError(`Could not complete the review: ${err.message}`, 'Athena did not check this change. Fix the Git problem above and run `athena review` again.', EXIT.NOT_AVAILABLE);
    }
    throw err;
  }
}

async function review(root: string, opts: ReviewOptions): Promise<ReviewResult> {
  const started = Date.now();
  const signal = opts.signal;
  signal?.throwIfAborted();
  const repoCheck = await git(root, ['rev-parse', '--is-inside-work-tree'], { signal });
  if (repoCheck.aborted) throw signal?.reason ?? new Error('Aborted');
  const isRepo = repoCheck.stdout.trim() === 'true';
  if (!isRepo) throw new AthenaError('`athena review` needs a Git repository.', 'Initialize Git, or review changes manually.');
  if (opts.base !== undefined && opts.staged) throw new AthenaError('`--staged` and `--base` cannot be combined.', 'Use `--staged` before committing, or `--base <ref>` to review commits.');
  if (opts.base !== undefined && !isSafeRef(opts.base)) throw new AthenaError(`Invalid base ref: ${opts.base}`);

  const runOpts: GitRunOptions = { signal, timeoutMs: REVIEW_GIT_TIMEOUT_MS };
  const g = (args: string[], extra: GitRunOptions = {}) => gitOrThrow(root, args, { ...runOpts, ...extra });
  const mode: ReviewMode = opts.base !== undefined ? 'base' : opts.staged ? 'staged' : 'working';
  const base = opts.base ?? 'HEAD';

  // What the change is compared against, and the diff arguments that select it.
  const headCommit = await git(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], runOpts);
  if (headCommit.aborted) throw signal?.reason ?? new Error('Aborted');
  let before: string | null; // tree-ish holding the "before" version of files; null = nothing yet
  let diffArgs: string[];
  let mergeBase: string | undefined;
  if (mode === 'base') {
    if (!headCommit.ok) throw new AthenaError("Can't review: HEAD has no commits yet.", undefined, EXIT.NOT_AVAILABLE);
    const baseCommit = await git(root, ['rev-parse', '--verify', '-q', `${opts.base}^{commit}`], runOpts);
    if (baseCommit.aborted) throw signal?.reason ?? new Error('Aborted');
    if (!baseCommit.ok || !baseCommit.stdout.trim()) {
      throw new AthenaError(`Can't review against ${opts.base}: it is not a commit in this repository (insufficient Git history).`, FETCH_HINT, EXIT.NOT_AVAILABLE);
    }
    const mb = await git(root, ['merge-base', baseCommit.stdout.trim(), headCommit.stdout.trim()], runOpts);
    if (mb.aborted) throw signal?.reason ?? new Error('Aborted');
    if (!mb.ok || !mb.stdout.trim()) {
      throw new AthenaError(`Can't review against ${opts.base}: no common ancestor with HEAD was found (the clone may be shallow).`, FETCH_HINT, EXIT.NOT_AVAILABLE);
    }
    mergeBase = mb.stdout.trim();
    before = mergeBase;
    diffArgs = [mergeBase, 'HEAD'];
  } else {
    // An unborn branch compares against the empty tree.
    before = headCommit.ok ? headCommit.stdout.trim() : null;
    const from = before ?? (await g(['hash-object', '-t', 'tree', '--stdin'], { input: '' })).trim();
    diffArgs = mode === 'staged' ? ['--cached', from] : [from];
  }

  let changed: ChangedFile[];
  if (mode === 'working') {
    const w = await workingChanges(root);
    if (!w) throw new AthenaError('Could not complete the review: `git status` failed.', 'Athena did not check this change.', EXIT.NOT_AVAILABLE);
    changed = w;
  } else {
    changed = parseNameStatusZ(await g(['diff', '--name-status', '-z', ...DIFF_FLAGS, ...diffArgs, '--', '.']));
  }
  const changedFiles = changed.filter((f) => !f.path.startsWith('.athena/'));

  const budget = opts.maxDiffBytes ?? MAX_DIFF_BYTES;
  const diff = await git(root, ['-c', 'core.quotePath=false', 'diff', ...DIFF_FLAGS, ...diffArgs, '--', '.'], { ...runOpts, maxBytes: budget });
  if (diff.aborted) throw signal?.reason ?? new Error('Aborted');
  if (diff.overflow) {
    throw new AthenaError(`The diff is larger than ${Math.round(budget / (1024 * 1024))} MB, so Athena can't review all of it.`, 'Athena did not check this change. Review a smaller range or split the change.', EXIT.NOT_AVAILABLE);
  }
  if (!diff.ok) throw new GitCommandError(['diff'], diff);
  const added = addedLines(diff.stdout);

  // Untracked files (working tree only): read each once, never through a symlink
  // that leaves the project, and never more than LARGE_ADDED_BYTES.
  const skipped: SkippedFile[] = [];
  const large: string[] = [];
  const untrackedText = new Map<string, string>();
  let untrackedAdded = 0;
  let untrackedBytes = diff.stdout.length;
  for (const f of changedFiles.filter((x) => x.status === 'untracked')) {
    signal?.throwIfAborted();
    if (untrackedBytes > budget) {
      skipped.push({ path: f.path, reason: 'budget' });
      continue;
    }
    const r = await readTextInsideRoot(root, f.path, LARGE_ADDED_BYTES);
    if (!r.ok) {
      if (r.reason === 'too-large') large.push(f.path);
      if (r.reason !== 'missing') skipped.push({ path: f.path, reason: r.reason });
      continue;
    }
    untrackedBytes += r.bytes;
    untrackedText.set(f.path, r.text);
    const lines = r.text.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    lines.forEach((text, i) => added.push({ file: f.path, line: i + 1, text }));
    untrackedAdded += lines.filter((l) => l.length > 0).length;
  }

  const numstat = await g(['diff', '--numstat', ...DIFF_FLAGS, ...diffArgs, '--', '.']);
  let addedCount = 0;
  let removedCount = 0;
  for (const line of numstat.split('\n')) {
    const [a, r] = line.split('\t');
    if (a && r && a !== '-') {
      addedCount += Number(a) || 0;
      removedCount += Number(r) || 0;
    }
  }

  /**
   * Contents of a changed file as it will be committed (working tree, index or
   * HEAD), for the dependency check. Its added lines were already scanned above,
   * so an unreadable file here only skips the dependency comparison.
   */
  const readNew = async (p: string): Promise<string | null> => {
    if (untrackedText.has(p)) return untrackedText.get(p)!;
    if (mode === 'working') {
      const r = await readTextInsideRoot(root, p, LARGE_ADDED_BYTES);
      return r.ok ? r.text : null;
    }
    const spec = `${mode === 'staged' ? '' : 'HEAD'}:./${p}`;
    const r = await git(root, ['cat-file', 'blob', spec], { ...runOpts, maxBytes: LARGE_ADDED_BYTES });
    if (r.aborted) throw signal?.reason ?? new Error('Aborted');
    if (r.overflow) return null;
    if (!r.ok) throw new GitCommandError(['cat-file', 'blob', spec], r);
    return r.stdout;
  };

  const findings: ReviewFinding[] = [];
  const paths = changedFiles.map((f) => f.path);
  /** Every location a check covers (its `files` list is capped for display). */
  const locations = new Map<ReviewFinding, ReviewLocation[]>();
  const add = (f: ReviewFinding, all?: Array<string | ReviewLocation>) => {
    findings.push(f);
    locations.set(f, (all ?? f.files).map((x) => (typeof x === 'string' ? { file: x } : x)));
  };

  // 1. Secrets in added lines — the only blocker Athena raises on its own.
  const secretDetail = scanAddedLinesDetailed(added);
  const secretHits = new Map<string, Set<string>>();
  for (const hit of secretDetail) {
    if (!secretHits.has(hit.type)) secretHits.set(hit.type, new Set());
    secretHits.get(hit.type)!.add(`${hit.file}:${hit.line}`);
  }
  for (const [type, locations] of secretHits) {
    add({ level: 'blocker', check: 'secrets', message: `Possible ${type} added`, files: [...locations].slice(0, 10), hint: 'Remove the value, use an environment variable, and rotate the credential if it was real.' });
  }

  // 2. Env files (removing one from the repository is not flagged)
  const envFiles = changedFiles.filter((f) => f.status !== 'deleted' && ENV_FILE.test(f.path)).map((f) => f.path);
  if (envFiles.length) add({ level: 'blocker', check: 'env-file', message: 'Environment file included in the change', files: envFiles, hint: 'Add it to .gitignore and commit a .env.example with names only.' });

  // 3. New dependencies (a new manifest adds all of its dependencies)
  for (const f of changedFiles.filter((x) => x.status !== 'deleted' && MANIFEST_FILE.test(x.path))) {
    signal?.throwIfAborted();
    const now = await readNew(f.path);
    if (now === null) continue;
    const nowDeps = await manifestDependencyNames(f.path, now);
    if (!nowDeps) continue;
    let beforeText = '';
    const beforePath = f.status === 'renamed' && f.from ? f.from : f.path;
    if (before && f.status !== 'added' && f.status !== 'untracked') {
      const spec = `${before}:./${beforePath}`;
      const r = await git(root, ['cat-file', 'blob', spec], { ...runOpts, maxBytes: 8 * 1024 * 1024 });
      if (r.aborted) throw signal?.reason ?? new Error('Aborted');
      if (r.ok) beforeText = r.stdout;
      else if (f.status === 'modified' || f.status === 'renamed') throw new GitCommandError(['cat-file', 'blob', spec], r);
    }
    const beforeDeps = (await manifestDependencyNames(f.path, beforeText)) ?? new Set<string>();
    const newDeps = [...nowDeps].filter((d) => !beforeDeps.has(d));
    if (newDeps.length) add({ level: 'info', check: 'dependencies', message: `New dependencies: ${newDeps.slice(0, 10).join(', ')}${newDeps.length > 10 ? ` +${newDeps.length - 10}` : ''}`, files: [f.path], hint: 'Justify each addition; check licence, maintenance and size.' });
  }

  // 4. Source without tests (structural only)
  const changedSource = paths.filter((p) => SOURCE_FILE.test(p) && !TEST_FILE.test(p));
  const changedTests = paths.filter((p) => TEST_FILE.test(p));
  if (changedSource.length && !changedTests.length) {
    add({ level: 'warning', check: 'tests', message: `${changedSource.length} source file(s) changed with no test file changes`, files: changedSource.slice(0, 10), hint: 'See `.athena/testing.md` for the project test commands and layout.' }, changedSource);
  }

  // 5. Routes / schema / auth touchpoints
  const routeFiles = changedSource.filter((p) => API_ROUTE_PATH.test(p));
  if (routeFiles.length) add({ level: 'info', check: 'api', message: 'API surface changed', files: routeFiles.slice(0, 10), hint: 'Check auth/authorization and error handling (`.athena/api.md`, `.athena/auth.md`).' }, routeFiles);
  const schemaFiles = paths.filter((p) => SCHEMA_PATH.test(p));
  if (schemaFiles.length) add({ level: 'info', check: 'database', message: 'Database schema or migrations changed', files: schemaFiles.slice(0, 10), hint: 'Check indexes, constraints and backward compatibility (`.athena/database.md`).' }, schemaFiles);
  const authFiles = changedSource.filter((p) => AUTH_PATH.test(p));
  if (authFiles.length) add({ level: 'warning', check: 'auth', message: 'Authentication/authorization code changed', files: authFiles.slice(0, 10), hint: 'Review against `.athena/auth.md` and `.athena/security.md`.' }, authFiles);

  // 6. Large added files
  for (const f of changedFiles.filter((x) => x.status === 'added')) {
    signal?.throwIfAborted();
    let size: number | null = null;
    if (mode === 'working') {
      const st = await fs.lstat(path.join(root, f.path)).catch(() => null);
      size = st?.isFile() ? st.size : null;
    } else {
      const r = await git(root, ['cat-file', '-s', `${mode === 'staged' ? '' : 'HEAD'}:./${f.path}`], runOpts);
      if (r.ok) size = Number(r.stdout.trim());
    }
    if (size !== null && size > LARGE_ADDED_BYTES && !large.includes(f.path)) large.push(f.path);
  }
  if (large.length) add({ level: 'warning', check: 'large-files', message: 'Large files added', files: large, hint: 'Consider whether these belong in Git.' });

  // 7. Debug leftovers in added lines
  const debugHits = added.filter((l) => /\b(TODO|FIXME|XXX|console\.log|debugger|print\(|binding\.pry|dd\()/.test(l.text) && SOURCE_FILE.test(l.file));
  if (debugHits.length) {
    add({ level: 'info', check: 'leftovers', message: `${debugHits.length} added line(s) contain TODO/FIXME or debug statements`, files: [...new Set(debugHits.map((l) => `${l.file}:${l.line}`))].slice(0, 10) }, debugHits.map((l) => ({ file: l.file, line: l.line })));
  }

  // 8. Known vulnerable dependencies from the last scan
  const lastScan = await loadScan(root);
  if (lastScan) {
    const vulnerable = lastScan.tools.flatMap((t) => t.findings).filter((f) => ['critical', 'high'].includes(f.severity));
    if (vulnerable.length) add({ level: 'warning', check: 'vulnerabilities', message: `${vulnerable.length} high/critical dependency advisor${vulnerable.length === 1 ? 'y' : 'ies'} from the last scan (${lastScan.scannedAt.slice(0, 10)})`, files: [], hint: 'Run `athena security` for details.' });
  }

  // 9. Knowledge freshness
  let knowledgeInSync: boolean | null = null;
  if (opts.checkSync) {
    knowledgeInSync = await opts.checkSync(root).catch(() => null);
    if (knowledgeInSync === false) add({ level: 'info', check: 'knowledge', message: 'Athena knowledge is out of date for these changes', files: [], hint: 'Run `athena sync` so agents read current context.' });
  }

  const rulesText = await readTextIfExists(path.join(athenaDir(root), 'rules.md'));
  const rules = rulesText ? listRules(parseRules(rulesText)).filter((r) => r.enabled) : [];
  const reviewDoc = await readTextIfExists(path.join(athenaDir(root), 'code-review.md'));
  const checklist = reviewDoc
    ? [...reviewDoc.matchAll(/^- \[ \] (.+)$/gm)].map((m) => m[1]!.trim())
    : [];

  if (skipped.length) {
    add({ level: 'warning', check: 'skipped', message: `${skipped.length} changed file${skipped.length === 1 ? ' was' : 's were'} not checked`, files: skipped.map((s) => `${s.path} (${SKIP_REASON[s.reason]})`).slice(0, 10), hint: 'Athena could not read these files, so their contents were not checked for secrets. Check them yourself.' }, skipped.map((s) => s.path));
  }

  const durationMs = Date.now() - started;
  const tooLarge = skipped.filter((s) => s.reason === 'too-large').length;
  const scan: ScanResult = {
    schemaVersion: 1,
    scannedAt: new Date().toISOString(),
    durationMs,
    scope: { mode: mode === 'working' ? 'changed' : mode, ...(opts.base !== undefined ? { base: opts.base } : {}), files: changedFiles.length },
    findings: dedupeFindings(reviewFindings({ checks: findings.map((check) => ({ check, locations: locations.get(check) ?? [] })), secrets: secretDetail }).map((f) => Finding.parse(f))),
    coverage: reviewCoverage({ checked: changedFiles.filter((f) => f.status !== 'deleted').length - skipped.length, skipped: { tooLarge, unreadable: skipped.length - tooLarge }, durationMs, incomplete: skipped.length > 0 }).map((c) => Coverage.parse(c)),
  };

  return { base, mode, ...(mergeBase ? { mergeBase } : {}), changedFiles, findings, rules, checklist, knowledgeInSync, stats: { added: addedCount + untrackedAdded, removed: removedCount, files: changedFiles.length }, incomplete: skipped.length > 0, skipped, scan };
}

/**
 * The review checks as a scanner for `runScanners`: scope `staged` reviews the index,
 * `base` the commits since `ctx.base`, `changed` the working tree. Scope `all` is
 * skipped (there is no diff). A review that cannot run (no Git, unknown base) throws,
 * which runScanners records as `failed` coverage.
 */
export function createReviewScanner(opts: Pick<ReviewOptions, 'checkSync' | 'maxDiffBytes'> = {}): Scanner {
  return reviewScanner(async (ctx) => {
    const r = await reviewChanges(ctx.root, { ...opts, signal: ctx.signal, ...(ctx.mode === 'staged' ? { staged: true } : {}), ...(ctx.mode === 'base' ? { base: ctx.base ?? 'HEAD' } : {}) });
    return { findings: r.scan.findings, coverage: r.scan.coverage };
  });
}

const SKIP_REASON: Record<SkippedFile['reason'], string> = {
  'outside-root': 'symlink to a path outside the project',
  'too-large': `larger than ${LARGE_ADDED_BYTES / 1024} KB`,
  'not-a-file': 'not a regular file',
  unreadable: 'could not be read',
  budget: `over the ${MAX_DIFF_BYTES / (1024 * 1024)} MB review limit`,
};

export function hasBlockers(result: ReviewResult): boolean {
  return result.findings.some((f) => f.level === 'blocker');
}
