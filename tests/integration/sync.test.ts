import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { runPipeline } from '../../src/services/pipeline.js';
import { applySync, ignorePlan, needsIndexRefreshOnly, planSync } from '../../src/services/sync.js';
import { watchProject, type WatchEvent } from '../../src/services/watch.js';
import { IgnoreMatcher } from '../../src/core/fs/ignore.js';
import { AthenaConfig } from '../../src/core/config.js';
import { walkProject } from '../../src/core/fs/walker.js';
import { diffModels } from '../../src/core/impact/model-diff.js';
import { emptyModel } from '../../src/core/model/project-model.js';
import { detected } from '../../src/core/model/fact.js';
import { cleanupProjects, gitInit, makeProject } from '../helpers.js';

afterAll(cleanupProjects);

const gitCommit = (dir: string, msg: string) =>
  new Promise<void>((resolve, reject) =>
    execFile('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.com', 'commit', '-qam', msg, '--no-gpg-sign'], { cwd: dir }, (e) => (e ? reject(e) : resolve())),
  );

async function project(): Promise<string> {
  const dir = await makeProject({
    'package.json': JSON.stringify({ name: 'shop', dependencies: { express: '5' } }),
    'src/server.ts': "import express from 'express';\nconst app = express();\napp.get('/orders', h);\n",
    'README.md': '# shop\n',
  });
  await runPipeline({ root: dir, mode: 'init', agents: [] });
  return dir;
}

const read = (dir: string, f: string) => fs.readFile(path.join(dir, '.athena', f), 'utf8');

describe('ignore matcher', () => {
  it('applies nested .gitignore files relative to their directory', async () => {
    const dir = await makeProject({
      '.gitignore': '*.log\n',
      'packages/api/.gitignore': 'generated/\nsecret.txt\n',
      'packages/api/generated/client.ts': 'x',
      'packages/api/secret.txt': 'x',
      'packages/api/src/index.ts': 'x',
      'packages/web/secret.txt': 'x',
      'packages/web/debug.log': 'x',
    });
    const r = await walkProject(dir, { config: AthenaConfig.parse({}) });
    expect(r.files.map((f) => f.path).sort()).toEqual(['.gitignore', 'packages/api/.gitignore', 'packages/api/src/index.ts', 'packages/web/secret.txt']);
  });

  it('supports include overrides and directory-only patterns', () => {
    const m = new IgnoreMatcher(AthenaConfig.parse({ ignore: ['tmp/'], include: ['dist/keep.js'] }));
    expect(m.ignores('tmp', true)).toBe(true);
    expect(m.ignores('tmp', false)).toBe(false);
    expect(m.ignores('node_modules/x/index.js')).toBe(true);
    expect(m.ignores('dist/keep.js')).toBe(false);
    expect(m.ignores('dist/other.js')).toBe(true);
  });
});

describe('model diff', () => {
  it('summarizes added routes and maps them to documents', () => {
    const a = emptyModel('x', '/x');
    const b = emptyModel('x', '/x');
    b.routes.push({ method: 'POST', path: '/refunds', framework: 'Express', file: 'src/r.ts', line: 1, provenance: detected('code', [{ file: 'src/r.ts' }]) });
    const changes = diffModels(a, b);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.summary).toBe('1 route added (POST /refunds)');
    expect(changes[0]!.docs).toEqual(expect.arrayContaining(['api', 'security']));
    expect(changes[0]!.docs).not.toContain('deployment');
  });

  it('ignores git fields that change on every commit', () => {
    const a = emptyModel('x', '/x');
    const b = emptyModel('x', '/x');
    b.git = { ...b.git, head: 'abc', lastCommitDate: '2026-01-01' };
    expect(diffModels(a, b)).toEqual([]);
  });
});

describe('sync plan and apply', () => {
  it('is up to date right after init', async () => {
    const dir = await project();
    const plan = await planSync(dir);
    expect(plan.upToDate).toBe(true);
    expect(plan.documents).toEqual([]);
    expect(needsIndexRefreshOnly(plan)).toBe(false);
  });

  it('proposes only affected documents, with reasons and diffs, without writing', async () => {
    const dir = await project();
    const before = await read(dir, 'api.md');
    await fs.appendFile(path.join(dir, 'src/server.ts'), "app.post('/refunds', h);\n");

    const plan = await planSync(dir);
    const files = plan.documents.map((d) => d.file);
    expect(files).toContain('api.md');
    expect(files).not.toContain('deployment.md');
    expect(files).not.toContain('database.md');
    const api = plan.documents.find((d) => d.file === 'api.md')!;
    expect(api.reasons.join('\n')).toContain('1 route added (POST /refunds)');
    expect(api.diff).toContain('+| POST | `/refunds`');
    expect(api.additions).toBeGreaterThan(0);
    expect(plan.fileChanges.modified).toEqual(['src/server.ts']);
    expect(await read(dir, 'api.md')).toBe(before); // nothing written

    const result = await applySync(dir, plan);
    expect(result.applied).toEqual(files);
    expect(await read(dir, 'api.md')).toContain('/refunds');
    const again = await planSync(dir);
    expect(again.upToDate).toBe(true);
    expect(again.fileChanges.modified).toEqual([]);
  });

  it('keeps developer-edited sections and reports them', async () => {
    const dir = await project();
    const file = path.join(dir, '.athena/api.md');
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('## Endpoints', '## Endpoints\n\nCurated by hand.'));
    await fs.appendFile(path.join(dir, 'src/server.ts'), "app.delete('/orders/:id', h);\n");
    const plan = await planSync(dir);
    const api = plan.documents.find((d) => d.file === 'api.md');
    // The endpoints block is preserved, so api.md changes only if another section changed.
    if (api) expect(api.preservedSections).toContain('endpoints');
    await applySync(dir, plan);
    expect(await read(dir, 'api.md')).toContain('Curated by hand.');
  });

  it('refuses to apply a stale plan when a document changed afterwards', async () => {
    const dir = await project();
    await fs.appendFile(path.join(dir, 'src/server.ts'), "app.put('/orders/:id', h);\n");
    const plan = await planSync(dir);
    await fs.appendFile(path.join(dir, '.athena/api.md'), '\nEdited meanwhile.\n');
    await expect(applySync(dir, plan)).rejects.toMatchObject({ kind: 'conflict' });
    expect(await read(dir, 'api.md')).toContain('Edited meanwhile.');
  });

  it('detects renames by content and refreshes the index when no document changes', async () => {
    const dir = await project();
    await fs.rename(path.join(dir, 'README.md'), path.join(dir, 'README-old.md'));
    const plan = await planSync(dir);
    expect(plan.fileChanges.renamed).toEqual([{ from: 'README.md', to: 'README-old.md' }]);
    expect(plan.fileChanges.added).toEqual([]);
    expect(plan.upToDate).toBe(true);
    expect(needsIndexRefreshOnly(plan)).toBe(true);
    await applySync(dir, plan);
    expect((await planSync(dir)).fileChanges.renamed).toEqual([]);
  });

  it('remembers ignored proposals until content changes again', async () => {
    const dir = await project();
    await fs.appendFile(path.join(dir, 'src/server.ts'), "app.get('/a', h);\n");
    const plan = await planSync(dir);
    await ignorePlan(dir, plan.id);
    expect((await planSync(dir)).ignored).toBe(true);
    await fs.appendFile(path.join(dir, 'src/server.ts'), "app.get('/b', h);\n");
    expect((await planSync(dir)).ignored).toBe(false);
    await expect(ignorePlan(dir, '../../etc')).rejects.toThrow();
  });

  it('reports git commits since the last analysis', async () => {
    const dir = await project();
    await gitInit(dir);
    await runPipeline({ root: dir, mode: 'analyze' });
    await fs.appendFile(path.join(dir, 'src/server.ts'), "app.get('/c', h);\n");
    await gitCommit(dir, 'Add /c endpoint');
    const plan = await planSync(dir);
    expect(plan.git.commits.map((c) => c.subject)).toEqual(['Add /c endpoint']);
    expect(plan.git.diverged).toBe(false);
  });
});

describe('watcher', () => {
  const waitFor = async (events: WatchEvent[], pred: (e: WatchEvent) => boolean, ms = 15_000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const hit = events.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timed out; events: ${events.map((e) => e.type).join(',')}`);
  };

  it('proposes (without writing) after a burst of changes, and ignores ignored paths', async () => {
    const dir = await project();
    const events: WatchEvent[] = [];
    const w = await watchProject(dir, { debounceMs: 200, onEvent: (e) => events.push(e) });
    try {
      await fs.mkdir(path.join(dir, 'node_modules/x'), { recursive: true });
      await fs.writeFile(path.join(dir, 'node_modules/x/index.js'), 'x');
      await new Promise((r) => setTimeout(r, 600));
      expect(events.some((e) => e.type === 'changes' && e.paths?.some((p) => p.startsWith('node_modules')))).toBe(false);

      const before = await read(dir, 'api.md');
      await fs.appendFile(path.join(dir, 'src/server.ts'), "app.get('/watched', h);\n");
      const proposal = await waitFor(events, (e) => e.type === 'plan' && !e.plan!.upToDate);
      expect(proposal.plan!.documents.map((d) => d.file)).toContain('api.md');
      expect(await read(dir, 'api.md')).toBe(before);
      expect(w.latestPlan()?.id).toBe(proposal.plan!.id);
    } finally {
      await w.close();
    }
  }, 30_000);

  it('auto-applies when enabled', async () => {
    const dir = await project();
    const events: WatchEvent[] = [];
    const w = await watchProject(dir, { debounceMs: 200, autoApply: true, onEvent: (e) => events.push(e) });
    try {
      await fs.appendFile(path.join(dir, 'src/server.ts'), "app.get('/auto', h);\n");
      const applied = await waitFor(events, (e) => e.type === 'applied');
      expect(applied.result!.applied).toContain('api.md');
      expect(await read(dir, 'api.md')).toContain('/auto');
    } finally {
      await w.close();
    }
  }, 30_000);
});

describe('model diff wording', () => {
  it('describes new directories and database technologies', () => {
    const a = emptyModel('x', '/x');
    const b = emptyModel('x', '/x');
    b.topLevelDirs = ['prisma'];
    b.databases = [{ name: 'PostgreSQL', kind: 'service', provenance: detected('config', []) }];
    const byLabel = Object.fromEntries(diffModels(a, b).map((c) => [c.label, c.summary]));
    expect(byLabel['Project structure']).toBe('1 top-level director(ies) added (prisma)');
    expect(byLabel['Database technology']).toBe('1 technology added (PostgreSQL)');
  });
});
