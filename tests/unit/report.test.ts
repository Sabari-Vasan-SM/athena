import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { Coverage, Finding, type FindingInput, type ScanResult } from '../../src/core/findings/finding.js';
import { codeFingerprint, fileFingerprint, packageFingerprint } from '../../src/core/findings/fingerprint.js';
import { SECRET_PATTERNS } from '../../src/core/security/secrets.js';
import { listRules, render, REPORT_FORMATS, ruleInfo, toJsonReport, toSarif, type ReportInput } from '../../src/core/report/index.js';
import { mdText } from '../../src/core/report/markdown.js';
import { ghData, ghProp, MAX_ANNOTATIONS } from '../../src/core/report/github.js';
import { FAKE, REPO_ROOT } from '../helpers.js';

const GOLDEN = path.join(REPO_ROOT, 'tests/fixtures/report');

const finding = (over: Partial<FindingInput>): Finding =>
  Finding.parse({
    confidence: 'high',
    label: 'DETECTED',
    engine: { id: 'athena' },
    ...over,
  } as FindingInput);

const stripeLine = `const key = "${FAKE.stripe}";`;
const stripeStart = stripeLine.indexOf(FAKE.stripe);

const secret = finding({
  fingerprint: codeFingerprint({ ruleId: 'secret/stripe-key', file: 'src/pay.ts', lineText: stripeLine, mask: [stripeStart, stripeStart + FAKE.stripe.length] }),
  ruleId: 'secret/stripe-key',
  category: 'secret',
  severity: 'critical',
  title: 'Stripe secret key in source',
  message: 'A Stripe secret key appears in source. Rotate it.',
  cwe: ['CWE-798'],
  location: { file: 'src/pay.ts', startLine: 12, startColumn: 14 },
  alsoReportedBy: ['gitleaks'],
});

const dep = finding({
  fingerprint: packageFingerprint({ ruleId: 'dependency/vulnerable-package', ecosystem: 'npm', name: 'lodash', manifest: 'package-lock.json', advisoryId: 'GHSA-35jh-r3h4-6jhm' }),
  ruleId: 'dependency/vulnerable-package',
  category: 'dependency',
  severity: 'high',
  label: 'FACT',
  title: 'lodash 4.17.20 has a known vulnerability',
  message: 'Command injection in lodash (GHSA-35jh-r3h4-6jhm). Fixed in 4.17.21.',
  engine: { id: 'npm-audit', version: '10.9.0' },
  package: { ecosystem: 'npm', name: 'lodash', version: '4.17.20', manifest: 'package-lock.json', advisoryIds: ['GHSA-35jh-r3h4-6jhm'], fixedIn: '4.17.21', fixAvailable: true },
  help: { text: 'Upgrade lodash to 4.17.21 or later.', url: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm' },
});

const review = finding({
  fingerprint: fileFingerprint({ ruleId: 'review/env-file', file: '.env.production' }),
  ruleId: 'review/env-file',
  category: 'review',
  severity: 'medium',
  title: 'Environment file in the change',
  message: 'Environment file included in the change.',
  location: { file: '.env.production' },
});

const potential = finding({
  fingerprint: codeFingerprint({ ruleId: 'secret/generic-secret-assignment', file: 'config/app.ts', lineText: 'const apiKey = "⟨v⟩"' }),
  ruleId: 'secret/generic-secret-assignment',
  category: 'secret',
  severity: 'unrated',
  confidence: 'low',
  label: 'INFERRED',
  potential: true,
  title: 'Hardcoded secret-like assignment',
  message: 'A high-entropy value is assigned to apiKey.',
  location: { file: 'config/app.ts', startLine: 3 },
});

const baselined = finding({
  fingerprint: codeFingerprint({ ruleId: 'review/leftovers', file: 'src/old.ts', lineText: 'console.log(x)' }),
  ruleId: 'review/leftovers',
  category: 'review',
  severity: 'low',
  title: 'Debug statement added',
  message: 'console.log left in code.',
  location: { file: 'src/old.ts', startLine: 40 },
});

const suppressed = finding({
  fingerprint: codeFingerprint({ ruleId: 'secret/jwt', file: 'tests/fixtures/token.ts', lineText: 'const t = "⟨v⟩"' }),
  ruleId: 'secret/jwt',
  category: 'secret',
  severity: 'high',
  title: 'JSON Web Token in source',
  message: 'A JWT appears in source.',
  location: { file: 'tests/fixtures/token.ts', startLine: 1 },
});

const triaged = finding({
  fingerprint: fileFingerprint({ ruleId: 'review/auth', file: 'src/auth/session.ts' }),
  ruleId: 'review/auth',
  category: 'review',
  severity: 'info',
  title: 'Authentication code changed',
  message: 'Authentication/authorization code changed.',
  location: { file: 'src/auth/session.ts' },
});

const coverage = [
  { engine: 'athena-secrets', category: 'secret', status: 'ok', filesScanned: 120, filesSkipped: { tooLarge: 2, binary: 1 }, durationMs: 40 },
  { engine: 'npm-audit', category: 'dependency', status: 'ok', target: 'package-lock.json', network: true, durationMs: 900 },
  { engine: 'pip-audit', category: 'dependency', status: 'failed', target: 'requirements.txt', reason: 'pip-audit exited with code 2', network: true, durationMs: 300 },
  { engine: 'semgrep', category: 'sast', status: 'unavailable', reason: 'semgrep is not installed', durationMs: 0 },
  { engine: 'athena-review', category: 'review', status: 'ok', filesScanned: 8, durationMs: 12 },
].map((c) => Coverage.parse(c));

const result: ScanResult = {
  schemaVersion: 1,
  scannedAt: '2026-10-01T12:00:00.000Z',
  durationMs: 1300,
  scope: { mode: 'changed', base: 'main', files: 8 },
  findings: [secret, dep, review, potential, baselined, suppressed, triaged],
  coverage,
};

const input: ReportInput = {
  result,
  statuses: { [baselined.fingerprint]: 'baselined', [suppressed.fingerprint]: 'suppressed', [triaged.fingerprint]: 'triaged:accepted-risk' },
  gate: { passed: false, reasons: ['1 open critical finding (fail on: high)', 'Coverage incomplete: pip-audit failed'] },
  ratings: { secret: { grade: 'E', basis: '1 open critical secret' }, dependency: { grade: 'D', basis: '1 open high advisory' } },
  toolVersion: '0.5.0',
};

describe('report formats: golden output', () => {
  it('text', async () => {
    const out = render('text', input, { color: false, width: 100 });
    await expect(out).toMatchFileSnapshot(path.join(GOLDEN, 'scan.txt'));
    expect(out).toContain('Potential hardcoded secret-like assignment');
    expect(out).toMatch(/Open findings: 4 \(1 critical · 1 high · 1 unrated · 1 medium\)/);
    expect(out).toContain('Not counted: 1 baselined · 1 suppressed · 1 triaged');
    expect(out).toContain('[triaged (accepted-risk)]');
    expect(out).toMatch(/pip-audit\s+dependency\s+failed/);
    expect(out).toContain('Not covered by any engine: sast, iac, license, quality, memory');
    expect(out).not.toMatch(/\x1b\[/);
  });

  it('text respects width and adds colour only when asked', () => {
    const narrow = render('text', input, { color: false, width: 50 });
    for (const line of narrow.split('\n')) expect([...line].length, line).toBeLessThanOrEqual(50);
    expect(render('text', input, { color: true, width: 100 })).toMatch(/\x1b\[/);
  });

  it('markdown', async () => {
    const out = render('markdown', input);
    await expect(out).toMatchFileSnapshot(path.join(GOLDEN, 'scan.md'));
    expect(out.startsWith('<!-- athena-scan:v1 -->\n')).toBe(true);
    expect(out).toContain('**Gate: failed**');
    expect(out).toContain('`pip-audit` (dependency, `requirements.txt`): **failed**');
    expect(out).toContain('Not counted: 1 baselined, 1 suppressed, 1 triaged.');
    expect(out).not.toContain('JSON Web Token'); // suppressed: not listed
  });

  it('json', async () => {
    const out = render('json', input);
    await expect(out).toMatchFileSnapshot(path.join(GOLDEN, 'scan.json'));
    const j = JSON.parse(out);
    expect(j).toMatchObject({ schemaVersion: 1, tool: { name: 'athena', version: '0.5.0' }, fingerprintVersion: 1, scope: result.scope, scannedAt: result.scannedAt });
    expect(j.findings).toHaveLength(7);
    expect(j.findings.find((f: Finding) => f.fingerprint === triaged.fingerprint).status).toBe('triaged:accepted-risk');
    expect(j.summary).toMatchObject({ open: 4, baselined: 1, suppressed: 1, triaged: 1, openPotential: 1 });
    expect(j.coverage).toHaveLength(5);
    expect(j.gate.passed).toBe(false);
    expect(toJsonReport({ result, toolVersion: '1' })).not.toHaveProperty('gate');
  });

  it('github', async () => {
    const out = render('github', input);
    await expect(out).toMatchFileSnapshot(path.join(GOLDEN, 'scan.github.txt'));
    const lines = out.trim().split('\n');
    expect(lines.every((l) => l.startsWith('::'))).toBe(true);
    expect(lines[0]).toMatch(/^::error file=src\/pay.ts,line=12,col=14,title=Athena \[critical\]%3A Stripe secret key in source::/);
    expect(out).toContain('::error file=package-lock.json,title=Athena [high]%3A lodash 4.17.20 has a known vulnerability::');
    expect(out).toContain('::warning file=config/app.ts,line=3,title=Athena [unrated]%3A Potential hardcoded secret-like assignment::');
    expect(out).not.toContain('src/old.ts'); // baselined: no annotation
    expect(out).toContain('::warning title=Athena coverage gap::pip-audit (dependency, requirements.txt): failed');
    expect(out).toContain('::notice title=Athena coverage gap::semgrep (sast): unavailable');
    expect(out).toContain('::error title=Athena gate::Gate failed');
  });
});

describe('escaping untrusted text', () => {
  const evil = 'Bad | <script>alert(1)</script> ]] [x](javascript:alert(1)) @octocat 100%\r\n::error::pwned, a:b `tick`';
  const evilFinding = finding({
    fingerprint: 'e'.repeat(32),
    ruleId: 'sast/js/evil',
    category: 'sast',
    severity: 'high',
    title: evil,
    message: `msg ${evil}`,
    location: { file: 'src/a|b <x>.ts', startLine: 2 },
    engine: { id: 'semgrep<img>' },
  });
  const evilInput: ReportInput = { result: { ...result, findings: [evilFinding], coverage: [Coverage.parse({ engine: 'x', category: 'sast', status: 'failed', reason: '<b>boom</b>\n::error::x', durationMs: 1 })] }, toolVersion: '0.5.0' };

  it('markdown: no HTML, no table breaks, no mentions, no links, one line per row', () => {
    const out = render('markdown', evilInput);
    expect(out).not.toMatch(/<script|<img|<b>/);
    expect(out).not.toMatch(/(?<!\\)\]\(javascript/); // `]` is escaped, so no link
    expect(out).not.toMatch(/@octocat/);
    const row = out.split('\n').find((l) => l.startsWith('| High |') && l.includes('Bad'))!;
    // Exactly 6 unescaped pipes: 5 columns.
    expect(row.match(/(?<!\\)\|/g)).toHaveLength(6);
    expect(out.split('\n').filter((l) => l.includes('pwned'))).toHaveLength(1);
    expect(mdText('a\nb')).toBe('a b');
    expect(mdText('x'.repeat(500)).length).toBeLessThanOrEqual(200);
  });

  it('github: data and properties cannot start or end a command', () => {
    const out = render('github', evilInput);
    const lines = out.trim().split('\n');
    for (const l of lines) expect(l.startsWith('::')).toBe(true);
    // No raw CR/LF inside a command, and no second "::" outside the command header.
    const first = lines[0]!;
    const header = first.slice(0, first.indexOf('::', 2) + 2);
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).toContain('title=Athena [high]%3A Bad | <script>alert(1)</script> ]] [x](javascript%3Aalert(1)) @octocat 100%25%0D%0A%3A%3Aerror%3A%3Apwned%2C a%3Ab `tick`');
    expect(first.slice(header.length)).toContain('100%25%0D%0A::error::pwned');
    expect(ghData('%\r\n')).toBe('%25%0D%0A');
    expect(ghProp('a:b,c')).toBe('a%3Ab%2Cc');
    expect(out).toContain('x (sast): failed — <b>boom</b>%0A::error::x');
  });

  it('caps annotations and says how many were left out', () => {
    const many = Array.from({ length: 60 }, (_, i) => finding({ fingerprint: i.toString(16).padStart(32, '0'), ruleId: 'sast/js/x', category: 'sast', severity: 'medium', title: `T${i}`, message: 'm', location: { file: 'a.ts', startLine: i + 1 } }));
    const out = render('github', { result: { ...result, findings: many }, toolVersion: '1' });
    expect(out.split('\n').filter((l) => l.startsWith('::warning file='))).toHaveLength(MAX_ANNOTATIONS);
    expect(out).toContain('60 open findings, 10 not annotated (limit 50)');
    const md = render('markdown', { result: { ...result, findings: many }, toolVersion: '1' });
    expect(md).toContain('_Showing 50 of 60 open findings; 10 more not shown.');
  });
});

describe('no secret values in any format', () => {
  it('reporters add nothing beyond the findings; fingerprints carry no raw text', () => {
    expect(secret.fingerprint).toMatch(/^[a-f0-9]{32}$/);
    for (const format of REPORT_FORMATS) {
      const out = render(format, input, { color: false, width: 100 });
      expect(out, format).not.toContain(FAKE.stripe);
      expect(out, format).not.toContain(FAKE.stripe.slice(8, 20));
    }
    const sarif = toSarif(input);
    for (const r of sarif.runs[0].results) {
      expect(Object.values(r.partialFingerprints as Record<string, string>).every((v) => /^[a-f0-9]{32}$/.test(v))).toBe(true);
    }
  });
});

describe('sarif', () => {
  const sarif = toSarif(input);
  const run = sarif.runs[0];

  it('validates against the official SARIF 2.1.0 schema', () => {
    const require = createRequire(import.meta.url);
    const Ajv = require('ajv');
    const addFormats = require('ajv-formats');
    const schema = JSON.parse(readFileSync(path.join(REPO_ROOT, 'tests/fixtures/sarif/sarif-2.1.0.schema.json'), 'utf8'));
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    for (const doc of [sarif, toSarif({ result: { ...result, findings: [], coverage: [] }, toolVersion: 'dev' }), toSarif({ result: { ...result, scope: { mode: 'all' } }, toolVersion: '1.0.0' })]) {
      const ok = validate(doc);
      expect(ok, JSON.stringify(validate.errors, null, 2)).toBe(true);
    }
  });

  it('maps rules, levels, fingerprints, baseline state and suppressions', () => {
    expect(run.tool.driver).toMatchObject({ name: 'Athena', version: '0.5.0', semanticVersion: '0.5.0', informationUri: 'https://athena.sabari.me' });
    const rule = (id: string) => run.tool.driver.rules.find((r: { id: string }) => r.id === id);
    expect(rule('secret/stripe-key').properties).toEqual({ tags: ['secret', 'security', 'external/cwe/cwe-798'], 'security-severity': '9.5', precision: 'high' });
    expect(rule('secret/generic-secret-assignment').properties).toMatchObject({ 'security-severity': '7.0', precision: 'low' });
    expect(rule('dependency/vulnerable-package')).toMatchObject({ helpUri: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm', help: { text: 'Upgrade lodash to 4.17.21 or later.' } });
    // Falls back to the catalog when the finding has no help.
    expect(rule('review/env-file').help.text).toBe(ruleInfo('review/env-file')!.help);

    const res = (fp: string) => run.results.find((r: { partialFingerprints: Record<string, string> }) => r.partialFingerprints['athena/v1'] === fp);
    expect(res(secret.fingerprint)).toMatchObject({ level: 'error', baselineState: 'new', locations: [{ physicalLocation: { artifactLocation: { uri: 'src/pay.ts', uriBaseId: '%SRCROOT%' }, region: { startLine: 12, startColumn: 14 } } }] });
    expect(res(secret.fingerprint).ruleIndex).toBe(run.tool.driver.rules.findIndex((r: { id: string }) => r.id === 'secret/stripe-key'));
    expect(res(dep.fingerprint).locations[0].physicalLocation.artifactLocation.uri).toBe('package-lock.json');
    expect(res(dep.fingerprint).properties).toMatchObject({ label: 'FACT', engine: 'npm-audit', package: { name: 'lodash' } });
    expect(res(potential.fingerprint)).toMatchObject({ level: 'warning', properties: { potential: true } });
    expect(res(potential.fingerprint).message.text).toMatch(/^Potential /);
    expect(res(review.fingerprint).locations[0].physicalLocation).not.toHaveProperty('region');
    expect(res(baselined.fingerprint)).toMatchObject({ level: 'note', baselineState: 'unchanged', suppressions: [{ kind: 'external', status: 'accepted' }] });
    expect(res(suppressed.fingerprint).suppressions).toEqual([{ kind: 'inSource', status: 'accepted', justification: 'Suppressed by an inline Athena comment.' }]);
    expect(res(triaged.fingerprint).suppressions[0]).toMatchObject({ kind: 'external', justification: 'Triaged as accepted-risk in Athena triage.' });
  });

  it('reports coverage gaps as tool execution notifications', () => {
    const inv = run.invocations[0];
    expect(inv.executionSuccessful).toBe(false);
    expect(inv.toolExecutionNotifications.map((n: { level: string; descriptor: { id: string } }) => [n.level, n.descriptor.id])).toEqual([
      ['error', 'athena/coverage/failed'],
      ['warning', 'athena/coverage/unavailable'],
    ]);
    const clean = toSarif({ result: { ...result, coverage: coverage.filter((c) => c.status === 'ok') }, toolVersion: '1' });
    expect(clean.runs[0].invocations[0]).toMatchObject({ executionSuccessful: true, toolExecutionNotifications: [] });
  });

  it('no baselineState for a full scan without a baseline; excluded findings omitted; paths relative and encoded', () => {
    const s = toSarif({
      result: { ...result, scope: { mode: 'all' }, findings: [secret, finding({ ...review, fingerprint: 'f'.repeat(32), location: { file: '/repo/src/my file.ts', startLine: 1 } })] },
      statuses: { [secret.fingerprint]: 'excluded' },
      root: '/repo',
      toolVersion: 'dev',
    });
    expect(s.runs[0].results).toHaveLength(1);
    expect(s.runs[0].results[0]).not.toHaveProperty('baselineState');
    expect(s.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri).toBe('src/my%20file.ts');
    expect(s.runs[0].tool.driver).not.toHaveProperty('semanticVersion');
  });
});

describe('rule catalog', () => {
  it('covers every secret pattern, the dependency rule and review checks', () => {
    for (const p of SECRET_PATTERNS) expect(ruleInfo(`secret/${p.id}`), p.id).toBeDefined();
    expect(ruleInfo('dependency/vulnerable-package')?.cwe).toEqual(['CWE-1395']);
    expect(ruleInfo('review/env-file')).toBeDefined();
    expect(ruleInfo('secret/generic-secret-assignment')?.potential).toBe(true);
    for (const r of listRules()) {
      expect(r.id).toMatch(/^[a-z0-9][a-z0-9._/-]{1,120}$/);
      expect(r.help.length).toBeGreaterThan(10);
      for (const c of r.cwe) expect(c).toMatch(/^CWE-\d+$/);
    }
  });
});

describe('markdown block syntax at the start of untrusted text', () => {
  it('cannot open a heading, list or ordered list', () => {
    expect(mdText('# Title')).toBe('\\# Title');
    expect(mdText('- item')).toBe('\\- item');
    expect(mdText('1. item')).toBe('1\\. item');
    expect(mdText('a @b')).toBe('a @​b');
  });
});
