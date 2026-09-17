import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AthenaConfig } from '../config.js';
import { IgnoreMatcher } from './ignore.js';
import { toPosix } from '../util/paths.js';

export interface FileEntry {
  /** Repo-relative POSIX path. */
  path: string;
  size: number;
  mtimeMs: number;
  /** sha256 of content; for oversized files, a metadata hash prefixed with "meta:". */
  hash: string;
  binary: boolean;
  large: boolean;
}

export interface WalkResult {
  files: FileEntry[];
  skippedBinary: number;
  skippedLarge: number;
  skippedUnreadable: number;
  truncated: boolean;
  warnings: string[];
}

export interface WalkOptions {
  config: AthenaConfig;
  signal?: AbortSignal;
  onProgress?: (scanned: number) => void;
  /**
   * Previous index (path → truncated hash/size/mtime). When size and mtime match, the
   * previous hash (and binary flag) is reused instead of re-reading the file.
   */
  reuse?: Record<string, { h: string; s: number; m: number; b?: 1 }>;
  /** Share a matcher (e.g. with a watcher). Nested .gitignore files found during the walk are registered on it. */
  matcher?: IgnoreMatcher;
}

const SNIFF_BYTES = 8000;

export async function walkProject(root: string, opts: WalkOptions): Promise<WalkResult> {
  const rootReal = await fs.realpath(root);
  const matcher = opts.matcher ?? (await IgnoreMatcher.load(rootReal, opts.config));
  const result: WalkResult = { files: [], skippedBinary: 0, skippedLarge: 0, skippedUnreadable: 0, truncated: false, warnings: [] };
  const visitedDirs = new Set<string>([rootReal]);
  const pending: string[] = [];
  const isIgnored = (rel: string, isDir: boolean): boolean => matcher.ignores(rel, isDir);

  // Iterative DFS so huge trees don't blow the stack.
  const stack: string[] = [rootReal];
  while (stack.length) {
    opts.signal?.throwIfAborted();
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      result.skippedUnreadable++;
      result.warnings.push(`Cannot read directory ${toPosix(path.relative(rootReal, dir)) || '.'}: ${(err as NodeJS.ErrnoException).code ?? 'error'}`);
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const dirRel = toPosix(path.relative(rootReal, dir));
    if (dirRel && entries.some((e) => e.name === '.gitignore' && e.isFile())) {
      const gi = await fs.readFile(path.join(dir, '.gitignore'), 'utf8').catch(() => null);
      if (gi !== null) matcher.setGitignore(dirRel, gi);
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const rel = toPosix(path.relative(rootReal, abs));
      let isDir = ent.isDirectory();
      let isFile = ent.isFile();

      if (ent.isSymbolicLink()) {
        // Follow symlinks only if the target stays inside the project root.
        try {
          const target = await fs.realpath(abs);
          const relTarget = path.relative(rootReal, target);
          if (relTarget.startsWith('..') || path.isAbsolute(relTarget)) continue;
          const st = await fs.stat(target);
          isDir = st.isDirectory();
          isFile = st.isFile();
          if (isDir) {
            if (visitedDirs.has(target)) continue; // loop protection
          }
        } catch {
          continue; // broken link
        }
      }

      if (isDir) {
        if (isIgnored(rel, true)) continue;
        const real = await fs.realpath(abs).catch(() => abs);
        if (visitedDirs.has(real)) continue;
        visitedDirs.add(real);
        stack.push(abs);
      } else if (isFile) {
        if (isIgnored(rel, false)) continue;
        if (result.files.length + pending.length >= opts.config.maxFiles) {
          result.truncated = true;
          break;
        }
        pending.push(rel);
      }
    }
    if (result.truncated) break;
    if (pending.length >= 256) await flush();
  }
  await flush();

  if (result.truncated) {
    result.warnings.push(`File limit reached (${opts.config.maxFiles}); analysis is partial. Raise maxFiles in .athena/config.json or add ignores.`);
  }
  result.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return result;

  async function flush(): Promise<void> {
    const batch = pending.splice(0, pending.length);
    await mapLimit(batch, 32, async (rel) => {
      opts.signal?.throwIfAborted();
      const entry = await indexFile(rootReal, rel, opts.config.maxFileBytes, opts.reuse?.[rel]);
      if (!entry) {
        result.skippedUnreadable++;
        return;
      }
      if (entry.binary) result.skippedBinary++;
      if (entry.large) result.skippedLarge++;
      result.files.push(entry);
    });
    opts.onProgress?.(result.files.length);
  }
}

async function indexFile(root: string, rel: string, maxBytes: number, prev?: { h: string; s: number; m: number; b?: 1 }): Promise<FileEntry | null> {
  const abs = path.join(root, rel);
  try {
    const st = await fs.stat(abs);
    if (prev && prev.s === st.size && prev.m === Math.floor(st.mtimeMs)) {
      return { path: rel, size: st.size, mtimeMs: prev.m, hash: prev.h, binary: prev.b === 1, large: prev.h.startsWith('meta:') };
    }
    if (st.size > maxBytes) {
      return { path: rel, size: st.size, mtimeMs: Math.floor(st.mtimeMs), hash: `meta:${st.size}:${Math.floor(st.mtimeMs)}`, binary: false, large: true };
    }
    const buf = await fs.readFile(abs);
    const sniff = buf.subarray(0, SNIFF_BYTES);
    const binary = sniff.includes(0);
    return {
      path: rel,
      size: st.size,
      mtimeMs: Math.floor(st.mtimeMs),
      hash: crypto.createHash('sha256').update(buf).digest('hex'),
      binary,
      large: false,
    };
  } catch {
    return null;
  }
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return out;
}
