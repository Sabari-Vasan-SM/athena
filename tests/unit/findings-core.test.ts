import { describe, expect, it } from 'vitest';
import { codeFingerprint, normalizeLine, occurrenceCounter, packageFingerprint } from '../../src/core/findings/fingerprint.js';
import { dedupeFindings, Finding, type FindingInput } from '../../src/core/findings/finding.js';
import { runScanners, type Scanner } from '../../src/core/scanners/types.js';
import { AthenaConfig } from '../../src/core/config.js';
import { FAKE } from '../helpers.js';

const base = (over: Partial<FindingInput> = {}): FindingInput => ({
  fingerprint: 'a'.repeat(32),
  ruleId: 'secret/stripe-key',
  category: 'secret',
  severity: 'high',
  confidence: 'high',
  label: 'DETECTED',
  title: 'Possible Stripe key',
  message: 'A Stripe secret key appears in source.',
  engine: { id: 'athena' },
  ...over,
});

describe('fingerprints', () => {
  const line = `const key = "${FAKE.stripe}";`;
  const start = line.indexOf(FAKE.stripe);
  const mask: [number, number] = [start, start + FAKE.stripe.length];

  it('never depend on the secret value', () => {
    const a = codeFingerprint({ ruleId: 'secret/stripe-key', file: 'src/a.ts', lineText: line, mask });
    const otherValue = `sk_live_${'Z'.repeat(24)}`;
    const other = line.replace(FAKE.stripe, otherValue);
    const b = codeFingerprint({ ruleId: 'secret/stripe-key', file: 'src/a.ts', lineText: other, mask: [start, start + otherValue.length] });
    expect(a).toBe(b);
    expect(normalizeLine(line, mask)).not.toContain(FAKE.stripe);
    expect(a).toMatch(/^[a-f0-9]{32}$/);
  });

  it('survive whitespace changes, and differ by rule, file and occurrence', () => {
    const fp = (lineText: string, occurrence = 0, file = 'src/a.ts', ruleId = 'sast/js/eval') => codeFingerprint({ ruleId, file, lineText, occurrence });
    expect(fp('eval(input)')).toBe(fp('   eval( input)'.replace('( ', '(')));
    expect(fp('eval(input)')).toBe(fp('\teval(input)  '));
    expect(fp('eval(input)')).not.toBe(fp('eval(input)', 1));
    expect(fp('eval(input)')).not.toBe(fp('eval(input)', 0, 'src/b.ts'));
    expect(fp('eval(input)')).not.toBe(fp('eval(input)', 0, 'src/a.ts', 'sast/js/function-ctor'));
    const next = occurrenceCounter();
    expect([next('r', 'f', 'x'), next('r', 'f', 'x'), next('r', 'f', 'y')]).toEqual([0, 1, 0]);
  });

  it('package fingerprints identify package + advisory, not where it is imported', () => {
    const p = (advisoryId: string) => packageFingerprint({ ruleId: 'dependency/vulnerable-package', ecosystem: 'npm', name: 'lodash', manifest: 'package-lock.json', advisoryId });
    expect(p('GHSA-1')).toBe(p('GHSA-1'));
    expect(p('GHSA-1')).not.toBe(p('GHSA-2'));
  });
});

describe('findings', () => {
  it('validates shape and rejects junk', () => {
    expect(Finding.parse(base()).potential).toBe(false);
    expect(() => Finding.parse(base({ fingerprint: 'nope' }))).toThrow();
    expect(() => Finding.parse(base({ severity: 'moderate' as never }))).toThrow();
    expect(() => Finding.parse(base({ cwe: ['89'] }))).toThrow();
  });

  it('dedupes the same problem from several engines, keeping the strongest rating', () => {
    const a = Finding.parse(base({ severity: 'medium', engine: { id: 'athena' } }));
    const b = Finding.parse(base({ severity: 'critical', engine: { id: 'gitleaks' } }));
    const c = Finding.parse(base({ fingerprint: 'b'.repeat(32), severity: 'low' }));
    const out = dedupeFindings([c, a, b]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ severity: 'critical', engine: { id: 'athena' }, alsoReportedBy: ['gitleaks'] });
  });
});

describe('runScanners', () => {
  it('reports a crashing scanner as failed coverage instead of dropping it', async () => {
    const ok: Scanner = { id: 'ok', category: 'secret', title: 'ok', run: async () => ({ findings: [base()], coverage: [{ engine: 'ok', category: 'secret', status: 'ok', durationMs: 1 }] }) };
    const boom: Scanner = { id: 'boom', category: 'dependency', title: 'boom', run: async () => { throw new Error('tool exploded'); } };
    const r = await runScanners([ok, boom], { root: '/tmp', config: AthenaConfig.parse({}), mode: 'all' });
    expect(r.findings).toHaveLength(1);
    expect(r.coverage.find((c) => c.engine === 'boom')).toMatchObject({ status: 'failed', reason: 'tool exploded' });
  });
});
