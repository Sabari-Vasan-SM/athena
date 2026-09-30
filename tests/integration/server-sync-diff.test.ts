import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createServer } from '../../src/server/app.js';
import { runPipeline } from '../../src/services/pipeline.js';
import { cleanupProjects, makeProject } from '../helpers.js';

const TOKEN = 'test-token-0123456789abcdefghijklmnop';
const PORT = 7999;
const auth = { authorization: `Bearer ${TOKEN}`, host: `127.0.0.1:${PORT}` };
const json = { ...auth, 'content-type': 'application/json' };

afterAll(cleanupProjects);

async function project(): Promise<string> {
  const dir = await makeProject({
    'package.json': JSON.stringify({ name: 'shop', dependencies: { express: '5' } }),
    'src/server.ts': "import express from 'express';\nconst app = express();\napp.get('/orders', h);\n",
  });
  await runPipeline({ root: dir, mode: 'init', agents: [] });
  return dir;
}

describe('slim /api/sync with lazy per-document diffs', () => {
  it('omits diffs from GET /api/sync and serves them from GET /api/sync/:doc', async () => {
    const dir = await project();
    const s = await createServer({ root: dir, token: TOKEN, host: '127.0.0.1', port: PORT, webDir: dir });
    try {
      // No proposal yet.
      expect((await s.app.inject({ url: '/api/sync/api', headers: auth })).statusCode).toBe(404);

      await fs.appendFile(path.join(dir, 'src/server.ts'), "app.post('/refunds', h);\n");
      const checked = (await s.app.inject({ method: 'POST', url: '/api/sync/check', headers: json, payload: {} })).json();
      const planId = checked.plan.id as string;

      const summary = (await s.app.inject({ url: '/api/sync', headers: auth })).json();
      expect(summary.plan.id).toBe(planId);
      const doc = summary.plan.documents.find((d: { id: string }) => d.id === 'api');
      expect(doc).toMatchObject({ file: 'api.md', diffTruncated: false });
      expect(doc.additions).toBeGreaterThan(0);
      expect(doc.reasons.length).toBeGreaterThan(0);
      expect(doc).not.toHaveProperty('diff');

      const diff = await s.app.inject({ url: `/api/sync/api?planId=${planId}`, headers: auth });
      expect(diff.statusCode).toBe(200);
      expect(diff.json()).toMatchObject({ planId, id: 'api', file: 'api.md' });
      expect(diff.json().diff).toContain('@@');
      expect(diff.json().diff).toContain('/refunds');

      // Allowlist and plan membership.
      expect((await s.app.inject({ url: '/api/sync/rules', headers: auth })).statusCode).toBe(404);
      expect((await s.app.inject({ url: '/api/sync/nope', headers: auth })).statusCode).toBe(404);
      for (const bad of ['..%2F..%2Fetc%2Fpasswd', 'API', 'api.md', '%2e%2e']) {
        const r = await s.app.inject({ url: `/api/sync/${bad}`, headers: auth });
        expect([400, 404], bad).toContain(r.statusCode);
      }
      // Stale or malformed plan ids.
      expect((await s.app.inject({ url: '/api/sync/api?planId=0000000000000000', headers: auth })).statusCode).toBe(409);
      expect((await s.app.inject({ url: '/api/sync/api?planId=xyz', headers: auth })).statusCode).toBe(400);
      // Still behind auth.
      expect((await s.app.inject({ url: '/api/sync/api', headers: { host: auth.host } })).statusCode).toBe(401);
    } finally {
      await s.close();
    }
  });

  it('reports a corrupted model.json as a client error with a hint, not a 500', async () => {
    const dir = await project();
    const s = await createServer({ root: dir, token: TOKEN, host: '127.0.0.1', port: PORT, webDir: dir });
    try {
      await fs.writeFile(path.join(dir, '.athena/model.json'), '{not json');
      const r = await s.app.inject({ method: 'POST', url: '/api/security/scan', headers: json, payload: { skipAudit: true } });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toMatch(/model\.json is corrupted/);
      expect(r.json().hint).toMatch(/athena analyze/);
      expect((await s.app.inject({ url: '/api/security', headers: auth })).json().running).toBe(false);
    } finally {
      await s.close();
    }
  });
});
