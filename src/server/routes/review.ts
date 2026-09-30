import { reviewChanges } from '../../services/review.js';
import { staleForCheck } from '../../services/sync.js';
import type { ServerContext } from '../context.js';

/** Pre-commit style review of the working tree (or against a base ref). */
export function registerReviewRoutes({ app, root, scheduler }: ServerContext): void {
  app.get<{ Querystring: { base?: string } }>('/api/review', async (req) => {
    const base = typeof req.query.base === 'string' && req.query.base ? req.query.base : undefined;
    return reviewChanges(root, { base, checkSync: async () => staleForCheck(await scheduler.request({ reason: 'review' })).length === 0 });
  });
}
