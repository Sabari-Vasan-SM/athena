import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ProjectSession } from '../../src/services/project-session.js';
import { AthenaError } from '../../src/services/errors.js';
import { graphSummary } from '../../src/services/context.js';
import { getOverview } from '../../src/services/overview.js';
import { runPipeline } from '../../src/services/pipeline.js';
import { cleanupProjects, makeProject } from '../helpers.js';

afterAll(cleanupProjects);

async function initialized(): Promise<string> {
  const dir = await makeProject({ 'package.json': JSON.stringify({ name: 'shop', dependencies: { express: '5' } }), 'src/a.ts': 'export {};\n' });
  await runPipeline({ root: dir, mode: 'init', agents: [] });
  return dir;
}

describe('ProjectSession', () => {
  it('memoizes model.json until the file changes', async () => {
    const dir = await initialized();
    const s = new ProjectSession(dir);
    const a = await s.model();
    expect(a).not.toBeNull();
    expect(await s.model()).toBe(a); // same object: not re-parsed

    // Rewrite with the same content: new inode/mtime, so it is re-read.
    const file = path.join(dir, '.athena/model.json');
    const raw = await fs.readFile(file, 'utf8');
    await fs.rm(file);
    await fs.writeFile(file, raw.replace(/"filesScanned":\s*\d+/, '"filesScanned": 4242'));
    const b = await s.model();
    expect(b).not.toBe(a);
    expect(b!.stats.filesScanned).toBe(4242);
  });

  it('shares one read between concurrent callers', async () => {
    const dir = await initialized();
    const s = new ProjectSession(dir);
    const [a, b] = await Promise.all([s.model(), s.model()]);
    expect(a).toBe(b);
  });

  it('reports missing and corrupted artifacts with actionable errors', async () => {
    const dir = await initialized();
    const s = new ProjectSession(dir);
    const file = path.join(dir, '.athena/model.json');

    await fs.writeFile(file, '{not json');
    expect(await s.readModel()).toMatchObject({ kind: 'corrupted', reason: 'invalid JSON' });
    expect(await s.model()).toBeNull();
    await expect(s.requireModel()).rejects.toThrow(AthenaError);
    await expect(s.requireModel()).rejects.toMatchObject({ message: expect.stringContaining('corrupted'), hint: expect.stringContaining('athena analyze') });

    await fs.writeFile(file, JSON.stringify({ hello: 'world' }));
    expect((await s.readModel()).kind).toBe('corrupted');

    await fs.rm(file);
    expect(await s.readModel()).toEqual({ kind: 'missing' });
    expect(await s.hasModel()).toBe(false);
    await expect(s.requireModel()).rejects.toMatchObject({ message: 'model.json is missing.' });
  });

  it('loads graph, scan and state, and tolerates their absence', async () => {
    const dir = await initialized();
    const s = new ProjectSession(dir);
    expect(await s.graph()).toBeNull();
    expect(await s.scan()).toBeNull();
    const st = await s.state();
    expect(st.kind).toBe('ok');
    expect(await s.state()).toBe(st);
  });

  it('graphSummary reports hasModel from a stat, overview omits an unusable model', async () => {
    const dir = await initialized();
    expect((await graphSummary(dir)).model.hasModel).toBe(true);
    await fs.writeFile(path.join(dir, '.athena/model.json'), '{not json');
    expect((await getOverview(dir)).summary).toBeNull();
    await fs.rm(path.join(dir, '.athena/model.json'));
    expect((await graphSummary(dir)).model.hasModel).toBe(false);
  });
});
