import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createServer } from '../../src/server/app.js';
import { runPipeline } from '../../src/services/pipeline.js';
import { cleanupProjects, makeProject } from '../helpers.js';

const TOKEN = 'test-token-0123456789abcdefghijklmnop';
const PORT = 7997;
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

describe('server planning goes through the scheduler', () => {
  it('concurrent checks without a watcher share analyses instead of starting one each', async () => {
    const dir = await project();
    const s = await createServer({ root: dir, token: TOKEN, host: '127.0.0.1', port: PORT, webDir: dir });
    try {
      await fs.appendFile(path.join(dir, 'src/server.ts'), "app.post('/refunds', h);\n");
      const responses = await Promise.all(Array.from({ length: 6 }, () => s.app.inject({ method: 'POST', url: '/api/sync/check', headers: json, payload: {} })));
      expect(responses.every((r) => r.statusCode === 200)).toBe(true);
      // One run, plus at most one coalesced follow-up for requests that arrived while it ran.
      expect(s.scheduler.stats.runs).toBeLessThanOrEqual(2);
      expect(new Set(responses.map((r) => r.json().plan.id)).size).toBe(1);
    } finally {
      await s.close();
    }
  });

  it('watched file changes invalidate the cached status immediately', async () => {
    const dir = await project();
    const s = await createServer({ root: dir, token: TOKEN, host: '127.0.0.1', port: PORT, webDir: dir, watch: true, watchDebounceMs: 3000 });
    try {
      const before = (await s.app.inject({ url: '/api/status', headers: auth })).json();
      expect(before.changes.added).toEqual([]);
      await fs.writeFile(path.join(dir, 'src/new.ts'), 'export {};\n');
      let after = before;
      for (let i = 0; i < 60 && !after.changes.added.includes('src/new.ts'); i++) {
        await new Promise((r) => setTimeout(r, 50));
        after = (await s.app.inject({ url: '/api/status', headers: auth })).json();
      }
      // Before the debounced plan (which may refresh the index) and within the 30 s TTL: the watcher event invalidated it.
      expect(after.changes.added).toContain('src/new.ts');
    } finally {
      await s.close();
    }
  }, 20_000);
});
