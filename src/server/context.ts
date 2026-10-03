import type { FastifyInstance } from 'fastify';
import { buildStatus, type StatusReport } from '../services/status.js';
import type { SyncPlan } from '../services/sync.js';
import { AnalysisScheduler } from '../services/scheduler.js';
import type { ProjectWatcher } from '../services/watch.js';
import { projectSession, type ProjectSession } from '../services/project-session.js';
import type { EventBus } from './events.js';

/** Mutable per-server state shared by the route modules. */
export interface ServerState {
  analysisRunning: boolean;
  scanRunning: boolean;
  graphBuilding: boolean;
  syncBusy: boolean;
  /** The pending sync proposal (null when knowledge is up to date). */
  currentPlan: SyncPlan | null;
  lastCheckedAt: string | null;
  watcher: ProjectWatcher | null;
}

/** Everything a route module needs: the app, the project, the event bus and shared state. */
export interface ServerContext {
  readonly app: FastifyInstance;
  readonly root: string;
  readonly events: EventBus;
  readonly instanceId: string;
  /** Memoized `.athena` artifacts (model, graph, scan, state). */
  readonly session: ProjectSession;
  /** file → content hash written by this server, to tell our own writes from external edits. */
  readonly recentWrites: Map<string, string>;
  /** Memory writes from the web UI still in progress; the memory watcher waits for them before deciding a change is external. */
  readonly memoryWrites: { inFlight: number };
  readonly state: ServerState;
  /** Single-flight, coalescing planner for this project (shared with the file watcher). */
  readonly scheduler: AnalysisScheduler;
  /** `buildStatus`, cached until a watched change (or for 3 s when not watching). */
  getStatus(): Promise<StatusReport>;
  invalidateStatus(): void;
  /** Record a plan as the current proposal (only if it proposes changes). */
  setPlan(plan: SyncPlan | null): void;
  /** Re-plan now (through the watcher when watching). */
  checkNow(): Promise<SyncPlan | null>;
  /** Re-plan in the background if a proposal is pending (it may now be stale). */
  replanSoon(): void;
}

const STATUS_TTL_MS = 3000;
/** With a watcher, changes invalidate the status cache; the TTL is only a safety net. */
const WATCHED_STATUS_TTL_MS = 30_000;

export function createServerContext(init: { app: FastifyInstance; root: string; events: EventBus; instanceId: string }): ServerContext {
  const { root } = init;
  let statusCache: { at: number; report: StatusReport } | null = null;
  let statusInflight: { gen: number; report: Promise<StatusReport> } | null = null;
  let statusGen = 0;
  const state: ServerState = { analysisRunning: false, scanRunning: false, graphBuilding: false, syncBusy: false, currentPlan: null, lastCheckedAt: null, watcher: null };

  const ctx: ServerContext = {
    ...init,
    session: projectSession(root),
    recentWrites: new Map(),
    memoryWrites: { inFlight: 0 },
    state,
    scheduler: new AnalysisScheduler(root),
    async getStatus() {
      const ttl = state.watcher ? WATCHED_STATUS_TTL_MS : STATUS_TTL_MS;
      if (statusCache && Date.now() - statusCache.at < ttl) return statusCache.report;
      // Concurrent requests share one computation.
      if (statusInflight && statusInflight.gen === statusGen) return statusInflight.report;
      const gen = statusGen;
      const started = Date.now();
      const inflight = { gen, report: buildStatus(root) };
      statusInflight = inflight;
      const report = await inflight.report.finally(() => {
        if (statusInflight === inflight) statusInflight = null;
      });
      // Don't cache a report that an invalidation raced with.
      if (gen === statusGen) statusCache = { at: started, report };
      return report;
    },
    invalidateStatus() {
      statusCache = null;
      statusGen++;
    },
    setPlan(plan) {
      state.lastCheckedAt = new Date().toISOString();
      state.currentPlan = plan && !plan.upToDate ? plan : null;
    },
    async checkNow() {
      if (state.watcher) return state.watcher.planNow();
      // Single flight: concurrent checks share one analysis (or one follow-up run).
      const plan = await ctx.scheduler.request({ reason: 'check' });
      ctx.setPlan(plan);
      return plan;
    },
    replanSoon() {
      if (state.currentPlan) void ctx.checkNow().catch(() => {});
    },
  };
  return ctx;
}
