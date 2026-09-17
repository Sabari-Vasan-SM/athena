import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ATHENA_DIR } from '../config.js';
import { writeFileAtomic } from '../util/fs.js';
import type { FileEntry } from '../fs/walker.js';

export const STATE_SCHEMA_VERSION = 1;

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

export const AthenaState = z.object({
  schemaVersion: z.literal(STATE_SCHEMA_VERSION),
  athenaVersion: z.string(),
  projectName: z.string(),
  createdAt: z.string(),
  analyzedAt: z.string(),
  analysisDurationMs: z.number(),
  git: z.object({ isRepo: z.boolean(), head: z.string().optional(), branch: z.string().optional() }),
  /** Repo-relative path → content hash/size/mtime. Basis for incremental analysis. */
  fileIndex: z.record(z.string(), z.object({ h: z.string(), s: z.number(), m: z.number(), b: z.literal(1).optional() })),
  documents: z.record(z.string(), DocumentState),
  detectors: z.record(z.string(), z.number()),
  agents: z.record(z.string(), AgentState),
  warnings: z.array(z.string()),
});
export type AthenaState = z.infer<typeof AthenaState>;
export type DocumentState = z.infer<typeof DocumentState>;

export function athenaDir(root: string): string {
  return path.join(root, ATHENA_DIR);
}

export type StateReadResult =
  | { kind: 'missing' }
  | { kind: 'ok'; state: AthenaState }
  | { kind: 'corrupted'; reason: string };

export async function readState(dir: string): Promise<StateReadResult> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, 'state.json'), 'utf8');
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
  const parsed = AthenaState.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { kind: 'corrupted', reason: `schema mismatch at ${issue?.path.join('.') || '(root)'}: ${issue?.message}` };
  }
  return { kind: 'ok', state: parsed.data };
}

export async function writeState(dir: string, state: AthenaState): Promise<void> {
  await writeFileAtomic(path.join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
}

/** Move a corrupted state.json aside so it can be inspected; never delete it. */
export async function backupCorruptedState(dir: string): Promise<string | null> {
  const src = path.join(dir, 'state.json');
  const backupDir = path.join(dir, '.backup');
  const dest = path.join(backupDir, `state.${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  try {
    await fs.mkdir(backupDir, { recursive: true });
    await fs.rename(src, dest);
    return dest;
  } catch {
    return null;
  }
}

export function buildFileIndex(files: FileEntry[]): AthenaState['fileIndex'] {
  const idx: AthenaState['fileIndex'] = {};
  for (const f of files) idx[f.path] = { h: f.hash.startsWith('meta:') ? f.hash : f.hash.slice(0, 16), s: f.size, m: f.mtimeMs, ...(f.binary ? { b: 1 as const } : {}) };
  return idx;
}

export interface IndexDiff {
  added: string[];
  modified: string[];
  deleted: string[];
}

export function diffFileIndex(prev: AthenaState['fileIndex'], next: AthenaState['fileIndex']): IndexDiff {
  const diff: IndexDiff = { added: [], modified: [], deleted: [] };
  for (const [p, v] of Object.entries(next)) {
    const old = prev[p];
    if (!old) diff.added.push(p);
    else if (old.h !== v.h) diff.modified.push(p);
  }
  for (const p of Object.keys(prev)) if (!(p in next)) diff.deleted.push(p);
  return diff;
}
