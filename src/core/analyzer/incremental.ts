import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import type { AthenaConfig } from '../config.js';
import type { FileEntry, WalkResult } from '../fs/walker.js';
import type { IgnoreMatcher } from '../fs/ignore.js';

/**
 * What a full walk saw, kept in memory so a later analysis in the same process
 * can re-stat only the paths a file watcher reported instead of walking the tree.
 * Never persisted: it is only trustworthy while every change since it was taken
 * has been reported (the scheduler tracks that).
 */
export interface WalkSnapshot {
  /** Files with their content hashes (after the content pass). Treat as read-only. */
  readonly files: readonly FileEntry[];
  /** factsConfigHash of the config the walk ran with (ignore/include/maxFileBytes). */
  readonly configHash: string;
  readonly maxFiles: number;
  /** `.git/info/exclude` when the walk ran (not watched: compared instead). */
  readonly excludeText: string | null;
  /** The walk's matcher, with every nested .gitignore it found registered. */
  readonly matcher: IgnoreMatcher;
  /** True when the walk could be complete and exact (no truncation, symlinks or unreadable entries). */
  readonly reusable: boolean;
  readonly takenAt: number;
}

export interface IncrementalInput {
  snapshot: WalkSnapshot;
  /** Repo-relative POSIX paths reported changed (added, modified, deleted) since the snapshot's walk started. */
  changedPaths: readonly string[];
}

/** Above this many changed paths a full walk is as cheap and simpler to trust. */
export const MAX_INCREMENTAL_PATHS = 2000;

export function readExclude(root: string): Promise<string | null> {
  return fs.readFile(path.join(root, '.git', 'info', 'exclude'), 'utf8').catch(() => null);
}

/** Walk semantics: a path is skipped when any ancestor directory, or the path itself, is ignored. */
export function isIgnoredWithAncestors(matcher: IgnoreMatcher, rel: string, isDir: boolean): boolean {
  for (let i = rel.indexOf('/'); i > 0; i = rel.indexOf('/', i + 1)) {
    if (matcher.ignores(rel.slice(0, i), true)) return true;
  }
  return matcher.ignores(rel, isDir);
}

/**
 * The walk result a full walk would produce, derived from `snapshot` plus a stat
 * of each changed path — or null when that cannot be done safely and the caller
 * must walk: config or exclude changes, `.gitignore` changes, directory adds or
 * deletes, symlinks, a snapshot that was truncated or saw unreadable entries,
 * or too many changes.
 *
 * Changed files are always returned with an empty hash so the content pass
 * re-reads them (a same-size edit within the mtime granularity is still caught).
 */
export async function incrementalWalk(root: string, config: AthenaConfig, configHash: string, input: IncrementalInput, signal?: AbortSignal): Promise<WalkResult | null> {
  const { snapshot } = input;
  if (!snapshot.reusable || snapshot.configHash !== configHash || snapshot.maxFiles !== config.maxFiles) return null;
  const changed = [...new Set(input.changedPaths)];
  if (changed.length > MAX_INCREMENTAL_PATHS) return null;
  if ((await readExclude(root)) !== snapshot.excludeText) return null;

  const byPath = new Map(snapshot.files.map((f) => [f.path, f]));
  let dirPrefixes: Set<string> | null = null;
  const isKnownDir = (rel: string): boolean => {
    if (!dirPrefixes) {
      dirPrefixes = new Set();
      for (const f of snapshot.files) for (let i = f.path.indexOf('/'); i > 0; i = f.path.indexOf('/', i + 1)) dirPrefixes.add(f.path.slice(0, i));
    }
    return dirPrefixes.has(rel);
  };

  for (const rel of changed) {
    signal?.throwIfAborted();
    if (!rel || rel === '.' || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes('\\')) return null;
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    if (base === '.gitignore') return null;
    let st: Stats;
    try {
      st = await fs.lstat(path.join(root, rel));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && (err as NodeJS.ErrnoException).code !== 'ENOTDIR') return null;
      if (byPath.delete(rel)) continue;
      if (isKnownDir(rel)) return null; // directory deleted
      continue;
    }
    if (st.isSymbolicLink()) return null;
    if (st.isDirectory()) {
      if (isIgnoredWithAncestors(snapshot.matcher, rel, true)) continue;
      return null; // directory added (or replaced a file): walk it
    }
    if (!st.isFile()) {
      byPath.delete(rel);
      continue;
    }
    if (isKnownDir(rel)) return null; // a file replaced a directory
    if (isIgnoredWithAncestors(snapshot.matcher, rel, false)) {
      byPath.delete(rel);
      continue;
    }
    const size = st.size;
    const mtimeMs = Math.floor(st.mtimeMs);
    byPath.set(
      rel,
      size > config.maxFileBytes
        ? { path: rel, size, mtimeMs, hash: `meta:${size}:${mtimeMs}`, binary: false, large: true }
        : { path: rel, size, mtimeMs, hash: '', binary: false, large: false },
    );
  }

  if (byPath.size > config.maxFiles) return null;
  // Copies: the analysis fills in hashes and must never mutate the snapshot.
  const files = [...byPath.values()].map((f) => ({ ...f }));
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, skippedBinary: 0, skippedLarge: 0, skippedUnreadable: 0, truncated: false, warnings: [], symlinks: 0 };
}
