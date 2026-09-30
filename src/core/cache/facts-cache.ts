import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../util/fs.js';

/**
 * Per-file facts cache: `.athena/cache/v1/facts/<2-hex>.json`.
 *
 * Each shard maps a content hash (sha256 of the file bytes) to the facts that
 * detectors extracted from that content: `{ "<hash>": { "<factId>": value } }`.
 * Facts are pure functions of the content (plus, for a few, the path — those
 * carry the path in their id), so a cached value is valid for any file with the
 * same bytes. `version.json` records the detector version string and the config
 * hash the facts were computed under; on a mismatch the whole facts directory is
 * discarded. Shards are loaded lazily, written atomically, and a corrupted shard
 * is ignored (and rebuilt on the next save).
 */
export const CACHE_DIR = path.join('cache', 'v1');
const FACTS_DIR = 'facts';
const VERSION_FILE = 'version.json';
/** Bump when the on-disk layout of the facts cache changes. */
export const FACTS_FORMAT = 1;

export interface CacheIdentity {
  /** Detector version string (see DETECTORS_VERSION). */
  detectors: string;
  /** Hash of the config options that influence facts (ignore/include/maxFileBytes). */
  config: string;
}

type Shard = Record<string, Record<string, unknown>>;

export interface FactsCacheStats {
  shardsLoaded: number;
  corruptShards: number;
  shardsWritten: number;
  reset: boolean;
}

const shardOf = (hash: string) => hash.slice(0, 2);

export function cacheRoot(athenaDir: string): string {
  return path.join(athenaDir, CACHE_DIR);
}

export class FactsCache {
  private readonly shards = new Map<string, Shard>();
  private readonly loading = new Map<string, Promise<Shard>>();
  private readonly dirty = new Set<string>();
  /** Facts that must not be persisted (e.g. keyed with an ephemeral per-process key). */
  private readonly transient = new Map<string, Record<string, unknown>>();
  readonly stats: FactsCacheStats = { shardsLoaded: 0, corruptShards: 0, shardsWritten: 0, reset: false };

  private constructor(
    /** `.athena/cache/v1` to read from; null = start empty (nothing on disk yet). */
    private dir: string | null,
    readonly identity: CacheIdentity,
    /** True when the on-disk facts are stale (identity/format mismatch) and must be discarded on save. */
    private reset: boolean,
  ) {
    this.stats.reset = reset;
  }

  static async open(athenaDir: string | null, identity: CacheIdentity): Promise<FactsCache> {
    if (!athenaDir) return new FactsCache(null, identity, false);
    const dir = cacheRoot(athenaDir);
    let reset = true;
    try {
      const v = JSON.parse(await fs.readFile(path.join(dir, FACTS_DIR, VERSION_FILE), 'utf8')) as Partial<CacheIdentity> & { format?: number };
      reset = v.format !== FACTS_FORMAT || v.detectors !== identity.detectors || v.config !== identity.config;
    } catch {
      /* missing or unreadable version file: start over */
    }
    return new FactsCache(reset ? null : dir, identity, reset);
  }

  private shard(prefix: string): Promise<Shard> | Shard {
    const loaded = this.shards.get(prefix);
    if (loaded) return loaded;
    let p = this.loading.get(prefix);
    if (!p) {
      p = this.loadShard(prefix);
      this.loading.set(prefix, p);
    }
    return p;
  }

  private async loadShard(prefix: string): Promise<Shard> {
    let data: Shard = {};
    if (this.dir) {
      try {
        const raw = await fs.readFile(path.join(this.dir, FACTS_DIR, `${prefix}.json`), 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          data = parsed as Shard;
          this.stats.shardsLoaded++;
        } else throw new Error('bad shard');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          // Corrupted shard: ignore it and rewrite it on the next save.
          this.stats.corruptShards++;
          data = {};
          this.dirty.add(prefix);
        }
      }
    }
    this.shards.set(prefix, data);
    this.loading.delete(prefix);
    return data;
  }

  /** Load the shards for these hashes (in parallel) so get/has can run synchronously. */
  async preload(hashes: Iterable<string>): Promise<void> {
    const prefixes = new Set<string>();
    for (const h of hashes) if (isContentHash(h)) prefixes.add(shardOf(h));
    await Promise.all([...prefixes].map((p) => this.shard(p)));
  }

  /** Synchronous lookup; the shard must have been loaded (see preload / getAsync). */
  entry(hash: string): Record<string, unknown> | undefined {
    return this.shards.get(shardOf(hash))?.[hash];
  }

  has(hash: string, id: string): boolean {
    if (this.transient.get(hash)?.[id] !== undefined) return true;
    const e = this.entry(hash);
    return !!e && e[id] !== undefined;
  }

  /** Synchronous lookup when the shard is already loaded; `undefined` otherwise (or when absent). */
  peek(hash: string, id: string): unknown {
    const t = this.transient.get(hash)?.[id];
    if (t !== undefined) return t;
    return this.shards.get(shardOf(hash))?.[hash]?.[id];
  }

  async get(hash: string, id: string): Promise<unknown> {
    const t = this.transient.get(hash)?.[id];
    if (t !== undefined) return t;
    if (!isContentHash(hash)) return undefined;
    const s = await this.shard(shardOf(hash));
    return s[hash]?.[id];
  }

  /**
   * Store a fact. Values are normalized through JSON so a value read back from disk
   * is indistinguishable from a freshly computed one.
   */
  async set(hash: string, id: string, value: unknown, opts: { persist?: boolean; replacePrefix?: string } = {}): Promise<void> {
    const normalized = value === undefined ? null : (JSON.parse(JSON.stringify(value)) as unknown);
    if (opts.persist === false || !isContentHash(hash)) {
      const e = this.transient.get(hash) ?? {};
      e[id] = normalized;
      this.transient.set(hash, e);
      return;
    }
    const prefix = shardOf(hash);
    const s = await this.shard(prefix);
    const e = (s[hash] ??= {});
    if (opts.replacePrefix) for (const k of Object.keys(e)) if (k !== id && k.startsWith(opts.replacePrefix)) delete e[k];
    e[id] = normalized;
    this.dirty.add(prefix);
  }

  /**
   * Persist changed shards under `athenaDir` (default: where the cache was opened).
   * With `live`, entries for content no longer present in the project are dropped
   * from every loaded shard.
   */
  async save(athenaDir: string, live?: Set<string>): Promise<void> {
    const dir = cacheRoot(athenaDir);
    const factsDir = path.join(dir, FACTS_DIR);
    const retarget = this.dir !== dir;
    if (this.reset || retarget) {
      // Stale or foreign facts on disk: start from a clean directory.
      await fs.rm(factsDir, { recursive: true, force: true });
      for (const p of this.shards.keys()) this.dirty.add(p);
    }
    if (live) {
      for (const [prefix, shard] of this.shards) {
        for (const h of Object.keys(shard)) {
          if (!live.has(h)) {
            delete shard[h];
            this.dirty.add(prefix);
          }
        }
      }
    }
    await fs.mkdir(factsDir, { recursive: true });
    const writes = [...this.dirty].map(async (prefix) => {
      const shard = this.shards.get(prefix) ?? {};
      const file = path.join(factsDir, `${prefix}.json`);
      if (!Object.keys(shard).length) await fs.rm(file, { force: true });
      else await writeFileAtomic(file, JSON.stringify(shard));
      this.stats.shardsWritten++;
    });
    await Promise.all(writes);
    if (this.reset || retarget || writes.length) {
      await writeFileAtomic(path.join(factsDir, VERSION_FILE), JSON.stringify({ format: FACTS_FORMAT, ...this.identity }));
    }
    if (live) {
      // Shards that hold no live content at all were never loaded this run: remove them.
      const livePrefixes = new Set([...live].filter(isContentHash).map(shardOf));
      const names = await fs.readdir(factsDir).catch(() => [] as string[]);
      await Promise.all(names.filter((n) => /^[0-9a-f]{2}\.json$/.test(n) && !livePrefixes.has(n.slice(0, 2)) && !this.shards.has(n.slice(0, 2))).map((n) => fs.rm(path.join(factsDir, n), { force: true })));
    }
    this.dirty.clear();
    this.reset = false;
    this.dir = dir;
  }
}

/** Content hashes key the cache; metadata hashes (oversized files) never have facts. */
export function isContentHash(h: string): boolean {
  // Index hashes are hex sha256 (or a 16-char prefix from v1); metadata hashes start with "meta:".
  return h.length >= 16 && h.length <= 64 && !h.startsWith('meta:');
}
