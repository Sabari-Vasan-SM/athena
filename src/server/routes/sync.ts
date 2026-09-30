import { promises as fs } from 'node:fs';
import path from 'node:path';
import { KNOWLEDGE_DOCS } from '../../core/knowledge/documents.js';
import { athenaDir } from '../../core/state/state.js';
import { AthenaError, notFound } from '../../services/errors.js';
import { contentHash } from '../../services/knowledge.js';
import { applySync, ignorePlan, type ProposedDocument, type SyncPlan } from '../../services/sync.js';
import type { ServerContext } from '../context.js';

/** A proposed document without its diff (fetched separately from GET /api/sync/:doc). */
export type ProposedDocumentSummary = Omit<ProposedDocument, 'diff'>;
export type SyncPlanSummary = Omit<SyncPlan, 'documents'> & { documents: ProposedDocumentSummary[] };

/** The plan as GET /api/sync returns it: everything but the (potentially large) per-document diffs. */
export function summarizePlan(plan: SyncPlan | null): SyncPlanSummary | null {
  if (!plan) return null;
  return { ...plan, documents: plan.documents.map(({ diff: _diff, ...rest }) => rest) };
}

const DOC_IDS = new Set<string>(KNOWLEDGE_DOCS.map((d) => d.id));
const planIdSchema = { schema: { body: { type: 'object', required: ['planId'], additionalProperties: false, properties: { planId: { type: 'string', pattern: '^[a-f0-9]{16}$' } } } } };
const docParamsSchema = {
  schema: {
    params: { type: 'object', required: ['doc'], additionalProperties: false, properties: { doc: { type: 'string', pattern: '^[a-z][a-z-]{0,39}$' } } },
    querystring: { type: 'object', additionalProperties: false, properties: { planId: { type: 'string', pattern: '^[a-f0-9]{16}$' } } },
  },
};

/** Continuous synchronization: current proposal, per-document diffs, check, apply, ignore. */
export function registerSyncRoutes(ctx: ServerContext): void {
  const { app, root, events, state } = ctx;

  app.get('/api/sync', async () => ({ watching: Boolean(state.watcher), lastCheckedAt: state.lastCheckedAt, plan: summarizePlan(state.currentPlan) }));

  /** The diff for one document of the current proposal. `planId` (optional) guards against a proposal that changed meanwhile. */
  app.get<{ Params: { doc: string }; Querystring: { planId?: string } }>('/api/sync/:doc', docParamsSchema, async (req) => {
    const id = req.params.doc;
    if (!DOC_IDS.has(id)) throw notFound(`Unknown document: ${id}`);
    const plan = state.currentPlan;
    if (req.query.planId && plan?.id !== req.query.planId) throw new AthenaError('This proposal is out of date.', 'Check for changes again and review the new proposal.', 1, 'conflict');
    const doc = plan?.documents.find((d) => d.id === id);
    if (!plan || !doc) throw notFound(`No proposed update for ${id}.`);
    return { planId: plan.id, id: doc.id, file: doc.file, diff: doc.diff, diffTruncated: doc.diffTruncated, additions: doc.additions, deletions: doc.deletions };
  });

  // The check response keeps the full plan (with diffs): it is an explicit, one-off request.
  app.post('/api/sync/check', async () => {
    const plan = await ctx.checkNow();
    if (!state.watcher) ctx.setPlan(plan);
    return { watching: Boolean(state.watcher), lastCheckedAt: state.lastCheckedAt, plan: state.currentPlan, upToDate: plan?.upToDate ?? true };
  });

  app.post<{ Body: { planId: string } }>('/api/sync/apply', planIdSchema, async (req) => {
    if (!state.currentPlan || state.currentPlan.id !== req.body.planId) throw new AthenaError('This proposal is out of date.', 'Check for changes again and review the new proposal.', 1, 'conflict');
    if (state.syncBusy || state.analysisRunning) throw new AthenaError('Another update is in progress.', undefined, 1, 'busy');
    state.syncBusy = true;
    const plan = state.currentPlan;
    try {
      // Never interleaved with a plan in flight (which would read a half-written index).
      const result = await ctx.scheduler.exclusive(() => applySync(root, plan));
      for (const d of plan.documents) {
        const text = await fs.readFile(path.join(athenaDir(root), d.file), 'utf8').catch(() => null);
        if (text !== null) ctx.recentWrites.set(d.file, contentHash(text));
      }
      state.currentPlan = null;
      state.lastCheckedAt = new Date().toISOString();
      ctx.invalidateStatus();
      events.emit({ source: 'web-ui', type: 'sync.applied', level: 'success', message: `Knowledge updated: ${result.applied.join(', ')}`, data: { files: result.applied, preserved: result.preserved } });
      events.setActivity({ state: 'SUCCESS', actor: 'athena', task: 'Knowledge synchronized', reading: [] }, 4000);
      return result;
    } catch (err) {
      if (err instanceof AthenaError && err.kind === 'conflict') ctx.replanSoon();
      throw err;
    } finally {
      state.syncBusy = false;
    }
  });

  app.post<{ Body: { planId: string } }>('/api/sync/ignore', planIdSchema, async (req) => {
    if (!state.currentPlan || state.currentPlan.id !== req.body.planId) throw new AthenaError('This proposal is out of date.', undefined, 1, 'conflict');
    await ignorePlan(root, req.body.planId);
    state.currentPlan = { ...state.currentPlan, ignored: true };
    events.emit({ source: 'web-ui', type: 'sync.ignored', level: 'info', message: `Ignored proposed update to ${state.currentPlan.documents.map((d) => d.file).join(', ')}` });
    return { ok: true };
  });
}
