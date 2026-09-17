import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type AthenaServer } from '../../src/server/app.js';
import { findAvailablePort } from '../../src/server/port.js';
import { findRunningInstance, startServer } from '../../src/server/instance.js';
import { runPipeline } from '../../src/services/pipeline.js';
import { cleanupProjects, FAKE, gitInit, makeProject } from '../helpers.js';

const TOKEN = 'test-token-0123456789abcdefghijklmnop';
const PORT = 7999;
const HOST = `127.0.0.1:${PORT}`;
const auth = { authorization: `Bearer ${TOKEN}`, host: HOST };

let root: string;
let webDir: string;
let server: AthenaServer;

async function project(): Promise<string> {
  const dir = await makeProject({
    'package.json': JSON.stringify({ name: 'shop', dependencies: { express: '5' } }),
    'src/server.ts': "import express from 'express';\nconst app = express();\napp.get('/orders', h);\n",
  });
  await runPipeline({ root: dir, mode: 'init', agents: [] });
  return dir;
}

beforeAll(async () => {
  root = await project();
  webDir = await makeProject({ 'index.html': '<!doctype html><title>Athena</title>', 'assets/app-abc.js': 'console.log(1)' });
  server = await createServer({ root, token: TOKEN, host: '127.0.0.1', port: PORT, webDir });
});
afterAll(async () => {
  await server.close();
  await cleanupProjects();
});

describe('server security', () => {
  it('rejects requests without or with a wrong token', async () => {
    expect((await server.app.inject({ url: '/api/overview', headers: { host: HOST } })).statusCode).toBe(401);
    expect((await server.app.inject({ url: '/api/overview', headers: { host: HOST, authorization: 'Bearer nope' } })).statusCode).toBe(401);
    expect((await server.app.inject({ url: '/api/overview', headers: auth })).statusCode).toBe(200);
  });

  it('allows unauthenticated health checks only', async () => {
    const r = await server.app.inject({ url: '/api/health', headers: { host: HOST } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, instanceId: server.instanceId });
    expect(JSON.stringify(r.json())).not.toContain(root);
  });

  it('rejects foreign Host headers (DNS rebinding)', async () => {
    const r = await server.app.inject({ url: '/api/overview', headers: { ...auth, host: 'evil.example:7999' } });
    expect(r.statusCode).toBe(421);
    expect((await server.app.inject({ url: '/', headers: { host: 'attacker.test' } })).statusCode).toBe(421);
    expect((await server.app.inject({ url: '/api/health', headers: { host: `localhost:${PORT}` } })).statusCode).toBe(200);
  });

  it('rejects cross-origin and non-JSON state changes', async () => {
    const cross = await server.app.inject({ method: 'POST', url: '/api/rules', headers: { ...auth, origin: 'https://evil.example', 'content-type': 'application/json' }, payload: { section: 'X', text: 'y' } });
    expect(cross.statusCode).toBe(403);
    const form = await server.app.inject({ method: 'POST', url: '/api/rules', headers: { ...auth, 'content-type': 'text/plain' }, payload: 'section=X' });
    expect(form.statusCode).toBe(415);
  });

  it('sets security headers', async () => {
    const r = await server.app.inject({ url: '/api/overview', headers: auth });
    expect(r.headers['content-security-policy']).toContain("script-src 'self'");
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
  });

  it('only serves allowlisted documents (no path traversal)', async () => {
    for (const bad of ['..%2F..%2Fetc%2Fpasswd', '..%2Fpackage.json', 'state', 'model', '%2e%2e', 'project.md']) {
      const r = await server.app.inject({ url: `/api/docs/${bad}`, headers: auth });
      expect([400, 404]).toContain(r.statusCode);
      expect(r.body).not.toContain('root:');
    }
    for (const bad of ['/..%2F..%2Fpackage.json', '/assets/../../package.json', '/%2e%2e/%2e%2e/etc/passwd', '/index.html/../../x.json']) {
      const r = await server.app.inject({ url: bad, headers: { host: HOST } });
      expect(r.body).not.toContain('"name"');
    }
  });

  it('serves UI assets and falls back to index.html for app routes', async () => {
    const js = await server.app.inject({ url: '/assets/app-abc.js', headers: { host: HOST } });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toContain('javascript');
    expect(js.headers['cache-control']).toContain('immutable');
    const spa = await server.app.inject({ url: '/docs/api', headers: { host: HOST } });
    expect(spa.body).toContain('<title>Athena</title>');
    expect((await server.app.inject({ url: '/missing.js', headers: { host: HOST } })).statusCode).toBe(404);
  });
});

describe('knowledge API', () => {
  it('lists documents with sync state', async () => {
    const docs = (await server.app.inject({ url: '/api/docs', headers: auth })).json() as Array<{ id: string; sync: string; present: boolean }>;
    expect(docs).toHaveLength(12);
    expect(docs.find((d) => d.id === 'rules')!.sync).toBe('developer-owned');
    expect(docs.find((d) => d.id === 'api')!.sync).toBe('synchronized');
  });

  it('reads a document split into generated and developer segments', async () => {
    const d = (await server.app.inject({ url: '/api/docs/api', headers: auth })).json();
    expect(d.content).toContain('/orders');
    expect(d.segments.some((s: { kind: string; id?: string }) => s.kind === 'generated' && s.id === 'endpoints')).toBe(true);
    expect(d.segments.at(-1).kind).toBe('developer');
    expect(d.hash).toMatch(/^[a-f0-9]{16}$/);
  });

  it('saves with optimistic concurrency and writes the real file', async () => {
    const d = (await server.app.inject({ url: '/api/docs/debugging', headers: auth })).json();
    const content = `${d.content}\nThe payment webhook retries 3 times.\n`;
    const saved = await server.app.inject({ method: 'PUT', url: '/api/docs/debugging', headers: { ...auth, 'content-type': 'application/json' }, payload: { content, baseHash: d.hash } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ sync: expect.any(String), affectedBy: expect.any(Array), segments: expect.any(Array) });
    expect(await fs.readFile(path.join(root, '.athena/debugging.md'), 'utf8')).toContain('webhook retries 3 times');
    const stale = await server.app.inject({ method: 'PUT', url: '/api/docs/debugging', headers: { ...auth, 'content-type': 'application/json' }, payload: { content: 'overwrite', baseHash: d.hash } });
    expect(stale.statusCode).toBe(409);
    expect(await fs.readFile(path.join(root, '.athena/debugging.md'), 'utf8')).not.toBe('overwrite\n');
    const events = server.events.recent().map((e) => e.type);
    expect(events).toContain('knowledge.saved');
  });

  it('refuses to save secrets into knowledge files', async () => {
    const d = (await server.app.inject({ url: '/api/docs/deployment', headers: auth })).json();
    const r = await server.app.inject({ method: 'PUT', url: '/api/docs/deployment', headers: { ...auth, 'content-type': 'application/json' }, payload: { content: `${d.content}\nSTRIPE_KEY=${FAKE.stripe}\n`, baseHash: d.hash } });
    expect(r.statusCode).toBe(422);
    expect(r.body).not.toContain(FAKE.stripe);
    expect(r.json().details.secrets[0].type).toBe('stripe-key');
    expect(await fs.readFile(path.join(root, '.athena/deployment.md'), 'utf8')).not.toContain(FAKE.stripe);
  });

  it('validates request bodies', async () => {
    const r = await server.app.inject({ method: 'PUT', url: '/api/docs/api', headers: { ...auth, 'content-type': 'application/json' }, payload: { content: 1, baseHash: null, extra: true } });
    expect(r.statusCode).toBe(400);
  });

  it('searches documents', async () => {
    const hits = (await server.app.inject({ url: '/api/search?q=orders', headers: auth })).json() as Array<{ id: string; line: number }>;
    expect(hits.some((h) => h.id === 'api')).toBe(true);
    expect((await server.app.inject({ url: '/api/search?q=o', headers: auth })).json()).toEqual([]);
  });
});

describe('rules API', () => {
  it('adds, toggles, edits and deletes rules in rules.md', async () => {
    let v = (await server.app.inject({ url: '/api/rules', headers: auth })).json();
    const before = v.rules.length;
    v = (await server.app.inject({ method: 'POST', url: '/api/rules', headers: { ...auth, 'content-type': 'application/json' }, payload: { section: 'Database', text: 'Every table has tenant_id.', baseHash: v.hash } })).json();
    const rule = v.rules.find((r: { text: string }) => r.text === 'Every table has tenant_id.');
    expect(v.rules.length).toBe(before + 1);
    v = (await server.app.inject({ method: 'PATCH', url: `/api/rules/${rule.index}`, headers: { ...auth, 'content-type': 'application/json' }, payload: { enabled: false, baseHash: v.hash } })).json();
    expect(await fs.readFile(path.join(root, '.athena/rules.md'), 'utf8')).toContain('- [disabled] Every table has tenant_id.');
    v = (await server.app.inject({ method: 'PATCH', url: `/api/rules/${rule.index}`, headers: { ...auth, 'content-type': 'application/json' }, payload: { text: 'Every tenant table has tenant_id.', baseHash: v.hash } })).json();
    const stale = await server.app.inject({ method: 'DELETE', url: `/api/rules/${rule.index}?baseHash=0000000000000000`, headers: auth });
    expect(stale.statusCode).toBe(409);
    v = (await server.app.inject({ method: 'DELETE', url: `/api/rules/${rule.index}?baseHash=${v.hash}`, headers: auth })).json();
    expect(v.rules.length).toBe(before);
    expect(await fs.readFile(path.join(root, '.athena/rules.md'), 'utf8')).not.toContain('tenant_id');
  });

  it('rejects invalid indexes', async () => {
    const v = (await server.app.inject({ url: '/api/rules', headers: auth })).json();
    expect((await server.app.inject({ method: 'PATCH', url: '/api/rules/abc', headers: { ...auth, 'content-type': 'application/json' }, payload: { enabled: true, baseHash: v.hash } })).statusCode).toBe(400);
    expect((await server.app.inject({ method: 'PATCH', url: '/api/rules/999', headers: { ...auth, 'content-type': 'application/json' }, payload: { enabled: true, baseHash: v.hash } })).statusCode).toBe(400);
  });
});

describe('analysis, agents, activity', () => {
  it('runs analysis in the background and reports real events', async () => {
    const r = await server.app.inject({ method: 'POST', url: '/api/analyze', headers: { ...auth, 'content-type': 'application/json' }, payload: {} });
    expect(r.statusCode).toBe(202);
    expect(server.events.activity().state).toBe('ANALYZING');
    const busy = await server.app.inject({ method: 'POST', url: '/api/analyze', headers: { ...auth, 'content-type': 'application/json' }, payload: {} });
    expect(busy.statusCode).toBe(423);
    for (let i = 0; i < 100 && !server.events.recent().some((e) => e.type === 'analysis.completed'); i++) await new Promise((res) => setTimeout(res, 50));
    expect(server.events.recent().map((e) => e.type)).toContain('analysis.completed');
    expect(server.events.activity().state).toBe('SUCCESS');
  });

  it('reports that agent activity observation is not available', async () => {
    const a = (await server.app.inject({ url: '/api/activity', headers: auth })).json();
    expect(a.agentObservation.available).toBe(false);
    expect(a.events.every((e: { source: string }) => e.source !== 'agent')).toBe(true);
  });

  it('configures and removes agent integrations', async () => {
    const list = (await server.app.inject({ method: 'POST', url: '/api/agents/configure', headers: { ...auth, 'content-type': 'application/json' }, payload: { agents: ['cursor'] } })).json();
    expect(list.find((a: { id: string }) => a.id === 'cursor').configured).toBe(true);
    await fs.access(path.join(root, '.cursor/rules/athena.mdc'));
    const bad = await server.app.inject({ method: 'POST', url: '/api/agents/configure', headers: { ...auth, 'content-type': 'application/json' }, payload: { agents: ['../../etc'] } });
    expect(bad.statusCode).toBe(400);
    await server.app.inject({ method: 'POST', url: '/api/agents/remove', headers: { ...auth, 'content-type': 'application/json' }, payload: { agents: ['cursor'] } });
    await expect(fs.access(path.join(root, '.cursor/rules/athena.mdc'))).rejects.toThrow();
  });

  it('emits an event when a knowledge file changes on disk outside the UI', async () => {
    const file = path.join(root, '.athena/performance.md');
    await fs.appendFile(file, '\nMeasured p95 at 180ms.\n');
    for (let i = 0; i < 60 && !server.events.recent().some((e) => e.type === 'knowledge.external-change'); i++) await new Promise((res) => setTimeout(res, 50));
    const e = server.events.recent().find((x) => x.type === 'knowledge.external-change');
    expect(e?.data?.file).toBe('performance.md');
    expect(e?.source).toBe('filesystem');
  });

  it('streams events over SSE with authentication', async () => {
    const running = await startServer({ root: await project(), webDir });
    try {
      const base = `http://127.0.0.1:${running.info.port}`;
      expect((await fetch(`${base}/api/events`)).status).toBe(401);
      const ac = new AbortController();
      const res = await fetch(`${base}/api/events`, { headers: { authorization: `Bearer ${running.info.token}` }, signal: ac.signal });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first).toContain('event: activity');
      ac.abort();
    } finally {
      await running.close();
    }
  });
});

describe('history', () => {
  it('reads document history from git', async () => {
    const dir = await project();
    await gitInit(dir);
    const s = await createServer({ root: dir, token: TOKEN, host: '127.0.0.1', port: PORT, webDir });
    try {
      const h = (await s.app.inject({ url: '/api/docs/project/history', headers: auth })).json();
      expect(h.available).toBe(true);
      expect(h.entries).toHaveLength(1);
      const rev = await s.app.inject({ url: `/api/docs/project/history/${h.entries[0].sha}`, headers: auth });
      expect(rev.json().content).toContain('# Project');
      expect((await s.app.inject({ url: '/api/docs/project/history/HEAD;rm', headers: auth })).statusCode).toBe(400);
    } finally {
      await s.close();
    }
  });
});

describe('ports and instances', () => {
  let blocker: net.Server | null = null;
  afterEach(() => new Promise<void>((r) => (blocker ? blocker.close(() => r()) : r())));

  it('skips occupied ports', async () => {
    const start = await findAvailablePort('127.0.0.1', 18_400);
    blocker = net.createServer().listen(start, '127.0.0.1');
    await new Promise((r) => blocker!.once('listening', r));
    expect(await findAvailablePort('127.0.0.1', start)).toBeGreaterThan(start);
  });

  it('writes a private instance file and discovers the running server', async () => {
    const dir = await project();
    const running = await startServer({ root: dir, webDir });
    try {
      const file = path.join(dir, '.athena/.server.json');
      if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o077).toBe(0);
      expect(await fs.readFile(path.join(dir, '.athena/.gitignore'), 'utf8')).toContain('.server.json');
      const found = await findRunningInstance(dir);
      expect(found?.instanceId).toBe(running.info.instanceId);
      expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#token=/);
    } finally {
      await running.close();
    }
    await expect(fs.access(path.join(dir, '.athena/.server.json'))).rejects.toThrow();
  });

  it('refuses non-loopback binding without explicit opt-in', async () => {
    await expect(startServer({ root, host: '0.0.0.0', webDir })).rejects.toThrow(/allow-remote/);
  });
});

describe('sync API', () => {
  const json = { ...auth, 'content-type': 'application/json' };

  it('checks, proposes, rejects stale ids, and applies', async () => {
    const dir = await project();
    const s = await createServer({ root: dir, token: TOKEN, host: '127.0.0.1', port: PORT, webDir });
    try {
      let r = (await s.app.inject({ url: '/api/sync', headers: auth })).json();
      expect(r).toMatchObject({ watching: false, plan: null });

      await fs.appendFile(path.join(dir, 'src/server.ts'), "app.post('/refunds', h);\n");
      r = (await s.app.inject({ method: 'POST', url: '/api/sync/check', headers: json, payload: {} })).json();
      expect(r.upToDate).toBe(false);
      const plan = r.plan;
      expect(plan.documents.map((d: { file: string }) => d.file)).toContain('api.md');
      expect(plan.documents[0].diff).toContain('@@');

      expect((await s.app.inject({ method: 'POST', url: '/api/sync/apply', headers: json, payload: { planId: '0000000000000000' } })).statusCode).toBe(409);
      expect((await s.app.inject({ method: 'POST', url: '/api/sync/apply', headers: json, payload: { planId: '../../x' } })).statusCode).toBe(400);

      const applied = await s.app.inject({ method: 'POST', url: '/api/sync/apply', headers: json, payload: { planId: plan.id } });
      expect(applied.statusCode).toBe(200);
      expect(await fs.readFile(path.join(dir, '.athena/api.md'), 'utf8')).toContain('/refunds');
      expect((await s.app.inject({ url: '/api/sync', headers: auth })).json().plan).toBeNull();
      expect(s.events.recent().map((e) => e.type)).toContain('sync.applied');
    } finally {
      await s.close();
    }
  });

  it('ignores a proposal', async () => {
    const dir = await project();
    const s = await createServer({ root: dir, token: TOKEN, host: '127.0.0.1', port: PORT, webDir });
    try {
      await fs.appendFile(path.join(dir, 'src/server.ts'), "app.get('/ignored', h);\n");
      const { plan } = (await s.app.inject({ method: 'POST', url: '/api/sync/check', headers: json, payload: {} })).json();
      expect((await s.app.inject({ method: 'POST', url: '/api/sync/ignore', headers: json, payload: { planId: plan.id } })).statusCode).toBe(200);
      expect((await s.app.inject({ url: '/api/sync', headers: auth })).json().plan.ignored).toBe(true);
    } finally {
      await s.close();
    }
  });

  it('watches the project and emits a proposal event when files change', async () => {
    const dir = await project();
    const s = await createServer({ root: dir, token: TOKEN, host: '127.0.0.1', port: PORT, webDir, watch: true, watchDebounceMs: 200 });
    try {
      expect((await s.app.inject({ url: '/api/sync', headers: auth })).json().watching).toBe(true);
      // The startup check must complete and clear the "analyzing" state even when nothing changed.
      for (let i = 0; i < 100 && !(await s.app.inject({ url: '/api/sync', headers: auth })).json().lastCheckedAt; i++) await new Promise((res) => setTimeout(res, 50));
      expect((await s.app.inject({ url: '/api/sync', headers: auth })).json().lastCheckedAt).not.toBeNull();
      expect(s.events.activity().state).toBe('IDLE');
      await new Promise((res) => setTimeout(res, 500));
      await fs.appendFile(path.join(dir, 'src/server.ts'), "app.get('/live', h);\n");
      for (let i = 0; i < 200 && !s.events.recent().some((e) => e.type === 'sync.proposed'); i++) await new Promise((res) => setTimeout(res, 50));
      const e = s.events.recent().find((x) => x.type === 'sync.proposed');
      expect(e?.data?.files).toContain('api.md');
      expect((await s.app.inject({ url: '/api/sync', headers: auth })).json().plan.documents.length).toBeGreaterThan(0);
      expect(await fs.readFile(path.join(dir, '.athena/api.md'), 'utf8')).not.toContain('/live');
    } finally {
      await s.close();
    }
  }, 30_000);
});
