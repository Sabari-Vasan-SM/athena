import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runPipeline } from '../../src/services/pipeline.js';
import { planSnapshot, planSync, type SyncPlan } from '../../src/services/sync.js';
import { AnalysisScheduler } from '../../src/services/scheduler.js';
import { watchProject, type WatchEvent } from '../../src/services/watch.js';
import type { WalkSnapshot } from '../../src/core/analyzer/incremental.js';
import { cleanupProjects, makeProject } from '../helpers.js';

afterAll(cleanupProjects);

async function project(): Promise<string> {
  const dir = await makeProject({
    '.gitignore': '*.log\n',
    'package.json': JSON.stringify({ name: 'shop', dependencies: { express: '5', prisma: '5' } }),
    'src/server.ts': "import express from 'express';\nconst app = express();\napp.get('/orders', h);\n",
    'src/util/money.ts': 'export const cents = (n: number) => Math.round(n * 100);\n',
    'src/util/old-name.ts': 'export const legacy = 1;\n',
    'packages/api/.gitignore': 'generated/\n',
    'packages/api/src/index.ts': "app.post('/api/pay', h);\n",
    'packages/api/generated/client.ts': 'x',
    'tests/money.test.ts': "import { cents } from '../src/util/money';\n",
    'README.md': '# shop\n',
  });
  await runPipeline({ root: dir, mode: 'init', agents: [] });
  return dir;
}

/** Everything in a plan that must not depend on how the file list was obtained. */
function comparable(plan: SyncPlan) {
  const { createdAt: _c, durationMs: _d, ...rest } = plan;
  return rest;
}
const fileList = (s: WalkSnapshot) => s.files.map((f) => [f.path, f.hash, f.size, f.binary, f.large]);

async function write(dir: string, rel: string, text: string) {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), text);
}

/** Plan fully and incrementally (from `snapshot` + `changedPaths`); both must agree. */
async function expectSame(dir: string, snapshot: WalkSnapshot, changedPaths: string[], mode: 'incremental' | 'full') {
  const full = await planSync(dir);
  const inc = await planSync(dir, { incremental: { snapshot, changedPaths } });
  const fullSnap = planSnapshot(full)!;
  const incSnap = planSnapshot(inc)!;
  expect(fullSnap.walkMode).toBe('full');
  expect(incSnap.walkMode).toBe(mode);
  expect(comparable(inc)).toEqual(comparable(full));
  expect(fileList(incSnap.snapshot)).toEqual(fileList(fullSnap.snapshot));
  return incSnap.snapshot;
}

describe('incremental analysis from watcher paths', () => {
  it('equals a full plan after edits, adds, deletes and renames', async () => {
    const dir = await project();
    let snap = planSnapshot(await planSync(dir))!.snapshot;
    expect(snap.reusable).toBe(true);

    await fs.appendFile(path.join(dir, 'src/server.ts'), "app.get('/refunds', h);\n");
    snap = await expectSame(dir, snap, ['src/server.ts'], 'incremental');

    await write(dir, 'src/routes/users.ts', "app.get('/users', h);\n"); // existing parent? no: new dir → full
    snap = await expectSame(dir, snap, ['src/routes', 'src/routes/users.ts'], 'full');

    await write(dir, 'src/util/tax.ts', 'export const tax = 0.2;\n'); // new file in a known directory
    snap = await expectSame(dir, snap, ['src/util/tax.ts'], 'incremental');

    await fs.rm(path.join(dir, 'tests/money.test.ts'));
    snap = await expectSame(dir, snap, ['tests/money.test.ts'], 'incremental');

    await fs.rename(path.join(dir, 'src/util/old-name.ts'), path.join(dir, 'src/util/new-name.ts'));
    const renamed = await planSync(dir, { incremental: { snapshot: snap, changedPaths: ['src/util/old-name.ts', 'src/util/new-name.ts'] } });
    expect(renamed.fileChanges.renamed).toEqual([{ from: 'src/util/old-name.ts', to: 'src/util/new-name.ts' }]);
    snap = await expectSame(dir, snap, ['src/util/old-name.ts', 'src/util/new-name.ts'], 'incremental');

    // Ignored paths reported by a watcher change nothing.
    await write(dir, 'debug.log', 'noise');
    await write(dir, 'packages/api/generated/client.ts', 'regenerated');
    snap = await expectSame(dir, snap, ['debug.log', 'packages/api/generated/client.ts'], 'incremental');

    // A path reported changed that did not change is harmless (re-read, same hash).
    await expectSame(dir, snap, ['README.md', 'does/not/exist.ts'], 'incremental');
  });

  it('falls back to a full walk for ignore-file, config and directory changes', async () => {
    const dir = await project();
    let snap = planSnapshot(await planSync(dir))!.snapshot;

    // .gitignore edits change what is in the tree.
    await fs.appendFile(path.join(dir, '.gitignore'), 'tests/\n');
    snap = await expectSame(dir, snap, ['.gitignore'], 'full');
    await fs.writeFile(path.join(dir, 'packages/api/.gitignore'), '');
    snap = await expectSame(dir, snap, ['packages/api/.gitignore'], 'full');

    // .athena/config.json is not watched: detected by the config hash.
    await write(dir, '.athena/config.json', JSON.stringify({ ignore: ['README.md'] }));
    snap = await expectSame(dir, snap, [], 'full');

    // .git/info/exclude is not watched either.
    await write(dir, '.git/info/exclude', 'packages/\n');
    snap = await expectSame(dir, snap, [], 'full');
    await fs.rm(path.join(dir, '.git'), { recursive: true });
    snap = await expectSame(dir, snap, [], 'full');

    // Directory deletes.
    await fs.rm(path.join(dir, 'src/util'), { recursive: true });
    snap = await expectSame(dir, snap, ['src/util'], 'full');

    // A snapshot taken under a different file limit is not reused.
    await write(dir, '.athena/config.json', JSON.stringify({ ignore: ['README.md'], maxFiles: 5 }));
    const limited = await planSync(dir);
    expect(planSnapshot(limited)!.snapshot.reusable).toBe(false); // truncated walk
    const again = await planSync(dir, { incremental: { snapshot: planSnapshot(limited)!.snapshot, changedPaths: [] } });
    expect(planSnapshot(again)!.walkMode).toBe('full');
  });

  it('does not trust walks that followed symlinks', async () => {
    const dir = await project();
    await fs.symlink(path.join(dir, 'src/util'), path.join(dir, 'src/linked'));
    const snap = planSnapshot(await planSync(dir))!.snapshot;
    expect(snap.reusable).toBe(false);
    await fs.appendFile(path.join(dir, 'src/util/money.ts'), '// edit\n');
    await expectSame(dir, snap, ['src/util/money.ts'], 'full');
  });

  it('a watcher burst becomes one incremental plan', async () => {
    const dir = await project();
    const scheduler = new AnalysisScheduler(dir);
    const events: WatchEvent[] = [];
    const w = await watchProject(dir, { debounceMs: 250, scheduler, onEvent: (e) => events.push(e) });
    const waitFor = async (pred: () => boolean) => {
      for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 50));
      if (!pred()) throw new Error(`timed out; events: ${events.map((e) => e.type).join(',')}`);
    };
    try {
      await w.planNow(); // baseline (full walk)
      expect(scheduler.stats.runs).toBe(1);
      const runs = scheduler.stats.runs;
      for (let i = 0; i < 5; i++) await fs.appendFile(path.join(dir, 'src/server.ts'), `app.get('/burst${i}', h);\n`);
      await write(dir, 'src/util/extra.ts', 'export const x = 1;\n');
      await waitFor(() => events.some((e) => e.type === 'plan' && !e.plan!.upToDate && e.plan!.fileChanges.added.includes('src/util/extra.ts')));
      await new Promise((r) => setTimeout(r, 400)); // no trailing duplicate run
      expect(scheduler.stats.runs - runs).toBe(1);
      expect(scheduler.stats.incremental).toBe(1);
      const planning = events.filter((e) => e.type === 'planning').at(-1)!;
      expect(new Set(planning.paths)).toEqual(new Set(['src/server.ts', 'src/util/extra.ts']));
      const plan = w.latestPlan()!;
      const full = await planSync(dir);
      expect(comparable(plan)).toEqual(comparable(full));
    } finally {
      await w.close();
      scheduler.close();
    }
  }, 30_000);
});
