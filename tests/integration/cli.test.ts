import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { CLI, cleanupProjects, FAKE, gitInit, makeProject, REPO_ROOT, runCli } from '../helpers.js';
import { KNOWLEDGE_DOCS } from '../../src/core/knowledge/documents.js';

beforeAll(async () => {
  // CLI tests exercise the built artifact.
  await new Promise<void>((resolve, reject) => execFile('npx', ['tsup'], { cwd: REPO_ROOT, shell: process.platform === 'win32' }, (err) => (err ? reject(err) : resolve())));
  await fs.access(CLI);
}, 120_000);
afterAll(cleanupProjects);

const read = (dir: string, rel: string) => fs.readFile(path.join(dir, rel), 'utf8');

async function sampleProject(): Promise<string> {
  return makeProject({
    'package.json': JSON.stringify({ name: 'shop', description: 'Demo shop', scripts: { test: 'vitest run', dev: 'vite' }, dependencies: { express: '5', pg: '8' }, devDependencies: { vitest: '3' } }),
    'src/server.ts': "import express from 'express';\nconst app = express();\napp.get('/orders', h);\n",
    'src/config.ts': `export const key = "${FAKE.stripe}";\nexport const db = "postgres://app:${FAKE.dbPassword}@db:5432/shop";\n`,
    'CLAUDE.md': '# Team instructions\n\nUse pnpm.\n',
    '.claude/settings.json': '{}',
  });
}

describe('athena CLI', () => {
  it('prints version and help', async () => {
    const v = await runCli(['--version'], REPO_ROOT);
    expect(v.code).toBe(0);
    expect(v.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const h = await runCli(['--help'], REPO_ROOT);
    expect(h.stdout).toContain('init');
    expect(h.stdout).toContain('doctor');
  });

  it('init creates knowledge, never leaks secrets, and preserves existing agent files', async () => {
    const dir = await sampleProject();
    const r = await runCli(['init'], dir);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('Athena ready.');

    for (const d of KNOWLEDGE_DOCS) await expect(fs.access(path.join(dir, '.athena', d.file))).resolves.toBeUndefined();
    const state = JSON.parse(await read(dir, '.athena/state.json'));
    expect(state.schemaVersion).toBe(1);
    expect(state.agents['claude-code'].configured).toBe(true);
    expect(state.agents['cursor']).toBeUndefined();

    // No secret anywhere in .athena/
    for (const f of await fs.readdir(path.join(dir, '.athena'))) {
      if (f.startsWith('.backup')) continue;
      const text = await read(dir, `.athena/${f}`);
      expect(text, f).not.toContain(FAKE.stripe);
      expect(text, f).not.toContain(FAKE.dbPassword);
    }
    const security = await read(dir, '.athena/security.md');
    expect(security).toMatch(/stripe-key.*src\/config\.ts:1/);

    const claude = await read(dir, 'CLAUDE.md');
    expect(claude.startsWith('# Team instructions\n\nUse pnpm.\n')).toBe(true);
    expect(claude).toContain('@.athena/rules.md');
    expect(await read(dir, 'AGENTS.md')).toContain('<!-- athena:start -->');

    const again = await runCli(['init'], dir);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('already initialized');
  });

  it('analyze is idempotent and preserves developer edits', async () => {
    const dir = await sampleProject();
    expect((await runCli(['init', '--no-agents'], dir)).code).toBe(0);
    const before = await Promise.all(KNOWLEDGE_DOCS.map((d) => read(dir, `.athena/${d.file}`)));

    const r = await runCli(['analyze', '--json'], dir);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.documents.every((d: { status: string }) => d.status === 'unchanged')).toBe(true);
    const after = await Promise.all(KNOWLEDGE_DOCS.map((d) => read(dir, `.athena/${d.file}`)));
    expect(after).toEqual(before);

    // Edit developer notes and a generated section
    const apiPath = path.join(dir, '.athena/api.md');
    let api = await fs.readFile(apiPath, 'utf8');
    api = api.replace('<!-- Knowledge Athena cannot detect', 'All endpoints require JWT.\n\n<!-- Knowledge Athena cannot detect');
    api = api.replace('## Endpoints', '## Endpoints\n\nHand-curated note inside a generated section.');
    await fs.writeFile(apiPath, api);
    await fs.appendFile(path.join(dir, 'src/server.ts'), "app.post('/refunds', h);\n");

    const r2 = await runCli(['analyze', '--json'], dir);
    const out2 = JSON.parse(r2.stdout);
    expect(out2.documents.find((d: { file: string }) => d.file === 'api.md').preservedModified).toEqual(['endpoints']);
    const api2 = await read(dir, '.athena/api.md');
    expect(api2).toContain('All endpoints require JWT.');
    expect(api2).toContain('Hand-curated note');
    expect(api2).not.toContain('/refunds');

    await runCli(['analyze', '--force'], dir);
    const api3 = await read(dir, '.athena/api.md');
    expect(api3).toContain('/refunds');
    expect(api3).toContain('All endpoints require JWT.');
  });

  it('status reports changes and affected documents', async () => {
    const dir = await sampleProject();
    await gitInit(dir);
    await runCli(['init'], dir);
    const clean = JSON.parse((await runCli(['status', '--json'], dir)).stdout);
    expect(clean.health).toBe('healthy');
    expect(clean.sync).toBe('up-to-date');

    await fs.appendFile(path.join(dir, 'src/server.ts'), "app.get('/x', h);\n");
    await fs.writeFile(path.join(dir, 'Dockerfile'), 'FROM node:22\n');
    const s = JSON.parse((await runCli(['status', '--json'], dir)).stdout);
    expect(s.sync).toBe('needs-update');
    expect(s.changes.modified).toEqual(['src/server.ts']);
    expect(s.changes.added).toEqual(['Dockerfile']);
    expect(s.affectedDocuments.map((a: { file: string }) => a.file)).toEqual(expect.arrayContaining(['deployment.md', 'project.md']));
    expect(s.git.uncommitted).toBeGreaterThan(0);

    const text = await runCli(['status'], dir);
    expect(text.stdout).toContain('Athena Status');
    expect(text.stdout).toContain('Needs update');
  });

  it('rules commands edit rules.md in place', async () => {
    const dir = await sampleProject();
    await runCli(['init', '--no-agents'], dir);
    expect((await runCli(['rules', 'add', 'Every table needs tenant_id', '--section', 'Database'], dir)).code).toBe(0);
    const list = JSON.parse((await runCli(['rules', 'list', '--json'], dir)).stdout) as Array<{ index: number; text: string; enabled: boolean }>;
    const rule = list.find((r) => r.text === 'Every table needs tenant_id')!;
    expect(rule.enabled).toBe(true);
    expect((await runCli(['rules', 'disable', String(rule.index)], dir)).code).toBe(0);
    expect(await read(dir, '.athena/rules.md')).toContain('- [disabled] Every table needs tenant_id');
    const bad = await runCli(['rules', 'enable', '999'], dir);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/No rule #999/);
  });

  it('recovers from a corrupted state.json', async () => {
    const dir = await sampleProject();
    await runCli(['init', '--no-agents'], dir);
    await fs.writeFile(path.join(dir, '.athena/state.json'), '{ corrupted');
    const doctor = await runCli(['doctor'], dir);
    expect(doctor.code).toBe(1);
    expect(doctor.stdout).toMatch(/corrupted/);
    const r = await runCli(['analyze'], dir);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/corrupted/);
    const backups = await fs.readdir(path.join(dir, '.athena/.backup'));
    expect(backups.length).toBe(1);
    expect((await runCli(['doctor'], dir)).code).toBe(0);
  });

  it('dry run writes nothing', async () => {
    const dir = await sampleProject();
    const r = await runCli(['init', '--dry-run', '--agents', 'all'], dir);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('Dry run');
    await expect(fs.access(path.join(dir, '.athena'))).rejects.toThrow();
    await expect(fs.access(path.join(dir, '.cursor'))).rejects.toThrow();
    expect(await read(dir, 'CLAUDE.md')).toBe('# Team instructions\n\nUse pnpm.\n');
  });

  it('configures and removes every agent integration', async () => {
    const dir = await sampleProject();
    await runCli(['init', '--agents', 'all'], dir);
    expect(await read(dir, '.cursor/rules/athena.mdc')).toMatch(/^---\n[\s\S]*alwaysApply: true/);
    const ag = await read(dir, '.agents/rules/athena.md');
    expect(ag.length).toBeLessThan(12_000);
    const doctor = await runCli(['doctor', '--json'], dir);
    expect(JSON.parse(doctor.stdout).ok).toBe(true);

    expect((await runCli(['agents', 'remove', 'cursor', 'claude'], dir)).code).toBe(0);
    await expect(fs.access(path.join(dir, '.cursor/rules/athena.mdc'))).rejects.toThrow();
    expect(await read(dir, 'CLAUDE.md')).toBe('# Team instructions\n\nUse pnpm.\n');

    const clean = await runCli(['clean', '--yes'], dir);
    expect(clean.code).toBe(0);
    await expect(fs.access(path.join(dir, '.athena'))).rejects.toThrow();
    await expect(fs.access(path.join(dir, 'AGENTS.md'))).rejects.toThrow();
  });

  it('does not overwrite a user file at an Athena-owned path', async () => {
    const dir = await makeProject({ '.cursor/rules/athena.mdc': 'my own rule' });
    await runCli(['init', '--agents', 'cursor'], dir);
    expect(await read(dir, '.cursor/rules/athena.mdc')).toBe('my own rule');
  });

  it('uses meaningful exit codes', async () => {
    const dir = await makeProject({ 'a.txt': 'x' });
    const notInit = await runCli(['status'], dir);
    expect(notInit.code).toBe(3);
    expect(notInit.stderr).toContain('athena init');
    const planned = await runCli(['security'], dir);
    expect(planned.code).toBe(2);
    expect(planned.stdout).toContain('Not available yet');
    const unknown = await runCli(['init', '--agents', 'copilotx'], dir);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('Unknown agent');
  });

  it('works in a subdirectory of a git repository and via --cwd', async () => {
    const dir = await makeProject({ 'services/api/package.json': JSON.stringify({ name: 'api', dependencies: { hono: '4' } }), 'README.md': '#' });
    await gitInit(dir);
    const sub = path.join(dir, 'services/api');
    const r = await runCli(['init', '--no-agents', '--cwd', sub], dir);
    expect(r.code, r.stderr).toBe(0);
    await fs.writeFile(path.join(sub, 'index.ts'), 'export {}');
    await fs.writeFile(path.join(dir, 'README.md'), 'outside change');
    const s = JSON.parse((await runCli(['status', '--json'], sub)).stdout);
    expect(s.changes.added).toEqual(['index.ts']);
    expect(s.git.uncommitted).toBe(1);
  });
});

describe('agent presence detection', () => {
  it('does not count files Athena created as evidence of an agent', async () => {
    const { ADAPTERS } = await import('../../src/agents/registry.js');
    const dir = await makeProject({ 'a.txt': 'x' });
    await runCli(['init', '--agents', 'all'], dir);
    for (const a of ADAPTERS) expect((await a.detectPresence(dir)).evidence, a.id).toEqual([]);

    await fs.writeFile(path.join(dir, '.cursor/rules/team.mdc'), 'team rule');
    await fs.appendFile(path.join(dir, 'CLAUDE.md'), '\nUse pnpm.\n');
    const byId = Object.fromEntries(await Promise.all(ADAPTERS.map(async (a) => [a.id, (await a.detectPresence(dir)).evidence])));
    expect(byId['cursor']).toEqual(['.cursor']);
    expect(byId['claude-code']).toEqual(['CLAUDE.md']);
    expect(byId['antigravity']).toEqual([]);
  });
});

describe('build output', () => {
  it('rebuilding the CLI does not delete the web UI build', async () => {
    const marker = path.join(REPO_ROOT, 'dist/web/keep-test.html');
    await fs.mkdir(path.dirname(marker), { recursive: true });
    await fs.writeFile(marker, 'x');
    try {
      await new Promise<void>((resolve, reject) => execFile('npx', ['tsup'], { cwd: REPO_ROOT, shell: process.platform === 'win32' }, (err) => (err ? reject(err) : resolve())));
      await expect(fs.access(marker)).resolves.toBeUndefined();
    } finally {
      await fs.rm(marker, { force: true });
    }
  }, 120_000);
});

describe('athena sync (CLI)', () => {
  it('checks, dry-runs, refuses to apply without confirmation, and applies with --yes', async () => {
    const dir = await makeProject({ 'package.json': JSON.stringify({ name: 'shop', dependencies: { express: '5' } }), 'src/app.ts': "import express from 'express';\nconst app = express();\napp.get('/a', h);\n" });
    await runCli(['init', '--no-agents'], dir);
    expect((await runCli(['sync', '--check'], dir)).code).toBe(0);

    await fs.appendFile(path.join(dir, 'src/app.ts'), "app.post('/b', h);\n");
    const check = await runCli(['sync', '--check', '--json'], dir);
    expect(check.code).toBe(1);
    expect(JSON.parse(check.stdout).documents.map((d: { file: string }) => d.file)).toContain('api.md');

    const before = await read(dir, '.athena/api.md');
    const dry = await runCli(['sync', '--dry-run', '--diff'], dir);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain('+| POST | `/b`');
    const noTty = await runCli(['sync'], dir);
    expect(noTty.stdout).toContain('confirmation required');
    expect(await read(dir, '.athena/api.md')).toBe(before);

    const yes = await runCli(['sync', '--yes'], dir);
    expect(yes.code, yes.stderr).toBe(0);
    expect(yes.stdout).toContain('Updated');
    expect(await read(dir, '.athena/api.md')).toContain('/b');
    expect((await runCli(['sync', '--check'], dir)).code).toBe(0);
  });
});
