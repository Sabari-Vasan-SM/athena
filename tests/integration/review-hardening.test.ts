import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPipeline } from '../../src/services/pipeline.js';
import { hasBlockers, reviewChanges, type ReviewResult } from '../../src/services/review.js';
import { AthenaError } from '../../src/services/errors.js';
import { cleanupProjects, CLI, FAKE, gitInit, makeProject, REPO_ROOT, runCli } from '../helpers.js';

const isWin = process.platform === 'win32';
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const tmpDirs: string[] = [];
let shimDir = '';

beforeAll(async () => {
  shimDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'athena-shim-')));
  tmpDirs.push(shimDir);
  await fs.writeFile(path.join(shimDir, 'athena'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
}, 120_000);
afterAll(async () => {
  await cleanupProjects();
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});

function git(dir: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) =>
    execFile('git', args, { cwd: dir, env: { ...process.env, ...GIT_ENV, NO_COLOR: '1', ...env } }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, stdout, stderr });
    }),
  );
}
const commit = async (dir: string, msg: string) => {
  await git(dir, ['add', '-A']);
  const r = await git(dir, ['commit', '-q', '--no-gpg-sign', '-m', msg]);
  expect(r.code, r.stderr).toBe(0);
};

/** An initialized Athena project in a Git repo with everything committed. */
async function repo(files: Record<string, string> = {}): Promise<string> {
  const dir = await makeProject({
    'package.json': JSON.stringify({ name: 'shop', dependencies: { express: '5' } }, null, 2),
    'src/server.ts': "import express from 'express';\nconst app = express();\n",
    'src/server.test.ts': 'it("works", () => {});\n',
    ...files,
  });
  await runPipeline({ root: dir, mode: 'init', agents: [] });
  await gitInit(dir);
  return dir;
}

const secretFindings = (r: ReviewResult) => r.findings.filter((f) => f.check === 'secrets');

describe('review: multi-line secrets', () => {
  it('flags a private key in a new file and in a modified file at the right line, without the value', async () => {
    const dir = await repo();
    await fs.writeFile(path.join(dir, 'src/new-key.ts'), `// key\n${FAKE.pem}\n`);
    await fs.appendFile(path.join(dir, 'src/server.ts'), `const k = \`\n${FAKE.pem}\n\`;\n`);
    const r = await reviewChanges(dir);
    const s = secretFindings(r);
    expect(s).toHaveLength(1);
    expect(s[0]!.level).toBe('blocker');
    expect(s[0]!.message).toContain('private-key');
    expect(new Set(s[0]!.files)).toEqual(new Set(['src/new-key.ts:2', 'src/server.ts:4']));
    const json = JSON.stringify(r);
    for (const line of FAKE.pem.split('\n').slice(1, -1)) expect(json).not.toContain(line);

    // The same change, committed and reviewed against a base.
    await commit(dir, 'keys');
    const based = await reviewChanges(dir, { base: 'HEAD~1' });
    expect(new Set(secretFindings(based)[0]?.files)).toEqual(new Set(['src/new-key.ts:2', 'src/server.ts:4']));
  }, 60_000);
});

describe('review: fails closed when Git cannot produce the change', () => {
  it('errors with exit code 2 and a fetch-depth hint for an unknown base', async () => {
    const dir = await repo();
    const err = await reviewChanges(dir, { base: 'origin/main' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AthenaError);
    expect((err as AthenaError).exitCode).toBe(2);
    expect((err as AthenaError).hint).toContain('fetch-depth: 0');

    const cli = await runCli(['review', '--no-sync', '--base', 'origin/main'], dir);
    expect(cli.code).toBe(2);
    expect(cli.stderr).toContain('fetch-depth: 0');
    expect(cli.stdout).not.toContain('No changes');
  }, 60_000);

  it('errors instead of reporting "no changes" in a shallow clone', async () => {
    const src = await repo();
    await fs.writeFile(path.join(src, 'src/leak.ts'), `export const k = "${FAKE.github}";\n`);
    await commit(src, 'leak');
    const cloneParent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'athena-shallow-')));
    tmpDirs.push(cloneParent);
    const clone = path.join(cloneParent, 'c');
    expect((await git(cloneParent, ['clone', '-q', '--depth', '1', `file://${src}`, clone])).code).toBe(0);
    const cli = await runCli(['review', '--no-sync', '--base', 'HEAD~1'], clone);
    expect(cli.code).toBe(2);
    expect(cli.stderr).toContain('fetch-depth: 0');
  }, 60_000);

  it('fails when the diff is larger than the budget instead of truncating it', async () => {
    const dir = await repo();
    await fs.appendFile(path.join(dir, 'src/server.ts'), `${'// filler line\n'.repeat(200)}const k = "${FAKE.github}";\n`);
    await expect(reviewChanges(dir, { maxDiffBytes: 1024 })).rejects.toMatchObject({ exitCode: 2, message: expect.stringMatching(/diff is larger than/) });
    expect(hasBlockers(await reviewChanges(dir))).toBe(true);
  }, 60_000);

  it('stops when interrupted', async () => {
    const dir = await repo();
    const ac = new AbortController();
    ac.abort(new Error('Interrupted'));
    await expect(reviewChanges(dir, { signal: ac.signal })).rejects.toThrow('Interrupted');
  }, 60_000);
});

describe('review: --base uses merge-base..HEAD for both the file list and the patch', () => {
  it('ignores commits that are only on the base branch', async () => {
    const dir = await repo();
    await git(dir, ['branch', '-M', 'main']);
    await git(dir, ['checkout', '-q', '-b', 'feature']);
    await fs.writeFile(path.join(dir, 'src/feature.ts'), 'export const f = 1;\n');
    await commit(dir, 'feature');
    await git(dir, ['checkout', '-q', 'main']);
    await fs.writeFile(path.join(dir, 'src/main-only.ts'), `export const k = "${FAKE.github}";\n`);
    await commit(dir, 'main moved on');
    await git(dir, ['checkout', '-q', 'feature']);

    const r = await reviewChanges(dir, { base: 'main' });
    expect(r.mode).toBe('base');
    expect(r.mergeBase).toMatch(/^[0-9a-f]{40,64}$/);
    expect(r.changedFiles.map((f) => f.path)).toEqual(['src/feature.ts']);
    expect(secretFindings(r)).toEqual([]);
  }, 60_000);
});

describe('review: dependency changes', () => {
  it('reports every dependency of a new manifest and ignores non-dependency keys', async () => {
    const dir = await repo();
    await fs.writeFile(path.join(dir, 'pyproject.toml'), '[project]\nname = "svc"\nversion = "1.0"\ndependencies = ["requests>=2", "flask"]\n');
    await fs.mkdir(path.join(dir, 'crate'));
    await fs.writeFile(path.join(dir, 'crate/Cargo.toml'), '[package]\nname = "c"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nserde = "1"\n');
    const r = await reviewChanges(dir);
    const deps = r.findings.filter((f) => f.check === 'dependencies');
    const py = deps.find((f) => f.files[0] === 'pyproject.toml')!;
    expect(py.message).toBe('New dependencies: requests, flask');
    const cargo = deps.find((f) => f.files[0] === 'crate/Cargo.toml')!;
    expect(cargo.message).toBe('New dependencies: serde');
  }, 60_000);

  it('only reports dependencies that were not there before', async () => {
    const dir = await repo({ 'go.mod': 'module example.com/x\n\ngo 1.23\n\nrequire github.com/a/b v1.0.0\n' });
    await fs.writeFile(path.join(dir, 'go.mod'), 'module example.com/x\n\ngo 1.23\n\nrequire (\n\tgithub.com/a/b v1.0.0\n\tgithub.com/c/d v2.0.0\n)\n');
    const r = await reviewChanges(dir);
    expect(r.findings.find((f) => f.check === 'dependencies')?.message).toBe('New dependencies: github.com/c/d');
  }, 60_000);
});

describe('review --staged', () => {
  it('reviews the index, not the working tree or untracked files', async () => {
    const dir = await repo();
    await fs.writeFile(path.join(dir, '.env'), `GITHUB_TOKEN=${FAKE.github}\n`);
    await fs.appendFile(path.join(dir, 'src/server.ts'), `const k = "${FAKE.stripe}";\n`);
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
    pkg.dependencies['left-pad'] = '1';
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
    await git(dir, ['add', 'package.json']);
    pkg.dependencies['right-pad'] = '1';
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));

    const staged = await reviewChanges(dir, { staged: true });
    expect(staged.mode).toBe('staged');
    expect(staged.changedFiles.map((f) => f.path)).toEqual(['package.json']);
    expect(hasBlockers(staged)).toBe(false);
    expect(staged.findings.find((f) => f.check === 'dependencies')?.message).toBe('New dependencies: left-pad');

    await git(dir, ['add', 'src/server.ts']);
    const withSecret = await reviewChanges(dir, { staged: true });
    expect(secretFindings(withSecret)[0]?.files).toEqual(['src/server.ts:3']);

    await expect(reviewChanges(dir, { staged: true, base: 'HEAD' })).rejects.toThrow(/cannot be combined/);
  }, 60_000);

  it.skipIf(isWin)('the --review pre-commit hook ignores unstaged and untracked files but blocks a staged secret', async () => {
    const dir = await makeProject({ 'package.json': JSON.stringify({ name: 'shop' }), 'src/app.ts': 'export const a = 1;\n' });
    await gitInit(dir);
    expect((await runCli(['init', '--no-agents', '--quiet'], dir)).code).toBe(0);
    await commit(dir, 'knowledge');
    expect((await runCli(['git-hook', 'install', '--review'], dir)).code).toBe(0);
    expect(await fs.readFile(path.join(dir, '.git/hooks/pre-commit'), 'utf8')).toContain('review --staged --no-sync');
    const env = { PATH: `${shimDir}${path.delimiter}${process.env.PATH}` };

    await fs.writeFile(path.join(dir, '.env'), `GITHUB_TOKEN=${FAKE.github}\n`);
    await fs.writeFile(path.join(dir, 'notes.md'), '# notes\n');
    // The hook's knowledge check sees what is staged; stage up-to-date knowledge so only the review decides.
    expect((await runCli(['sync', '--yes'], dir)).code).toBe(0);
    await git(dir, ['add', 'notes.md', '.athena']);
    const ok = await git(dir, ['commit', '-q', '--no-gpg-sign', '-m', 'notes'], env);
    expect(ok.code, ok.stderr).toBe(0);

    await fs.writeFile(path.join(dir, 'notes.md'), `# notes\ntoken ${FAKE.github}\n`);
    await git(dir, ['add', 'notes.md']);
    expect((await runCli(['sync', '--yes'], dir)).code).toBe(0);
    await git(dir, ['add', '.athena']);
    const blocked = await git(dir, ['commit', '-q', '--no-gpg-sign', '-m', 'leak'], env);
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain('found blockers');
    expect(blocked.stderr).toContain('notes.md:2');
    expect(blocked.stderr).not.toContain(FAKE.github);
  }, 120_000);
});

describe.skipIf(isWin)('review: untracked symlinks and large files', () => {
  it('does not follow a symlink out of the project and reports it as skipped', async () => {
    const dir = await repo();
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'athena-outside-')));
    tmpDirs.push(outside);
    await fs.writeFile(path.join(outside, 'creds.txt'), `token ${FAKE.github}\n`);
    await fs.symlink(path.join(outside, 'creds.txt'), path.join(dir, 'creds.txt'));
    await fs.writeFile(path.join(dir, 'big.txt'), 'x'.repeat(600 * 1024));

    const r = await reviewChanges(dir);
    expect(secretFindings(r)).toEqual([]);
    expect(r.incomplete).toBe(true);
    expect(r.skipped).toEqual(expect.arrayContaining([{ path: 'creds.txt', reason: 'outside-root' }, { path: 'big.txt', reason: 'too-large' }]));
    expect(r.findings.find((f) => f.check === 'skipped')?.level).toBe('warning');
    expect(r.findings.find((f) => f.check === 'large-files')?.files).toEqual(['big.txt']);

    const cli = await runCli(['review', '--no-sync'], dir);
    expect(cli.stdout).not.toContain('found nothing to flag');
    expect(cli.stdout).toContain('not checked');
  }, 60_000);
});

describe('review: repository layouts', () => {
  it('works before the first commit and in a project inside a subdirectory', async () => {
    const fresh = await makeProject({ 'package.json': JSON.stringify({ name: 'x', dependencies: { a: '1' } }), 'src/k.ts': `export const k = "${FAKE.github}";\n` });
    await git(fresh, ['init', '-q']);
    const working = await reviewChanges(fresh);
    expect(secretFindings(working)[0]?.files).toEqual(['src/k.ts:1']);
    await git(fresh, ['add', 'src/k.ts', 'package.json']);
    const staged = await reviewChanges(fresh, { staged: true });
    expect(secretFindings(staged)[0]?.files).toEqual(['src/k.ts:1']);
    expect(staged.findings.find((f) => f.check === 'dependencies')?.message).toBe('New dependencies: a');

    const mono = await makeProject({ 'README.md': '# mono\n', 'packages/api/package.json': JSON.stringify({ name: 'api' }), 'packages/api/src/a.ts': 'export const a = 1;\n' });
    await gitInit(mono);
    const api = path.join(mono, 'packages/api');
    await fs.writeFile(path.join(mono, 'README.md'), `# mono\n${FAKE.github}\n`);
    await fs.writeFile(path.join(api, 'package.json'), JSON.stringify({ name: 'api', dependencies: { zod: '3' } }));
    await fs.writeFile(path.join(api, 'src/a.ts'), `export const a = "${FAKE.stripe}";\n`);
    await git(mono, ['add', '-A']);
    const r = await reviewChanges(api, { staged: true });
    expect(r.changedFiles.map((f) => f.path).sort()).toEqual(['package.json', 'src/a.ts']);
    expect(secretFindings(r).flatMap((f) => f.files)).toEqual(['src/a.ts:1']);
    expect(r.findings.find((f) => f.check === 'dependencies')?.message).toBe('New dependencies: zod');
  }, 60_000);
});
