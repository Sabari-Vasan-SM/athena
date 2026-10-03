import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkPolicyFrom } from '../../src/core/policy/tamper.js';
import { createBaseline, serializeBaseline } from '../../src/core/findings/baseline.js';
import { Coverage, Finding, type ScanResult } from '../../src/core/findings/finding.js';
import { codeFingerprint } from '../../src/core/findings/fingerprint.js';
import { evaluateFindings } from '../../src/services/findings.js';
import { AthenaError } from '../../src/services/errors.js';
import { cleanupProjects, gitInit, makeProject } from '../helpers.js';

afterAll(cleanupProjects);

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const run = (cwd: string, args: string[]) =>
  new Promise<string>((resolve, reject) => execFile('git', args, { cwd, env: ENV }, (err, stdout) => (err ? reject(err) : resolve(stdout))));
const write = (root: string, rel: string, text: string) => fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true }).then(() => fs.writeFile(path.join(root, rel), text));
const commit = async (root: string, msg: string) => {
  await run(root, ['add', '-A']);
  await run(root, ['commit', '-q', '--no-gpg-sign', '-m', msg]);
};

const EVAL_LINE = 'eval(userInput);';
const evalFinding = (line: number) =>
  Finding.parse({
    fingerprint: codeFingerprint({ ruleId: 'sast/js/eval', file: 'src/app.js', lineText: EVAL_LINE }),
    ruleId: 'sast/js/eval',
    category: 'sast',
    severity: 'high',
    confidence: 'high',
    label: 'DETECTED',
    title: 'eval of user input',
    message: 'm',
    location: { file: 'src/app.js', startLine: line },
    engine: { id: 'athena' },
  });
const result = (findings: Finding[]): ScanResult => ({
  schemaVersion: 1,
  scannedAt: new Date().toISOString(),
  durationMs: 1,
  scope: { mode: 'base', base: 'main' },
  findings,
  coverage: ['secret', 'dependency', 'sast', 'iac', 'review'].map((category) => Coverage.parse({ engine: `e-${category}`, category, status: 'ok', durationMs: 1 })),
});

/** A repo whose `main` has a strict policy, with a `feature` branch checked out. */
async function repo(): Promise<string> {
  const root = await makeProject({
    '.athena/policy.json': JSON.stringify({ schemaVersion: 1, gate: { failOn: 'high' } }),
    'src/app.js': 'const a = 1;\n',
  });
  await gitInit(root);
  await run(root, ['branch', '-M', 'main']);
  await run(root, ['checkout', '-q', '-b', 'feature']);
  return root;
}

describe('--policy-from (anti-tamper)', () => {
  it('uses the base policy even when HEAD relaxes failOn, and reports the relaxation', async () => {
    const root = await repo();
    await write(root, 'src/app.js', `const a = 1;\n${EVAL_LINE}\n`);
    await write(root, '.athena/policy.json', JSON.stringify({ schemaVersion: 1, gate: { failOn: 'critical' } }));
    await commit(root, 'weaken');

    // Without --policy-from the weakened working-tree policy passes the gate…
    const local = await evaluateFindings(root, result([evalFinding(2)]));
    expect(local.gate.passed).toBe(true);

    // …with it, main's policy applies and the change is reported.
    const ci = await evaluateFindings(root, result([evalFinding(2)]), { policyFrom: 'main' });
    expect(ci.policy.gate.failOn).toBe('high');
    expect(ci.policySource).toMatchObject({ kind: 'ref', ref: 'main' });
    expect(ci.gate.passed).toBe(false);
    const weakened = ci.findings.filter((f) => f.ruleId === 'review/policy-weakened');
    expect(weakened).toHaveLength(1);
    expect(weakened[0]).toMatchObject({ severity: 'high', location: { file: '.athena/policy.json' } });
    expect(weakened[0]!.message).toContain('gate.failOn high → critical');
    expect(ci.gate.failingFindings).toContain(weakened[0]!.fingerprint);
  });

  it('ignores baseline entries added in the change and reports them', async () => {
    const root = await repo();
    await write(root, 'src/app.js', `const a = 1;\n${EVAL_LINE}\n`);
    await write(root, '.athena/baseline.json', serializeBaseline(createBaseline([evalFinding(2)])));
    await commit(root, 'baseline the new problem');

    const ci = await evaluateFindings(root, result([evalFinding(2)]), { policyFrom: 'main' });
    expect(ci.statuses[evalFinding(2).fingerprint]!.status).toBe('open');
    expect(ci.gate.passed).toBe(false);
    const w = ci.findings.find((f) => f.ruleId === 'review/policy-weakened');
    expect(w).toMatchObject({ severity: 'high', location: { file: '.athena/baseline.json' } });
    expect(w!.message).toMatch(/1 baseline entry added \(sast\/js\/eval\)/);
  });

  it('reports an added athena-ignore comment (committed or not) as high', async () => {
    const root = await repo();
    await write(root, 'src/app.js', `const a = 1;\n// athena-ignore sast/js/eval -- trust me\n${EVAL_LINE}\n`);
    await commit(root, 'suppress');
    await write(root, 'src/new.py', 'x = 1  # athena-ignore sast/py/exec -- later\n'); // untracked

    const r = await checkPolicyFrom(root, 'main');
    expect(r.addedSuppressions.map((s) => [s.file, s.line, s.ruleId])).toEqual([
      ['src/app.js', 2, 'sast/js/eval'],
      ['src/new.py', 1, 'sast/py/exec'],
    ]);
    expect(r.findings.map((f) => [f.severity, f.location?.file, f.location?.startLine])).toEqual([
      ['high', 'src/app.js', 2],
      ['high', 'src/new.py', 1],
    ]);

    // The suppression itself still applies; the gate fails on the policy-weakened finding instead.
    const ci = await evaluateFindings(root, result([evalFinding(3)]), { policyFrom: 'main' });
    expect(ci.statuses[evalFinding(3).fingerprint]!.status).toBe('suppressed');
    expect(ci.gate.passed).toBe(false);
    expect(ci.gate.failingFindings).toHaveLength(2);
  });

  it('a base policy can downgrade policy-weakened findings; tightening changes are info', async () => {
    const root = await makeProject({ '.athena/policy.json': JSON.stringify({ rules: { 'review/policy-weakened': { severity: 'info' } } }), 'a.js': '' });
    await gitInit(root);
    await run(root, ['branch', '-M', 'main']);
    await run(root, ['checkout', '-q', '-b', 'feature']);
    await write(root, 'a.js', '// athena-ignore r/x -- ok\n');
    const ci = await evaluateFindings(root, result([]), { policyFrom: 'main' });
    expect(ci.findings.find((f) => f.ruleId === 'review/policy-weakened')!.severity).toBe('info');
    expect(ci.gate.passed).toBe(true);

    const root2 = await repo();
    await write(root2, '.athena/policy.json', JSON.stringify({ schemaVersion: 1, gate: { failOn: 'medium' } }));
    const r2 = await checkPolicyFrom(root2, 'main');
    expect(r2.findings.map((f) => f.severity)).toEqual(['info']);
  });

  it('missing files at the base mean defaults; unchanged files produce nothing', async () => {
    const root = await makeProject({ 'a.js': '' });
    await gitInit(root);
    const r = await checkPolicyFrom(root, 'HEAD');
    expect(r.base.policy.gate.failOn).toBe('high');
    expect(r.base.baseline).toBeNull();
    expect(r.findings).toEqual([]);
  });

  it('rejects unsafe or unknown refs, and an invalid policy at the base', async () => {
    const root = await repo();
    await expect(evaluateFindings(root, result([]), { policyFrom: '--output=/tmp/x' })).rejects.toThrow(/Invalid ref/);
    await expect(evaluateFindings(root, result([]), { policyFrom: 'nope' })).rejects.toBeInstanceOf(AthenaError);
    await run(root, ['checkout', '-q', 'main']);
    await write(root, '.athena/policy.json', '{"gate":{"failOn":"never"}}');
    await commit(root, 'broken');
    await run(root, ['checkout', '-q', 'feature']);
    await expect(evaluateFindings(root, result([]), { policyFrom: 'main' })).rejects.toThrow(/policy\.json at [0-9a-f]+ is invalid at gate\.failOn/);
  });

  it('an invalid policy at HEAD is reported, not used', async () => {
    const root = await repo();
    await write(root, '.athena/policy.json', '{ broken');
    const ci = await evaluateFindings(root, result([]), { policyFrom: 'main' });
    expect(ci.findings.find((f) => f.ruleId === 'review/policy-weakened')).toMatchObject({ severity: 'high', title: '.athena/policy.json is invalid in this change' });
  });
});
