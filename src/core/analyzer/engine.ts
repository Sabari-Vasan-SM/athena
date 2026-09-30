import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sniffBinary, type FileEntry } from '../fs/walker.js';
import type { FactsCache } from '../cache/facts-cache.js';
import { ByteLRU, DEFAULT_TEXT_CACHE_BYTES } from '../cache/lru.js';
import type { AnalysisHints, FactDef, FactRuntime, FactSource } from './context.js';

export type ReadFileFn = (abs: string) => Promise<Buffer>;

export interface FactEngineOptions {
  root: string;
  files: FileEntry[];
  cache: FactsCache;
  runtime: FactRuntime;
  /** Every fact any detector reads. */
  defs: FactDef<unknown>[];
  signal?: AbortSignal;
  /** Injectable reader (tests count reads with it). */
  readFile?: ReadFileFn;
  /** Byte budget for text kept for aggregate-stage lookups (default 64MB). */
  textCacheBytes?: number;
}

export interface EngineStats {
  /** File contents read from disk (content pass + aggregate-stage misses). */
  filesRead: number;
  /** Paths read more than once (should stay empty). */
  rereads: number;
  factsComputed: number;
}

const ERR = '$err';

/**
 * Serves per-file facts for the analyzer.
 *
 * The content pass (`process`) reads a file's bytes once, hashes them, sniffs for
 * binary content and computes every applicable fact while the text is in memory;
 * the text is then dropped. Detectors (the aggregate stage) read facts back by
 * content hash. A fact that is neither cached nor computed in the pass (e.g. an
 * expensive one the hints did not ask for) is computed on demand from text held
 * in a byte-budgeted LRU.
 */
export class FactEngine implements FactSource {
  readonly byPath: Map<string, FileEntry>;
  /** Files that could not be read in the content pass (dropped from the analysis). */
  readonly unreadable = new Set<string>();
  readonly stats: EngineStats = { filesRead: 0, rereads: 0, factsComputed: 0 };
  hints: AnalysisHints | null = null;
  readonly runtime: FactRuntime;

  private readonly inflight = new Map<string, Promise<void>>();
  private readonly readPaths = new Set<string>();
  private readonly lru: ByteLRU<string>;
  private readonly readFileFn: ReadFileFn;

  constructor(private readonly opts: FactEngineOptions) {
    this.byPath = new Map(opts.files.map((f) => [f.path, f]));
    this.runtime = opts.runtime;
    this.lru = new ByteLRU<string>(opts.textCacheBytes ?? DEFAULT_TEXT_CACHE_BYTES, (s) => s.length * 2);
    this.readFileFn = opts.readFile ?? ((abs) => fs.readFile(abs));
  }

  keyOf(def: FactDef<unknown>, rel: string): string {
    if (def.pathKeyed) return `${def.id}@${rel}`;
    if (def.keyed) return `${def.id}:${this.runtime.fingerprintKeyId ?? 'ephemeral'}`;
    return def.id;
  }

  private persistable(def: FactDef<unknown>): boolean {
    return !def.keyed || this.runtime.fingerprintKeyId !== null;
  }

  /** Facts computed for this file in the content pass, given the current hints. */
  eagerDefs(f: FileEntry): FactDef<unknown>[] {
    return this.opts.defs.filter((d) => d.applies(f) && (!d.when || (this.hints !== null && d.when(this.hints))));
  }

  /** True when the file must be read: unknown hash, or an applicable fact missing from the cache. */
  needsProcessing(f: FileEntry): boolean {
    if (f.hash === '') return true;
    if (f.binary || f.large) return false;
    const entry = this.opts.cache.entry(f.hash);
    for (const d of this.opts.defs) {
      if (!d.applies(f) || (d.when && (this.hints === null || !d.when(this.hints)))) continue;
      if (entry?.[this.keyOf(d, f.path)] === undefined && !this.opts.cache.has(f.hash, this.keyOf(d, f.path))) return true;
    }
    return false;
  }

  private async readBytes(rel: string): Promise<Buffer> {
    this.opts.signal?.throwIfAborted();
    const buf = await this.readFileFn(path.join(this.opts.root, rel));
    this.stats.filesRead++;
    if (this.readPaths.has(rel)) this.stats.rereads++;
    else this.readPaths.add(rel);
    return buf;
  }

  /** Content pass for one file: read once, hash, sniff, compute missing facts, drop the text. */
  process(f: FileEntry, extra?: FactDef<unknown>): Promise<void> {
    let p = this.inflight.get(f.path);
    if (!p) {
      p = this.doProcess(f, extra);
      this.inflight.set(f.path, p);
    }
    return p;
  }

  private async doProcess(f: FileEntry, extra?: FactDef<unknown>): Promise<void> {
    let buf: Buffer;
    try {
      buf = await this.readBytes(f.path);
    } catch (err) {
      if (this.opts.signal?.aborted) throw err;
      if (f.hash === '') this.unreadable.add(f.path);
      return;
    }
    f.hash = crypto.createHash('sha256').update(buf).digest('hex');
    f.binary = sniffBinary(buf);
    if (f.binary || f.large) return;
    const text = buf.toString('utf8');
    await this.opts.cache.preload([f.hash]);
    const defs = this.eagerDefs(f);
    if (extra && !defs.includes(extra)) defs.push(extra);
    for (const def of defs) {
      const key = this.keyOf(def, f.path);
      if (!this.opts.cache.has(f.hash, key)) await this.computeAndStore(f, def, key, text);
    }
  }

  private async computeAndStore(f: FileEntry, def: FactDef<unknown>, key: string, text: string): Promise<void> {
    let value: unknown;
    try {
      value = def.compute(text, f.path, this.runtime);
    } catch (err) {
      // Replayed as a throw when the detector reads the fact (same failure as before).
      value = { [ERR]: (err as Error)?.message ?? String(err) };
    }
    this.stats.factsComputed++;
    await this.opts.cache.set(f.hash, key, value, { persist: this.persistable(def), replacePrefix: def.keyed ? `${def.id}:` : undefined });
  }

  async read(rel: string): Promise<string | null> {
    const cached = this.lru.get(rel);
    if (cached !== undefined) return cached;
    const entry = this.byPath.get(rel);
    if (!entry || entry.binary || entry.large || this.unreadable.has(rel)) return null;
    let text: string | null;
    try {
      text = (await this.readBytes(rel)).toString('utf8');
    } catch (err) {
      if (this.opts.signal?.aborted) throw err;
      text = null;
    }
    if (text !== null) this.lru.set(rel, text);
    return text;
  }

  async fact<T>(rel: string, def: FactDef<T>): Promise<T | null> {
    const f = this.byPath.get(rel);
    if (!f) return null;
    if (f.hash === '') await this.process(f);
    if (f.binary || f.large || this.unreadable.has(rel)) return null;
    const d = def as FactDef<unknown>;
    const key = this.keyOf(d, rel);
    let v = this.opts.cache.peek(f.hash, key);
    if (v === undefined) v = await this.opts.cache.get(f.hash, key);
    if (v === undefined && !this.inflight.has(rel)) {
      // Not processed yet in this run (e.g. read while computing hints): do the full content pass for it now.
      await this.process(f, d);
      if (f.binary || f.large) return null;
      v = await this.opts.cache.get(f.hash, key);
    }
    if (v === undefined) {
      const text = await this.read(rel);
      if (text === null) return null;
      await this.computeAndStore(f, d, key, text);
      v = await this.opts.cache.get(f.hash, key);
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && ERR in v) throw new Error(String((v as Record<string, unknown>)[ERR]));
    // Detectors may mutate what they get back; never hand out the cached object.
    if (v === null || typeof v !== 'object') return v as T;
    if (Array.isArray(v) && v.length === 0) return [] as T;
    return structuredClone(v) as T;
  }
}
