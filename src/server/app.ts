import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { AthenaError, type ErrorKind } from '../services/errors.js';
import { releaseProjectSession } from '../services/project-session.js';
import { createServerContext } from './context.js';
import type { AnalysisScheduler } from '../services/scheduler.js';
import { EventBus } from './events.js';
import { registerActivityRoutes, createAgentActivityFeed } from './routes/activity.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerAnalysisRoutes } from './routes/analysis.js';
import { registerContextRoutes } from './routes/context.js';
import { registerDocsRoutes } from './routes/docs.js';
import { registerEventRoutes } from './routes/events.js';
import { registerGraphRoutes } from './routes/graph.js';
import { registerReviewRoutes } from './routes/review.js';
import { registerRulesRoutes } from './routes/rules.js';
import { registerSecurityRoutes } from './routes/security.js';
import { registerSessionRoutes } from './routes/session.js';
import { registerStaticRoutes } from './routes/static.js';
import { registerSyncRoutes } from './routes/sync.js';
import { allowedHostsFor, allowedOriginsFor, DEFAULT_RATE_LIMIT, makeGuard, makeRateLimiter, SECURITY_HEADERS, type RateLimitOptions } from './security.js';
import { SseHub, type SseOptions } from './sse.js';
import { buildAssetMap } from './static.js';
import { watchKnowledgeDir, watchProjectFiles } from './watchers.js';

export { clampContextChars, MAX_CONTEXT_CHARS } from './routes/context.js';

export interface ServerOptions {
  root: string;
  token: string;
  host: string;
  port: number;
  webDir: string;
  /** Explicit opt-in to non-loopback binding. The Host allowlist still applies (bind host + loopback). */
  allowRemote?: boolean;
  /** Per-client rate limit for /api/* (token bucket). */
  rateLimit?: RateLimitOptions;
  logger?: boolean;
  /** Watch the project and propose knowledge updates as files change. */
  watch?: boolean;
  /** Watcher debounce (ms); mainly for tests. */
  watchDebounceMs?: number;
  /** Event stream tuning (coalescing window, client cap, queue bounds); mainly for tests. */
  sse?: Partial<SseOptions>;
}

export interface AthenaServer {
  app: FastifyInstance;
  events: EventBus;
  instanceId: string;
  /** The project's planning queue (diagnostics, tests). */
  scheduler: AnalysisScheduler;
  close(): Promise<void>;
}

const STATUS: Record<ErrorKind, number> = {
  invalid: 400,
  'not-found': 404,
  conflict: 409,
  'not-initialized': 409,
  busy: 423,
  unprocessable: 422,
  forbidden: 403,
  internal: 500,
};

/**
 * The local web server behind `athena open`. This file wires cross-cutting
 * concerns (rate limit, auth/Host/Origin guard, security headers, errors) and
 * lifecycle; the endpoints live in ./routes/*, sharing one ServerContext.
 */
export async function createServer(opts: ServerOptions): Promise<AthenaServer> {
  const root = opts.root;
  const events = new EventBus();
  const instanceId = crypto.randomUUID();
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: false,
    // Hijacked SSE responses would otherwise keep close() waiting forever.
    forceCloseConnections: true,
    // Strict validation: no type coercion, reject (don't silently strip) unknown fields.
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, allErrors: false } },
  });
  const assets = await buildAssetMap(opts.webDir);

  // ---- cross-cutting hooks (registered before any route) ----------------------------------
  const takeToken = makeRateLimiter(opts.rateLimit ?? DEFAULT_RATE_LIMIT);
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    if (!takeToken(req.ip || 'unknown')) {
      reply.header('Retry-After', '1');
      await reply.code(429).send({ error: 'Too many requests' });
    }
  });
  app.addHook('onRequest', makeGuard({
    token: opts.token,
    allowedHosts: allowedHostsFor(opts.host, opts.port, { remote: opts.allowRemote }),
    allowedOrigins: allowedOriginsFor(opts.host, opts.port, { remote: opts.allowRemote }),
  }));
  app.addHook('onSend', async (req, reply, payload) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AthenaError) {
      return reply.code(STATUS[err.kind]).send({ error: err.message, hint: err.hint, kind: err.kind, details: err.details });
    }
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'Internal error' });
  });

  // ---- routes ------------------------------------------------------------------------------
  const ctx = createServerContext({ app, root, events, instanceId });
  const feed = createAgentActivityFeed(ctx);
  const hub = new SseHub(events, opts.sse);

  registerSessionRoutes(ctx);
  registerDocsRoutes(ctx);
  registerRulesRoutes(ctx);
  registerAgentRoutes(ctx);
  registerAnalysisRoutes(ctx);
  registerSyncRoutes(ctx);
  registerSecurityRoutes(ctx);
  registerReviewRoutes(ctx);
  registerContextRoutes(ctx);
  registerGraphRoutes(ctx);
  registerActivityRoutes(ctx);
  registerEventRoutes(app, hub);
  registerStaticRoutes(app, assets);

  // ---- watchers ----------------------------------------------------------------------------
  const stopDocsWatcher = watchKnowledgeDir(ctx, feed);
  await feed.seed();
  if (opts.watch) await watchProjectFiles(ctx, opts.watchDebounceMs);

  return {
    app,
    events,
    instanceId,
    scheduler: ctx.scheduler,
    async close() {
      await ctx.state.watcher?.close();
      ctx.state.watcher = null;
      ctx.scheduler.close();
      stopDocsWatcher();
      events.close();
      await app.close();
      hub.close();
      releaseProjectSession(root);
    },
  };
}
