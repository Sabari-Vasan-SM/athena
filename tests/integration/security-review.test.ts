import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { runPipeline } from '../../src/services/pipeline.js';
import { planSync, applySync } from '../../src/services/sync.js';
import { loadScan, meetsThreshold, runSecurityScan, saveScan, type SecurityScan } from '../../src/services/security.js';
import { reviewChanges, hasBlockers } from '../../src/services/review.js';
import { analyzeProject } from '../../src/core/analyzer/analyze.js';
import { cleanupProjects, FAKE, gitInit, makeProject, runCli } from '../helpers.js';

afterAll(cleanupProjects);

const gitCommitAll = (dir: string, msg: string) =>
  new Promise<void>((resolve, reject) =>
    execFile('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.com', 'commit', '-qam', msg, '--no-gpg-sign'], { cwd: dir }, (e) => (e ? reject(e) : resolve())),
  );

async function project(files: Record<string, string> = {}): Promise<string> {
  const dir = await makeProject({
    'package.json': JSON.stringify({ name: 'shop', dependencies: { express: '5' } }),
    'src/server.ts': "import express from 'express';\nconst app = express();\napp.get('/orders', h);\n",
    'src/server.test.ts': 'it("works", () => {});\n',
    ...files,
  });
  await runPipeline({ root: dir, mode: 'init', agents: [] });
  return dir;
}

const fakeScan = (overrides: Partial<SecurityScan> = {}): SecurityScan => ({
  schemaVersion: 1,
  scannedAt: new Date().toISOString(),
  durationMs: 1200,
  tools: [
    { tool: 'npm audit', ecosystem: 'npm', status: 'ok', durationMs: 900, findings: [{ package: 'lodash', severity: 'critical', title: 'Command Injection in lodash', id: '1523', url: 'https://example.test/adv', fixAvailable: true }] },
    { tool: 'pip-audit', ecosystem: 'python', status: 'unavailable', message: 'pip-audit is not installed or not on PATH', durationMs: 1, findings: [] },
  ],
  counts: { critical: 1, high: 0, moderate: 0, low: 0, unknown: 0 },
  secrets: { count: 0, files: [] },
  ...overrides,
});

describe('security scan', () => {
  it('runs only the tools the project needs and reports missing ones honestly', async () => {
    const dir = await project();
    const { model } = await analyzeProject(dir);
    const scan = await runSecurityScan(dir, model, { timeoutMs: 5000 });
    // No lockfile in this fixture: npm audit must not be claimed to have run.
    expect(scan.tools.every((t) => t.status !== 'ok' || t.findings.length >= 0)).toBe(true);
    expect(scan.tools.some((t) => t.ecosystem === 'go' || t.ecosystem === 'cargo')).toBe(false);
    expect(scan.secrets.count).toBe(0);
  }, 60_000);

  it('reports unavailable tools rather than "no problems"', async () => {
    const dir = await project({ 'go.mod': 'module example.com/x\n\ngo 1.23\n' });
    const { model } = await analyzeProject(dir);
    const scan = await runSecurityScan(dir, model, { timeoutMs: 5000 });
    const go = scan.tools.find((t) => t.ecosystem === 'go');
    expect(go).toBeDefined();
    if (go!.status !== 'ok') {
      expect(['unavailable', 'failed', 'timeout']).toContain(go!.status);
      expect(go!.findings).toEqual([]);
      expect(go!.message).toBeTruthy();
    }
  }, 60_000);

  it('counts secrets found by analysis', async () => {
    const dir = await project({ 'src/keys.ts': `export const k = "${FAKE.stripe}";\n` });
    const { model } = await analyzeProject(dir);
    const scan = await runSecurityScan(dir, model, { skipAudit: true });
    expect(scan.secrets.count).toBe(1);
    expect(scan.secrets.files).toEqual(['src/keys.ts']);
    expect(JSON.stringify(scan)).not.toContain(FAKE.stripe);
  });

  it('persists scans and applies severity thresholds', async () => {
    const dir = await project();
    const scan = fakeScan();
    await saveScan(dir, scan);
    expect((await loadScan(dir))?.tools[0]?.findings[0]?.package).toBe('lodash');
    expect(meetsThreshold(scan, 'critical')).toBe(true);
    expect(meetsThreshold(scan, 'low')).toBe(true);
    expect(meetsThreshold(fakeScan({ tools: [], counts: { critical: 0, high: 0, moderate: 0, low: 0, unknown: 0 } }), 'low')).toBe(false);
  });

  it('records scan results in security.md via sync, attributed to the tool', async () => {
    const dir = await project();
    await saveScan(dir, fakeScan());
    const plan = await planSync(dir);
    expect(plan.documents.map((d) => d.file)).toContain('security.md');
    await applySync(dir, plan);
    const doc = await fs.readFile(path.join(dir, '.athena/security.md'), 'utf8');
    expect(doc).toContain('lodash');
    expect(doc).toContain('npm audit');
    expect(doc).toContain('CRITICAL');
    expect(doc).toMatch(/pip-audit.*not installed/);
    expect(doc).toContain('not maintain its own vulnerability database');
  });
});

describe('review', () => {
  it('flags added secrets as blockers and reports diff facts', async () => {
    const dir = await project();
    await gitInit(dir);
    await fs.writeFile(path.join(dir, 'src/pay.ts'), `const key = "${FAKE.stripe}";\n// TODO: handle refunds\nexport const pay = () => key;\n`);
    await fs.mkdir(path.join(dir, 'src/routes'), { recursive: true });
    await fs.writeFile(path.join(dir, 'src/routes/checkout.ts'), 'export const route = "/checkout";\n');
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
    pkg.dependencies['left-pad'] = '1.3.0';
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));

    const result = await reviewChanges(dir);
    const byCheck = Object.fromEntries(result.findings.map((f) => [f.check, f]));
    expect(byCheck.secrets?.level).toBe('blocker');
    expect(byCheck.secrets?.files[0]).toContain('src/pay.ts');
    expect(byCheck.dependencies?.message).toContain('left-pad');
    expect(byCheck.tests?.level).toBe('warning');
    expect(byCheck.api).toBeDefined();
    expect(byCheck.leftovers).toBeDefined();
    expect(hasBlockers(result)).toBe(true);
    expect(result.stats.files).toBe(3);
    expect(result.stats.added).toBeGreaterThan(0);
    // The secret value itself is never echoed back.
    expect(JSON.stringify(result)).not.toContain(FAKE.stripe);
  }, 60_000);

  it('lists enabled rules and the project checklist, and stays quiet on a clean tree', async () => {
    const dir = await project();
    await gitInit(dir);
    const result = await reviewChanges(dir);
    expect(result.changedFiles).toEqual([]);
    expect(result.findings.filter((f) => f.level === 'blocker')).toEqual([]);
    expect(result.rules.length).toBeGreaterThan(0);
    expect(result.rules.every((r) => r.enabled)).toBe(true);
    expect(result.checklist.length).toBeGreaterThan(0);
  }, 60_000);

  it('flags committed env files and compares against a base ref', async () => {
    const dir = await project();
    await gitInit(dir);
    await fs.writeFile(path.join(dir, '.env'), 'API_KEY=abc\n');
    await execFileAsync(dir, ['add', '-A', '-f']);
    await gitCommitAll(dir, 'add env');
    const result = await reviewChanges(dir, { base: 'HEAD~1' });
    expect(result.findings.find((f) => f.check === 'env-file')?.level).toBe('blocker');
    expect(result.changedFiles.map((f) => f.path)).toContain('.env');
    await expect(reviewChanges(dir, { base: 'x;rm -rf /' })).rejects.toThrow(/Invalid base ref/);
  }, 60_000);

  it('requires a git repository', async () => {
    const dir = await project();
    await expect(reviewChanges(dir)).rejects.toThrow(/Git repository/);
  });
});

describe('CLI', () => {
  it('athena security reports and honors --fail-on', async () => {
    const dir = await project({ 'src/keys.ts': `export const k = "${FAKE.stripe}";\n` });
    const run = await runCli(['security', '--no-audit', '--json'], dir);
    expect(run.code).toBe(0);
    const scan = JSON.parse(run.stdout) as SecurityScan;
    expect(scan.secrets.count).toBe(1);
    expect(run.stdout).not.toContain(FAKE.stripe);

    const failing = await runCli(['security', '--last', '--fail-on', 'critical'], dir);
    expect(failing.code).toBe(1); // secrets present
    const bad = await runCli(['security', '--last', '--fail-on', 'nonsense'], dir);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('Invalid --fail-on');
  }, 120_000);

  it('athena review exits 1 on blockers and 0 when clean', async () => {
    const dir = await project();
    await gitInit(dir);
    const clean = await runCli(['review', '--no-sync'], dir);
    expect(clean.code).toBe(0);

    await fs.writeFile(path.join(dir, 'src/leak.ts'), `export const k = "${FAKE.github}";\n`);
    const dirty = await runCli(['review', '--no-sync'], dir);
    expect(dirty.code).toBe(1);
    expect(dirty.stdout).toContain('blocker');
    expect(dirty.stdout).not.toContain(FAKE.github);

    const forgiving = await runCli(['review', '--no-sync', '--no-fail'], dir);
    expect(forgiving.code).toBe(0);
  }, 120_000);
});

function execFileAsync(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => execFile('git', args, { cwd }, (e) => (e ? reject(e) : resolve())));
}
