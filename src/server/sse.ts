import type { EventBus } from './events.js';

export interface SseOptions {
  /** Events are batched and written at most once per window (ms). */
  coalesceMs: number;
  /** Concurrent event streams; more are refused with 503. */
  maxClients: number;
  /** Events queued per client while waiting for a flush or for a congested client to drain; older ones are dropped. */
  maxPending: number;
  /** Byte budget for those queued events. */
  maxPendingBytes: number;
  heartbeatMs: number;
}

export const SSE_DEFAULTS: SseOptions = {
  coalesceMs: 250,
  maxClients: 16,
  maxPending: 100,
  maxPendingBytes: 256 * 1024,
  heartbeatMs: 20_000,
};

/** The part of `http.ServerResponse` the hub uses (a fake in tests). */
export interface SseSink {
  write(chunk: string): boolean;
  once(event: 'drain', listener: () => void): unknown;
  end(): void;
}

interface Client {
  sink: SseSink;
  /** Serialized `event` frames not yet written. */
  pending: string[];
  pendingBytes: number;
  /** Latest serialized `activity` frame not yet written (only the latest matters). */
  activity: string | null;
  /** Events dropped since the last write; reported to the client as `resync`. */
  dropped: number;
  /** Waiting for 'drain': nothing is written until the socket catches up. */
  congested: boolean;
}

export const sseFrame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * Fans the event bus out to SSE clients.
 *
 * - Bursts are coalesced: events are serialized once and written to each client
 *   in one batch per `coalesceMs` window; intermediate `activity` states are
 *   collapsed to the latest.
 * - Backpressure: when a write returns false (the response's unsent output
 *   `writableLength` reached its high-water mark), nothing more is written
 *   until it drains. Meanwhile at most
 *   `maxPending` events are kept (oldest dropped) plus the latest activity; after
 *   draining the client gets a `resync` frame with the number of events it missed
 *   (it can refetch /api/activity), then the queued events and latest activity.
 * - At most `maxClients` concurrent streams.
 */
export class SseHub {
  private readonly clients = new Map<SseSink, Client>();
  private readonly opts: SseOptions;
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly heartbeat: NodeJS.Timeout;
  private readonly unsubscribe: () => void;

  constructor(private readonly bus: EventBus, opts: Partial<SseOptions> = {}) {
    this.opts = { ...SSE_DEFAULTS, ...opts };
    this.unsubscribe = bus.subscribe((e) => {
      if (e.type === '__activity') this.enqueue(sseFrame('activity', (e as { activity: unknown }).activity), true);
      else this.enqueue(sseFrame('event', e), false);
    });
    this.heartbeat = setInterval(() => {
      for (const c of this.clients.values()) if (!c.congested) this.write(c, ': ping\n\n');
    }, this.opts.heartbeatMs);
    this.heartbeat.unref();
  }

  get size(): number {
    return this.clients.size;
  }

  get full(): boolean {
    return this.clients.size >= this.opts.maxClients;
  }

  /** Start streaming to `sink` (the current activity is sent immediately). Returns a function that detaches it. */
  add(sink: SseSink): () => void {
    const client: Client = { sink, pending: [], pendingBytes: 0, activity: null, dropped: 0, congested: false };
    this.clients.set(sink, client);
    this.write(client, sseFrame('activity', this.bus.activity()));
    return () => {
      this.clients.delete(sink);
    };
  }

  /** Write everything queued now (normally done by the coalescing timer). */
  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    for (const c of this.clients.values()) if (!c.congested) this.send(c);
  }

  /** End every stream and stop listening to the bus. */
  close(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    clearInterval(this.heartbeat);
    this.unsubscribe();
    for (const c of this.clients.values()) c.sink.end();
    this.clients.clear();
  }

  private enqueue(frame: string, isActivity: boolean): void {
    if (!this.clients.size) return;
    for (const c of this.clients.values()) {
      if (isActivity) {
        c.activity = frame;
        continue;
      }
      c.pending.push(frame);
      c.pendingBytes += frame.length;
      while (c.pending.length > this.opts.maxPending || (c.pendingBytes > this.opts.maxPendingBytes && c.pending.length > 1)) {
        c.pendingBytes -= c.pending.shift()!.length;
        c.dropped++;
      }
    }
    this.flushTimer ??= setTimeout(() => this.flush(), this.opts.coalesceMs);
  }

  private send(c: Client): void {
    let out = '';
    if (c.dropped) {
      out += sseFrame('resync', { dropped: c.dropped });
      c.dropped = 0;
    }
    if (c.pending.length) out += c.pending.join('');
    if (c.activity) out += c.activity;
    c.pending = [];
    c.pendingBytes = 0;
    c.activity = null;
    if (out) this.write(c, out);
  }

  private write(c: Client, chunk: string): void {
    if (c.sink.write(chunk)) return;
    c.congested = true;
    c.sink.once('drain', () => {
      c.congested = false;
      if (this.clients.get(c.sink) === c) this.send(c);
    });
  }
}
