import type { IncrementalInput, WalkSnapshot } from '../core/analyzer/incremental.js';
import { planSnapshot, planSync, type SyncPlan } from './sync.js';

/**
 * One process-wide queue for sync planning (analysis) on a project.
 *
 * - Single flight: at most one plan runs at a time.
 * - Coalescing: every request that arrives while a plan runs joins ONE follow-up
 *   run, which covers the union of the changed paths reported meanwhile.
 * - Abort: a request with `supersede` (new file changes) aborts an in-flight
 *   plan that is still planning — planning is read-only, so that is always safe —
 *   and the aborted run's waiters get the follow-up's result instead. At most
 *   `maxConsecutiveAborts` in a row, so a steady stream of edits cannot starve it.
 * - Incremental: when change tracking is on (a watcher reports every change via
 *   `noteChanges`), a run re-stats only the changed paths on top of the previous
 *   run's walk instead of walking the tree; a full walk happens on the first run,
 *   after `resetBaseline()`, or when the baseline is older than `fullWalkEveryMs`.
 * - `exclusive(fn)`: run a writer (apply, full analysis) with no plan in flight.
 */

export interface PlanRequest {
  /** Why (for diagnostics / events): 'watch', 'check', 'mcp', 'review', … */
  reason: string;
  /** Repo-relative POSIX paths that changed (only meaningful with change tracking). */
  paths?: readonly string[];
  /** Abort an in-flight plan that is still planning, if allowed. */
  supersede?: boolean;
  /** Force a full walk for this run. */
  full?: boolean;
}

export interface PlannerInput {
  signal: AbortSignal;
  incremental?: IncrementalInput;
}

export interface PlannerOutput {
  plan: SyncPlan;
  snapshot: WalkSnapshot | null;
}

export type Planner = (root: string, input: PlannerInput) => Promise<PlannerOutput>;

export interface SchedulerOptions {
  /** Injectable planner (tests). Default: planSync. */
  planner?: Planner;
  /** Default 2. */
  maxConsecutiveAborts?: number;
  /** Walk the whole tree at least this often even when tracking changes (default 5 min). */
  fullWalkEveryMs?: number;
}

/**
 * The ignore rules a watcher decided what to watch with. If the project's rules
 * differ (config or .git/info/exclude edited since), the watcher may not see every
 * relevant path, so runs walk the whole tree.
 */
export interface TrackingGuard {
  configHash: string;
  excludeText: string | null;
}

export interface RunInfo {
  reason: string;
  paths: string[];
  incremental: boolean;
}

export interface SchedulerHooks {
  /** A run starts planning. */
  onStart?: (run: RunInfo) => void;
  /** Runs inside the run slot after planning (e.g. refresh the index or auto-apply); errors reject the run. */
  onPlan?: (plan: SyncPlan, run: RunInfo) => Promise<void> | void;
}

interface Waiter {
  resolve: (plan: SyncPlan) => void;
  reject: (err: unknown) => void;
}

interface Run {
  reasons: string[];
  waiters: Waiter[];
  controller: AbortController;
  phase: 'queued' | 'planning' | 'finishing';
  superseded: boolean;
  claimed: string[];
  forceFull: boolean;
}

export const DEFAULT_FULL_WALK_EVERY_MS = 5 * 60_000;

function abortError(): Error {
  const e = new Error('The analysis was cancelled.');
  e.name = 'AbortError';
  return e;
}

const defaultPlanner: Planner = async (root, input) => {
  const plan = await planSync(root, { signal: input.signal, incremental: input.incremental });
  return { plan, snapshot: planSnapshot(plan)?.snapshot ?? null };
};

export class AnalysisScheduler {
  readonly hooks: SchedulerHooks = {};
  private readonly planner: Planner;
  private readonly maxConsecutiveAborts: number;
  private readonly fullWalkEveryMs: number;

  private current: Run | null = null;
  private next: Run | null = null;
  /** Serializes runs and exclusive writers. */
  private lock: Promise<unknown> = Promise.resolve();
  private closed = false;
  private consecutiveAborts = 0;

  // Change tracking (incremental analysis).
  private tracking = false;
  /** What the tracker (watcher) was set up with: a walk made under other ignore rules is not trusted. */
  private guard: TrackingGuard | null = null;
  private epoch = 0;
  private noted = new Set<string>();
  private baseline: { snapshot: WalkSnapshot; epoch: number } | null = null;
  private forceFullNext = false;

  /** Counters (tests, diagnostics). */
  readonly stats = { runs: 0, aborted: 0, incremental: 0, coalesced: 0 };

  constructor(
    readonly root: string,
    opts: SchedulerOptions = {},
  ) {
    this.planner = opts.planner ?? defaultPlanner;
    this.maxConsecutiveAborts = opts.maxConsecutiveAborts ?? 2;
    this.fullWalkEveryMs = opts.fullWalkEveryMs ?? DEFAULT_FULL_WALK_EVERY_MS;
  }

  get busy(): boolean {
    return this.current !== null;
  }

  /**
   * Turn change tracking on (a watcher that is ready and will report every change)
   * or off. Either way the baseline is dropped: the next run walks the whole tree.
   */
  setTracking(on: boolean, guard?: TrackingGuard): void {
    this.tracking = on;
    this.guard = on ? (guard ?? null) : null;
    this.resetBaseline();
  }

  /** Forget the previous walk (watcher error, missed events): the next run walks the whole tree. */
  resetBaseline(): void {
    this.epoch++;
    this.baseline = null;
    this.noted.clear();
  }

  /** Record changed paths without requesting a plan (a watcher calls this on every event). */
  noteChanges(paths: Iterable<string>): void {
    // Recorded even without tracking: runs report them (RunInfo.paths); they only
    // drive an incremental walk when tracking is on and a baseline exists.
    for (const p of paths) this.noted.add(p);
  }

  /** Request a plan. Resolves with the plan of the run that covers this request. */
  request(req: PlanRequest): Promise<SyncPlan> {
    if (this.closed) return Promise.reject(abortError());
    if (req.paths?.length) this.noteChanges(req.paths);
    if (req.full) this.forceFullNext = true;
    return new Promise<SyncPlan>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      if (!this.current) {
        const run = this.newRun(req.reason);
        run.waiters.push(waiter);
        this.start(run);
        return;
      }
      this.stats.coalesced++;
      if (this.current.phase === 'queued' && !this.current.superseded) {
        // Not started yet (waiting behind an exclusive writer): it will claim these paths too.
        this.current.reasons.push(req.reason);
        this.current.waiters.push(waiter);
        return;
      }
      if (!this.next) this.next = this.newRun(req.reason);
      else this.next.reasons.push(req.reason);
      this.next.waiters.push(waiter);
      const cur = this.current;
      // Only when there really are new changes (reported with this request or noted since the run started).
      if (req.supersede && (req.paths?.length || this.noted.size) && cur.phase === 'planning' && !cur.superseded && this.consecutiveAborts < this.maxConsecutiveAborts) {
        cur.superseded = true;
        this.consecutiveAborts++;
        this.stats.aborted++;
        this.next.waiters.unshift(...cur.waiters.splice(0));
        cur.controller.abort();
      }
    });
  }

  /**
   * Run `fn` with no plan in flight; plans requested meanwhile wait for it.
   * For writers (apply, full analysis) that must not interleave with planning.
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.lock.then(fn);
    this.lock = result.catch(() => {});
    return result;
  }

  /** Abort everything and reject pending requests. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const err = abortError();
    for (const run of [this.current, this.next]) {
      if (!run) continue;
      run.superseded = true;
      for (const w of run.waiters.splice(0)) w.reject(err);
      run.controller.abort();
    }
    this.next = null;
  }

  private newRun(reason: string): Run {
    return { reasons: [reason], waiters: [], controller: new AbortController(), phase: 'queued', superseded: false, claimed: [], forceFull: false };
  }

  private start(run: Run): void {
    this.current = run;
    const task = this.lock.then(() => this.execute(run));
    this.lock = task.catch(() => {});
  }

  /** The run is over: free the slot (starting the follow-up), then settle its waiters. */
  private finish(run: Run, outcome: { plan: SyncPlan } | { error: unknown }): void {
    if (this.current === run) this.current = null;
    const next = this.next;
    this.next = null;
    if (next && !this.closed) this.start(next);
    for (const w of run.waiters.splice(0)) {
      if ('plan' in outcome) w.resolve(outcome.plan);
      else w.reject(outcome.error);
    }
  }

  private async execute(run: Run): Promise<void> {
    if (run.superseded || this.closed) {
      // Aborted while waiting for the lock: its waiters were moved to the follow-up.
      this.finish(run, { error: abortError() });
      return;
    }
    this.stats.runs++;
    const epoch = this.epoch;
    run.claimed = [...this.noted];
    this.noted.clear();
    run.forceFull = this.forceFullNext;
    this.forceFullNext = false;
    const base = this.baseline;
    const guard = this.guard;
    const useIncremental =
      this.tracking &&
      !run.forceFull &&
      base !== null &&
      base.epoch === epoch &&
      Date.now() - base.snapshot.takenAt < this.fullWalkEveryMs &&
      (!guard || (guard.configHash === base.snapshot.configHash && guard.excludeText === base.snapshot.excludeText));
    const info: RunInfo = { reason: run.reasons.join(','), paths: run.claimed, incremental: useIncremental };
    run.phase = 'planning';
    try {
      this.hooks.onStart?.(info);
      const out = await this.planner(this.root, {
        signal: run.controller.signal,
        incremental: useIncremental ? { snapshot: base!.snapshot, changedPaths: run.claimed } : undefined,
      });
      run.controller.signal.throwIfAborted();
      if (useIncremental && out.snapshot?.takenAt === base!.snapshot.takenAt) this.stats.incremental++;
      // Keep the walk as the next baseline only if no reset happened while it ran.
      if (this.tracking && out.snapshot && this.epoch === epoch) this.baseline = { snapshot: out.snapshot, epoch };
      run.phase = 'finishing';
      await this.hooks.onPlan?.(out.plan, info);
      this.consecutiveAborts = 0;
      this.finish(run, { plan: out.plan });
    } catch (err) {
      // The claimed paths were not folded into a baseline: hand them to the next run.
      if (this.epoch === epoch) for (const p of run.claimed) this.noted.add(p);
      this.finish(run, { error: run.superseded ? abortError() : err });
    }
  }
}
