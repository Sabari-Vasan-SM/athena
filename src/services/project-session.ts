import { promises as fs, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { GRAPH_FILE, ProjectGraph } from '../core/graph/graph.js';
import { ProjectModel } from '../core/model/project-model.js';
import { SCAN_FILE, SecurityScan } from '../core/model/security-scan.js';
import { athenaDir, readState, type StateReadResult } from '../core/state/state.js';
import { AthenaError } from './errors.js';

/** Result of reading one `.athena/*.json` artifact. */
export type ArtifactRead<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'missing' }
  | { kind: 'corrupted'; reason: string };

interface Schema<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
}

interface Entry<T> {
  /** File identity at read time: inode, size and mtime (ns). */
  key: string;
  result: ArtifactRead<T>;
}

const fileKey = (st: BigIntStats) => `${st.ino}:${st.size}:${st.mtimeNs}`;

/**
 * One loader for a project's `.athena` artifacts (model.json, graph.json,
 * security-scan.json, state.json). Parsed results are memoized per file and
 * reused until the file's inode, size or mtime changes, so a long-running
 * `athena open` doesn't re-read and re-validate multi-megabyte JSON on every
 * request. Concurrent loads of the same file share one read.
 *
 * Returned objects are shared between callers: treat them as read-only.
 */
export class ProjectSession {
  private readonly cache = new Map<string, Entry<unknown>>();
  private readonly inflight = new Map<string, Promise<ArtifactRead<unknown>>>();
  private stateEntry: { key: string; state: StateReadResult } | null = null;

  constructor(readonly root: string) {}

  get dir(): string {
    return athenaDir(this.root);
  }

  /** model.json, or why it can't be used. */
  readModel(): Promise<ArtifactRead<ProjectModel>> {
    return this.read('model.json', ProjectModel);
  }

  /** The parsed model, or null when missing or unusable. */
  async model(): Promise<ProjectModel | null> {
    const r = await this.readModel();
    return r.kind === 'ok' ? r.value : null;
  }

  /** The parsed model; throws an AthenaError with a hint when it is missing or corrupted. */
  async requireModel(): Promise<ProjectModel> {
    const r = await this.readModel();
    if (r.kind === 'ok') return r.value;
    if (r.kind === 'missing') throw new AthenaError('model.json is missing.', 'Run `athena analyze` (or re-analyze from the overview) first.');
    throw new AthenaError(`model.json is corrupted (${r.reason}).`, 'Run `athena analyze` to rebuild it.');
  }

  /** Cheap existence check (a stat, no parsing). */
  async hasModel(): Promise<boolean> {
    return this.exists('model.json');
  }

  readGraph(): Promise<ArtifactRead<ProjectGraph>> {
    return this.read(GRAPH_FILE, ProjectGraph);
  }

  async graph(): Promise<ProjectGraph | null> {
    const r = await this.readGraph();
    return r.kind === 'ok' ? r.value : null;
  }

  readScan(): Promise<ArtifactRead<SecurityScan>> {
    return this.read(SCAN_FILE, SecurityScan);
  }

  async scan(): Promise<SecurityScan | null> {
    const r = await this.readScan();
    return r.kind === 'ok' ? r.value : null;
  }

  /** state.json via `readState`, memoized like the other artifacts. */
  async state(): Promise<StateReadResult> {
    const file = path.join(this.dir, 'state.json');
    const st = await fs.stat(file, { bigint: true }).catch(() => null);
    if (!st) return readState(this.dir);
    const key = fileKey(st);
    if (this.stateEntry?.key === key) return this.stateEntry.state;
    const state = await readState(this.dir);
    // Only keep the result if the file didn't change while it was read.
    const after = await fs.stat(file, { bigint: true }).catch(() => null);
    if (after && fileKey(after) === key) this.stateEntry = { key, state };
    return state;
  }

  /**
   * Record a value this process just wrote to `.athena/<name>`, so the next
   * read doesn't parse it again. The file must already be on disk.
   */
  async remember(name: 'model.json' | typeof GRAPH_FILE | typeof SCAN_FILE, value: unknown): Promise<void> {
    const st = await fs.stat(path.join(this.dir, name), { bigint: true }).catch(() => null);
    if (st) this.cache.set(name, { key: fileKey(st), result: { kind: 'ok', value } });
    else this.cache.delete(name);
  }

  /** Drop memoized results (all, or one file). */
  invalidate(name?: string): void {
    if (!name || name === 'state.json') this.stateEntry = null;
    if (name) this.cache.delete(name);
    else this.cache.clear();
  }

  private async exists(name: string): Promise<boolean> {
    const st = await fs.stat(path.join(this.dir, name)).catch(() => null);
    return Boolean(st?.isFile());
  }

  private read<T>(name: string, schema: Schema<T>): Promise<ArtifactRead<T>> {
    const running = this.inflight.get(name);
    if (running) return running as Promise<ArtifactRead<T>>;
    const p = this.load(name, schema).finally(() => this.inflight.delete(name));
    this.inflight.set(name, p);
    return p;
  }

  private async load<T>(name: string, schema: Schema<T>): Promise<ArtifactRead<T>> {
    const file = path.join(this.dir, name);
    let st: BigIntStats;
    try {
      st = await fs.stat(file, { bigint: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      this.cache.delete(name);
      if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
      return { kind: 'corrupted', reason: `unreadable (${code})` };
    }
    const key = fileKey(st);
    const hit = this.cache.get(name) as Entry<T> | undefined;
    if (hit?.key === key) return hit.result;

    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { kind: 'missing' };
      return { kind: 'corrupted', reason: `unreadable (${code})` };
    }
    const result = parseArtifact(raw, schema);
    // Cache only if the file is still the one that was stat'ed (no write raced the read).
    const after = await fs.stat(file, { bigint: true }).catch(() => null);
    if (after && fileKey(after) === key) this.cache.set(name, { key, result });
    return result;
  }
}

function parseArtifact<T>(raw: string, schema: Schema<T>): ArtifactRead<T> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { kind: 'corrupted', reason: 'invalid JSON' };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return { kind: 'ok', value: parsed.data };
  const issue = parsed.error.issues[0];
  return { kind: 'corrupted', reason: `schema mismatch at ${issue?.path.map(String).join('.') || '(root)'}: ${issue?.message}` };
}

const sessions = new Map<string, ProjectSession>();

/** The shared session for a project root (one per resolved root per process). */
export function projectSession(root: string): ProjectSession {
  const key = path.resolve(root);
  let s = sessions.get(key);
  if (!s) {
    s = new ProjectSession(key);
    sessions.set(key, s);
  }
  return s;
}

/** Forget a root's session and its cached artifacts (e.g. when a server closes). */
export function releaseProjectSession(root: string): void {
  sessions.delete(path.resolve(root));
}
