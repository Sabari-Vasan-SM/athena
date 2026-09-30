import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ATHENA_DIR } from '../config.js';
import { writeFileAtomic } from '../util/fs.js';
import type { FileEntry } from '../fs/walker.js';
import { CACHE_DIR } from '../cache/facts-cache.js';

/**
 * state.json schema v2: small bookkeeping only (≤ ~50KB regardless of repo size).
 * The file index — the per-file hash/size/mtime snapshot of the last analysis —
 * lives in `.athena/cache/v1/files.json` (see readFileIndex / writeFileIndex).
 * v1 files (index embedded) are migrated when read.
 */
export const STATE_SCHEMA_VERSION = 2;

export const DocumentState = z.object({
  file: z.string(),
  blocks: z.array(z.string()),
  lastGeneratedAt: z.string(),
  /** When the file content last changed due to Athena. */
  lastChangedAt: z.string(),
  contentHash: z.string(),
  preservedModified: z.array(z.string()),
});

export const AgentState = z.object({
  configured: z.boolean(),
  files: z.array(z.string()),
  configuredAt: z.string().optional(),
});

const StateFields = {
  athenaVersion: z.string(),
  projectName: z.string(),
  createdAt: z.string(),
  analyzedAt: z.string(),
  analysisDurationMs: z.number(),
  git: z.object({ isRepo: z.boolean(), head: z.string().optional(), branch: z.string().optional() }),
  documents: z.record(z.string(), DocumentState),
  detectors: z.record(z.string(), z.number()),
  agents: z.record(z.string(), AgentState),
  warnings: z.array(z.string()),
};

export const AthenaStateSchema = z.object({ schemaVersion: z.literal(STATE_SCHEMA_VERSION), ...StateFields });
/** v1 layout: identical, plus the embedded file index (shape-checked separately, not with zod). */
const AthenaStateV1 = z.object({ schemaVersion: z.literal(1), ...StateFields, fileIndex: z.record(z.string(), z.unknown()) });

export interface FileIndexEntry {
  /** Content sha256 (hex), or "meta:<size>:<mtime>" for oversized files. v1 indexes hold 16-char prefixes. */
  h: string;
  s: number;
  m: number;
  b?: 1;
}
/** Repo-relative path → content hash/size/mtime. Basis for incremental analysis and change detection. */
export type FileIndex = Record<string, FileIndexEntry>;

export type AthenaState = z.infer<typeof AthenaStateSchema> & {
  /**
   * Set by the pipeline when composing a new state: writeState moves it to the
   * cache directory. Never present on a state returned by readState — use readFileIndex.
   */
  fileIndex?: FileIndex;
};
/** @deprecated alias kept for callers that validated with the schema object. */
export const AthenaState = AthenaStateSchema;
export type DocumentState = z.infer<typeof DocumentState>;

/** At most this many analysis warnings are kept in state.json (model.json has them all). */
export const MAX_STATE_WARNINGS = 100;

export function athenaDir(root: string): string {
  return path.join(root, ATHENA_DIR);
}

export function fileIndexPath(dir: string): string {
  return path.join(dir, CACHE_DIR, 'files.json');
}

export type StateReadResult =
  | { kind: 'missing' }
  | { kind: 'ok'; state: AthenaState }
  | { kind: 'corrupted'; reason: string };

type Stamp = string;
const stampOf = (st: { size: number; mtimeMs: number; ino: number }): Stamp => `${st.ino}:${st.size}:${st.mtimeMs}`;

/** Parsed state per file, reused while the file is unchanged (same inode, size and mtime). */
const stateMemo = new Map<string, { stamp: Stamp; result: StateReadResult }>();
const indexMemo = new Map<string, { stamp: Stamp; index: FileIndex }>();
/** Index of a v1 state that could not be migrated on disk (read-only checkout). */
const pendingV1Index = new Map<string, FileIndex>();

function isIndexEntry(v: unknown): v is FileIndexEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return typeof e.h === 'string' && typeof e.s === 'number' && typeof e.m === 'number' && (e.b === undefined || e.b === 1);
}

export async function readState(dir: string): Promise<StateReadResult> {
  const file = path.join(dir, 'state.json');
  let st: Stats;
  try {
    st = await fs.stat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'corrupted', reason: `unreadable (${(err as NodeJS.ErrnoException).code})` };
  }
  const memo = stateMemo.get(file);
  if (memo && memo.stamp === stampOf(st)) return structuredClone(memo.result);

  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'corrupted', reason: `unreadable (${(err as NodeJS.ErrnoException).code})` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { kind: 'corrupted', reason: 'invalid JSON' };
  }

  let result: StateReadResult;
  if (json && typeof json === 'object' && (json as { schemaVersion?: unknown }).schemaVersion === 1) {
    result = await migrateV1(dir, json);
    // Migration rewrote state.json: memoize against the new file.
    st = await fs.stat(file).catch(() => st);
  } else {
    const parsed = AthenaStateSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      result = { kind: 'corrupted', reason: `schema mismatch at ${issue?.path.join('.') || '(root)'}: ${issue?.message}` };
    } else result = { kind: 'ok', state: parsed.data };
  }
  stateMemo.set(file, { stamp: stampOf(st), result: structuredClone(result) });
  return result;
}

/** v1 → v2: move the embedded file index to the cache directory and rewrite state.json. */
async function migrateV1(dir: string, json: unknown): Promise<StateReadResult> {
  const parsed = AthenaStateV1.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { kind: 'corrupted', reason: `schema mismatch at ${issue?.path.join('.') || '(root)'}: ${issue?.message}` };
  }
  const { fileIndex: rawIndex, schemaVersion: _v, ...rest } = parsed.data;
  const index: FileIndex = {};
  for (const [p, v] of Object.entries(rawIndex)) {
    if (!isIndexEntry(v)) return { kind: 'corrupted', reason: `schema mismatch at fileIndex.${p}: invalid entry` };
    index[p] = v;
  }
  const state: AthenaState = { schemaVersion: STATE_SCHEMA_VERSION, ...rest };
  try {
    await writeFileIndex(dir, index);
    await writeStateFile(dir, state);
    pendingV1Index.delete(dir);
  } catch {
    // Read-only checkout: keep working from memory; the next successful write migrates it.
    pendingV1Index.set(dir, index);
  }
  return { kind: 'ok', state };
}

async function writeStateFile(dir: string, state: AthenaState): Promise<void> {
  const { fileIndex: _index, ...rest } = state;
  const out = { ...rest, schemaVersion: STATE_SCHEMA_VERSION, warnings: rest.warnings.slice(0, MAX_STATE_WARNINGS) };
  await writeFileAtomic(path.join(dir, 'state.json'), `${JSON.stringify(out, null, 2)}\n`);
  stateMemo.delete(path.join(dir, 'state.json'));
}

/**
 * Write state.json. When the state carries a `fileIndex` (a freshly composed
 * state), the index is written to the cache directory; otherwise the existing
 * index is left untouched.
 */
export async function writeState(dir: string, state: AthenaState): Promise<void> {
  if (state.fileIndex) await writeFileIndex(dir, state.fileIndex);
  await writeStateFile(dir, state);
}

/**
 * The file index of the last analysis (empty when there is none). Parsed once per
 * process while the file is unchanged; only cheap shape checks are applied.
 * Callers must not mutate the returned object.
 */
export async function readFileIndex(dir: string): Promise<FileIndex> {
  const file = fileIndexPath(dir);
  let st: Stats;
  try {
    st = await fs.stat(file);
  } catch {
    const pending = pendingV1Index.get(dir);
    if (pending) return pending;
    // A v1 state.json that hasn't been read yet: readState migrates it.
    const s = await readState(dir);
    return s.kind === 'ok' ? (pendingV1Index.get(dir) ?? (await readIndexFile(file))) : {};
  }
  const memo = indexMemo.get(file);
  if (memo && memo.stamp === stampOf(st)) return memo.index;
  const index = await readIndexFile(file);
  indexMemo.set(file, { stamp: stampOf(st), index });
  return index;
}

async function readIndexFile(file: string): Promise<FileIndex> {
  let json: unknown;
  try {
    json = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return {};
  }
  const out: FileIndex = {};
  const files = (json as { files?: unknown })?.files;
  if ((json as { v?: unknown })?.v !== 1 || !files || typeof files !== 'object') return out;
  for (const [p, t] of Object.entries(files as Record<string, unknown>)) {
    if (!Array.isArray(t) || typeof t[0] !== 'string' || typeof t[1] !== 'number' || typeof t[2] !== 'number') continue;
    out[p] = t[3] === 1 ? { h: t[0], s: t[1], m: t[2], b: 1 } : { h: t[0], s: t[1], m: t[2] };
  }
  return out;
}

/** Compact on-disk form: `{ "v": 1, "files": { "<path>": [hash, size, mtime, binary?] } }`. */
/**
 * Entries modified this recently are "racily clean": a same-size edit within the same
 * clock tick (or the filesystem's timestamp granularity) would leave size and mtime
 * unchanged. Like Git, store an mtime that can never match for them, so the next walk
 * re-reads the file instead of trusting the stat.
 */
export const RACY_WINDOW_MS = 2000;

export async function writeFileIndex(dir: string, index: FileIndex, now = Date.now()): Promise<void> {
  const files: Record<string, [string, number, number] | [string, number, number, 1]> = {};
  for (const [p, e] of Object.entries(index)) {
    const m = now - e.m < RACY_WINDOW_MS ? -1 : e.m;
    files[p] = e.b === 1 ? [e.h, e.s, m, 1] : [e.h, e.s, m];
  }
  const file = fileIndexPath(dir);
  await writeFileAtomic(file, JSON.stringify({ v: 1, files }));
  indexMemo.delete(file);
}

/** Move a corrupted state.json aside so it can be inspected; never delete it. */
export async function backupCorruptedState(dir: string): Promise<string | null> {
  const src = path.join(dir, 'state.json');
  const backupDir = path.join(dir, '.backup');
  const dest = path.join(backupDir, `state.${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  try {
    await fs.mkdir(backupDir, { recursive: true });
    await fs.rename(src, dest);
    stateMemo.delete(src);
    return dest;
  } catch {
    return null;
  }
}

export function buildFileIndex(files: FileEntry[]): FileIndex {
  const idx: FileIndex = {};
  for (const f of files) idx[f.path] = { h: f.hash, s: f.size, m: f.mtimeMs, ...(f.binary ? { b: 1 as const } : {}) };
  return idx;
}

/**
 * True when two index hashes denote the same content. v1 indexes stored 16-char
 * prefixes; comparing on the shorter length keeps a migrated index from reporting
 * every file as modified.
 */
export function sameHash(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.startsWith('meta:') || b.startsWith('meta:')) return false;
  const n = Math.min(a.length, b.length);
  return n >= 16 && a.slice(0, n) === b.slice(0, n);
}

export interface IndexDiff {
  added: string[];
  modified: string[];
  deleted: string[];
}

export function diffFileIndex(prev: FileIndex, next: FileIndex): IndexDiff {
  const diff: IndexDiff = { added: [], modified: [], deleted: [] };
  for (const [p, v] of Object.entries(next)) {
    const old = prev[p];
    if (!old) diff.added.push(p);
    else if (!sameHash(old.h, v.h)) diff.modified.push(p);
  }
  for (const p of Object.keys(prev)) if (!(p in next)) diff.deleted.push(p);
  return diff;
}
