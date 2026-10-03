import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI, cleanupProjects, FAKE, gitInit, makeProject, REPO_ROOT, runCli, type CliResult } from '../helpers.js';

const REPORT = path.join(REPO_ROOT, 'action', 'report.mjs');

beforeAll(async () => {
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
    // File annotations: with a line where the finding has one, without otherwise.
    expect(r.stdout).toContain('::error file=src/keys.ts,line=1,title=Athena%3A secrets::Possible aws-access-key-id added');
    expect(r.stdout).toMatch(/^::error file=\.env\.production,title=Athena%3A env-file::Environment file included/m);

    const m = await report(['markdown', reviewFile, syncFile]);
    expect(m.code).toBe(0);
    expect(m.stdout.startsWith('<!-- athena-review:v1 -->\n### Athena review\n')).toBe(true);
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

describe('GitHub Action PR comment and annotations', () => {
  const comments = (list: unknown[]) => list.map((c) => JSON.stringify(c)).join('\n');

  it('only updates a comment authored by github-actions[bot] that carries the marker', async () => {
    const dir = await makeProject({});
    const file = path.join(dir, 'comments.jsonl');
    const find = async (list: unknown[]) => {
      await fs.writeFile(file, comments(list));
      const r = await report(['find-comment', file]);
      expect(r.code).toBe(0);
      return r.stdout.trim();
    };
    // Someone else quoting the marker (or a different bot) is never matched.
    expect(await find([
      { id: 1, login: 'mallory', body: '<!-- athena-review:v1 -->\nfake' },
      { id: 2, login: 'renovate[bot]', body: '<!-- athena-review:v1 -->' },
      { id: 3, login: 'github-actions[bot]', body: 'CI summary without marker' },
    ])).toBe('');
    expect(await find([
      { id: 1, login: 'mallory', body: '<!-- athena-review:v1 -->' },
      { id: 42, login: 'github-actions[bot]', body: '<!-- athena-review:v1 -->\n### Athena review' },
    ])).toBe('42');
    // The pre-v1 marker from the same bot is recognised so old comments get upgraded.
    expect(await find([{ id: 7, login: 'github-actions[bot]', body: '<!-- athena-review -->\n### Athena review' }])).toBe('7');
    // Garbage lines and non-numeric ids are ignored.
    expect(await find(['not json', { id: 'x; rm -rf /', login: 'github-actions[bot]', body: '<!-- athena-review:v1 -->' }] as unknown[])).toBe('');
    // Missing file: no comment.
    expect((await report(['find-comment', path.join(dir, 'missing.jsonl')])).stdout).toBe('');

    const action = await fs.readFile(path.join(REPO_ROOT, 'action.yml'), 'utf8');
    expect(action).toContain('report.mjs" find-comment');
    expect(action).not.toContain('.user.type == "Bot"');
  });

  it('emits escaped file annotations without secret values', async () => {
    const dir = await makeProject({});
    const f = path.join(dir, 'review.json');
    await fs.writeFile(
      f,
      JSON.stringify({
        base: 'abc',
        stats: { files: 3, added: 3, removed: 0 },
        findings: [
          { level: 'blocker', check: 'secrets', message: 'Possible stripe-key added', files: ['src/a,b:c.ts:12'], hint: 'Rotate it.' },
          { level: 'warning', check: 'tests', message: 'Source changed without tests\n::error::injected', files: ['src/x.ts'] },
          { level: 'info', check: 'dependencies', message: 'New dependencies', files: ['package.json'] },
        ],
      }),
    );
    const r = await report(['review', f]);
    const lines = r.stdout.split('\n');
    expect(lines).toContain('::error file=src/a%2Cb%3Ac.ts,line=12,title=Athena%3A secrets::Possible stripe-key added Rotate it.');
    expect(lines).toContain('::warning file=src/x.ts,title=Athena%3A tests::Source changed without tests%0A::error::injected');
    expect(lines.some((l) => l.startsWith('::error::injected'))).toBe(false);
    expect(lines.some((l) => l.includes('package.json') && l.startsWith('::'))).toBe(false);
  });
});
