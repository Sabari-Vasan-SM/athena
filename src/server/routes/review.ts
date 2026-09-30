import { reviewChanges } from '../../services/review.js';
import { planSync, staleForCheck } from '../../services/sync.js';
import type { ServerContext } from '../context.js';

/** Pre-commit style review of the working tree (or against a base ref). */
export function registerReviewRoutes({ app, root }: ServerContext): void {
  app.get<{ Querystring: { base?: string } }>('/api/review', async (req) => {
    const base = typeof req.query.base === 'string' && req.query.base ? req.query.base : undefined;
    return reviewChanges(root, { base, checkSync: async (r) => staleForCheck(await planSync(r)).length === 0 });
  });
}
