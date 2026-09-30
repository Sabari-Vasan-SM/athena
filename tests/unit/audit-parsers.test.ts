import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  AuditToolError,
  meetsThreshold,
  parseComposerAudit,
  parseGovulncheck,
  parseNpmAudit,
  parsePipAudit,
  parsePnpmAudit,
  planPipAudit,
  runSecurityScan,
  type SecurityScan,
} from '../../src/services/security.js';
import { SecurityScan as SecurityScanSchema } from '../../src/core/model/security-scan.js';
import { emptyModel } from '../../src/core/model/project-model.js';
import { cleanupProjects, makeProject, REPO_ROOT } from '../helpers.js';

const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures', 'audit');
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf8');

afterAll(cleanupProjects);

describe('npm audit parser', () => {
  it('parses npm ≥7 vulnerabilities', () => {
    const v = parseNpmAudit(fixture('npm-v7.json'));
    expect(v.map((x) => [x.package, x.severity])).toEqual([
      ['lodash', 'high'],
      ['mkdirp', 'critical'],
      ['minimist', 'critical'],
    ]);
    expect(v[0]).toMatchObject({ title: 'Command Injection in lodash', id: '1106913', fixAvailable: true });
    expect(v[1]!.title).toContain('minimist');
  });

  it('parses a clean report as no findings', () => {
    expect(parseNpmAudit(fixture('npm-clean.json'))).toEqual([]);
  });

  it('treats an {error} report (e.g. offline) as a failure, not as clean', () => {
    expect(() => parseNpmAudit(fixture('npm-error.json'))).toThrow(AuditToolError);
    expect(() => parseNpmAudit(fixture('npm-error.json'))).toThrow(/ENOTFOUND/);
  });

  it('rejects empty or unrecognised output', () => {
    expect(() => parseNpmAudit('')).toThrow();
    expect(() => parseNpmAudit('{}')).toThrow(AuditToolError);
    expect(() => parseNpmAudit('not json')).toThrow();
  });

  it('reads npm ≤6 legacy advisories', () => {
    expect(parseNpmAudit(fixture('pnpm-advisories.json')).map((x) => x.package).sort()).toEqual(['lodash', 'minimist', 'old-thing']);
  });
});

describe('pnpm audit parser', () => {
  it('parses the legacy advisories shape', () => {
    const v = parsePnpmAudit(fixture('pnpm-advisories.json'));
    const byPkg = Object.fromEntries(v.map((x) => [x.package, x]));
    expect(Object.keys(byPkg).sort()).toEqual(['lodash', 'minimist', 'old-thing']);
    expect(byPkg.lodash).toMatchObject({ severity: 'high', title: 'Command Injection in lodash', id: 'GHSA-35jh-r3h4-6jhm', url: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm', fixAvailable: true });
    expect(byPkg.lodash!.vulnerableRange).toContain('<4.17.21');
    expect(byPkg.lodash!.vulnerableRange).toContain('4.17.20');
    expect(byPkg.minimist!.severity).toBe('critical');
    expect(byPkg['old-thing']).toMatchObject({ severity: 'moderate', fixAvailable: false });
  });

  it('does not report a pnpm advisories report as clean (the npm ≥7 parser used to)', () => {
    expect(parsePnpmAudit(fixture('pnpm-advisories.json')).length).toBe(3);
  });

  it('fails on error output and on output without advisories', () => {
    expect(() => parsePnpmAudit('{"error":{"code":"ERR_PNPM_AUDIT_BAD_RESPONSE","message":"The audit endpoint responded with 503"}}')).toThrow(/ERR_PNPM_AUDIT_BAD_RESPONSE/);
    expect(() => parsePnpmAudit(fixture('npm-v7.json'))).toThrow(AuditToolError);
  });
});

describe('pip-audit parser', () => {
  it('parses dependencies, marks findings unrated, ignores skipped deps', () => {
    const v = parsePipAudit(fixture('pip-audit.json'));
    expect(v).toHaveLength(2);
    expect(v.every((x) => x.package === 'flask' && x.severity === 'unrated' && x.fixAvailable)).toBe(true);
    expect(v[0]).toMatchObject({ id: 'PYSEC-2019-179', vulnerableRange: 'installed 0.5' });
  });

  it('rejects output without a dependencies list', () => {
    expect(() => parsePipAudit('{"error":"boom"}')).toThrow(AuditToolError);
    expect(() => parsePipAudit('')).toThrow();
  });
});

describe('govulncheck parser', () => {
  it('parses the pretty-printed JSON stream (which the line-based parser missed)', () => {
    const v = parseGovulncheck(fixture('govulncheck.json'));
    const byId = Object.fromEntries(v.map((x) => [x.id, x]));
    expect(Object.keys(byId).sort()).toEqual(['GO-2021-0113', 'GO-2022-1059']);
    expect(byId['GO-2022-1059']).toMatchObject({ package: 'golang.org/x/text', severity: 'unrated', vulnerableRange: 'installed v0.3.7', fixAvailable: true, url: 'https://pkg.go.dev/vuln/GO-2022-1059' });
    expect(byId['GO-2022-1059']!.title).toContain('called by your code');
    expect(byId['GO-2021-0113']!.title).toContain('module required');
  });

  it('parses the single-line stream too', () => {
    expect(parseGovulncheck(fixture('govulncheck.ndjson')).map((x) => x.id)).toEqual(['GO-2022-1059']);
  });

  it('distinguishes a clean report from no report', () => {
    expect(parseGovulncheck(fixture('govulncheck-clean.json'))).toEqual([]);
    expect(() => parseGovulncheck('')).toThrow(AuditToolError);
    expect(() => parseGovulncheck('go: cannot find main module')).toThrow(AuditToolError);
  });
});

describe('composer audit parser', () => {
  it('accepts the empty-array form and rejects missing advisories', () => {
    expect(parseComposerAudit('{"advisories":[],"abandoned":[]}')).toEqual([]);
    expect(() => parseComposerAudit('{}')).toThrow(AuditToolError);
  });
});

describe('unrated severity', () => {
  const scanWith = (severity: string): SecurityScan =>
    SecurityScanSchema.parse({
      schemaVersion: 1,
      scannedAt: new Date().toISOString(),
      durationMs: 1,
      tools: [{ tool: 'pip-audit', ecosystem: 'python', status: 'ok', durationMs: 1, findings: [{ package: 'flask', severity, title: 'x' }] }],
      counts: { critical: 0, high: 0, moderate: 0, low: 0, unknown: 1 },
      secrets: { count: 0, files: [] },
    });

  it('reads legacy "unknown" as "unrated"', () => {
    const scan = scanWith('unknown');
    expect(scan.tools[0]!.findings[0]!.severity).toBe('unrated');
    expect(scan.counts.unrated).toBe(1);
  });

  it('unrated findings meet every threshold unless unrated=warn', () => {
    const scan = scanWith('unrated');
    expect(meetsThreshold(scan, 'critical')).toBe(true);
    expect(meetsThreshold(scan, 'critical', { unrated: 'fail' })).toBe(true);
    expect(meetsThreshold(scan, 'low', { unrated: 'warn' })).toBe(false);
  });
});

describe('pip-audit targets', () => {
  it('audits requirements files, never the ambient environment', async () => {
    const dir = await makeProject({ 'requirements.txt': 'flask==0.5\n', 'requirements-dev.txt': 'pytest\n' });
    const plan = await planPipAudit({ root: dir, files: ['requirements-dev.txt', 'requirements.txt', 'src/app.py'] });
    expect(Array.isArray(plan)).toBe(true);
    const invs = plan as Exclude<typeof plan, string>;
    expect(invs.map((i) => i.target)).toEqual(['requirements-dev.txt', 'requirements.txt']);
    for (const i of invs) expect(i.args.slice(0, 2)).toEqual(['-r', i.target]);
  });

  it('audits a PEP 621 pyproject.toml as a project path', async () => {
    const dir = await makeProject({ 'pyproject.toml': '[project]\nname = "x"\ndependencies = ["flask==0.5"]\n' });
    const plan = await planPipAudit({ root: dir, files: ['pyproject.toml'] });
    expect(plan).toEqual([{ target: 'pyproject.toml', args: ['--format', 'json', '--progress-spinner', 'off', '.'] }]);
  });

  it('reports nothing to audit instead of scanning the active environment', async () => {
    const dir = await makeProject({ 'Pipfile': '[packages]\nflask = "*"\n', 'pyproject.toml': '[tool.poetry]\nname = "x"\n' });
    const plan = await planPipAudit({ root: dir, files: ['Pipfile', 'pyproject.toml'] });
    expect(typeof plan).toBe('string');
    expect(plan).toMatch(/no requirements file to audit/);
  });
});

describe('runSecurityScan with fake audit tools', () => {
  const originalPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = originalPath;
  });

  async function fakeBin(dir: string, name: string, script: string): Promise<void> {
    const bin = path.join(dir, '.fakebin');
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
  }

  it.skipIf(process.platform === 'win32')('npm audit {error} output is reported as failed, not clean', async () => {
    const dir = await makeProject({ 'package.json': '{"name":"x"}', 'package-lock.json': '{"lockfileVersion":3}', '.gitignore': '.fakebin\n' });
    await fakeBin(dir, 'npm', `cat '${path.join(FIXTURES, 'npm-error.json')}'\nexit 1`);
    const scan = await runSecurityScan(dir, emptyModel('x', dir), { timeoutMs: 10_000 });
    const npm = scan.tools.find((t) => t.tool === 'npm audit');
    expect(npm?.status).toBe('failed');
    expect(npm?.message).toMatch(/ENOTFOUND/);
  });

  it.skipIf(process.platform === 'win32')('npm audit exiting 1 with vulnerabilities is a successful run', async () => {
    const dir = await makeProject({ 'package.json': '{"name":"x"}', 'package-lock.json': '{"lockfileVersion":3}', '.gitignore': '.fakebin\n' });
    await fakeBin(dir, 'npm', `cat '${path.join(FIXTURES, 'npm-v7.json')}'\nexit 1`);
    const scan = await runSecurityScan(dir, emptyModel('x', dir), { timeoutMs: 10_000 });
    const npm = scan.tools.find((t) => t.tool === 'npm audit');
    expect(npm?.status).toBe('ok');
    expect(npm?.findings).toHaveLength(3);
    expect(scan.counts.critical).toBe(2);
  });

  it.skipIf(process.platform === 'win32')('pnpm audit findings are reported', async () => {
    const dir = await makeProject({ 'package.json': '{"name":"x"}', 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n", '.gitignore': '.fakebin\n' });
    await fakeBin(dir, 'pnpm', `cat '${path.join(FIXTURES, 'pnpm-advisories.json')}'\nexit 1`);
    const scan = await runSecurityScan(dir, emptyModel('x', dir), { timeoutMs: 10_000 });
    const pnpm = scan.tools.find((t) => t.tool === 'pnpm audit');
    expect(pnpm?.status).toBe('ok');
    expect(pnpm?.findings.map((f) => f.package).sort()).toEqual(['lodash', 'minimist', 'old-thing']);
  });

  it.skipIf(process.platform === 'win32')('pip-audit is pointed at each requirements file', async () => {
    const dir = await makeProject({ 'requirements.txt': 'flask==0.5\n', 'services/api/requirements.txt': 'requests\n', '.gitignore': '.fakebin\nargs.log\n' });
    const log = path.join(dir, 'args.log');
    await fakeBin(dir, 'pip-audit', `echo "$@" >> '${log}'\ncat '${path.join(FIXTURES, 'pip-audit.json')}'\nexit 1`);
    const scan = await runSecurityScan(dir, emptyModel('x', dir), { timeoutMs: 10_000 });
    const pip = scan.tools.filter((t) => t.tool === 'pip-audit');
    expect(pip.map((t) => [t.target, t.status])).toEqual([
      ['requirements.txt', 'ok'],
      ['services/api/requirements.txt', 'ok'],
    ]);
    expect(scan.counts.unrated).toBe(4);
    const calls = (await fs.readFile(log, 'utf8')).trim().split('\n');
    expect(calls).toEqual(['-r requirements.txt --format json --progress-spinner off', '-r services/api/requirements.txt --format json --progress-spinner off']);
  });

  it.skipIf(process.platform === 'win32')('pip-audit is not run without an auditable input', async () => {
    const dir = await makeProject({ 'setup.py': 'from setuptools import setup\nsetup(name="x")\n', '.gitignore': '.fakebin\nargs.log\n' });
    const log = path.join(dir, 'args.log');
    await fakeBin(dir, 'pip-audit', `echo "$@" >> '${log}'\ncat '${path.join(FIXTURES, 'pip-audit.json')}'`);
    const model = emptyModel('x', dir);
    model.manifests.push({ path: 'setup.py', ecosystem: 'python' } as (typeof model.manifests)[number]);
    const scan = await runSecurityScan(dir, model, { timeoutMs: 10_000 });
    const pip = scan.tools.find((t) => t.tool === 'pip-audit');
    expect(pip?.status).toBe('unavailable');
    expect(pip?.message).toMatch(/no requirements file to audit/);
    await expect(fs.access(log)).rejects.toThrow();
  });
});
