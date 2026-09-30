import { spawn } from 'node:child_process';
import { lstatSync, promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { mapLimit } from '../fs/walker.js';
import { git } from './git.js';

/**
 * A directory tree that mirrors Git's index (what the next commit would contain)
 * for the project at `root`, so the analyzer can run on exactly the staged content.
 *
 * Writing every staged file on every check would cost as much as a cold analysis,
 * so the tree is kept between runs and updated incrementally from a manifest
 * (path → state key), and most files are *placeholders*:
 *
 * - An entry whose working-tree file matches the index (per `git diff-files`,
 *   which applies Git's racy-timestamp checks; assume-unchanged and skip-worktree
 *   entries never qualify) becomes a sparse file with the working-tree file's size
 *   and mtime. The analyzer's file index then recognizes it, so its hash and cached
 *   facts are reused without reading anything; when content is needed after all,
 *   `snapshotReader` reads the working-tree file, which has the staged bytes.
 * - Every other entry — staged-then-edited files, unstaged deletions — is written
 *   from its blob (`git cat-file --batch`). Blobs larger than `maxFileBytes` are
 *   never read: they become sparse files of the same size, which the analyzer
 *   indexes by metadata only, as it does oversized working-tree files.
 * - Files the analysis reads directly rather than through the reader
 *   (`.gitignore` files, everything under `.athena/`) always get their real content.
 * - Symlinks are recreated only when their target is relative and stays inside the
 *   tree (the analyzer ignores links that leave the project anyway).
 * - Submodules (gitlinks): the index records only a commit, so their working-tree
 *   files are mirrored as placeholders.
 *
 * Untracked files are never included, and every path is checked to stay inside `dest`.
 */

export type SnapshotManifest = Record<string, string>;

export interface IndexSnapshot {
  /** Path → state key of everything in the tree; persist it and pass it back as `previous`. */
  manifest: SnapshotManifest;
  /** Index entries (files and symlinks) in the tree. */
  entries: number;
  /** Placeholder paths: their content is the working-tree file's (see `snapshotReader`). */
  placeholders: Set<string>;
  /** Paths whose content was written from Git objects (not placeholders). */
  fromIndex: number;
  /** Tree entries written or removed in this update. */
  written: number;
  removed: number;
}

export interface SnapshotOptions {
  /** Blobs larger than this are not read (see above). */
  maxFileBytes: number;
  /** Manifest of the tree already at `dest` (null: `dest` is empty). */
  previous: SnapshotManifest | null;
  signal?: AbortSignal;
}

interface IndexEntry {
  mode: string;
  sha: string;
  path: string;
  /** False for assume-unchanged / skip-worktree entries: Git doesn't compare them with the working tree. */
  trustWorktree: boolean;
  /** Stat data cached in the index (absent if Git didn't print it). */
  size?: number;
  mtimeMs?: number;
}

export class IndexSnapshotError extends Error {}

async function gitOrFail(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const r = await git(cwd, args, { signal, timeoutMs: 120_000, maxBytes: 512 * 1024 * 1024 });
  signal?.throwIfAborted();
  if (!r.ok) throw new IndexSnapshotError(`git ${args[0]} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r.stdout;
}

/**
 * `git ls-files -s -v --debug -z` for the subtree at `cwd`, paths relative to it.
 * `--debug` adds the stat data Git cached for each entry, which (for entries
 * `git diff-files` reports clean) is the working-tree file's size and mtime — so
 * placeholders need no stat of their own.
 */
async function readIndex(cwd: string, signal?: AbortSignal): Promise<IndexEntry[]> {
  const out = await gitOrFail(cwd, ['ls-files', '-s', '-v', '--debug', '-z'], signal);
  const entries: IndexEntry[] = [];
  const unmerged = new Set<string>();
  let i = 0;
  while (i < out.length) {
    const nul = out.indexOf('\0', i);
    if (nul < 0) break;
    const rec = out.slice(i, nul);
    i = nul + 1;
    // Debug lines ("  mtime: <s>:<ns>", "  size: <n>\tflags: <x>", ...) until the next entry.
    const stat: Record<string, string> = {};
    while (out.startsWith('  ', i)) {
      const nl = out.indexOf('\n', i);
      const end = nl < 0 ? out.length : nl;
      for (const part of out.slice(i + 2, end).split('\t')) {
        const c = part.indexOf(': ');
        if (c > 0) stat[part.slice(0, c)] = part.slice(c + 2);
      }
      i = end + 1;
    }
    const m = /^(\S) (\d{6}) ([0-9a-f]{40,64}) (\d)\t([\s\S]+)$/.exec(rec);
    if (!m) throw new IndexSnapshotError(`unexpected \`git ls-files\` output: ${JSON.stringify(rec.slice(0, 80))}`);
    const [, tag, mode, sha, stage, p] = m as unknown as [string, string, string, string, string, string];
    if (stage !== '0') {
      unmerged.add(p);
      continue;
    }
    const mt = /^(\d+):(\d+)$/.exec(stat.mtime ?? '');
    const size = /^\d+$/.test(stat.size ?? '') ? Number(stat.size) : undefined;
    entries.push({ mode, sha, path: p, trustWorktree: tag === 'H', size, mtimeMs: mt ? Number(mt[1]) * 1000 + Number(mt[2]) / 1e6 : undefined });
  }
  if (unmerged.size) throw new IndexSnapshotError(`the index has unresolved merge conflicts (${[...unmerged].slice(0, 3).join(', ')}${unmerged.size > 3 ? ', …' : ''})`);
  return entries;
}

function inside(dest: string, rel: string): string {
  const abs = path.resolve(dest, rel);
  const r = path.relative(dest, abs);
  if (!r || r.startsWith('..') || path.isAbsolute(r)) throw new IndexSnapshotError(`refusing index path outside the project: ${rel}`);
  return abs;
}

/** Paths the analysis reads with plain fs calls, so they can't be placeholders. */
export function needsRealContent(rel: string): boolean {
  return rel.startsWith('.athena/') || rel === '.gitignore' || rel.endsWith('/.gitignore');
}

/** Stream `git cat-file --batch` for `shas`; `onBlob` receives each object's bytes in order. */
async function catFileBatch(cwd: string, shas: string[], onBlob: (sha: string, data: Buffer) => Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!shas.length) return;
  const child = spawn('git', ['cat-file', '--batch'], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
  const onAbort = () => child.kill('SIGKILL');
  signal?.addEventListener('abort', onAbort, { once: true });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => {
    if (stderr.length < 4096) stderr += d.toString('utf8');
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on('close', (code) => resolve(code));
    child.on('error', () => resolve(null));
  });
  child.stdin.on('error', () => {
    /* reported through the exit code */
  });
  child.stdin.end(`${shas.join('\n')}\n`);
  try {
    let buf: Buffer = Buffer.alloc(0);
    let want: { sha: string; size: number } | null = null;
    let received = 0;
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (!want) {
          const nl = buf.indexOf(0x0a);
          if (nl < 0) break;
          const header = buf.subarray(0, nl).toString('utf8');
          buf = buf.subarray(nl + 1);
          const h = /^([0-9a-f]+) (\w+) (\d+)$/.exec(header);
          if (!h) throw new IndexSnapshotError(`git cat-file: ${header}`);
          want = { sha: h[1]!, size: Number(h[3]) };
        }
        if (buf.length < want.size + 1) break;
        const data = Buffer.from(buf.subarray(0, want.size));
        buf = buf.subarray(want.size + 1);
        const done = want;
        want = null;
        received++;
        await onBlob(done.sha, data);
      }
    }
    const code = await exited;
    signal?.throwIfAborted();
    if (code !== 0 || received !== shas.length) throw new IndexSnapshotError(`git cat-file failed: ${stderr.trim() || `exit ${code}`}`);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

/** Desired state of one tree path. The key changes whenever the tree file must be rewritten. */
type Want =
  | { kind: 'placeholder'; key: string; size: number; mtimeMs: number }
  | { kind: 'blob'; key: string; sha: string }
  | { kind: 'sparse'; key: string; size: number }
  | { kind: 'symlink'; key: string; sha: string };

const placeholderWant = (size: number, mtimeMs: number): Want => ({ kind: 'placeholder', key: `p:${size}:${mtimeMs}`, size, mtimeMs });

/** Submodule working-tree files (regular files only, no `.git`, no symlinks) as placeholders. */
async function submoduleFiles(root: string, rel: string, out: Map<string, Want>): Promise<void> {
  let ents: Dirent[];
  try {
    ents = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return; // not checked out
  }
  for (const e of ents) {
    if (e.name === '.git') continue;
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) await submoduleFiles(root, r, out);
    else if (e.isFile()) {
      const st = await fs.stat(path.join(root, r)).catch(() => null);
      if (st) out.set(r, placeholderWant(st.size, st.mtimeMs));
    }
  }
}

async function writePlaceholder(file: string, size: number, mtimeMs: number): Promise<void> {
  const fh = await fs.open(file, 'w');
  try {
    if (size) await fh.truncate(size);
    // Mid-millisecond, so float rounding can't move it into the previous millisecond:
    // the analyzer compares whole milliseconds with its file index.
    const t = (Math.floor(mtimeMs) + 0.5) / 1000;
    await fh.utimes(t, t);
  } finally {
    await fh.close();
  }
}

/** Create `file` with `make`; if something is in the way (a directory from an older tree), remove it once. */
async function place(file: string, make: () => Promise<void>): Promise<void> {
  try {
    await make();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EISDIR' && code !== 'EEXIST' && code !== 'ENOTDIR' && code !== 'ENOENT' && code !== 'EPERM') throw err;
    await fs.rm(file, { recursive: true, force: true });
    await fs.mkdir(path.dirname(file), { recursive: true });
    await make();
  }
}

async function ensureDir(dir: string): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    // A file (or symlink) from an older tree where a directory now belongs.
    let d = dir;
    for (;;) {
      const st = await fs.lstat(d).catch(() => null);
      if (st && !st.isDirectory()) break;
      const up = path.dirname(d);
      if (up === d) throw err;
      d = up;
    }
    await fs.rm(d, { force: true });
    await fs.mkdir(dir, { recursive: true });
  }
}

/** Bring the tree at `dest` in line with the index of the project at `root`. */
export async function updateIndexSnapshot(root: string, dest: string, opts: SnapshotOptions): Promise<IndexSnapshot> {
  const { signal } = opts;
  const [entries, dirtyOut] = await Promise.all([readIndex(root, signal), gitOrFail(root, ['diff-files', '--name-only', '--relative', '-z'], signal)]);
  // Paths whose working-tree file differs from the index (stat-dirty files are included: only a speed cost).
  const dirty = new Set(dirtyOut.split('\0').filter(Boolean));

  const want = new Map<string, Want>();
  const needBlob: IndexEntry[] = [];
  for (const [i, e] of entries.entries()) {
    if (i % 1024 === 0) signal?.throwIfAborted();
    inside(dest, e.path);
    if (e.mode === '120000') want.set(e.path, { kind: 'symlink', key: `l:${e.sha}`, sha: e.sha });
    else if (e.mode === '100644' || e.mode === '100755') {
      if (e.trustWorktree && !dirty.has(e.path) && !needsRealContent(e.path)) {
        // Clean per diff-files: the index's cached stat is the working-tree file's.
        if (e.size !== undefined && e.mtimeMs !== undefined && e.size < 2 ** 32 - 1) {
          want.set(e.path, placeholderWant(e.size, e.mtimeMs));
          continue;
        }
        const st = lstatSync(path.join(root, e.path), { throwIfNoEntry: false });
        if (st?.isFile()) {
          want.set(e.path, placeholderWant(st.size, st.mtimeMs));
          continue;
        }
      }
      needBlob.push(e);
    }
  }
  for (const e of entries) if (e.mode === '160000') await submoduleFiles(root, e.path, want);

  // Sizes decide between content and a sparse placeholder for oversized blobs.
  const prev = opts.previous ?? {};
  const sizeFromKey = (key: string | undefined, sha: string) => (key?.startsWith(`s:${sha}:`) ? Number(key.split(':')[2]) : key?.startsWith(`b:${sha}:`) ? Number(key.split(':')[2]) : undefined);
  const unknown = [...new Set(needBlob.filter((e) => sizeFromKey(prev[e.path], e.sha) === undefined).map((e) => e.sha))];
  const sizes = new Map<string, number>();
  if (unknown.length) {
    const r = await git(root, ['cat-file', '--batch-check=%(objectname) %(objectsize)'], { signal, input: `${unknown.join('\n')}\n`, timeoutMs: 120_000, maxBytes: 64 * 1024 * 1024 });
    if (!r.ok) throw new IndexSnapshotError(`git cat-file failed: ${r.stderr.trim()}`);
    for (const line of r.stdout.split('\n')) {
      const m = /^([0-9a-f]+) (\d+)$/.exec(line);
      if (m) sizes.set(m[1]!, Number(m[2]));
    }
  }
  for (const e of needBlob) {
    const size = sizes.get(e.sha) ?? sizeFromKey(prev[e.path], e.sha);
    if (size === undefined) throw new IndexSnapshotError(`object ${e.sha} for ${e.path} is missing from the repository`);
    if (size > opts.maxFileBytes) want.set(e.path, { kind: 'sparse', key: `s:${e.sha}:${size}`, size });
    else want.set(e.path, { kind: 'blob', key: `b:${e.sha}:${size}`, sha: e.sha });
  }

  // Remove what is gone or changed, then write what is new or changed.
  const removals = Object.keys(prev).filter((p) => want.get(p)?.key !== prev[p]);
  await mapLimit(removals, 64, (p) => fs.rm(inside(dest, p), { force: true, recursive: true }));
  const todo = [...want].filter(([p, w]) => prev[p] !== w.key);
  const dirs = new Set(todo.map(([p]) => path.dirname(inside(dest, p))));
  for (const d of [...dirs].sort()) await ensureDir(d);

  const byBlob = new Map<string, string[]>();
  await mapLimit(todo, 64, async ([p, w]) => {
    signal?.throwIfAborted();
    const file = inside(dest, p);
    if (w.kind === 'placeholder') await place(file, () => writePlaceholder(file, w.size, w.mtimeMs));
    else if (w.kind === 'sparse') await place(file, () => writePlaceholder(file, w.size, Date.now()));
    else byBlob.set(w.sha, [...(byBlob.get(w.sha) ?? []), p]);
  });
  const links: Array<[string, string]> = [];
  await catFileBatch(
    root,
    [...byBlob.keys()],
    async (sha, data) => {
      for (const p of byBlob.get(sha) ?? []) {
        if (want.get(p)!.kind === 'symlink') links.push([p, data.toString('utf8')]);
        else {
          const file = inside(dest, p);
          await place(file, () => fs.writeFile(file, data));
        }
      }
    },
    signal,
  );
  // Symlinks last, so no file is ever written through one.
  for (const [p, target] of links) {
    const at = inside(dest, p);
    const rel = path.relative(dest, path.resolve(path.dirname(at), target));
    if (path.isAbsolute(target) || !rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    await place(at, () => fs.symlink(target, at)).catch(() => {
      /* e.g. no symlink permission on Windows: the path is simply absent */
    });
  }

  const manifest: SnapshotManifest = {};
  const placeholders = new Set<string>();
  let fromIndex = 0;
  for (const [p, w] of want) {
    manifest[p] = w.key;
    if (w.kind === 'placeholder') placeholders.add(p);
    else if (w.kind === 'blob') fromIndex++;
  }
  return { manifest, entries: entries.filter((e) => e.mode !== '160000').length, placeholders, fromIndex, written: todo.length, removed: removals.length };
}

/**
 * Content reader for the analyzer: placeholders are read from the working tree
 * (their content there is the staged content), everything else from the tree.
 */
export function snapshotReader(snapRoot: string, workRoot: string, placeholders: Set<string>): (abs: string) => Promise<Buffer> {
  return async (abs) => {
    // The analyzer may reach a placeholder through a symlink inside the tree.
    const real = await fs.realpath(abs).catch(() => abs);
    const rel = path.relative(snapRoot, real).split(path.sep).join('/');
    if (placeholders.has(rel)) return fs.readFile(path.join(workRoot, rel));
    return fs.readFile(abs);
  };
}
