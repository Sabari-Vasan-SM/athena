import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI, cleanupProjects, FAKE, gitInit, makeProject, REPO_ROOT, runCli, type CliResult } from '../helpers.js';

const REPORT = path.join(REPO_ROOT, 'action', 'report.mjs');

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => execFile('npx', ['tsup'], { cwd: REPO_ROOT, shell: process.platform === 'win32' }, (err) => (err ? reject(err) : resolve())));
  await fs.access(CLI);
}, 120_000);
afterAll(cleanupProjects);

function report(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [REPORT, ...args], { env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

function git(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('git', args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))),
  );
}

describe('GitHub Action', () => {
  it('action.yml declares the documented inputs and outputs, and never interpolates expressions into scripts', async () => {
    const action = YAML.parse(await fs.readFile(path.join(REPO_ROOT, 'action.yml'), 'utf8'));
    expect(action.runs.using).toBe('composite');
    expect(Object.keys(action.inputs)).toEqual(['check-sync', 'review', 'review-base', 'comment', 'version', 'working-directory', 'github-token']);
    expect(action.inputs['check-sync'].default).toBe('true');
    expect(action.inputs.review.default).toBe('true');
    expect(action.inputs.comment.default).toBe('false');
    expect(action.inputs.version.default).toBe('latest');
    expect(Object.keys(action.outputs)).toEqual(['in-sync', 'blockers']);
    for (const step of action.runs.steps) {
      if (step.run) {
        expect(step.shell, step.name).toBe('bash');
        expect(step.run, step.name).not.toContain('${{');
      }
    }
    const example = YAML.parse(await fs.readFile(path.join(REPO_ROOT, 'examples', 'github-workflow.yml'), 'utf8'));
    const steps = Object.values(example.jobs as Record<string, { steps: Array<{ uses?: string; with?: Record<string, unknown> }> }>)[0]!.steps;
    expect(steps.find((s) => s.uses?.startsWith('actions/checkout'))?.with?.['fetch-depth']).toBe(0);
    expect(steps.some((s) => s.uses?.startsWith('Sabari-Vasan-SM/athena@'))).toBe(true);
  });

  it('turns real sync and review JSON into outputs and a PR comment without secret values', async () => {
    const dir = await makeProject({ 'package.json': JSON.stringify({ name: 'shop', dependencies: { express: '5' } }), 'src/app.ts': "import express from 'express';\nconst app = express();\napp.get('/a', h);\n" });
    await gitInit(dir);
    expect((await runCli(['init', '--no-agents', '--quiet'], dir)).code).toBe(0);
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-q', '--no-gpg-sign', '-m', 'knowledge']);
    const base = await git(dir, ['rev-parse', 'HEAD']);
    await fs.writeFile(path.join(dir, 'src/keys.ts'), `export const k = "${FAKE.aws}";\n`);
    await fs.writeFile(path.join(dir, '.env.production'), 'API_KEY=x\n');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-q', '--no-gpg-sign', '-m', 'pr']);

    const sync = await runCli(['sync', '--check', '--json'], dir);
    expect(sync.code).toBe(1);
    const review = await runCli(['review', '--base', base, '--no-sync', '--json'], dir);
    expect(review.code).toBe(1);
    const syncFile = path.join(dir, 'sync.json');
    const reviewFile = path.join(dir, 'review.json');
    await fs.writeFile(syncFile, sync.stdout);
    await fs.writeFile(reviewFile, review.stdout);

    const outFile = path.join(dir, 'github-output');
    await fs.writeFile(outFile, '');
    const s = await report(['sync', syncFile], { GITHUB_OUTPUT: outFile });
    expect(s.code).toBe(0);
    expect(s.stdout).toContain('::error::Athena knowledge (.athena/) is out of date');
    const r = await report(['review', reviewFile], { GITHUB_OUTPUT: outFile });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('[blocker] Possible aws-access-key-id added (secrets): src/keys.ts:1');
    expect(await fs.readFile(outFile, 'utf8')).toBe('in-sync=false\nblockers=2\n');

    const m = await report(['markdown', reviewFile, syncFile]);
    expect(m.code).toBe(0);
    expect(m.stdout.startsWith('<!-- athena-review -->\n### Athena review\n')).toBe(true);
    expect(m.stdout).toContain('- **Blocker**: Possible aws-access-key-id added (`secrets`) in `src/keys.ts:1`');
    expect(m.stdout).toContain('- **Blocker**: Environment file included in the change (`env-file`) in `.env.production`');
    expect(m.stdout).toContain('**Athena knowledge is out of date:**');
    expect(m.stdout).toContain('**2 blockers found.**');
    for (const out of [s.stdout, r.stdout, m.stdout]) expect(out).not.toContain(FAKE.aws);
  });

  it('reports Athena errors and escapes untrusted text', async () => {
    const dir = await makeProject({});
    const errFile = path.join(dir, 'err.json');
    await fs.writeFile(errFile, JSON.stringify({ error: 'Athena is not initialized in this project.', hint: 'Run `athena init` in the project root.' }));
    const outFile = path.join(dir, 'github-output');
    const s = await report(['sync', errFile], { GITHUB_OUTPUT: outFile });
    expect(s.code).toBe(2);
    expect(s.stdout).toContain('::error::athena sync --check failed: Athena is not initialized');
    expect(await fs.readFile(outFile, 'utf8')).toBe('in-sync=false\n');

    const hostile = path.join(dir, 'hostile.json');
    await fs.writeFile(hostile, JSON.stringify({ base: 'abc', stats: { files: 1, added: 1, removed: 0 }, findings: [{ level: 'info', check: 'dependencies', message: 'New dependencies: <img src=x>\n::set-output name=x::y', files: ['a`b.ts'] }] }));
    const r = await report(['review', hostile]);
    expect(r.stdout.split('\n').some((l) => l.startsWith('::set-output'))).toBe(false);
    const m = await report(['markdown', hostile]);
    expect(m.stdout).toContain('&lt;img src=x&gt;');
    expect(m.stdout).toContain('`ab.ts`');
  });
});
