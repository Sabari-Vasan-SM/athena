import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { AthenaConfig } from '../../src/core/config.js';
import { Finding } from '../../src/core/findings/finding.js';
import { loadFindings, loadFindingsWithSource, migrateLegacyScan, saveFindings } from '../../src/core/findings/store.js';
import { saveScan as saveLegacyScan, type SecurityScan } from '../../src/core/model/security-scan.js';
import { auditDependencies, auditFindings, parseNpmAudit, parsePipAudit, parsePnpmAudit } from '../../src/core/scanners/dependencies.js';
import { builtinScanners } from '../../src/core/scanners/index.js';
import { reviewFindings, reviewScanner } from '../../src/core/scanners/review.js';
import { scanSecrets } from '../../src/core/scanners/secrets.js';
import { runScanners, type ScanContext } from '../../src/core/scanners/types.js';
import { emptyModel } from '../../src/core/model/project-model.js';
import { cleanupProjects, FAKE, makeProject, REPO_ROOT } from '../helpers.js';

afterAll(cleanupProjects);

const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures', 'audit');
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf8');
const ctx = (root: string, over: Partial<ScanContext> = {}): ScanContext => ({ root, config: AthenaConfig.parse({}), mode: 'all', ...over });

describe('secrets scanner', () => {
  it('reports one finding per match with location, severity and a masked fingerprint', async () => {
    const dir = await makeProject({
      'src/keys.ts': `// keys\nexport const k = "${FAKE.stripe}";\nexport const a = "${FAKE.aws}";\n`,
      'id_rsa.txt': `${FAKE.pem}\n`,
      'config.ts': `const password = "${FAKE.dbPassword}x9Q";\n`,
    });
    const out = await scanSecrets(ctx(dir));
    const findings = out.findings.map((f) => Finding.parse(f));
    const byRule = Object.fromEntries(findings.map((f) => [f.ruleId, f]));
    expect(byRule['secret/stripe-key']).toMatchObject({ severity: 'high', label: 'DETECTED', category: 'secret', cwe: ['CWE-798'], location: { file: 'src/keys.ts', startLine: 2, startColumn: 19 } });
    expect(byRule['secret/aws-access-key-id']?.severity).toBe('critical');
    expect(byRule['secret/private-key']).toMatchObject({ severity: 'critical', location: { file: 'id_rsa.txt', startLine: 1, endLine: 4 } });
    expect(byRule['secret/generic-secret-assignment']).toMatchObject({ severity: 'medium', confidence: 'low', potential: true });
    expect(out.summary.count).toBe(findings.length);
    expect(out.coverage[0]).toMatchObject({ engine: 'athena-secrets', status: 'ok', filesScanned: 3 });
    const json = JSON.stringify(out);
    for (const v of [FAKE.stripe, FAKE.aws, FAKE.dbPassword, 'MIIEowIBAAKCAQEA7Zq3']) expect(json).not.toContain(v);
  });

  it('keeps the fingerprint when only the secret value changes', async () => {
    const other = 'sk' + '_live_' + 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2';
    const a = await makeProject({ 'src/keys.ts': `export const k = "${FAKE.stripe}";\n` });
    const b = await makeProject({ 'src/keys.ts': `export const k = "${other}";\n` });
    const c = await makeProject({ 'src/keys.ts': `export const key = "${FAKE.stripe}";\n` });
    const fp = async (d: string) => (await scanSecrets(ctx(d))).findings[0]!.fingerprint;
    expect(await fp(a)).toBe(await fp(b));
    expect(await fp(a)).not.toBe(await fp(c));
  });

  it('gives identical lines distinct, stable fingerprints and respects ctx.files', async () => {
    const line = `export const k = "${FAKE.github}";\n`;
    const dir = await makeProject({ 'a.ts': line + line, 'b.ts': line });
    const all = await scanSecrets(ctx(dir));
    expect(new Set(all.findings.map((f) => f.fingerprint)).size).toBe(3);
    const scoped = await scanSecrets(ctx(dir, { files: ['b.ts'] }));
    expect(scoped.findings.map((f) => f.location?.file)).toEqual(['b.ts']);
    expect(scoped.coverage[0]?.filesScanned).toBe(1);
  });

  it('counts skipped binary files in coverage', async () => {
    const dir = await makeProject({ 'img.bin': Buffer.from([0, 1, 2, 0, 3]), 'a.ts': 'export {};\n' });
    const out = await scanSecrets(ctx(dir));
    expect(out.coverage[0]?.filesSkipped?.binary).toBe(1);
    expect(out.findings).toEqual([]);
  });
});

describe('dependency findings', () => {
  it('maps npm ≥7 rows to one finding per package+advisory, without transitive duplicates', () => {
    const f = auditFindings({ engine: 'npm-audit', ecosystem: 'npm', manifest: 'package-lock.json', findings: parseNpmAudit(fixture('npm-v7.json')) }).map((x) => Finding.parse(x));
    // mkdirp is only vulnerable through minimist, which is reported itself.
    expect(f.map((x) => x.package!.name).sort()).toEqual(['lodash', 'minimist']);
    const lodash = f.find((x) => x.package!.name === 'lodash')!;
    expect(lodash).toMatchObject({ ruleId: 'dependency/vulnerable-package', category: 'dependency', label: 'FACT', severity: 'high', engine: { id: 'npm-audit' }, cwe: ['CWE-77', 'CWE-94'] });
    expect(lodash.package).toMatchObject({ ecosystem: 'npm', manifest: 'package-lock.json', vulnerableRange: '<4.17.21', fixedIn: '4.17.21', fixAvailable: true });
    expect(lodash.package!.advisoryIds).toContain('GHSA-35jh-r3h4-6jhm');
    expect(lodash.help?.url).toBe('https://github.com/advisories/GHSA-35jh-r3h4-6jhm');
  });

  it('maps moderate to medium and missing severity to unrated', () => {
    const pnpm = auditFindings({ engine: 'pnpm-audit', ecosystem: 'npm', manifest: 'pnpm-lock.yaml', findings: parsePnpmAudit(fixture('pnpm-advisories.json')) });
    expect(pnpm.find((x) => x.package!.name === 'old-thing')?.severity).toBe('medium');
    expect(pnpm.find((x) => x.package!.name === 'lodash')?.package).toMatchObject({ version: '4.17.20' });
    const pip = auditFindings({ engine: 'pip-audit', ecosystem: 'python', target: 'requirements.txt', findings: parsePipAudit(fixture('pip-audit.json')) });
    expect(pip).toHaveLength(2);
    expect(pip.every((x) => x.severity === 'unrated' && x.package!.version === '0.5' && x.package!.manifest === 'requirements.txt')).toBe(true);
    expect(pip[0]!.package!.advisoryIds).toEqual(['PYSEC-2019-179', 'CVE-2019-1010083', 'GHSA-5wv5-4vpf-pj6m']);
  });

  it('skips network tools offline with a reason', async () => {
    const dir = await makeProject({ 'package.json': '{"name":"x"}', 'package-lock.json': '{}', 'go.mod': 'module x\n' });
    const out = await auditDependencies(ctx(dir, { offline: true }));
    expect(out.findings).toEqual([]);
    expect(out.coverage.map((c) => [c.engine, c.status])).toEqual([
      ['npm-audit', 'skipped'],
      ['govulncheck', 'skipped'],
    ]);
    expect(out.coverage[0]?.reason).toMatch(/offline/);
  });

  describe('with fake tools', () => {
    const originalPath = process.env.PATH;
    afterEach(() => {
      process.env.PATH = originalPath;
    });
    const fakeBin = async (dir: string, name: string, script: string) => {
      const bin = path.join(dir, '.fakebin');
      await fs.mkdir(bin, { recursive: true });
      await fs.writeFile(path.join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
      process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
    };

    it.skipIf(process.platform === 'win32')('records a failed tool in coverage, with no findings', async () => {
      const dir = await makeProject({ 'package.json': '{"name":"x"}', 'package-lock.json': '{}', '.gitignore': '.fakebin\n' });
      await fakeBin(dir, 'npm', `cat '${path.join(FIXTURES, 'npm-error.json')}'\nexit 1`);
      const out = await auditDependencies(ctx(dir), { model: emptyModel('x', dir) });
      expect(out.findings).toEqual([]);
      expect(out.coverage).toEqual([expect.objectContaining({ engine: 'npm-audit', category: 'dependency', status: 'failed', network: true, target: 'package-lock.json' })]);
      expect(out.coverage[0]?.reason).toMatch(/ENOTFOUND/);
    });

    it.skipIf(process.platform === 'win32')('runs through runScanners with the registry', async () => {
      const dir = await makeProject({ 'package.json': '{"name":"x"}', 'package-lock.json': '{}', '.gitignore': '.fakebin\n', 'src/k.ts': `const k = "${FAKE.stripe}";\n` });
      await fakeBin(dir, 'npm', `cat '${path.join(FIXTURES, 'npm-v7.json')}'\nexit 1`);
      const result = await runScanners(builtinScanners(), ctx(dir));
      expect(result.findings.map((f) => f.ruleId).sort()).toEqual(['dependency/vulnerable-package', 'dependency/vulnerable-package', 'secret/stripe-key']);
      expect(result.findings[0]!.severity).toBe('critical'); // minimist first
      expect(result.coverage.map((c) => c.engine)).toEqual(['athena-secrets', 'npm-audit']);
    });
  });
});

describe('review findings', () => {
  it('converts checks to one finding per file and secrets to located secret findings', () => {
    const line = `const k = "${FAKE.stripe}";`;
    const start = line.indexOf(FAKE.stripe);
    const findings = reviewFindings({
      checks: [
        { check: { level: 'blocker', check: 'secrets', message: 'Possible stripe-key added', files: ['src/a.ts:3'] }, locations: [{ file: 'src/a.ts', line: 3 }] },
        { check: { level: 'blocker', check: 'env-file', message: 'Environment file included', files: ['.env'] }, locations: [{ file: '.env' }] },
        { check: { level: 'warning', check: 'tests', message: '2 source files', files: ['a.ts', 'b.ts'] }, locations: [{ file: 'a.ts' }, { file: 'b.ts' }] },
        { check: { level: 'info', check: 'leftovers', message: 'TODOs', files: ['a.ts:1', 'a.ts:5'] }, locations: [{ file: 'a.ts', line: 5 }, { file: 'a.ts', line: 1 }] },
        { check: { level: 'info', check: 'knowledge', message: 'out of date', files: [] }, locations: [] },
      ],
      secrets: [{ type: 'stripe-key', file: 'src/a.ts', line: 3, column: start + 1, lineText: line, mask: [start, start + FAKE.stripe.length] }],
    }).map((f) => Finding.parse(f));
    expect(findings.map((f) => [f.ruleId, f.severity, f.location?.file])).toEqual([
      ['secret/stripe-key', 'high', 'src/a.ts'],
      ['review/env-file', 'high', '.env'],
      ['review/tests', 'medium', 'a.ts'],
      ['review/tests', 'medium', 'b.ts'],
      ['review/leftovers', 'info', 'a.ts'],
      ['review/knowledge', 'info', undefined],
    ]);
    expect(findings.find((f) => f.ruleId === 'review/leftovers')?.location?.startLine).toBe(1);
    expect(findings.every((f) => f.label === 'DETECTED')).toBe(true);
    expect(JSON.stringify(findings)).not.toContain(FAKE.stripe);
  });

  it('the review scanner skips scope "all"', async () => {
    const s = reviewScanner(async () => {
      throw new Error('should not run');
    });
    const out = await s.run(ctx('/nonexistent'));
    expect(out.coverage[0]).toMatchObject({ status: 'skipped' });
  });
});

describe('findings store', () => {
  const legacy = (over: Partial<SecurityScan> = {}): SecurityScan => ({
    schemaVersion: 1,
    scannedAt: '2026-09-01T10:00:00.000Z',
    durationMs: 1000,
    tools: [
      { tool: 'npm audit', ecosystem: 'npm', status: 'ok', durationMs: 900, findings: [{ package: 'lodash', severity: 'moderate', title: 'Command Injection', id: '1523', url: 'https://example.test/adv', fixAvailable: true }] },
      { tool: 'pip-audit', ecosystem: 'python', target: 'requirements.txt', status: 'failed', message: 'boom', durationMs: 5, findings: [] },
      { tool: 'govulncheck', ecosystem: 'go', status: 'unavailable', message: 'govulncheck is not installed', durationMs: 1, findings: [] },
    ],
    counts: { critical: 0, high: 0, moderate: 1, low: 0, unrated: 0 },
    secrets: { count: 2, files: ['src/a.ts', 'src/b.ts'] },
    ...over,
  });

  it('migrates a v1 security-scan.json on read', async () => {
    const dir = await makeProject({ '.athena/README.md': 'x\n' });
    await saveLegacyScan(dir, legacy());
    const loaded = await loadFindingsWithSource(dir);
    expect(loaded?.source).toBe('migrated');
    const r = loaded!.result;
    expect(r.scannedAt).toBe('2026-09-01T10:00:00.000Z');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ ruleId: 'dependency/vulnerable-package', severity: 'medium', label: 'FACT', engine: { id: 'npm-audit' }, package: { name: 'lodash', advisoryIds: ['1523'] } });
    expect(r.coverage.map((c) => [c.engine, c.status])).toEqual([
      ['npm-audit', 'ok'],
      ['pip-audit', 'failed'],
      ['govulncheck', 'unavailable'],
      ['athena-secrets', 'ok'],
    ]);
    expect(r.coverage[3]?.reason).toMatch(/2 potential secret\(s\) in 2 file\(s\)/);
  });

  it('saves and loads findings.json, preferring it unless the legacy file is newer', async () => {
    const dir = await makeProject({ '.athena/README.md': 'x\n' });
    expect(await loadFindings(dir)).toBeNull();
    const result = migrateLegacyScan(legacy({ scannedAt: '2026-09-02T00:00:00.000Z', secrets: { count: 0, files: [] } }));
    await saveFindings(dir, result);
    await saveLegacyScan(dir, legacy());
    expect((await loadFindingsWithSource(dir))?.source).toBe('findings');
    await saveLegacyScan(dir, legacy({ scannedAt: '2026-09-03T00:00:00.000Z' }));
    expect((await loadFindingsWithSource(dir))?.source).toBe('migrated');
    await expect(saveFindings(dir, { ...result, schemaVersion: 2 } as never)).rejects.toThrow();
  });
});
