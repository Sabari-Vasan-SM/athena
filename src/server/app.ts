import { promises as fs, watch, type FSWatcher } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { KNOWLEDGE_DOCS, RELEVANCE_MAP } from '../core/knowledge/documents.js';
import { athenaDir } from '../core/state/state.js';
import { AthenaError, type ErrorKind } from '../services/errors.js';
import { contentHash, docAtRevision, docHistory, listDocs, readDoc, saveDoc, searchDocs } from '../services/knowledge.js';
import { getRules, rulesAdd, rulesRemove, rulesUpdate } from '../services/rules.js';
import { buildStatus, type StatusReport } from '../services/status.js';
import { runDoctor } from '../services/doctor.js';
import { configureAgents, listAgents, removeAgents } from '../services/agents.js';
import { getOverview } from '../services/overview.js';
import { runPipeline } from '../services/pipeline.js';
import { applySync, ignorePlan, planSync, type SyncPlan } from '../services/sync.js';
import { loadScan, runSecurityScan, saveScan, type SecurityScan } from '../services/security.js';
import { reviewChanges } from '../services/review.js';
import { getRelevantContext, graphSummary, refreshGraph } from '../services/context.js';
import { aiStatus } from '../services/ai.js';
import { ProjectModel } from '../core/model/project-model.js';
import { watchProject, type ProjectWatcher } from '../services/watch.js';
import { ACTIVITY_FILE, activityFile, parseEventLines, readRecentEvents, summarizeSessions } from '../services/agent-activity.js';
import type { AgentEvent } from '../agents/common/hook-events.js';
import { ATHENA_VERSION } from '../services/version.js';
import { EventBus } from './events.js';
import { allowedHostsFor, allowedOriginsFor, makeGuard, SECURITY_HEADERS } from './security.js';
import { buildAssetMap, MISSING_UI_HTML } from './static.js';

export interface ServerOptions {
  root: string;
  token: string;
  host: string;
  port: number;
  webDir: string;
  /** Explicit opt-in to non-loopback binding; disables the Host allowlist. */
  allowRemote?: boolean;
  logger?: boolean;
  /** Watch the project and propose knowledge updates as files change. */
  watch?: boolean;
  /** Watcher debounce (ms); mainly for tests. */
  watchDebounceMs?: number;
}

export interface AthenaServer {
  app: FastifyInstance;
  events: EventBus;
  instanceId: string;
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

export async function createServer(opts: ServerOptions): Promise<AthenaServer> {
  const root = opts.root;
  const events = new EventBus();
  const instanceId = crypto.randomUUID();
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: false,
    // Strict validation: no type coercion, reject (don't silently strip) unknown fields.
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, allErrors: false } },
  });
  const assets = await buildAssetMap(opts.webDir);
  const recentWrites = new Map<string, string>(); // file → hash written by this server
  let analysisRunning = false;
  let currentPlan: SyncPlan | null = null;
  let lastCheckedAt: string | null = null;
  let watcher: ProjectWatcher | null = null;
  let syncBusy = false;
  let activityOffset = 0;
  /** Agent activity is only shown while it is fresh; after this it reverts to idle. */
  const AGENT_IDLE_MS = 5 * 60 * 1000;
  let statusCache: { at: number; report: StatusReport } | null = null;

  app.addHook('onRequest', makeGuard({
    token: opts.token,
    allowedHosts: opts.allowRemote ? new Set() : allowedHostsFor(opts.host, opts.port),
    allowedOrigins: opts.allowRemote ? new Set() : allowedOriginsFor(opts.host, opts.port),
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

  const invalidateStatus = () => (statusCache = null);
  const getStatus = async (): Promise<StatusReport> => {
    if (statusCache && Date.now() - statusCache.at < 3000) return statusCache.report;
    const report = await buildStatus(root);
    statusCache = { at: Date.now(), report };
    return report;
  };

  // ---- health & session -------------------------------------------------
  app.get('/api/health', async () => ({ ok: true, instanceId, version: ATHENA_VERSION }));
  app.get('/api/session', async () => ({ ok: true, instanceId, version: ATHENA_VERSION, root, docs: KNOWLEDGE_DOCS, relevanceMap: RELEVANCE_MAP }));

  // ---- overview / status / doctor ------------------------------------------
  app.get('/api/overview', async () => getOverview(root));
  app.get('/api/status', async () => getStatus());
  app.get('/api/doctor', async () => runDoctor(root));

  // ---- knowledge documents --------------------------------------------------
  app.get('/api/docs', async () => {
    const [docs, status] = await Promise.all([listDocs(root), getStatus().catch(() => null)]);
    const affected = new Map(status?.affectedDocuments.map((a) => [a.file, a.reasons]) ?? []);
    return docs.map((d) => ({ ...d, sync: syncState(d.id, d.present, affected.get(d.file)), affectedBy: affected.get(d.file) ?? [] }));
  });

  const withSync = async <T extends { id: string; file: string }>(doc: T) => {
    const status = await getStatus().catch(() => null);
    const reasons = status?.affectedDocuments.find((a) => a.file === doc.file)?.reasons;
    return { ...doc, sync: syncState(doc.id, true, reasons), affectedBy: reasons ?? [] };
  };

  app.get<{ Params: { id: string } }>('/api/docs/:id', async (req) => withSync(await readDoc(root, req.params.id)));

  app.put<{ Params: { id: string }; Body: { content: string; baseHash: string | null } }>(
    '/api/docs/:id',
    { schema: { body: { type: 'object', required: ['content', 'baseHash'], additionalProperties: false, properties: { content: { type: 'string' }, baseHash: { type: ['string', 'null'] } } } } },
    async (req) => {
      const doc = await saveDoc(root, req.params.id, req.body.content, req.body.baseHash);
      recentWrites.set(doc.file, doc.hash!);
      invalidateStatus();
      events.emit({ source: 'web-ui', type: 'knowledge.saved', level: 'success', message: `Saved ${doc.file}`, data: { file: doc.file } });
      replanSoon();
      return withSync(doc);
    },
  );

  app.get<{ Params: { id: string } }>('/api/docs/:id/history', async (req) => docHistory(root, req.params.id));
  app.get<{ Params: { id: string; sha: string } }>('/api/docs/:id/history/:sha', async (req) => ({ content: await docAtRevision(root, req.params.id, req.params.sha) }));

  app.get<{ Querystring: { q?: string } }>('/api/search', async (req) => searchDocs(root, String(req.query.q ?? '').slice(0, 200)));

  // ---- rules -------------------------------------------------------------------
  const ruleAfter = (message: string) => {
    events.emit({ source: 'web-ui', type: 'rules.changed', level: 'success', message });
  };
  app.get('/api/rules', async () => getRules(root));
  app.post<{ Body: { section: string; text: string; baseHash?: string } }>(
    '/api/rules',
    { schema: { body: { type: 'object', required: ['section', 'text'], additionalProperties: false, properties: { section: { type: 'string', maxLength: 200 }, text: { type: 'string', maxLength: 1000 }, baseHash: { type: 'string' } } } } },
    async (req) => {
      const v = await rulesAdd(root, req.body.baseHash, req.body.section, req.body.text);
      recentWrites.set('rules.md', v.hash);
      ruleAfter(`Added rule to "${req.body.section}"`);
      return v;
    },
  );
  app.patch<{ Params: { index: string }; Body: { text?: string; enabled?: boolean; baseHash: string } }>(
    '/api/rules/:index',
    { schema: { body: { type: 'object', required: ['baseHash'], additionalProperties: false, properties: { text: { type: 'string', maxLength: 1000 }, enabled: { type: 'boolean' }, baseHash: { type: 'string' } } } } },
    async (req) => {
      const index = parseIndex(req.params.index);
      const v = await rulesUpdate(root, req.body.baseHash, index, { text: req.body.text, enabled: req.body.enabled });
      recentWrites.set('rules.md', v.hash);
      ruleAfter(req.body.enabled === undefined ? `Edited rule #${index}` : `${req.body.enabled ? 'Enabled' : 'Disabled'} rule #${index}`);
      return v;
    },
  );
  app.delete<{ Params: { index: string }; Querystring: { baseHash?: string } }>('/api/rules/:index', async (req) => {
    const index = parseIndex(req.params.index);
    if (!req.query.baseHash) throw new AthenaError('baseHash is required');
    const v = await rulesRemove(root, req.query.baseHash, index);
    recentWrites.set('rules.md', v.hash);
    ruleAfter(`Deleted rule #${index}`);
    return v;
  });

  // ---- agents ----------------------------------------------------------------------
  app.get('/api/agents', async () => listAgents(root));
  app.post<{ Body: { agents: string[] } }>(
    '/api/agents/configure',
    { schema: { body: { type: 'object', required: ['agents'], additionalProperties: false, properties: { agents: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 40 } } } } } },
    async (req) => {
      const r = await configureAgents(root, req.body.agents);
      events.emit({ source: 'web-ui', type: 'agents.configured', level: 'success', message: `Configured ${r.map((x) => x.id).join(', ')}`, data: { files: r.flatMap((x) => x.files.map((f) => f.path)) } });
      return listAgents(root);
    },
  );
  app.post<{ Body: { agents: string[] } }>(
    '/api/agents/remove',
    { schema: { body: { type: 'object', required: ['agents'], additionalProperties: false, properties: { agents: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 40 } } } } } },
    async (req) => {
      const removed = await removeAgents(root, req.body.agents);
      events.emit({ source: 'web-ui', type: 'agents.removed', level: 'info', message: `Removed ${req.body.agents.join(', ')} integration${removed.length ? ` (${removed.join(', ')})` : ''}` });
      return listAgents(root);
    },
  );

  // ---- analysis ------------------------------------------------------------------------
  app.post<{ Body: { force?: boolean } }>(
    '/api/analyze',
    { schema: { body: { type: 'object', additionalProperties: false, properties: { force: { type: 'boolean' } } } } },
    async (req, reply) => {
      if (analysisRunning) throw new AthenaError('An analysis is already running.', undefined, 1, 'busy');
      analysisRunning = true;
      const started = Date.now();
      events.setActivity({ state: 'ANALYZING', actor: 'athena', task: 'Analyzing project', reading: [] });
      events.emit({ source: 'athena', type: 'analysis.started', level: 'info', message: 'Analysis started (requested from web UI)' });
      void runPipeline({
        root,
        mode: 'analyze',
        force: req.body?.force,
        onStage: (stage) => {
          const labels: Record<string, string> = { scan: 'Scanning files', detect: 'Detecting technologies, schema and routes', git: 'Reading Git metadata', write: 'Writing knowledge', agents: 'Updating agent integrations' };
          if (labels[stage]) events.setActivity({ state: 'ANALYZING', actor: 'athena', task: labels[stage]!, reading: [] });
        },
      })
        .then((result) => {
          for (const d of result.docs) recentWrites.set(d.file, d.contentHash);
          const changed = result.docs.filter((d) => d.status !== 'unchanged').map((d) => d.file);
          const preserved = result.docs.filter((d) => d.preservedModified.length).map((d) => d.file);
          invalidateStatus();
          currentPlan = null;
          events.emit({
            source: 'athena',
            type: 'analysis.completed',
            level: 'success',
            message: `Analysis completed in ${((Date.now() - started) / 1000).toFixed(1)}s — ${changed.length ? `updated ${changed.join(', ')}` : 'knowledge already up to date'}`,
            data: { changed, preserved, filesScanned: result.analysis.model.stats.filesScanned, warnings: result.analysis.model.warnings.length },
          });
          events.setActivity({ state: 'SUCCESS', actor: 'athena', task: 'Analysis complete', reading: [] }, 4000);
        })
        .catch((err: Error) => {
          events.emit({ source: 'athena', type: 'analysis.failed', level: 'error', message: `Analysis failed: ${err.message}` });
          events.setActivity({ state: 'ERROR', actor: 'athena', task: 'Analysis failed', reading: [] }, 8000);
        })
        .finally(() => {
          analysisRunning = false;
        });
      return reply.code(202).send({ accepted: true });
    },
  );

  // ---- agent activity (from hooks) -----------------------------------------------------------
  const toAthenaEvent = (e: AgentEvent) => ({
    id: e.id,
    ts: e.ts,
    source: 'agent' as const,
    type: `agent.${e.kind}`,
    level: (e.kind === 'stop' ? 'success' : 'info') as 'success' | 'info',
    message: `${e.agent}: ${e.message}`,
    data: { agent: e.agent, session: e.session, hook: e.hook, files: e.files, command: e.command, tool: e.tool },
  });

  const applyAgentEvent = (e: AgentEvent, live: boolean) => {
    if (events.has(e.id)) return;
    if (live) events.emit(toAthenaEvent(e));
    else events.seed([{ ...toAthenaEvent(e) }]);
    if (!live) return;
    if (e.state === 'IDLE') {
      if (events.activity().actor === 'agent') events.setActivity({ state: 'IDLE', actor: 'none', task: null, reading: [] });
      return;
    }
    // Athena's own analysis takes precedence only while it is running.
    if (analysisRunning) return;
    events.setActivity({ state: e.state, actor: 'agent', task: `${e.agent}: ${e.message}`, reading: e.files.slice(0, 4) }, e.state === 'SUCCESS' ? 10_000 : AGENT_IDLE_MS);
  };

  const readNewAgentEvents = async () => {
    try {
      const file = activityFile(root);
      const st = await fs.stat(file).catch(() => null);
      if (!st) return;
      if (st.size < activityOffset) activityOffset = 0; // file rotated
      if (st.size === activityOffset) return;
      const handle = await fs.open(file, 'r');
      try {
        const length = st.size - activityOffset;
        const buf = Buffer.alloc(length);
        await handle.read(buf, 0, length, activityOffset);
        const text = buf.toString('utf8');
        const lastNewline = text.lastIndexOf('\n');
        if (lastNewline === -1) return; // partial line; wait for the rest
        activityOffset += Buffer.byteLength(text.slice(0, lastNewline + 1));
        for (const e of parseEventLines(text.slice(0, lastNewline + 1))) applyAgentEvent(e, true);
      } finally {
        await handle.close();
      }
    } catch {
      /* activity log unreadable: ignore */
    }
  };

  // ---- synchronization ----------------------------------------------------------------------
  const setPlan = (plan: SyncPlan | null) => {
    lastCheckedAt = new Date().toISOString();
    currentPlan = plan && !plan.upToDate ? plan : null;
  };
  const checkNow = async (): Promise<SyncPlan | null> => {
    if (watcher) return watcher.planNow();
    const plan = await planSync(root);
    setPlan(plan);
    return plan;
  };
  const replanSoon = () => {
    if (currentPlan) void checkNow().catch(() => {});
  };

  app.get('/api/sync', async () => ({ watching: Boolean(watcher), lastCheckedAt, plan: currentPlan }));

  app.post('/api/sync/check', async () => {
    const plan = await checkNow();
    if (!watcher) setPlan(plan);
    return { watching: Boolean(watcher), lastCheckedAt, plan: currentPlan, upToDate: plan?.upToDate ?? true };
  });

  const planIdSchema = { schema: { body: { type: 'object', required: ['planId'], additionalProperties: false, properties: { planId: { type: 'string', pattern: '^[a-f0-9]{16}$' } } } } };

  app.post<{ Body: { planId: string } }>('/api/sync/apply', planIdSchema, async (req) => {
    if (!currentPlan || currentPlan.id !== req.body.planId) throw new AthenaError('This proposal is out of date.', 'Check for changes again and review the new proposal.', 1, 'conflict');
    if (syncBusy || analysisRunning) throw new AthenaError('Another update is in progress.', undefined, 1, 'busy');
    syncBusy = true;
    const plan = currentPlan;
    try {
      const result = await applySync(root, plan);
      for (const d of plan.documents) {
        const text = await fs.readFile(path.join(athenaDir(root), d.file), 'utf8').catch(() => null);
        if (text !== null) recentWrites.set(d.file, contentHash(text));
      }
      currentPlan = null;
      lastCheckedAt = new Date().toISOString();
      invalidateStatus();
      events.emit({ source: 'web-ui', type: 'sync.applied', level: 'success', message: `Knowledge updated: ${result.applied.join(', ')}`, data: { files: result.applied, preserved: result.preserved } });
      events.setActivity({ state: 'SUCCESS', actor: 'athena', task: 'Knowledge synchronized', reading: [] }, 4000);
      return result;
    } catch (err) {
      if (err instanceof AthenaError && err.kind === 'conflict') replanSoon();
      throw err;
    } finally {
      syncBusy = false;
    }
  });

  app.post<{ Body: { planId: string } }>('/api/sync/ignore', planIdSchema, async (req) => {
    if (!currentPlan || currentPlan.id !== req.body.planId) throw new AthenaError('This proposal is out of date.', undefined, 1, 'conflict');
    await ignorePlan(root, req.body.planId);
    currentPlan = { ...currentPlan, ignored: true };
    events.emit({ source: 'web-ui', type: 'sync.ignored', level: 'info', message: `Ignored proposed update to ${currentPlan.documents.map((d) => d.file).join(', ')}` });
    return { ok: true };
  });

  // ---- security & review ---------------------------------------------------------------------
  let scanRunning = false;
  const projectModel = async (): Promise<ProjectModel> => {
    const raw = await fs.readFile(path.join(athenaDir(root), 'model.json'), 'utf8').catch(() => null);
    if (raw) {
      const parsed = ProjectModel.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    }
    throw new AthenaError('model.json is missing.', 'Run `athena analyze` (or re-analyze from the overview) first.');
  };

  app.get('/api/security', async () => ({ scan: await loadScan(root), running: scanRunning }));

  app.post<{ Body: { skipAudit?: boolean } }>(
    '/api/security/scan',
    { schema: { body: { type: 'object', additionalProperties: false, properties: { skipAudit: { type: 'boolean' } } } } },
    async (req, reply) => {
      if (scanRunning) throw new AthenaError('A security scan is already running.', undefined, 1, 'busy');
      scanRunning = true;
      const model = await projectModel();
      events.emit({ source: 'web-ui', type: 'security.started', level: 'info', message: 'Security scan started' });
      events.setActivity({ state: 'REVIEWING', actor: 'athena', task: 'Scanning dependencies', reading: [] });
      void runSecurityScan(root, model, { skipAudit: req.body?.skipAudit, onTool: (tool) => events.setActivity({ state: 'REVIEWING', actor: 'athena', task: `Running ${tool}`, reading: [] }) })
        .then(async (scan: SecurityScan) => {
          await saveScan(root, scan);
          const findings = scan.tools.reduce((n, t) => n + t.findings.length, 0);
          events.emit({
            source: 'athena',
            type: 'security.completed',
            level: findings || scan.secrets.count ? 'warn' : 'success',
            message: `Security scan finished — ${findings} dependency finding(s), ${scan.secrets.count} potential secret(s)`,
            data: { findings, secrets: scan.secrets.count },
          });
          events.setActivity({ state: 'SUCCESS', actor: 'athena', task: 'Security scan complete', reading: [] }, 4000);
          replanSoon();
        })
        .catch((err: Error) => {
          events.emit({ source: 'athena', type: 'security.failed', level: 'error', message: `Security scan failed: ${err.message}` });
          events.setActivity({ state: 'ERROR', actor: 'athena', task: 'Security scan failed', reading: [] }, 8000);
        })
        .finally(() => {
          scanRunning = false;
        });
      return reply.code(202).send({ accepted: true });
    },
  );

  app.get<{ Querystring: { base?: string } }>('/api/review', async (req) => {
    const base = typeof req.query.base === 'string' && req.query.base ? req.query.base : undefined;
    return reviewChanges(root, { base, checkSync: async (r) => (await planSync(r)).upToDate });
  });

  // ---- context engine & graph -------------------------------------------------------------
  let graphBuilding = false;

  app.get<{ Querystring: { task?: string; maxChars?: string } }>('/api/context', async (req) => {
    const task = String(req.query.task ?? '').slice(0, 500);
    const maxChars = req.query.maxChars ? Number(req.query.maxChars) : undefined;
    return getRelevantContext(root, task, { maxChars: Number.isFinite(maxChars) ? maxChars : undefined });
  });

  app.get('/api/graph', async () => ({ ...(await graphSummary(root)), building: graphBuilding }));

  app.post('/api/graph/build', async () => {
    if (graphBuilding) throw new AthenaError('The graph is already being built.', undefined, 1, 'busy');
    graphBuilding = true;
    try {
      const graph = await refreshGraph(root);
      events.emit({ source: 'web-ui', type: 'graph.built', level: 'success', message: `Project graph built: ${graph.stats.nodes} nodes, ${graph.stats.edges} relationships` });
      return { built: true, builtAt: graph.builtAt, stats: graph.stats };
    } finally {
      graphBuilding = false;
    }
  });

  app.get('/api/ai', async () => aiStatus(root));

  // ---- events (streamed) ------------------------------------------------------------------
  app.get('/api/activity', async () => {
    const agents = await listAgents(root);
    const observing = agents.filter((a) => a.activityObservation === 'hooks');
    return {
      activity: events.activity(),
      events: events.recent(),
      sessions: summarizeSessions(await readRecentEvents(root, 500)),
      agentObservation: {
        available: observing.length > 0,
        agents: observing.map((a) => a.name),
        reason: observing.length
          ? 'Events below come from hooks the agent fired. Athena sees which tool ran and on which files — never the agent\'s reasoning.'
          : 'No agent is reporting activity yet. Configure an agent with hooks (Claude Code or Cursor) to see its actions here.',
      },
    };
  });

  app.get('/api/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('activity', events.activity());
    const unsubscribe = events.subscribe((e) => {
      if (e.type === '__activity') send('activity', (e as { activity: unknown }).activity);
      else send('event', e);
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);
    heartbeat.unref();
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // ---- static UI ---------------------------------------------------------------------------
  const sendAsset = async (reply: FastifyReply, urlPath: string) => {
    if (!assets) return reply.code(503).type('text/html; charset=utf-8').send(MISSING_UI_HTML);
    const asset = assets.get(urlPath) ?? assets.get('/index.html')!;
    const body = await fs.readFile(asset.abs);
    reply.header('Cache-Control', asset.immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    return reply.type(asset.type).send(body);
  };
  app.route({
    method: 'GET',
    url: '/*',
    handler: async (req, reply) => {
      let urlPath: string;
      try {
        urlPath = decodeURIComponent(req.url.split('?')[0]!);
      } catch {
        return reply.code(400).send('Bad request');
      }
      if (urlPath.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
      // Unknown extensions are SPA routes only when they look like app paths (no dot).
      if (assets && !assets.has(urlPath) && /\.[a-z0-9]+$/i.test(urlPath)) return reply.code(404).send('Not found');
      return sendAsset(reply, urlPath === '/' ? '/index.html' : urlPath);
    },
  });

  // ---- knowledge directory watcher -------------------------------------------------------------
  let docsWatcher: FSWatcher | null = null;
  const pending = new Map<string, NodeJS.Timeout>();
  try {
    const dir = athenaDir(root);
    docsWatcher = watch(dir, { persistent: false }, (_type, filename) => {
      const name = filename?.toString();
      if (name === ACTIVITY_FILE) {
        void readNewAgentEvents();
        return;
      }
      if (!name || !KNOWLEDGE_DOCS.some((d) => d.file === name)) return;
      clearTimeout(pending.get(name));
      pending.set(
        name,
        setTimeout(async () => {
          pending.delete(name);
          const text = await fs.readFile(path.join(dir, name), 'utf8').catch(() => null);
          const hash = text === null ? null : contentHash(text);
          if (hash && recentWrites.get(name) === hash) return; // our own write
          invalidateStatus();
          events.emit({ source: 'filesystem', type: 'knowledge.external-change', level: 'info', message: text === null ? `${name} was deleted on disk` : `${name} changed on disk`, data: { file: name, hash } });
        }, 150),
      );
    });
    docsWatcher.on('error', () => {});
  } catch {
    docsWatcher = null;
  }

  // Seed the timeline with agent events recorded while the UI was closed.
  {
    const history = await readRecentEvents(root, 200);
    for (const e of history) applyAgentEvent(e, false);
    activityOffset = await fs.stat(activityFile(root)).then((st) => st.size).catch(() => 0);
  }

  if (opts.watch) {
    try {
      watcher = await watchProject(root, {
        debounceMs: opts.watchDebounceMs,
        onEvent: (e) => {
          switch (e.type) {
            case 'planning':
              if (!analysisRunning) events.setActivity({ state: 'ANALYZING', actor: 'athena', task: e.paths?.length ? `Checking ${e.paths.length} changed file${e.paths.length === 1 ? '' : 's'}` : 'Checking for changes', reading: [] });
              break;
            case 'plan': {
              const plan = e.plan!;
              const prevId = currentPlan?.id;
              setPlan(plan);
              if (!analysisRunning) events.setActivity({ state: 'IDLE', actor: 'none', task: null, reading: [] });
              if (!plan.upToDate && !plan.ignored && plan.id !== prevId) {
                events.emit({ source: 'athena', type: 'sync.proposed', level: 'warn', message: `Knowledge update proposed for ${plan.documents.map((d) => d.file).join(', ')}`, data: { planId: plan.id, files: plan.documents.map((d) => d.file) } });
              }
              if (plan.upToDate && prevId) events.emit({ source: 'athena', type: 'sync.up-to-date', level: 'info', message: 'Proposal no longer needed — knowledge is up to date' });
              break;
            }
            case 'refreshed':
              setPlan(null);
              invalidateStatus();
              if (!analysisRunning) events.setActivity({ state: 'IDLE', actor: 'none', task: null, reading: [] });
              events.emit({ source: 'athena', type: 'sync.up-to-date', level: 'info', message: 'Files changed — knowledge already up to date (index refreshed)' });
              break;
            case 'git-head':
              events.emit({ source: 'filesystem', type: 'git.head', level: 'info', message: `Git HEAD moved ${e.head?.from?.slice(0, 8) ?? '?'} → ${e.head?.to?.slice(0, 8) ?? '?'}` });
              break;
            case 'error':
              if (!analysisRunning) events.setActivity({ state: 'ERROR', actor: 'athena', task: 'Change check failed', reading: [] }, 6000);
              events.emit({ source: 'athena', type: 'sync.error', level: 'error', message: `Change check failed: ${e.error?.message ?? 'unknown error'}` });
              break;
            default:
              break;
          }
        },
      });
      void watcher.planNow();
    } catch (err) {
      events.emit({ source: 'athena', type: 'sync.error', level: 'error', message: `File watching unavailable: ${(err as Error).message}` });
    }
  }

  return {
    app,
    events,
    instanceId,
    async close() {
      await watcher?.close();
      watcher = null;
      docsWatcher?.close();
      for (const t of pending.values()) clearTimeout(t);
      events.close();
      await app.close();
    },
  };
}

function parseIndex(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new AthenaError(`Invalid rule index: ${raw.slice(0, 20)}`);
  return n;
}

function syncState(id: string, present: boolean, affectedReasons: string[] | undefined): 'missing' | 'developer-owned' | 'synchronized' | 'may-be-outdated' {
  if (!present) return 'missing';
  if (id === 'rules') return 'developer-owned';
  return affectedReasons?.length ? 'may-be-outdated' : 'synchronized';
}
