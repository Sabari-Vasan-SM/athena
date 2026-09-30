/**
 * A size-bounded LRU map. Entries are weighed by `weigh` (bytes for text); the
 * least recently used entries are evicted once the total exceeds `budget`. An
 * entry heavier than the whole budget is not stored at all.
 */
export class ByteLRU<V> {
  private readonly map = new Map<string, { v: V; w: number }>();
  private total = 0;

  constructor(
    private readonly budget: number,
    private readonly weigh: (v: V) => number,
  ) {}

  get size(): number {
    return this.map.size;
  }

  get bytes(): number {
    return this.total;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    // Re-insert to mark as most recently used.
    this.map.delete(key);
    this.map.set(key, e);
    return e.v;
  }

  set(key: string, v: V): void {
    const w = Math.max(1, this.weigh(v));
    const old = this.map.get(key);
    if (old) {
      this.total -= old.w;
      this.map.delete(key);
    }
    if (w > this.budget) return;
    this.map.set(key, { v, w });
    this.total += w;
    for (const [k, e] of this.map) {
      if (this.total <= this.budget) break;
      this.map.delete(k);
      this.total -= e.w;
    }
  }

  clear(): void {
    this.map.clear();
    this.total = 0;
  }
}

/** Default budget for file text kept around for aggregate-stage lookups. */
export const DEFAULT_TEXT_CACHE_BYTES = 64 * 1024 * 1024;
