import type { FastifyInstance } from 'fastify';
import { buildStatus, type StatusReport } from '../services/status.js';
import { planSync, type SyncPlan } from '../services/sync.js';
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
  readonly state: ServerState;
  /** `buildStatus`, cached for 3 s. */
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

export function createServerContext(init: { app: FastifyInstance; root: string; events: EventBus; instanceId: string }): ServerContext {
  const { root } = init;
  let statusCache: { at: number; report: StatusReport } | null = null;
  const state: ServerState = { analysisRunning: false, scanRunning: false, graphBuilding: false, syncBusy: false, currentPlan: null, lastCheckedAt: null, watcher: null };

  const ctx: ServerContext = {
    ...init,
    session: projectSession(root),
    recentWrites: new Map(),
    state,
    async getStatus() {
      if (statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.report;
      const report = await buildStatus(root);
      statusCache = { at: Date.now(), report };
      return report;
    },
    invalidateStatus() {
      statusCache = null;
    },
    setPlan(plan) {
      state.lastCheckedAt = new Date().toISOString();
      state.currentPlan = plan && !plan.upToDate ? plan : null;
    },
    async checkNow() {
      if (state.watcher) return state.watcher.planNow();
      const plan = await planSync(root);
      ctx.setPlan(plan);
      return plan;
    },
    replanSoon() {
      if (state.currentPlan) void ctx.checkNow().catch(() => {});
    },
  };
  return ctx;
}
