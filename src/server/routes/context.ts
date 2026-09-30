import { getRelevantContext } from '../../services/context.js';
import type { ServerContext } from '../context.js';

/** Upper bound for /api/context budgets, whatever the client asks for. */
export const MAX_CONTEXT_CHARS = 200_000;

/** Server-side clamp for /api/context budgets: the budget decides how much work and memory a request costs. */
export function clampContextChars(raw: string | undefined): number | undefined {
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? Math.min(MAX_CONTEXT_CHARS, Math.max(500, Math.floor(n))) : undefined;
}

/** Task-relevant knowledge for agents (the context engine). */
export function registerContextRoutes({ app, root }: ServerContext): void {
  app.get<{ Querystring: { task?: string; maxChars?: string } }>('/api/context', async (req) => {
    const task = String(req.query.task ?? '').slice(0, 500);
    return getRelevantContext(root, task, { maxChars: clampContextChars(req.query.maxChars) });
  });
}
