/**
 * Golden test for the staged, cached analyzer: on several repositories, the model
 * it produces must be byte-identical (as model.json) to the one produced by the
 * frozen 0.2.1 analyzer in tests/golden/legacy — cold (empty cache), warm (all
 * facts cached, nothing read) and after edits (partially cached).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { analyzeProject } from '../../src/core/analyzer/analyze.js';
import { buildFileIndex, writeFileIndex } from '../../src/core/state/state.js';
import { analyzeProject as legacyAnalyze } from './legacy/analyzer/analyze.js';
import { backdateTree, cleanupProjects, makeProject, REPO_ROOT } from '../helpers.js';
import { kitchenSink, manySecrets } from './fixtures.js';

afterAll(cleanupProjects);

const SALT = 'a'.repeat(64);
const modelJson = (m: unknown) => `${JSON.stringify(m, null, 2)}\n`;

/** Give the project an .athena/ with a fixed salt so fingerprints are comparable (and the cache is used). */
async function prepare(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, '.athena'), { recursive: true });
  await fs.writeFile(path.join(dir, '.athena', 'local.json'), JSON.stringify({ salt: SALT }));
}

async function copyTree(src: string, dest: string, skip: (rel: string) => boolean): Promise<void> {
  for (const ent of await fs.readdir(src, { withFileTypes: true })) {
    const rel = ent.name;
    if (skip(rel)) continue;
    const s = path.join(src, rel);
    const d = path.join(dest, rel);
    if (ent.isDirectory()) {
      await fs.mkdir(d, { recursive: true });
      await copyTree(s, d, () => false);
    } else if (ent.isFile()) await fs.copyFile(s, d);
  }
}

async function copyOf(src: string, skipTop: string[] = []): Promise<string> {
  const dir = await makeProject({});
  await copyTree(src, dir, (rel) => skipTop.includes(rel));
  return dir;
}

async function textFileCount(dir: string): Promise<number> {
  const r = await legacyAnalyze(dir);
  return r.files.filter((f) => !f.binary && !f.large).length;
}

/** Legacy vs staged: cold, warm, then after an edit/add/delete. */
async function assertGolden(dir: string, mutate?: (dir: string) => Promise<number>): Promise<void> {
  await backdateTree(dir);
  await prepare(dir);
  const legacy = modelJson((await legacyAnalyze(dir)).model);

  const cold = await analyzeProject(dir);
  expect(modelJson(cold.model)).toBe(legacy);
  // Single pass: every file read at most once, and every text file exactly once.
  expect(cold.perf.rereads).toBe(0);
  expect(cold.perf.filesRead).toBe(await textFileCount(dir) + cold.files.filter((f) => f.binary).length);

  await writeFileIndex(path.join(dir, '.athena'), buildFileIndex(cold.files));
  const warm = await analyzeProject(dir);
  expect(modelJson(warm.model)).toBe(legacy);
  expect(warm.perf.filesRead).toBe(0);

  if (mutate) {
    await writeFileIndex(path.join(dir, '.athena'), buildFileIndex(warm.files));
    const expectedReads = await mutate(dir);
    const legacyAfter = modelJson((await legacyAnalyze(dir)).model);
    const after = await analyzeProject(dir);
    expect(modelJson(after.model)).toBe(legacyAfter);
    expect(after.perf.filesRead).toBe(expectedReads);
  }
}

describe('golden: staged analyzer matches the 0.2.1 analyzer', () => {
  it('kitchen-sink project (every detector)', async () => {
    const dir = await makeProject(kitchenSink());
    await assertGolden(dir, async (d) => {
      await fs.appendFile(path.join(d, 'apps/api/src/server.ts'), "\napp.delete('/added', h);\n");
      await fs.writeFile(path.join(d, 'apps/api/src/new.ts'), "import express from 'express';\napp.patch('/new', h);\nprocess.env.NEW_VAR;\n");
      await fs.rm(path.join(d, 'py/shop/urls.py'));
      return 2;
    });
  }, 60_000);

  it('secret findings cap', async () => {
    await assertGolden(await makeProject(manySecrets()));
  }, 60_000);

  it('examples/demo-shop', async () => {
    await assertGolden(await copyOf(path.join(REPO_ROOT, 'examples', 'demo-shop'), ['.athena']), async (d) => {
      await fs.appendFile(path.join(d, 'src/routes/orders.ts'), "\nrouter.get('/orders/extra', h);\n");
      return 1;
    });
  }, 60_000);

  it('this repository (src, tests, web, docs)', async () => {
    await assertGolden(await copyOf(REPO_ROOT, ['node_modules', 'dist', '.git', '.athena', 'coverage']));
  }, 120_000);

  it('a generated benchmark-style repository', async () => {
    const dir = path.join(await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'athena-golden-'))));
    try {
      execFileSync(process.execPath, [path.join(REPO_ROOT, 'bench', 'generate.mjs'), dir, '1500'], { stdio: 'ignore' });
      await assertGolden(dir, async (d) => {
        await fs.appendFile(path.join(d, 'package.json'), '\n');
        return 1;
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('malformed manifests and an empty project', async () => {
    await assertGolden(await makeProject({ 'package.json': '{ not json', 'pyproject.toml': '[project\nname=', 'docker-compose.yml': 'services: [unclosed', 'src/index.ts': 'export {}', 'src/broken.ts': 'app.get("/x", (req, res) => { ' }));
    await assertGolden(await makeProject({ 'package.json': 'null', 'src/a.ts': 'export {}' }));
    await assertGolden(await makeProject({}));
  }, 60_000);
});
