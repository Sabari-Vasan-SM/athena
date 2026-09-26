import { promises as fs, constants as fsc } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI, cleanupProjects, FAKE, gitInit, makeProject, REPO_ROOT, runCli, type CliResult } from '../helpers.js';

const isWin = process.platform === 'win32';
let shimDir = '';
let shim = '';

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => execFile('npx', ['tsup'], { cwd: REPO_ROOT, shell: isWin }, (err) => (err ? reject(err) : resolve())));
  await fs.access(CLI);
  // An `athena` on PATH that runs the freshly built CLI, as a global install would.
  shimDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'athena-shim-')));
  shim = path.join(shimDir, 'athena');
  await fs.writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
}, 120_000);
afterAll(async () => {
  await cleanupProjects();
  if (shimDir) await fs.rm(shimDir, { recursive: true, force: true });
});

/** PATH without any directory that already provides an `athena` command. */
async function pathWithoutAthena(): Promise<string> {
  const dirs: string[] = [];
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!d) continue;
    const found = await fs.access(path.join(d, 'athena'), fsc.X_OK).then(() => true, () => false);
    if (!found) dirs.push(d);
  }
  return dirs.join(path.delimiter);
}

const withShim = () => `${shimDir}${path.delimiter}${process.env.PATH}`;
const GIT_ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };

function git(dir: string, args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: dir, env: { ...process.env, ...GIT_ID, NO_COLOR: '1', ...env }, timeout: 60_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

const commitAll = async (dir: string, message: string, env: Record<string, string> = {}) => {
  await git(dir, ['add', '-A'], env);
  return git(dir, ['commit', '-q', '--no-gpg-sign', '-m', message], env);
};

/** A Git repo with Athena initialized and its knowledge committed. */
async function initializedRepo(files: Record<string, string> = {}): Promise<string> {
  const dir = await makeProject({
    'package.json': JSON.stringify({ name: 'shop', dependencies: { express: '5' } }),
    'src/app.ts': "import express from 'express';\nconst app = express();\napp.get('/a', h);\n",
    ...files,
  });
  await gitInit(dir);
  const r = await runCli(['init', '--no-agents', '--quiet'], dir);
  expect(r.code, r.stderr).toBe(0);
  expect((await commitAll(dir, 'knowledge')).code).toBe(0);
  return dir;
}

const hookPath = (dir: string) => path.join(dir, '.git', 'hooks', 'pre-commit');
const status = async (dir: string) => JSON.parse((await runCli(['git-hook', 'status', '--json'], dir)).stdout) as { installed: boolean; review: boolean; ownsFile: boolean; manager: string | null };

describe('athena git-hook', () => {
  it('installs an executable hook, is idempotent, and uninstalls cleanly', async () => {
    const dir = await initializedRepo();
    expect((await status(dir)).installed).toBe(false);

    const r = await runCli(['git-hook', 'install'], dir);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('Installed the pre-commit hook');
    expect(r.stdout).toContain('npx --no-install athena sync --check');
    const text = await fs.readFile(hookPath(dir), 'utf8');
    expect(text.startsWith('#!/bin/sh\n')).toBe(true);
    expect(text).toContain('# athena:start');
    expect(text).toContain('athena --no-color sync --check --quiet');
    expect(text).not.toContain(' review ');
    if (!isWin) expect((await fs.stat(hookPath(dir))).mode & 0o111).toBeTruthy();
    expect(await status(dir)).toMatchObject({ installed: true, review: false, ownsFile: true, manager: null });

    const again = JSON.parse((await runCli(['git-hook', 'install', '--json'], dir)).stdout);
    expect(again.action).toBe('unchanged');
    expect(await fs.readFile(hookPath(dir), 'utf8')).toBe(text);

    const withReview = JSON.parse((await runCli(['git-hook', 'install', '--review', '--json'], dir)).stdout);
    expect(withReview).toMatchObject({ action: 'updated', review: true });
    expect((await fs.readFile(hookPath(dir), 'utf8')).match(/# athena:start/g)).toHaveLength(1);

    const un = await runCli(['git-hook', 'uninstall'], dir);
    expect(un.code, un.stderr).toBe(0);
    await expect(fs.access(hookPath(dir))).rejects.toThrow();
    expect((await status(dir)).installed).toBe(false);
    expect((await runCli(['git-hook', 'uninstall'], dir)).stdout).toContain('No Athena pre-commit hook');
  });

  it('keeps an existing shell hook: Athena runs first, the rest is untouched and restored on uninstall', async () => {
    const dir = await initializedRepo();
    const original = '#!/bin/sh\necho "user hook ran" >&2\nexit 0\n';
    await fs.writeFile(hookPath(dir), original, { mode: 0o755 });

    const r = JSON.parse((await runCli(['git-hook', 'install', '--json'], dir)).stdout);
    expect(r).toMatchObject({ action: 'added-to-existing', installed: true, ownsFile: false });
    const text = await fs.readFile(hookPath(dir), 'utf8');
    expect(text.indexOf('# athena:end')).toBeLessThan(text.indexOf('exit 0'));
    expect(text).toContain('echo "user hook ran"');

    if (!isWin) {
      await fs.appendFile(path.join(dir, 'notes.txt'), 'hello\n');
      const c = await commitAll(dir, 'docs', { PATH: withShim() });
      expect(c.code, c.stderr).toBe(0);
      expect(c.stderr).toContain('user hook ran');
    }

    expect((await runCli(['git-hook', 'uninstall'], dir)).stdout).toContain('the rest of the hook is unchanged');
    expect(await fs.readFile(hookPath(dir), 'utf8')).toBe(original);
  });

  it('refuses to modify non-shell hooks and hooks owned by a hook manager', async () => {
    const dir = await initializedRepo();
    const py = '#!/usr/bin/env python3\nprint("hi")\n';
    await fs.writeFile(hookPath(dir), py, { mode: 0o755 });
    const r = await runCli(['git-hook', 'install'], dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not a shell script');
    expect(r.stderr).toContain('npx --no-install athena sync --check');
    expect(await fs.readFile(hookPath(dir), 'utf8')).toBe(py);

    await fs.writeFile(hookPath(dir), '#!/bin/sh\nlefthook run "pre-commit" "$@"\n', { mode: 0o755 });
    const lh = await runCli(['git-hook', 'install'], dir);
    expect(lh.code).toBe(1);
    expect(lh.stderr).toContain('managed by lefthook');

    await fs.rm(hookPath(dir));
    await git(dir, ['config', 'core.hooksPath', '.husky/_']);
    const husky = await runCli(['git-hook', 'install'], dir);
    expect(husky.code).toBe(1);
    expect(husky.stderr).toContain('managed by husky');
    expect(husky.stderr).toContain('npx --no-install athena sync --check');
    await expect(fs.access(path.join(dir, '.husky'))).rejects.toThrow();
  });

  it('follows core.hooksPath', async () => {
    const dir = await initializedRepo();
    await git(dir, ['config', 'core.hooksPath', 'githooks']);
    expect((await runCli(['git-hook', 'install'], dir)).code).toBe(0);
    await expect(fs.access(path.join(dir, 'githooks', 'pre-commit'))).resolves.toBeUndefined();
    await expect(fs.access(hookPath(dir))).rejects.toThrow();
  });
});

describe.skipIf(isWin)('athena git-hook: commits', () => {
  it('blocks a commit when knowledge is stale and allows it once synced; committed knowledge stays in sync', async () => {
    const dir = await initializedRepo();
    expect((await runCli(['git-hook', 'install'], dir)).code).toBe(0);
    const env = { PATH: withShim() };

    await fs.appendFile(path.join(dir, 'src/app.ts'), "app.post('/b', h);\n");
    const blocked = await commitAll(dir, 'add route', env);
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain('commit blocked: .athena/ knowledge is out of date');
    expect(blocked.stderr).toContain('api.md');

    expect((await runCli(['sync', '--yes'], dir)).code).toBe(0);
    const ok = await commitAll(dir, 'add route', env);
    expect(ok.code, ok.stderr).toBe(0);
    expect(ok.stderr).not.toContain('athena:');

    // New commits change Git-history hotspots, which must not block the next commit.
    await fs.appendFile(path.join(dir, 'src/app.ts'), '// note\n');
    const next = await commitAll(dir, 'comment', env);
    expect(next.code, next.stderr).toBe(0);
    const check = await runCli(['sync', '--check', '--json'], dir);
    expect(check.code).toBe(0);
    expect(JSON.parse(check.stdout)).toMatchObject({ inSync: true, stale: [] });
  });

  it('with --review, blocks commits that add a secret without printing it', async () => {
    const dir = await initializedRepo();
    expect((await runCli(['git-hook', 'install', '--review'], dir)).code).toBe(0);
    await fs.writeFile(path.join(dir, 'src/keys.ts'), `export const k = "${FAKE.aws}";\n`);
    await runCli(['sync', '--yes'], dir);
    const c = await commitAll(dir, 'keys', { PATH: withShim() });
    expect(c.code).toBe(1);
    expect(c.stderr).toContain('found blockers');
    expect(c.stderr).toContain('src/keys.ts:1');
    expect(c.stderr).not.toContain(FAKE.aws);
  });

  it('lets commits through when athena is not on PATH, and honours ATHENA_HOOK_COMMAND at install time', async () => {
    const dir = await initializedRepo();
    expect((await runCli(['git-hook', 'install'], dir)).code).toBe(0);
    const noAthena = { PATH: await pathWithoutAthena() };
    await fs.appendFile(path.join(dir, 'src/app.ts'), "app.post('/b', h);\n");
    const c = await commitAll(dir, 'stale but no athena', noAthena);
    expect(c.code, c.stderr).toBe(0);
    expect(c.stderr).toContain('`athena` not found on PATH; skipping');

    // An absolute command baked in at install time works without athena on PATH.
    expect((await runCli(['git-hook', 'install'], dir, { ATHENA_HOOK_COMMAND: shim })).code).toBe(0);
    expect(await fs.readFile(hookPath(dir), 'utf8')).toContain(`command -v ${shim} `);
    await fs.appendFile(path.join(dir, 'src/app.ts'), "app.put('/c', h);\n");
    const blocked = await commitAll(dir, 'stale', noAthena);
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain('knowledge is out of date');
  });

  it('runs Athena in a project inside a subdirectory of the repository', async () => {
    const dir = await makeProject({
      'README.md': '# mono\n',
      'packages/api/package.json': JSON.stringify({ name: 'api', dependencies: { express: '5' } }),
      'packages/api/src/app.ts': "import express from 'express';\nconst app = express();\napp.get('/a', h);\n",
    });
    await gitInit(dir);
    const api = path.join(dir, 'packages/api');
    expect((await runCli(['init', '--no-agents', '--quiet'], api)).code).toBe(0);
    await commitAll(dir, 'knowledge');
    expect((await runCli(['git-hook', 'install'], api)).code).toBe(0);
    expect(await fs.readFile(hookPath(dir), 'utf8')).toContain("-C 'packages/api' sync --check");

    await fs.appendFile(path.join(api, 'src/app.ts'), "app.post('/b', h);\n");
    const blocked = await commitAll(dir, 'route', { PATH: withShim() });
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain('api.md');
  });
});
