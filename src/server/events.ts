import crypto from 'node:crypto';

/**
 * Only events Athena actually observes are ever emitted. `source` states who did
 * it; AI agent events will only exist once a real integration (hooks) reports them.
 */
export type EventSource = 'athena' | 'web-ui' | 'filesystem' | 'agent';

export interface AthenaEvent {
  id: string;
  ts: string;
  source: EventSource;
  type: string;
  message: string;
  level: 'info' | 'success' | 'warn' | 'error';
  data?: Record<string, unknown>;
}

/** States the activity indicator can show. Agent work states require an agent integration. */
export type ActivityState = 'IDLE' | 'ANALYZING' | 'PLANNING' | 'CODING' | 'TESTING' | 'REVIEWING' | 'SUCCESS' | 'ERROR';

export interface Activity {
  state: ActivityState;
  /** Who the current state describes. */
  actor: 'athena' | 'agent' | 'none';
  task: string | null;
  reading: string[];
  since: string;
}

type Listener = (e: AthenaEvent | { type: '__activity'; activity: Activity }) => void;

export class EventBus {
  private readonly buffer: AthenaEvent[] = [];
  private readonly listeners = new Set<Listener>();
  private current: Activity = { state: 'IDLE', actor: 'none', task: null, reading: [], since: new Date().toISOString() };
  private settleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly capacity = 500) {}

  emit(e: Omit<AthenaEvent, 'id' | 'ts'>): AthenaEvent {
    const event: AthenaEvent = { id: crypto.randomUUID(), ts: new Date().toISOString(), ...e };
    this.buffer.push(event);
    if (this.buffer.length > this.capacity) this.buffer.splice(0, this.buffer.length - this.capacity);
    for (const l of this.listeners) l(event);
    return event;
  }

  recent(limit = 200): AthenaEvent[] {
    return this.buffer.slice(-limit);
  }

  activity(): Activity {
    return this.current;
  }

  setActivity(next: Omit<Activity, 'since'>, settleToIdleMs?: number): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    this.current = { ...next, since: new Date().toISOString() };
    for (const l of this.listeners) l({ type: '__activity', activity: this.current });
    if (settleToIdleMs) {
      this.settleTimer = setTimeout(() => this.setActivity({ state: 'IDLE', actor: 'none', task: null, reading: [] }), settleToIdleMs);
      this.settleTimer.unref();
    }
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  close(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.listeners.clear();
  }
}
