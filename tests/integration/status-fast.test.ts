import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { runPipeline } from '../../src/services/pipeline.js';
import { buildStatus } from '../../src/services/status.js';
import { fastIndexChanges } from '../../src/services/status-fast.js';
import { loadConfig } from '../../src/core/config.js';
import { athenaDir, readFileIndex } from '../../src/core/state/state.js';
import { backdate, cleanupProjects, gitInit, makeProject } from '../helpers.js';

afterAll(cleanupProjects);

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e.com' };
const gitRun = (dir: string, args: string[]) =>
  new Promise<void>((resolve, reject) => execFile('git', args, { cwd: dir, env: gitEnv }, (e) => (e ? reject(e) : resolve())));

async function project(): Promise<string> {
  const dir = await makeProject({
    '.gitignore': '*.log\nnode_modules/\n',
    'package.json': JSON.stringify({ name: 'shop', dependencies: { express: '5' } }),
    'src/server.ts': "import express from 'express';\napp.get('/orders', h);\n",
    'src/util/money.ts': 'export const cents = 1;\n',
    'src/util/tax.ts': 'export const tax = 1;\n',
    'packages/api/.gitignore': 'generated/\n',
    'packages/api/src/index.ts': "app.post('/pay', h);\n",
    'docs/guide.md': '# guide\n',
    'README.md': '# shop\n',
  });
  await gitInit(dir);
  await runPipeline({ root: dir, mode: 'init', agents: [] });
  // Index older than the racy window, as after any real session.
  const idx = path.join(dir, '.athena/cache/v1/files.json');
  const cfg = path.join(dir, '.athena/config.json');
  await backdate(dir, ['.athena/cache/v1/files.json']);
  if (await fs.stat(cfg).catch(() => null)) await backdate(dir, ['.athena/config.json']);
  await backdate(dir, ['.git/info/exclude']); // created by `git init`, before the analysis
  await fs.utimes(idx, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  return dir;
}

const write = async (dir: string, rel: string, text: string) => {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), text);
};

async function fast(dir: string) {
  const { config } = await loadConfig(dir);
  return fastIndexChanges(dir, config, await readFileIndex(athenaDir(dir)));
}

/** The fast (index + git) status must equal the walking one. */
async function expectSameStatus(dir: string, usesFastPath = true) {
  const [quick, walked] = [await buildStatus(dir), await buildStatus(dir, undefined, { noFastPath: true })];
  expect(quick).toEqual(walked);
  expect((await fast(dir)) !== null).toBe(usesFastPath);
  return walked;
}

describe('fast status (file index + git)', () => {
  it('matches the walking status on edits, adds, deletes and untracked files', async () => {
    const dir = await project();
    let s = await expectSameStatus(dir);
    expect(s.sync).toBe('up-to-date');

    await fs.appendFile(path.join(dir, 'src/server.ts'), "app.get('/refunds', h);\n"); // tracked edit
    await write(dir, 'src/routes/users.ts', 'export {};\n'); // untracked, new directory
    await write(dir, 'src/util/new.ts', 'export {};\n'); // untracked
    await fs.rm(path.join(dir, 'docs/guide.md')); // deleted
    await write(dir, 'debug.log', 'x'); // ignored by .gitignore
    await write(dir, 'node_modules/x/index.js', 'x'); // ignored
    await write(dir, 'packages/api/generated/client.ts', 'x'); // ignored by a nested .gitignore
    await write(dir, 'dist/bundle.js', 'x'); // Athena default ignore, visible to git
    s = await expectSameStatus(dir);
    expect(s.changes.modified).toEqual(['src/server.ts']);
    expect(s.changes.added).toEqual(['src/routes/users.ts', 'src/util/new.ts']);
    expect(s.changes.deleted).toEqual(['docs/guide.md']);
    expect(s.git.uncommitted).toBeGreaterThan(0);

    // Staged and committed adds (not untracked any more), a staged rename, a force-added ignored file.
    await gitRun(dir, ['add', 'src/util/new.ts']);
    await expectSameStatus(dir);
    await gitRun(dir, ['commit', '-qm', 'add', '--no-gpg-sign']);
    await gitRun(dir, ['mv', 'src/util/tax.ts', 'src/util/vat.ts']);
    await gitRun(dir, ['add', '-f', 'debug.log']);
    s = await expectSameStatus(dir);
    expect(s.changes.deleted).toContain('src/util/tax.ts');
    expect(s.changes.added).toContain('src/util/vat.ts');
    expect(s.changes.added).not.toContain('debug.log');
  });

  it('sees a file that was dirty at analysis time and has been reverted since', async () => {
    const dir = await project();
    await fs.appendFile(path.join(dir, 'src/util/money.ts'), '// wip\n');
    await runPipeline({ root: dir, mode: 'analyze' });
    await backdate(dir, ['.athena/cache/v1/files.json']);
    await gitRun(dir, ['checkout', '--', 'src/util/money.ts']); // clean again for git, not for the index
    const s = await expectSameStatus(dir);
    expect(s.changes.modified).toEqual(['src/util/money.ts']);
  });

  it('same-size edits are detected (size and mtime are only a hint)', async () => {
    const dir = await project();
    await fs.writeFile(path.join(dir, 'README.md'), '# shoP\n');
    const s = await expectSameStatus(dir);
    expect(s.changes.modified).toEqual(['README.md']);
  });

  it('falls back to walking when git cannot answer like a walk', async () => {
    // .gitignore change: the walk's file set changes.
    let dir = await project();
    await fs.appendFile(path.join(dir, '.gitignore'), 'docs/\n');
    await expectSameStatus(dir, false);

    // Ignore rules in .athena/config.json edited after the index.
    dir = await project();
    await write(dir, '.athena/config.json', JSON.stringify({ ignore: ['docs/'] }));
    await expectSameStatus(dir, false);

    // include patterns can re-include what git ignores.
    dir = await project();
    await write(dir, '.athena/config.json', JSON.stringify({ include: ['debug.log'] }));
    await expectSameStatus(dir, false);

    // A nested repository (the walk descends into it; git does not).
    dir = await project();
    await write(dir, 'vendor/lib/a.ts', 'x');
    await gitRun(path.join(dir, 'vendor/lib'), ['init', '-q']);
    await expectSameStatus(dir, false);

    // A symlinked directory.
    dir = await project();
    await fs.symlink(path.join(dir, 'src/util'), path.join(dir, 'src/linked'));
    await expectSameStatus(dir, false);

    // Not a git repository.
    dir = await project();
    await fs.rm(path.join(dir, '.git'), { recursive: true });
    await expectSameStatus(dir, false);
  });

  it('ignores Git global excludes the walk does not know about', async () => {
    const dir = await project();
    const globalIgnore = path.join(dir, '..', `${path.basename(dir)}-global-ignore`);
    await fs.writeFile(globalIgnore, '*.secret\n');
    await gitRun(dir, ['config', 'core.excludesFile', globalIgnore]);
    await write(dir, 'src/keys.secret', 'x');
    const s = await expectSameStatus(dir);
    expect(s.changes.added).toEqual(['src/keys.secret']);
    await fs.rm(globalIgnore);
  });
});
