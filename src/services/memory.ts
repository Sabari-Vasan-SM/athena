import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { athenaDir } from '../core/paths.js';
import { readTextIfExists, sha256, writeFileAtomic } from '../core/util/fs.js';
import {
  entriesOf,
  injectionFlags,
  LIMITS,
  MEMORY_FILES,
  MEMORY_KINDS,
  MemoryError,
  newMemoryFileText,
  normalizeInput,
  parseMemoryFile,
  recall,
  serializeMemoryFile,
  type MemoryEntry,
  type MemoryFile,
  type MemoryInput,
  type MemoryKind,
  type MemoryStatus,
  type MemoryView,
  type RecallHit,
  type RecallQuery,
} from '../core/memory/memory.js';
import { AthenaError, conflict, EXIT } from './errors.js';

export { MemoryError, type MemoryView, type RecallHit, type RecallQuery, type MemoryInput, type MemoryKind, type MemoryStatus };

export const MEMORY_DIR = 'memory';
const LOCK_FILE = path.join('cache', 'memory.lock');
const LOCK_STALE_MS = 10_000;

export const memoryDir = (root: string) => path.join(athenaDir(root), MEMORY_DIR);

function toAthenaError(err: unknown): never {
  if (err instanceof MemoryError) throw new AthenaError(err.message, err.hint);
  throw err;
}

/** Serialize writers across processes (agents and the developer may write at the same time). */
async function withLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const lock = path.join(athenaDir(root), LOCK_FILE);
  await fs.mkdir(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      await fs.writeFile(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const st = await fs.stat(lock).catch(() => null);
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        await fs.rm(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new AthenaError('Project memory is busy (another process is writing it).', 'Try again in a moment.', EXIT.ERROR, 'busy');
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lock, { force: true });
  }
}

async function readKind(root: string, kind: MemoryKind): Promise<{ file: MemoryFile; text: string | null }> {
  const text = await readTextIfExists(path.join(memoryDir(root), MEMORY_FILES[kind]));
  return { file: parseMemoryFile(kind, text ?? newMemoryFileText(kind)), text };
}

async function readAll(root: string): Promise<Map<MemoryKind, MemoryFile>> {
  const out = new Map<MemoryKind, MemoryFile>();
  for (const kind of MEMORY_KINDS) out.set(kind, (await readKind(root, kind)).file);
  return out;
}

async function writeKind(root: string, file: MemoryFile): Promise<void> {
  await writeFileAtomic(path.join(memoryDir(root), MEMORY_FILES[file.kind]), serializeMemoryFile(file));
}

/** Content hash (16 hex) of a project file's bytes, or null if it doesn't exist. */
async function fileHash(root: string, rel: string): Promise<string | null> {
  try {
    return sha256(await fs.readFile(path.join(root, rel))).slice(0, 16);
  } catch {
    return null;
  }
}

/** Anchors record what linked files looked like when the memory was recorded or confirmed. */
async function anchorsFor(root: string, files: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of files) {
    const h = await fileHash(root, f);
    if (h) out[f] = h;
  }
  return out;
}

async function toViews(root: string, entries: MemoryEntry[]): Promise<MemoryView[]> {
  const linked = [...new Set(entries.flatMap((e) => Object.keys(e.anchors)))];
  const now = new Map(await Promise.all(linked.map(async (f) => [f, await fileHash(root, f)] as const)));
  return entries.map((e) => {
    const changedFiles = Object.entries(e.anchors)
      .filter(([f, h]) => now.get(f) !== h)
      .map(([f]) => f);
    return {
      ...e,
      // Only a developer's confirmation turns a memory into a FACT.
      label: e.status === 'confirmed' ? 'FACT' : 'INFERRED',
      stale: e.status !== 'superseded' && changedFiles.length > 0,
      changedFiles,
      flags: injectionFlags(e),
    };
  });
}

export interface ListOptions {
  kind?: MemoryKind;
  status?: MemoryStatus;
  stale?: boolean;
}

export async function listMemory(root: string, opts: ListOptions = {}): Promise<MemoryView[]> {
  const all = [...(await readAll(root)).values()].flatMap(entriesOf);
  const views = await toViews(root, all);
  return views
    .filter((v) => (!opts.kind || v.kind === opts.kind) && (!opts.status || v.status === opts.status) && (opts.stale === undefined || v.stale === opts.stale))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

export async function getMemory(root: string, id: string): Promise<MemoryView> {
  const hit = (await listMemory(root)).find((v) => v.id === id);
  if (!hit) throw new AthenaError(`No memory with id ${id}.`, 'List them with `athena memory list`.', EXIT.ERROR, 'not-found');
  return hit;
}

export async function recallMemory(root: string, q: RecallQuery): Promise<RecallHit[]> {
  return recall(await listMemory(root), q);
}

export async function searchMemory(root: string, query: string): Promise<MemoryView[]> {
  const q = query.toLowerCase();
  return (await listMemory(root)).filter((v) => `${v.title}\n${v.details}\n${v.tags.join(' ')}\n${v.files.join(' ')}`.toLowerCase().includes(q));
}

const newId = (taken: Set<string>) => {
  for (;;) {
    const id = `m-${crypto.randomBytes(3).toString('hex')}`;
    if (!taken.has(id)) return id;
  }
};

/**
 * Record a memory. Agent-written entries are `unreviewed`; a developer's are `confirmed`.
 * Refuses secrets, oversized entries and a full store. Returns the stored entry.
 */
export async function addMemory(root: string, input: MemoryInput, source: string): Promise<MemoryView> {
  let clean;
  try {
    clean = normalizeInput(input);
  } catch (err) {
    toAthenaError(err);
  }
  if (!/^(developer|agent:[a-z0-9-]{1,40})$/.test(source)) throw new AthenaError(`Invalid memory source: ${source}`);
  return withLock(root, async () => {
    const all = await readAll(root);
    const entries = [...all.values()].flatMap(entriesOf);
    if (entries.length >= LIMITS.entries) throw conflict(`Project memory is full (${LIMITS.entries} entries).`, 'Forget or supersede old entries with `athena memory forget <id>`.');
    const bytes = [...all.values()].reduce((n, f) => n + Buffer.byteLength(serializeMemoryFile(f)), 0);
    if (bytes > LIMITS.totalBytes) throw conflict('Project memory is over its size limit.', 'Forget or shorten old entries.');
    if (clean.supersedes && !entries.some((e) => e.id === clean.supersedes)) throw new AthenaError(`Cannot supersede ${clean.supersedes}: no such memory.`);

    const now = new Date().toISOString();
    const developer = source === 'developer';
    const entry: MemoryEntry = {
      id: newId(new Set(entries.map((e) => e.id))),
      kind: clean.kind,
      status: developer ? 'confirmed' : 'unreviewed',
      source,
      title: clean.title,
      details: clean.details,
      files: clean.files,
      tags: clean.tags,
      evidence: clean.evidence,
      createdAt: now,
      confirmedAt: developer ? now : undefined,
      supersedes: clean.supersedes,
      anchors: await anchorsFor(root, clean.files),
    };
    const file = all.get(entry.kind)!;
    file.blocks.push({ kind: 'text', raw: '' }, { kind: 'entry', entry });
    await writeKind(root, file);
    if (clean.supersedes && developer) await markSuperseded(root, all, clean.supersedes, entry.id);
    return (await toViews(root, [entry]))[0]!;
  });
}

async function markSuperseded(root: string, all: Map<MemoryKind, MemoryFile>, id: string, by: string): Promise<void> {
  for (const file of all.values()) {
    for (const b of file.blocks) {
      if (b.kind === 'entry' && b.entry.id === id) {
        b.entry.status = 'superseded';
        b.entry.supersededBy = by;
        await writeKind(root, file);
        return;
      }
    }
  }
}

async function mutate(root: string, id: string, fn: (e: MemoryEntry, file: MemoryFile, all: Map<MemoryKind, MemoryFile>) => Promise<'write' | 'delete'>): Promise<void> {
  await withLock(root, async () => {
    const all = await readAll(root);
    for (const file of all.values()) {
      const i = file.blocks.findIndex((b) => b.kind === 'entry' && b.entry.id === id);
      if (i < 0) continue;
      const entry = (file.blocks[i] as { kind: 'entry'; entry: MemoryEntry }).entry;
      if ((await fn(entry, file, all)) === 'delete') {
        file.blocks.splice(i, 1);
        // Drop the blank separator line that preceded the entry.
        const prev = file.blocks[i - 1];
        if (prev?.kind === 'text' && prev.raw === '') file.blocks.splice(i - 1, 1);
      }
      await writeKind(root, file);
      return;
    }
    throw new AthenaError(`No memory with id ${id}.`, 'List them with `athena memory list`.', EXIT.ERROR, 'not-found');
  });
}

/** Developer confirmation: the entry becomes FACT and is re-anchored to the current files. */
export async function confirmMemory(root: string, id: string): Promise<MemoryView> {
  await mutate(root, id, async (e, _f, all) => {
    if (e.status === 'superseded') throw conflict(`${id} was superseded by ${e.supersededBy ?? 'a newer memory'}; confirm that one instead.`);
    e.status = 'confirmed';
    e.confirmedAt = new Date().toISOString();
    e.anchors = await anchorsFor(root, e.files);
    if (e.supersedes) await markSuperseded(root, all, e.supersedes, e.id);
    return 'write';
  });
  return getMemory(root, id);
}

/** Mark `id` as replaced by the newer memory `by`. */
export async function supersedeMemory(root: string, id: string, by: string): Promise<MemoryView> {
  if (id === by) throw new AthenaError('A memory cannot supersede itself.');
  // An unknown replacement is bad input (400), not a missing target (404).
  if (!(await listMemory(root)).some((m) => m.id === by)) throw new AthenaError(`Cannot supersede with ${by}: no such memory.`, 'Pass the id of the newer memory.');
  await mutate(root, id, async (e) => {
    e.status = 'superseded';
    e.supersededBy = by;
    return 'write';
  });
  return getMemory(root, id);
}

export async function forgetMemory(root: string, id: string): Promise<void> {
  await mutate(root, id, async () => 'delete');
}

/** Developer edit (title/details/files/tags/evidence); the entry stays confirmed only if it was. */
export async function updateMemory(root: string, id: string, patch: Partial<Omit<MemoryInput, 'kind' | 'supersedes'>>): Promise<MemoryView> {
  await mutate(root, id, async (e) => {
    let clean;
    try {
      // undefined = unchanged; any other value replaces the old one (an empty string clears details/evidence).
      const pick = <K extends keyof typeof patch>(k: K, cur: MemoryEntry[K & keyof MemoryEntry]) => (patch[k] !== undefined ? patch[k] : cur);
      clean = normalizeInput({ kind: e.kind, title: pick('title', e.title) as string, details: (pick('details', e.details) as string | undefined) ?? '', files: pick('files', e.files) as string[], tags: pick('tags', e.tags) as string[], evidence: (pick('evidence', e.evidence) as string | undefined) || undefined });
    } catch (err) {
      toAthenaError(err);
    }
    Object.assign(e, { title: clean.title, details: clean.details, files: clean.files, tags: clean.tags, evidence: clean.evidence });
    e.anchors = await anchorsFor(root, e.files);
    return 'write';
  });
  return getMemory(root, id);
}
