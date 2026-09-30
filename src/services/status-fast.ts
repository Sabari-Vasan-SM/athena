import { promises as fs, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ATHENA_DIR, type AthenaConfig } from '../core/config.js';
import { IgnoreMatcher } from '../core/fs/ignore.js';
import { factsConfigHash } from '../core/analyzer/config-hash.js';
import { CACHE_DIR } from '../core/cache/facts-cache.js';
import { mapLimit, statEntry } from '../core/fs/walker.js';
import { git, statusV2 } from '../core/git/git.js';
import { fileIndexPath, RACY_WINDOW_MS, sameHash, type FileIndex, type IndexDiff } from '../core/state/state.js';

export interface FastChanges {
  diff: IndexDiff;
  /** Uncommitted working-tree entries outside `.athena/` (same count as `workingChanges`). */
  uncommitted: number;
}

async function sameFactsConfig(root: string, config: AthenaConfig): Promise<boolean> {
  try {
    const v = JSON.parse(await fs.readFile(path.join(root, ATHENA_DIR, CACHE_DIR, 'facts', 'version.json'), 'utf8')) as { config?: unknown };
    return v.config === factsConfigHash(config);
  } catch {
    return false;
  }
}

const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const mtimeOf = (p: string) => statSync(p, { throwIfNoEntry: false })?.mtimeMs ?? null;

/**
 * Changes since the last analysis without walking the tree: every file in the
 * cached index is stat-ed (and re-hashed only when size/mtime moved), and new
 * files are found through Git — tracked paths (`ls-files`) plus untracked ones
 * (`ls-files -o` with the same exclude sources the walk uses; `.gitignore` files
 * and `.git/info/exclude`, not the global excludes file). The result equals
 * `diffFileIndex(index, walk)`.
 *
 * Returns null — the caller walks — whenever Git cannot give the same answer as
 * a walk: no index, not a Git work tree rooted at `root`, `include` patterns,
 * ignore rules changed since the index was written (`.gitignore`, config, info/exclude),
 * submodules, nested repositories, symlinked directories, or the file limit.
 */
export async function fastIndexChanges(root: string, config: AthenaConfig, prevIndex: FileIndex, signal?: AbortSignal): Promise<FastChanges | null> {
  const indexPaths = Object.keys(prevIndex);
  if (!indexPaths.length || config.include.length) return null;
  // Git's view matches the walk only when `root` is the work tree's top level with a real .git directory
  // (the walk reads root/.git/info/exclude and no .gitignore above root).
  if (!statSync(path.join(root, '.git'), { throwIfNoEntry: false })?.isDirectory()) return null;
  const indexMtime = mtimeOf(fileIndexPath(path.join(root, ATHENA_DIR)));
  if (indexMtime === null) return null;
  // Ignore rules edited after the index was written: the walk would include other files.
  const excludeFile = path.join(root, '.git', 'info', 'exclude');
  const excludeMtime = mtimeOf(excludeFile);
  // (Strictly newer: `git init` right before `athena init` must not disable the fast path.)
  if (excludeMtime !== null && excludeMtime > indexMtime) return null;
  const configMtime = mtimeOf(path.join(root, ATHENA_DIR, 'config.json'));
  if (configMtime !== null && configMtime > indexMtime - RACY_WINDOW_MS) {
    // `init` writes the config just before the index: within the racy window, trust it only
    // when the facts cache was built under this very config.
    if (configMtime > indexMtime || !(await sameFactsConfig(root, config))) return null;
  }

  const hasExclude = excludeMtime !== null;
  const gitCalls = Promise.all([
    statusV2(root, { signal }),
    git(root, ['ls-files', '-z', '-s', '--', '.'], { signal }),
    git(root, ['ls-files', '-z', '-o', '--exclude-per-directory=.gitignore', ...(hasExclude ? ['--exclude-from=.git/info/exclude'] : []), '--', '.'], { signal }),
  ]);

  // Modified / deleted: stat every indexed file while git runs.
  const diff: IndexDiff = { added: [], modified: [], deleted: [] };
  const recheck: string[] = [];
  for (const rel of indexPaths) {
    const prev = prevIndex[rel]!;
    const st = statSync(path.join(root, rel), { throwIfNoEntry: false });
    if (!st?.isFile()) {
      diff.deleted.push(rel);
      continue;
    }
    const large = st.size > config.maxFileBytes;
    if (prev.s === st.size && prev.m === Math.floor(st.mtimeMs) && prev.h.startsWith('meta:') === large) continue;
    recheck.push(rel);
  }
  signal?.throwIfAborted();
  const rechecked = await mapLimit(recheck, 32, (rel) => statEntry(root, rel, config.maxFileBytes));
  rechecked.forEach((e, i) => {
    const rel = recheck[i]!;
    if (!e) diff.deleted.push(rel);
    else if (!sameHash(prevIndex[rel]!.h, e.hash)) diff.modified.push(rel);
  });

  const [status, tracked, untracked] = await gitCalls;
  signal?.throwIfAborted();
  if (!status || !tracked.ok || !untracked.ok) return null;
  if (status.some((e) => e.submodule)) return null;
  const uncommitted = status.filter((e) => e.kind !== '!' && !e.path.startsWith(`${ATHENA_DIR}/`)).length;

  // Added: tracked or untracked paths the index doesn't know.
  const candidates = new Set<string>();
  for (const rec of tracked.stdout.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const mode = rec.slice(0, rec.indexOf(' '));
    const rel = rec.slice(tab + 1);
    if (mode === '160000') return null; // submodule: the walk descends into it
    if (mode === '120000' && statSync(path.join(root, rel), { throwIfNoEntry: false })?.isDirectory()) return null; // symlinked directory
    if (!(rel in prevIndex)) candidates.add(rel);
  }
  for (const rel of untracked.stdout.split('\0')) {
    if (!rel) continue;
    if (rel.endsWith('/')) return null; // nested repository: the walk descends into it
    if (!(rel in prevIndex)) candidates.add(rel);
  }

  const matcher = await IgnoreMatcher.load(root, config);
  const loaded = new Set<string>();
  const ignored = (rel: string): boolean => {
    // Walk semantics: each ancestor directory is tested with the rules above it, then its own .gitignore applies below it.
    for (let i = rel.indexOf('/'); i > 0; i = rel.indexOf('/', i + 1)) {
      const dir = rel.slice(0, i);
      if (matcher.ignores(dir, true)) return true;
      if (!loaded.has(dir)) {
        loaded.add(dir);
        try {
          matcher.setGitignore(dir, readFileSync(path.join(root, dir, '.gitignore'), 'utf8'));
        } catch {
          /* no .gitignore here */
        }
      }
    }
    return matcher.ignores(rel, false);
  };
  const toAdd: string[] = [];
  for (const rel of candidates) {
    if (ignored(rel)) continue;
    let st;
    try {
      st = await fs.lstat(path.join(root, rel));
    } catch {
      continue; // tracked but deleted from the work tree
    }
    if (st.isSymbolicLink()) {
      const target = await fs.realpath(path.join(root, rel)).catch(() => null);
      if (!target) continue;
      const relTarget = path.relative(await fs.realpath(root), target);
      if (relTarget.startsWith('..') || path.isAbsolute(relTarget)) continue;
      const tst = await fs.stat(target).catch(() => null);
      if (tst?.isDirectory()) return null;
      if (!tst?.isFile()) continue;
    } else if (!st.isFile()) continue;
    toAdd.push(rel);
  }
  const added = await mapLimit(toAdd, 32, (rel) => statEntry(root, rel, config.maxFileBytes));
  added.forEach((e, i) => {
    if (e) diff.added.push(toAdd[i]!);
  });

  // A changed .gitignore changes what the walk would include.
  if ([...diff.added, ...diff.modified, ...diff.deleted].some((p) => p === '.gitignore' || p.endsWith('/.gitignore'))) return null;
  // The walk stops at maxFiles.
  if (indexPaths.length - diff.deleted.length + diff.added.length >= config.maxFiles) return null;

  diff.added.sort(byPath);
  diff.modified.sort(byPath);
  const deleted = new Set(diff.deleted);
  diff.deleted = indexPaths.filter((p) => deleted.has(p));
  return { diff, uncommitted };
}
