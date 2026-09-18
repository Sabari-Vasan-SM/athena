import path from 'node:path';
import { changesSince, git, isSafeRef, workingChanges, type ChangedFile } from '../core/git/git.js';
import { listRules, parseRules, type Rule } from '../core/knowledge/rules.js';
import { scanText } from '../core/security/secrets.js';
import { athenaDir } from '../core/state/state.js';
import { readTextIfExists } from '../core/util/fs.js';
import { AthenaError } from './errors.js';
import { loadScan } from '../core/model/security-scan.js';

export type FindingLevel = 'blocker' | 'warning' | 'info';

export interface ReviewFinding {
  level: FindingLevel;
  check: string;
  message: string;
  files: string[];
  hint?: string;
}

export interface ReviewResult {
  base: string;
  changedFiles: ChangedFile[];
  findings: ReviewFinding[];
  /** Enabled rules from rules.md — a checklist for the human or agent, not automated. */
  rules: Rule[];
  checklist: string[];
  knowledgeInSync: boolean | null;
  stats: { added: number; removed: number; files: number };
}

const TEST_FILE = /(^|\/)(__tests__|tests?|spec|specs|e2e)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go|exs)$|_spec\.rb$|Tests?\.(java|kt|cs)$/;
const SOURCE_FILE = /\.(m|c)?(t|j)sx?$|\.(py|go|rs|java|kt|cs|php|rb|dart|ex|swift|vue|svelte)$/;
const ROUTE_FILE = /(^|\/)(routes?|controllers?|handlers?|api|endpoints?|resolvers?)\/|(^|\/)(urls\.py|routes\.rb)$|(^|\/)app\/(.+\/)?route\.(t|j)sx?$/i;
const SCHEMA_FILE = /\.prisma$|\.sql$|(^|\/)(migrations?|migrate|alembic)\/|(^|\/)models(\.py|\/)/i;
const AUTH_FILE = /(auth|session|login|oauth|jwt|guard|permission|rbac|acl|polic(y|ies)|middleware)/i;
const ENV_FILE = /(^|\/)\.env(\.(local|production|development|prod|dev|staging))?$/;
const MANIFEST_FILE = /(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|go\.mod|Cargo\.toml|composer\.json|Gemfile|pubspec\.yaml|pom\.xml|build\.gradle(\.kts)?)$/;
const LARGE_ADDED_BYTES = 512 * 1024;

/** Added lines from a unified diff (content only, no metadata). */
function addedLines(patch: string): Array<{ file: string; line: number; text: string }> {
  const out: Array<{ file: string; line: number; text: string }> = [];
  let file = '';
  let lineNo = 0;
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('+++ b/')) {
      file = raw.slice(6);
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) {
      lineNo = Number(h[1]);
      continue;
    }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      out.push({ file, line: lineNo++, text: raw.slice(1) });
    } else if (!raw.startsWith('-') && !raw.startsWith('\\')) lineNo++;
  }
  return out;
}

function depsOf(manifest: string, text: string): Set<string> {
  const names = new Set<string>();
  try {
    if (manifest.endsWith('package.json')) {
      const j = JSON.parse(text) as Record<string, unknown>;
      for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
        const deps = j[key];
        if (deps && typeof deps === 'object') for (const n of Object.keys(deps)) names.add(n);
      }
      return names;
    }
  } catch {
    return names;
  }
  for (const m of text.matchAll(/^\s*["']?([A-Za-z0-9._@/-]+)["']?\s*[=:><~^]/gm)) names.add(m[1]!);
  return names;
}

export interface ReviewOptions {
  /** Git ref to compare against; default: working tree vs HEAD. */
  base?: string;
  signal?: AbortSignal;
  /** Whether knowledge sync state should be checked (can be slow). */
  checkSync?: (root: string) => Promise<boolean>;
}

/**
 * Deterministic pre-review of the current change. Athena runs no AI here: every
 * finding is a fact about the diff. The project's own rules and review checklist
 * are listed for the human (or agent) to apply.
 */
export async function reviewChanges(root: string, opts: ReviewOptions = {}): Promise<ReviewResult> {
  const isRepo = (await git(root, ['rev-parse', '--is-inside-work-tree'])).stdout.trim() === 'true';
  if (!isRepo) throw new AthenaError('`athena review` needs a Git repository.', 'Initialize Git, or review changes manually.');

  const base = opts.base ?? 'HEAD';
  if (opts.base && !isSafeRef(opts.base)) throw new AthenaError(`Invalid base ref: ${opts.base}`);

  const changed = opts.base ? await changesSince(root, opts.base).catch(() => null) : await workingChanges(root);
  const changedFiles = (changed ?? []).filter((f) => !f.path.startsWith('.athena/'));

  const diffArgs = opts.base ? ['diff', '-M', `${opts.base}...HEAD`] : ['diff', 'HEAD'];
  const patch = (await git(root, [...diffArgs, '--', '.'])).stdout;
  const untracked = changedFiles.filter((f) => f.status === 'untracked');
  let extra = '';
  for (const f of untracked.slice(0, 200)) {
    const text = await readTextIfExists(path.join(root, f.path));
    if (text && text.length < 512 * 1024) extra += `+++ b/${f.path}\n@@ -0,0 +1,${text.split('\n').length} @@\n${text.split('\n').map((l) => `+${l}`).join('\n')}\n`;
  }
  const added = addedLines(patch + extra);
  // Untracked files never appear in git numstat; count their lines as additions.
  let untrackedAdded = 0;
  for (const f of untracked) {
    const text = await readTextIfExists(path.join(root, f.path));
    if (text) untrackedAdded += text.split('\n').filter((l) => l.length > 0).length;
  }
  const numstat = (await git(root, [...diffArgs, '--numstat', '--', '.'])).stdout;
  let addedCount = 0;
  let removedCount = 0;
  for (const line of numstat.split('\n')) {
    const [a, r] = line.split('\t');
    if (a && r && a !== '-' ) {
      addedCount += Number(a) || 0;
      removedCount += Number(r) || 0;
    }
  }

  const findings: ReviewFinding[] = [];
  const paths = changedFiles.map((f) => f.path);
  const add = (f: ReviewFinding) => findings.push(f);

  // 1. Secrets in added lines — the only blocker Athena raises on its own.
  const secretHits = new Map<string, Set<string>>();
  for (const l of added) {
    for (const m of scanText(l.text)) {
      const key = `${m.type}`;
      if (!secretHits.has(key)) secretHits.set(key, new Set());
      secretHits.get(key)!.add(`${l.file}:${l.line}`);
    }
  }
  for (const [type, locations] of secretHits) {
    add({ level: 'blocker', check: 'secrets', message: `Possible ${type} added`, files: [...locations].slice(0, 10), hint: 'Remove the value, use an environment variable, and rotate the credential if it was real.' });
  }

  // 2. Env files
  const envFiles = paths.filter((p) => ENV_FILE.test(p));
  if (envFiles.length) add({ level: 'blocker', check: 'env-file', message: 'Environment file included in the change', files: envFiles, hint: 'Add it to .gitignore and commit a .env.example with names only.' });

  // 3. New dependencies
  for (const p of paths.filter((x) => MANIFEST_FILE.test(x))) {
    const now = await readTextIfExists(path.join(root, p));
    const before = (await git(root, ['show', `${opts.base ?? 'HEAD'}:${p}`])).stdout;
    if (!now || !before) continue;
    const newDeps = [...depsOf(p, now)].filter((d) => !depsOf(p, before).has(d));
    if (newDeps.length) add({ level: 'info', check: 'dependencies', message: `New dependencies: ${newDeps.slice(0, 10).join(', ')}${newDeps.length > 10 ? ` +${newDeps.length - 10}` : ''}`, files: [p], hint: 'Justify each addition; check licence, maintenance and size.' });
  }

  // 4. Source without tests (structural only)
  const changedSource = paths.filter((p) => SOURCE_FILE.test(p) && !TEST_FILE.test(p));
  const changedTests = paths.filter((p) => TEST_FILE.test(p));
  if (changedSource.length && !changedTests.length) {
    add({ level: 'warning', check: 'tests', message: `${changedSource.length} source file(s) changed with no test file changes`, files: changedSource.slice(0, 10), hint: 'See `.athena/testing.md` for the project test commands and layout.' });
  }

  // 5. Routes / schema / auth touchpoints
  const routeFiles = changedSource.filter((p) => ROUTE_FILE.test(p));
  if (routeFiles.length) add({ level: 'info', check: 'api', message: 'API surface changed', files: routeFiles.slice(0, 10), hint: 'Check auth/authorization and error handling (`.athena/api.md`, `.athena/auth.md`).' });
  const schemaFiles = paths.filter((p) => SCHEMA_FILE.test(p));
  if (schemaFiles.length) add({ level: 'info', check: 'database', message: 'Database schema or migrations changed', files: schemaFiles.slice(0, 10), hint: 'Check indexes, constraints and backward compatibility (`.athena/database.md`).' });
  const authFiles = changedSource.filter((p) => AUTH_FILE.test(p));
  if (authFiles.length) add({ level: 'warning', check: 'auth', message: 'Authentication/authorization code changed', files: authFiles.slice(0, 10), hint: 'Review against `.athena/auth.md` and `.athena/security.md`.' });

  // 6. Large added files
  const large: string[] = [];
  for (const f of changedFiles.filter((x) => x.status === 'added' || x.status === 'untracked')) {
    const text = await readTextIfExists(path.join(root, f.path)).catch(() => null);
    if (text && Buffer.byteLength(text) > LARGE_ADDED_BYTES) large.push(f.path);
  }
  if (large.length) add({ level: 'warning', check: 'large-files', message: 'Large files added', files: large, hint: 'Consider whether these belong in Git.' });

  // 7. Debug leftovers in added lines
  const debugHits = added.filter((l) => /\b(TODO|FIXME|XXX|console\.log|debugger|print\(|binding\.pry|dd\()/.test(l.text) && SOURCE_FILE.test(l.file));
  if (debugHits.length) {
    add({ level: 'info', check: 'leftovers', message: `${debugHits.length} added line(s) contain TODO/FIXME or debug statements`, files: [...new Set(debugHits.map((l) => `${l.file}:${l.line}`))].slice(0, 10) });
  }

  // 8. Known vulnerable dependencies from the last scan
  const scan = await loadScan(root);
  if (scan) {
    const vulnerable = scan.tools.flatMap((t) => t.findings).filter((f) => ['critical', 'high'].includes(f.severity));
    if (vulnerable.length) add({ level: 'warning', check: 'vulnerabilities', message: `${vulnerable.length} high/critical dependency advisor${vulnerable.length === 1 ? 'y' : 'ies'} from the last scan (${scan.scannedAt.slice(0, 10)})`, files: [], hint: 'Run `athena security` for details.' });
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

  return { base, changedFiles, findings, rules, checklist, knowledgeInSync, stats: { added: addedCount + untrackedAdded, removed: removedCount, files: changedFiles.length } };
}

export function hasBlockers(result: ReviewResult): boolean {
  return result.findings.some((f) => f.level === 'blocker');
}
