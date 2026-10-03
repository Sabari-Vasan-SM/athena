import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, loadPolicy, Policy, PolicyError, PolicyPaths, applyRuleOverrides, ruleSetting, type PolicyInput } from '../../src/core/policy/policy.js';
import { comparePolicies, compareBaselines, compareTriage, addedSuppressionsInDiff } from '../../src/core/policy/tamper.js';
import { createBaseline, parseBaseline, pruneBaseline, serializeBaseline, updateBaseline } from '../../src/core/findings/baseline.js';
import { emptyTriage, parseTriage, setTriage } from '../../src/core/findings/triage.js';
import { applySuppressions, findSuppressions, parseSuppressionLine } from '../../src/core/findings/suppress.js';
import { deriveStatuses } from '../../src/core/findings/status.js';
import { evaluateGate } from '../../src/core/findings/gate.js';
import { rateCategories } from '../../src/core/findings/rating.js';
import { Coverage, Finding, type CoverageInput, type FindingInput, type ScanResult } from '../../src/core/findings/finding.js';
import { evaluateFindings } from '../../src/services/findings.js';
import { AthenaError } from '../../src/services/errors.js';
import { cleanupProjects, FAKE, makeProject } from '../helpers.js';

afterAll(cleanupProjects);

let n = 0;
const fp = () => (++n).toString(16).padStart(32, '0');
const finding = (over: Partial<FindingInput> = {}): Finding =>
  Finding.parse({
    fingerprint: fp(),
    ruleId: 'secret/stripe-key',
    category: 'secret',
    severity: 'high',
    confidence: 'high',
    label: 'DETECTED',
    title: 't',
    message: 'm',
    engine: { id: 'athena' },
    ...over,
  });
const cov = (over: Partial<CoverageInput> = {}): Coverage => Coverage.parse({ engine: 'athena-secrets', category: 'secret', status: 'ok', durationMs: 1, ...over });
const policy = (p: PolicyInput = {}) => Policy.parse(p);
const scan = (findings: Finding[], coverage: Coverage[] = [cov()], mode: ScanResult['scope']['mode'] = 'all'): ScanResult => ({
  schemaVersion: 1,
  scannedAt: new Date().toISOString(),
  durationMs: 1,
  scope: { mode },
  findings,
  coverage,
});
const gateOf = (findings: Finding[], p: PolicyInput = {}, opts: { baselined?: string[]; coverage?: Coverage[] } = {}) => {
  const pol = policy(p);
  const baseline = opts.baselined ? { schemaVersion: 1 as const, createdAt: 'x', entries: opts.baselined.map((f) => ({ fingerprint: f, ruleId: 'r/x', addedAt: 'x' })) } : null;
  const statuses = deriveStatuses(findings, { policy: pol, baseline, triage: null, suppressed: new Map() });
  return evaluateGate({ findings, coverage: opts.coverage ?? [cov()] }, { policy: pol, statuses });
};

describe('policy', () => {
  it('defaults when the file is missing', async () => {
    const root = await makeProject({ 'a.txt': 'x' });
    const p = await loadPolicy(root);
    expect(p.gate).toEqual({ failOn: 'high', minConfidence: 'medium', unrated: 'fail', scope: 'new', categories: ['secret', 'dependency', 'sast', 'iac', 'review'] });
    expect(p.external.network).toBe('allow');
    expect(p).toEqual(DEFAULT_POLICY);
  });

  it('rejects an invalid file with the offending path', async () => {
    const root = await makeProject({ '.athena/policy.json': JSON.stringify({ gate: { failOn: 'severe' } }) });
    await expect(loadPolicy(root)).rejects.toThrow(/policy\.json is invalid at gate\.failOn/);
    const typo = await makeProject({ '.athena/policy.json': JSON.stringify({ gate: { failon: 'low' } }) });
    await expect(loadPolicy(typo)).rejects.toBeInstanceOf(PolicyError);
    const bad = await makeProject({ '.athena/policy.json': '{ nope' });
    await expect(loadPolicy(bad)).rejects.toThrow(/not valid JSON/);
  });

  it('services surface an invalid policy as an AthenaError', async () => {
    const root = await makeProject({ '.athena/policy.json': JSON.stringify({ rules: { 'x/y': 'disabled' } }) });
    await expect(evaluateFindings(root, scan([]))).rejects.toBeInstanceOf(AthenaError);
  });

  it('rules: exact keys beat prefixes; overrides change severity; paths match globs', () => {
    const p = policy({ rules: { 'sast/js/*': 'off', 'sast/js/eval': { severity: 'low' } }, paths: { exclude: ['vendor/**', '*.min.js'], tests: ['tests/'] } });
    expect(ruleSetting(p, 'sast/js/eval')).toEqual({ severity: 'low' });
    expect(ruleSetting(p, 'sast/js/other')).toBe('off');
    expect(ruleSetting(p, 'sast/py/other')).toBeUndefined();
    const [f] = applyRuleOverrides(p, [finding({ ruleId: 'sast/js/eval', category: 'sast' })]);
    expect(f!.severity).toBe('low');
    const paths = new PolicyPaths(p);
    expect(paths.isExcluded('vendor/a/b.js')).toBe(true);
    expect(paths.isExcluded('src/app.min.js')).toBe(true);
    expect(paths.isExcluded('src/app.js')).toBe(false);
    expect(paths.isExcluded('../outside.js')).toBe(false);
    expect(paths.isTest('tests/unit/a.ts')).toBe(true);
  });
});

describe('baseline', () => {
  it('creates, updates without duplicates, and serializes stably', () => {
    const a = finding({ location: { file: 'b.ts', startLine: 1 } });
    const b = finding({ ruleId: 'dependency/vulnerable-package', category: 'dependency', package: { ecosystem: 'npm', name: 'x', manifest: 'package.json' } });
    const base = createBaseline([a], { now: new Date('2026-01-01T00:00:00Z'), reason: 'legacy' });
    expect(base.entries).toEqual([{ fingerprint: a.fingerprint, ruleId: a.ruleId, file: 'b.ts', addedAt: '2026-01-01T00:00:00.000Z', reason: 'legacy' }]);
    const { baseline, added } = updateBaseline(base, [a, b]);
    expect(added.map((e) => e.fingerprint)).toEqual([b.fingerprint]);
    expect(added[0]!.file).toBe('package.json');
    expect(parseBaseline(serializeBaseline(baseline))).toEqual(parseBaseline(serializeBaseline(baseline)));
    expect(() => updateBaseline(base, [b], { reason: `key ${FAKE.stripe}` })).toThrow(/secret/);
  });

  it('prunes fixed findings from a full scan, but keeps entries of categories not fully scanned', () => {
    const gone = finding();
    const still = finding();
    const dep = finding({ ruleId: 'dependency/vulnerable-package', category: 'dependency' });
    const base = createBaseline([gone, still, dep]);
    const r = pruneBaseline(base, scan([still], [cov(), cov({ engine: 'npm-audit', category: 'dependency', status: 'failed' })]));
    expect(r.removed.map((e) => e.fingerprint)).toEqual([gone.fingerprint]);
    expect(r.keptUnverified.map((e) => e.fingerprint)).toEqual([dep.fingerprint]);
    expect(r.baseline.entries.map((e) => e.fingerprint).sort()).toEqual([still.fingerprint, dep.fingerprint].sort());
    expect(() => pruneBaseline(base, scan([], [cov()], 'staged'))).toThrow(/partial scan/);
  });

  it('rejects duplicate fingerprints', () => {
    const e = { fingerprint: 'a'.repeat(32), ruleId: 'r/x', addedAt: 'x' };
    expect(() => parseBaseline(JSON.stringify({ schemaVersion: 1, createdAt: 'x', entries: [e, e] }))).toThrow(/more than once/);
  });
});

describe('triage', () => {
  it('records decisions with a required reason and refuses secrets without echoing them', () => {
    const t = setTriage(emptyTriage(), 'b'.repeat(32), { status: 'false-positive', reason: 'test fixture', by: 'dev', now: new Date('2026-01-01T00:00:00Z') });
    expect(t.entries['b'.repeat(32)]).toEqual({ status: 'false-positive', reason: 'test fixture', by: 'dev', at: '2026-01-01T00:00:00.000Z' });
    expect(() => setTriage(t, 'b'.repeat(32), { status: 'safe', reason: '  ' })).toThrow(/needs a reason/);
    expect(() => setTriage(t, 'b'.repeat(32), { status: 'safe', reason: 'x'.repeat(501) })).toThrow(/too long/);
    let msg = '';
    try {
      setTriage(t, 'b'.repeat(32), { status: 'safe', reason: `rotated ${FAKE.github}` });
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toMatch(/looks like it contains a secret/);
    expect(msg).not.toContain(FAKE.github);
    expect(() => parseTriage(JSON.stringify({ schemaVersion: 1, entries: { nothex: { status: 'safe', reason: 'x', at: 'x' } } }))).toThrow(/entries/);
    expect(() => parseTriage(JSON.stringify({ schemaVersion: 1, entries: { ['c'.repeat(32)]: { status: 'safe', reason: '', at: 'x' } } }))).toThrow(/reason/);
  });
});

describe('inline suppressions', () => {
  it.each([
    ['// athena-ignore sast/js/eval -- input is a constant'],
    ['x = 1  # athena-ignore sast/js/eval -- input is a constant'],
    ['/* athena-ignore sast/js/eval -- input is a constant */'],
    ['<!-- athena-ignore sast/js/eval -- input is a constant -->'],
    ['-- athena-ignore sast/js/eval -- input is a constant'],
    ['foo(); // athena-ignore sast/js/eval -- input is a constant'],
  ])('parses %s', (line) => {
    expect(parseSuppressionLine(line, 3)).toMatchObject({ line: 3, ruleId: 'sast/js/eval', reason: 'input is a constant' });
  });

  it('flags missing reasons and rule ids; ignores non-comments', () => {
    expect(parseSuppressionLine('// athena-ignore sast/js/eval', 1)).toMatchObject({ ruleId: 'sast/js/eval', problem: 'missing-reason' });
    expect(parseSuppressionLine('// athena-ignore sast/js/eval --   ', 1)).toMatchObject({ problem: 'missing-reason' });
    expect(parseSuppressionLine('// athena-ignore sast/js/eval because', 1)).toMatchObject({ problem: 'missing-reason' });
    expect(parseSuppressionLine('// athena-ignore -- why', 1)).toMatchObject({ problem: 'missing-rule' });
    expect(parseSuppressionLine('const s = "athena-ignore sast/js/eval -- x";', 1)).toBeNull();
    expect(parseSuppressionLine('// athena-ignored sast/js/eval -- x', 1)).toBeNull();
    expect(findSuppressions('a\n// athena-ignore r/x -- ok\nb\r\n# athena-ignore r/y')).toHaveLength(2);
  });

  it('applies to the same line or the line above; reasonless ones produce an info finding', async () => {
    const root = await makeProject({
      'src/a.js': ['// athena-ignore sast/js/eval -- constant input', 'eval(x);', 'eval(y); // athena-ignore sast/js/eval -- constant', '', 'eval(z);', '// athena-ignore sast/js/eval', 'eval(w);'].join('\n'),
    });
    const at = (line: number) => finding({ ruleId: 'sast/js/eval', category: 'sast', location: { file: 'src/a.js', startLine: line } });
    const [l2, l3, l5, l7] = [at(2), at(3), at(5), at(7)];
    const other = finding({ ruleId: 'sast/js/other', category: 'sast', location: { file: 'src/a.js', startLine: 2 } });
    const out = await applySuppressions(root, [l2!, l3!, l5!, l7!, other]);
    expect([...out.suppressed.keys()].sort()).toEqual([l2!.fingerprint, l3!.fingerprint].sort());
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({ ruleId: 'review/suppression-without-reason', severity: 'info', location: { file: 'src/a.js', startLine: 6 } });
  });

  it('skips unreadable files and never reads outside the root', async () => {
    const outside = await makeProject({ 'secret.js': '// athena-ignore r/x\n' });
    const root = await makeProject({ 'a.js': 'x' });
    await fs.symlink(path.join(outside, 'secret.js'), path.join(root, 'link.js'));
    const at = (file: string) => finding({ location: { file, startLine: 1 } });
    const out = await applySuppressions(root, [at('../../etc/passwd'), at('/etc/passwd'), at('missing.js'), at('link.js')]);
    expect(out.skippedFiles.map((s) => s.reason).sort()).toEqual(['missing', 'outside-root', 'outside-root', 'outside-root']);
    expect(out.findings).toEqual([]);
  });
});

describe('status derivation', () => {
  it('excluded > suppressed > triaged (closing) > baselined > open; to-review stays open', () => {
    const [ex, off, sup, tri, rev, bl, open] = Array.from({ length: 7 }, (_, i) => finding({ location: { file: i === 0 ? 'vendor/x.js' : 'src/x.js', startLine: i + 1 } }));
    off!.ruleId = 'secret/aws-key';
    const p = policy({ rules: { 'secret/aws-key': 'off' }, paths: { exclude: ['vendor/'] } });
    const triage = setTriage(setTriage(emptyTriage(), tri!.fingerprint, { status: 'accepted-risk', reason: 'tracked in JIRA-1' }), rev!.fingerprint, { status: 'to-review', reason: 'ask security' });
    const all = [ex!, off!, sup!, tri!, rev!, bl!, open!];
    const s = deriveStatuses(all, {
      policy: p,
      baseline: createBaseline([bl!, rev!, ex!]),
      triage,
      suppressed: new Map([[sup!.fingerprint, { file: 'src/x.js', line: 3, ruleId: sup!.ruleId, reason: 'ok' }]]),
    });
    expect(all.map((f) => s.get(f.fingerprint)!.status)).toEqual(['excluded', 'excluded', 'suppressed', 'triaged:accepted-risk', 'baselined', 'baselined', 'open']);
    expect(all.map((f) => s.get(f.fingerprint)!.active)).toEqual([false, false, false, false, true, true, true]);
    expect(s.get(rev!.fingerprint)).toMatchObject({ baselined: true, triage: 'to-review', reason: 'to review: ask security' });
  });
});

describe('gate truth table', () => {
  it('passes with nothing to report and fails on an open high finding', () => {
    expect(gateOf([]).passed).toBe(true);
    const f = finding();
    const g = gateOf([f]);
    expect(g.passed).toBe(false);
    expect(g.failingFindings).toEqual([f.fingerprint]);
    expect(g.reasons[0]).toMatch(/1 new finding at or above high/);
  });

  it.each([
    // severity, confidence, policy, baselined, expected pass
    ['medium', 'high', {}, false, true],
    ['critical', 'high', { gate: { failOn: 'critical' } }, false, false],
    ['high', 'high', { gate: { failOn: 'critical' } }, false, true],
    ['low', 'high', { gate: { failOn: 'low' } }, false, false],
    ['high', 'low', {}, false, true],
    ['high', 'low', { gate: { minConfidence: 'low' } }, false, false],
    ['high', 'medium', { gate: { minConfidence: 'high' } }, false, true],
    ['unrated', 'high', {}, false, false],
    ['unrated', 'high', { gate: { unrated: 'warn' } }, false, true],
    ['high', 'high', {}, true, true],
    ['high', 'high', { gate: { scope: 'all' } }, true, false],
    ['high', 'high', { gate: { categories: ['dependency'] } }, false, true],
  ] as const)('%s/%s %j baselined=%s → passed=%s', (severity, confidence, p, baselined, expected) => {
    const f = finding({ severity, confidence });
    const g = gateOf([f], p as PolicyInput, { baselined: baselined ? [f.fingerprint] : undefined });
    expect(g.passed).toBe(expected);
  });

  it('warns (but passes) on unrated findings under unrated: warn', () => {
    const f = finding({ severity: 'unrated' });
    const g = gateOf([f], { gate: { unrated: 'warn' } });
    expect(g.warningFindings).toEqual([f.fingerprint]);
    expect(g.warnings.join('\n')).toMatch(/unrated/);
  });

  it('fails when an engine of a gated category failed or timed out, even with no findings', () => {
    const g = gateOf([], {}, { coverage: [cov(), cov({ engine: 'npm-audit', category: 'dependency', status: 'timeout', reason: 'after 60 s' })] });
    expect(g.passed).toBe(false);
    expect(g.reasons[0]).toMatch(/npm-audit \(dependency\) timed out: after 60 s — it checked nothing/);
    expect(g.counted.brokenEngines).toBe(1);
    // A broken engine in an ungated category doesn't fail the gate.
    expect(gateOf([], {}, { coverage: [cov(), cov({ engine: 'lic', category: 'license', status: 'failed' })] }).passed).toBe(true);
  });

  it('lists unavailable engines and unscanned gated categories as warnings', () => {
    const g = gateOf([], {}, { coverage: [cov(), cov({ engine: 'pip-audit', category: 'dependency', status: 'unavailable', reason: 'not installed' })] });
    expect(g.passed).toBe(true);
    expect(g.warnings).toContain('pip-audit (dependency) unavailable: not installed');
    expect(g.warnings.some((w) => /no engine scanned .*\bsast\b/.test(w))).toBe(true);
  });
});

describe('rating', () => {
  it('grades from the worst active finding and never grades an unscanned category', () => {
    const p = policy();
    const fs = [finding({ severity: 'medium' }), finding({ severity: 'critical' }), finding({ ruleId: 'iac/x', category: 'iac', severity: 'unrated' })];
    const statuses = deriveStatuses(fs, { policy: p, baseline: null, triage: setTriage(emptyTriage(), fs[1]!.fingerprint, { status: 'fixed', reason: 'rotated' }), suppressed: new Map() });
    const coverage = [
      cov({ languages: ['typescript', 'python'], filesSkipped: { tooLarge: 2, binary: 1 } }),
      cov({ engine: 'checkov', category: 'iac' }),
      cov({ engine: 'semgrep', category: 'sast', status: 'unavailable' }),
      cov({ engine: 'npm-audit', category: 'dependency', status: 'failed' }),
      cov({ engine: 'reviewer', category: 'review' }),
    ];
    const r = Object.fromEntries(rateCategories({ findings: fs, coverage }, { policy: p, statuses }).map((x) => [x.category, x]));
    expect(r.secret).toMatchObject({ rating: 'C', worst: 'medium', active: 1 });
    expect(r.secret!.basis).toBe('1 engine (athena-secrets) across python, typescript; 3 files not covered');
    expect(r.iac!.rating).toBe('D');
    expect(rateCategories({ findings: [fs[2]!], coverage }, { policy: policy({ gate: { unrated: 'warn' } }), statuses })[1]!.rating).toBe('C');
    expect(r.review!.rating).toBe('A');
    expect(r.sast).toMatchObject({ rating: null, basis: 'not scanned (semgrep unavailable)' });
    expect(r.dependency!.rating).toBeNull();
    const counted = rateCategories({ findings: [], coverage: [cov()] }, { policy: p, statuses, rulesByEngine: { 'athena-secrets': 14 } });
    expect(counted[0]!.basis).toMatch(/^14 rules across all files/);
  });
});

describe('policy comparisons', () => {
  it('detects relaxations and tightenings', () => {
    const rel = (b: PolicyInput, h: PolicyInput) => comparePolicies(policy(b), policy(h)).map((c) => [c.key, c.relaxes]);
    expect(rel({}, { gate: { failOn: 'critical' } })).toEqual([['gate.failOn', true]]);
    expect(rel({}, { gate: { failOn: 'medium' } })).toEqual([['gate.failOn', false]]);
    expect(rel({}, { gate: { minConfidence: 'high', unrated: 'warn', scope: 'new' } })).toEqual([['gate.minConfidence', true], ['gate.unrated', true]]);
    expect(rel({ gate: { scope: 'all' } }, {})).toEqual([['gate.scope', true]]);
    expect(rel({}, { gate: { categories: ['secret'] } })).toEqual([['gate.categories', true]]);
    expect(rel({}, { rules: { 'a/b': 'off' } })).toEqual([['rules.a/b', true]]);
    expect(rel({}, { rules: { 'a/b': { severity: 'low' } } })).toEqual([['rules.a/b', true]]);
    expect(rel({}, { rules: { 'a/b': { severity: 'critical' } } })).toEqual([['rules.a/b', false]]);
    expect(rel({ rules: { 'a/b': 'off' } }, {})).toEqual([['rules.a/b', false]]);
    expect(rel({}, { paths: { exclude: ['src/'] } })).toEqual([['paths.exclude+', true]]);
    expect(rel({}, { paths: { tests: ['t/'] } })).toEqual([['paths.tests', false]]);
    expect(rel({}, { external: { semgrep: 'off', network: 'deny' } })).toEqual([['external.semgrep', true], ['external.network', true]]);
    expect(rel({ licenses: { deny: ['GPL-3.0'] } }, {})).toEqual([['licenses.deny-', true]]);
  });

  it('baseline additions and closing triage decisions relax; removals do not', () => {
    const f = finding();
    expect(compareBaselines(null, createBaseline([f])).map((c) => c.relaxes)).toEqual([true]);
    expect(compareBaselines(createBaseline([f]), null).map((c) => c.relaxes)).toEqual([false]);
    const t1 = setTriage(emptyTriage(), f.fingerprint, { status: 'to-review', reason: 'later' });
    expect(compareTriage(null, t1).map((c) => c.relaxes)).toEqual([false]);
    expect(compareTriage(t1, setTriage(t1, f.fingerprint, { status: 'safe', reason: 'checked' })).map((c) => c.relaxes)).toEqual([true]);
  });

  it('finds athena-ignore comments on added diff lines with their new line numbers', () => {
    const diff = [
      'diff --git src/a.js src/a.js',
      'index 1..2 100644',
      '--- src/a.js',
      '+++ src/a.js',
      '@@ -3,0 +4,2 @@ ctx',
      '+// athena-ignore sast/js/eval -- trusted',
      '+eval(x);',
      '@@ -9 +11 @@',
      '-old',
      '+++y // athena-ignore r/x -- why',
      'diff --git gone.js gone.js',
      '--- gone.js',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-// athena-ignore r/x -- why',
    ].join('\n');
    expect(addedSuppressionsInDiff(diff).map((s) => [s.file, s.line, s.ruleId])).toEqual([
      ['src/a.js', 4, 'sast/js/eval'],
      ['src/a.js', 11, 'r/x'],
    ]);
  });
});
