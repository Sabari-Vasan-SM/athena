import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { analyzeProject, DETECTORS_VERSION } from '../../src/core/analyzer/analyze.js';
import { runPipeline } from '../../src/services/pipeline.js';
import { planSync } from '../../src/services/sync.js';
import { buildStatus } from '../../src/services/status.js';
import { diffFileIndex, fileIndexPath, readFileIndex, readState, writeState } from '../../src/core/state/state.js';
import { ByteLRU } from '../../src/core/cache/lru.js';
import { cleanupProjects, FAKE, makeProject, runCli } from '../helpers.js';

afterAll(cleanupProjects);

const json = (v: unknown) => JSON.stringify(v, null, 2);

function sample(): Record<string, string | Buffer> {
  return {
    'package.json': json({ name: 'shop', dependencies: { express: '5', '@prisma/client': '6' }, devDependencies: { vitest: '3' } }),
    'src/server.ts': "import express from 'express';\nconst app = express();\napp.get('/health', h);\nconst k = process.env.API_KEY;\n",
    'src/orders.ts': "import { Router } from 'express';\nconst router = Router();\nrouter.post('/orders', h);\n",
    'src/config.ts': `export const stripe = "${FAKE.stripe}";\n`,
    'src/util.ts': 'export const x = 1;\n',
    'prisma/schema.prisma': 'model User {\n  id String @id\n}\n',
    'README.md': '# shop\n',
    'logo.png': Buffer.from([0x89, 0x50, 0x00, 0x01]),
  };
}

/** A reader that records every content read. */
function counter() {
  const reads: string[] = [];
  return { reads, readFile: async (abs: string) => (reads.push(abs), fs.readFile(abs)) };
}

const rel = (dir: string, abs: string[]) => abs.map((a) => path.relative(dir, a)).sort();
const modelOf = async (dir: string) => JSON.stringify((await analyzeProject(dir)).model);

async function initialized(files = sample()): Promise<string> {
  const dir = await makeProject(files);
  await runPipeline({ root: dir, mode: 'init', agents: [] });
  return dir;
}

describe('facts cache', () => {
  it('after init, an unchanged project is analyzed without reading any file', async () => {
    const dir = await initialized();
    const c = counter();
    const r = await analyzeProject(dir, { readFile: c.readFile });
    expect(c.reads).toEqual([]);
    expect(r.perf.filesRead).toBe(0);
    expect(r.model.routes.map((x) => x.path).sort()).toEqual(['/health', '/orders']);
    expect(r.model.security.secrets).toHaveLength(1);
    // The fingerprint key was created with .athena/ and is used from the first analysis on.
    const modelJson = JSON.parse(await fs.readFile(path.join(dir, '.athena/model.json'), 'utf8'));
    expect(r.model.security.secrets[0]!.fingerprint).toBe(modelJson.security.secrets[0].fingerprint);

    const plan = await planSync(dir);
    expect(plan.upToDate).toBe(true);
    expect(plan.fileChanges).toEqual({ added: [], modified: [], deleted: [], renamed: [] });
  });

  it('a one-file change reads exactly that file and updates the facts', async () => {
    const dir = await initialized();
    await fs.appendFile(path.join(dir, 'src/orders.ts'), "router.delete('/orders/:id', h);\n");
    const c = counter();
    const r = await analyzeProject(dir, { readFile: c.readFile });
    expect(rel(dir, c.reads)).toEqual(['src/orders.ts']);
    expect(r.model.routes.map((x) => `${x.method} ${x.path}`)).toContain('DELETE /orders/:id');
    const plan = await planSync(dir);
    expect(plan.fileChanges.modified).toEqual(['src/orders.ts']);
  });

  it('content reverted to a cached version needs only the hash read', async () => {
    const dir = await initialized();
    const file = path.join(dir, 'src/util.ts');
    const original = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, 'export const x = 2;\n');
    await analyzeProject(dir);
    await fs.writeFile(file, original);
    const c = counter();
    await analyzeProject(dir, { readFile: c.readFile });
    // Read once to hash; facts for the original content are still cached.
    expect(rel(dir, c.reads)).toEqual(['src/util.ts']);
  });

  it('a config change invalidates the cache', async () => {
    const dir = await initialized();
    const before = await modelOf(dir);
    await fs.writeFile(path.join(dir, '.athena/config.json'), json({ ignore: ['nothing-matches'] }));
    const c = counter();
    const r = await analyzeProject(dir, { readFile: c.readFile });
    // Every text file is read again (binary files keep their indexed flag).
    expect(rel(dir, c.reads)).toEqual(['README.md', 'package.json', 'prisma/schema.prisma', 'src/config.ts', 'src/orders.ts', 'src/server.ts', 'src/util.ts']);
    expect(r.perf.cache.reset).toBe(true);
    expect(JSON.stringify(r.model)).toBe(before);
    const version = JSON.parse(await fs.readFile(path.join(dir, '.athena/cache/v1/facts/version.json'), 'utf8'));
    expect(version.detectors).toBe(DETECTORS_VERSION);
  });

  it('a detector version bump invalidates the cache', async () => {
    const dir = await initialized();
    const before = await modelOf(dir);
    const vf = path.join(dir, '.athena/cache/v1/facts/version.json');
    const v = JSON.parse(await fs.readFile(vf, 'utf8'));
    await fs.writeFile(vf, JSON.stringify({ ...v, detectors: `${v.detectors}+bumped` }));
    const c = counter();
    const r = await analyzeProject(dir, { readFile: c.readFile });
    expect(c.reads).toHaveLength(7);
    expect(JSON.stringify(r.model)).toBe(before);
    expect(JSON.parse(await fs.readFile(vf, 'utf8')).detectors).toBe(DETECTORS_VERSION);
    const again = counter();
    await analyzeProject(dir, { readFile: again.readFile });
    expect(again.reads).toEqual([]);
  });

  it('a corrupted shard is ignored and rebuilt', async () => {
    const dir = await initialized();
    const before = await modelOf(dir);
    const factsDir = path.join(dir, '.athena/cache/v1/facts');
    const shards = (await fs.readdir(factsDir)).filter((f) => /^[0-9a-f]{2}\.json$/.test(f));
    expect(shards.length).toBeGreaterThan(0);
    const victim = path.join(factsDir, shards[0]!);
    const hashes = Object.keys(JSON.parse(await fs.readFile(victim, 'utf8')));
    await fs.writeFile(victim, '{ truncated');
    const c = counter();
    const r = await analyzeProject(dir, { readFile: c.readFile });
    expect(r.perf.cache.corruptShards).toBe(1);
    expect(c.reads).toHaveLength(hashes.length);
    expect(JSON.stringify(r.model)).toBe(before);
    expect(Object.keys(JSON.parse(await fs.readFile(victim, 'utf8'))).sort()).toEqual(hashes.sort());
  });

  it('drops facts for content that no longer exists', async () => {
    const dir = await initialized();
    const index = await readFileIndex(path.join(dir, '.athena'));
    const oldHash = index['src/util.ts']!.h;
    await fs.writeFile(path.join(dir, 'src/util.ts'), 'export const x = 3;\n');
    await analyzeProject(dir);
    const shard = JSON.parse(await fs.readFile(path.join(dir, '.athena/cache/v1/facts', `${oldHash.slice(0, 2)}.json`), 'utf8').catch(() => '{}'));
    expect(shard[oldHash]).toBeUndefined();
  });

  it('keeps state.json small and the index in the cache directory', async () => {
    const files = sample();
    for (let i = 0; i < 2000; i++) files[`src/gen/f${i}.ts`] = `export const v${i} = ${i};\n`;
    const dir = await initialized(files);
    const st = await fs.stat(path.join(dir, '.athena/state.json'));
    expect(st.size).toBeLessThan(50_000);
    const index = await readFileIndex(path.join(dir, '.athena'));
    expect(Object.keys(index)).toHaveLength(2008);
    expect(index['src/util.ts']!.h).toMatch(/^[0-9a-f]{64}$/);
    expect(await fs.readFile(path.join(dir, '.athena/.gitignore'), 'utf8')).toMatch(/^cache\/$/m);
    const status = await buildStatus(dir);
    expect(status.sync).toBe('up-to-date');
  });

  it('bounds the text kept in memory', () => {
    const lru = new ByteLRU<string>(10, (s) => s.length);
    lru.set('a', 'xxxx');
    lru.set('b', 'yyyy');
    expect(lru.get('a')).toBe('xxxx'); // a is now most recent
    lru.set('c', 'zzzz');
    expect(lru.has('b')).toBe(false);
    expect(lru.has('a') && lru.has('c')).toBe(true);
    expect(lru.bytes).toBe(8);
    lru.set('huge', 'x'.repeat(11));
    expect(lru.has('huge')).toBe(false);
  });

  it('analysis works with a tiny text budget and without a cache', async () => {
    const dir = await makeProject(sample());
    const a = await analyzeProject(dir, { cache: false, textCacheBytes: 1 });
    const b = await analyzeProject(dir);
    expect(JSON.stringify(a.model)).toBe(JSON.stringify(b.model));
    await expect(fs.access(path.join(dir, '.athena'))).rejects.toThrow();
  });
});

describe('state.json v2', () => {
  it('migrates a v1 state (embedded file index) on read', async () => {
    const dir = await initialized();
    const athena = path.join(dir, '.athena');
    const state = JSON.parse(await fs.readFile(path.join(athena, 'state.json'), 'utf8'));
    const index = await readFileIndex(athena);
    // Rebuild a 0.2.1-style state.json: schema 1, index inline with 16-char hashes.
    const v1Index = Object.fromEntries(Object.entries(index).map(([p, e]) => [p, { ...e, h: e.h.startsWith('meta:') ? e.h : e.h.slice(0, 16) }]));
    await fs.rm(path.join(athena, 'cache'), { recursive: true, force: true });
    await fs.writeFile(path.join(athena, 'state.json'), json({ ...state, schemaVersion: 1, fileIndex: v1Index }));

    const r = await readState(athena);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.state.schemaVersion).toBe(2);
    expect(r.state.fileIndex).toBeUndefined();
    expect(r.state.documents).toEqual(state.documents);
    const onDisk = JSON.parse(await fs.readFile(path.join(athena, 'state.json'), 'utf8'));
    expect(onDisk.schemaVersion).toBe(2);
    expect(onDisk.fileIndex).toBeUndefined();
    expect(await readFileIndex(athena)).toEqual(v1Index);
    await expect(fs.access(fileIndexPath(athena))).resolves.toBeUndefined();

    // Truncated v1 hashes still compare equal to full hashes: nothing reported as modified.
    const plan = await planSync(dir);
    expect(plan.fileChanges).toEqual({ added: [], modified: [], deleted: [], renamed: [] });
    expect(diffFileIndex({ a: { h: 'abcdef0123456789', s: 1, m: 1 } }, { a: { h: `abcdef0123456789${'0'.repeat(48)}`, s: 1, m: 2 } }).modified).toEqual([]);
  });

  it('a v1 state is migrated when status is the first command to read it', async () => {
    const dir = await initialized();
    const athena = path.join(dir, '.athena');
    const state = JSON.parse(await fs.readFile(path.join(athena, 'state.json'), 'utf8'));
    const index = await readFileIndex(athena);
    await fs.rm(path.join(athena, 'cache'), { recursive: true, force: true });
    await fs.writeFile(path.join(athena, 'state.json'), json({ ...state, schemaVersion: 1, fileIndex: index }));
    const status = await buildStatus(dir);
    expect(status.changes).toEqual({ added: [], modified: [], deleted: [] });
  });

  it('readState returns copies and writeState without an index keeps the index', async () => {
    const dir = await initialized();
    const athena = path.join(dir, '.athena');
    const a = await readState(athena);
    if (a.kind !== 'ok') throw new Error('expected state');
    a.state.projectName = 'mutated';
    const b = await readState(athena);
    expect(b.kind === 'ok' && b.state.projectName).toBe('shop');
    const before = await readFileIndex(athena);
    await writeState(athena, { ...a.state, projectName: 'renamed' });
    const c = await readState(athena);
    expect(c.kind === 'ok' && c.state.projectName).toBe('renamed');
    expect(await readFileIndex(athena)).toEqual(before);
  });
});

describe('athena clean', () => {
  it('removes the cache with .athena/', async () => {
    const dir = await initialized();
    await expect(fs.access(path.join(dir, '.athena/cache/v1/facts/version.json'))).resolves.toBeUndefined();
    const r = await runCli(['clean', '--yes'], dir);
    expect(r.code, r.stderr).toBe(0);
    await expect(fs.access(path.join(dir, '.athena'))).rejects.toThrow();
  });
});
