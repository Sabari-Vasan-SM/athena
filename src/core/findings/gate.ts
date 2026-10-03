import type { Policy } from '../policy/policy.js';
import { compareFindings, CONFIDENCE_RANK, SEVERITY_RANK, type Category, type Finding, type ScanResult } from './finding.js';
import type { StatusInfo } from './status.js';

/**
 * The quality gate. A finding fails the gate when it is
 *   - active (open, or triaged `to-review`; with scope `all` also baselined),
 *   - in one of `gate.categories`,
 *   - at least `gate.minConfidence` confident, and
 *   - at least `gate.failOn` severe — or unrated, when `gate.unrated` is `fail`.
 *
 * The gate also fails when an engine for a gated category failed or timed out: an
 * engine that broke checked nothing, so a pass would claim more than Athena knows.
 * Engines that were unavailable or skipped don't fail the gate but are listed in
 * `warnings`, as are gated categories nothing scanned at all.
 */
export interface GateResult {
  passed: boolean;
  /** Why the gate failed (empty when it passed). */
  reasons: string[];
  /** Things the reader should know that didn't fail the gate (unrated findings under `warn`, coverage gaps). */
  warnings: string[];
  counted: {
    /** Findings in the scan result. */
    total: number;
    /** Active findings in gated categories that were evaluated against the thresholds. */
    considered: number;
    failing: number;
    /** Unrated findings that would fail under `unrated: fail` but only warn. */
    unratedWarnings: number;
    /** Baselined findings skipped because the scope is `new`. */
    baselinedSkipped: number;
    /** Not active: excluded, suppressed or closed by triage. */
    notActive: number;
    outOfCategory: number;
    belowConfidence: number;
    belowSeverity: number;
    /** Engines for gated categories that failed or timed out. */
    brokenEngines: number;
  };
  failingFindings: string[];
  warningFindings: string[];
}

export interface GateContext {
  policy: Policy;
  statuses: Map<string, StatusInfo>;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function evaluateGate(result: Pick<ScanResult, 'findings' | 'coverage'>, ctx: GateContext): GateResult {
  const g = ctx.policy.gate;
  const gated = new Set<Category>(g.categories);
  const counted: GateResult['counted'] = {
    total: result.findings.length,
    considered: 0,
    failing: 0,
    unratedWarnings: 0,
    baselinedSkipped: 0,
    notActive: 0,
    outOfCategory: 0,
    belowConfidence: 0,
    belowSeverity: 0,
    brokenEngines: 0,
  };
  const failing: Finding[] = [];
  const warned: Finding[] = [];
  for (const f of result.findings) {
    const st = ctx.statuses.get(f.fingerprint);
    // A finding with no derived status is treated as open: unknown is never "fine".
    const active = st ? st.active : true;
    if (!active) {
      counted.notActive++;
      continue;
    }
    if (!gated.has(f.category)) {
      counted.outOfCategory++;
      continue;
    }
    if (g.scope === 'new' && st?.baselined) {
      counted.baselinedSkipped++;
      continue;
    }
    counted.considered++;
    if (CONFIDENCE_RANK[f.confidence] < CONFIDENCE_RANK[g.minConfidence]) {
      counted.belowConfidence++;
      continue;
    }
    if (f.severity === 'unrated') {
      if (g.unrated === 'fail') failing.push(f);
      else warned.push(f);
      continue;
    }
    if (SEVERITY_RANK[f.severity] < SEVERITY_RANK[g.failOn]) {
      counted.belowSeverity++;
      continue;
    }
    failing.push(f);
  }
  failing.sort(compareFindings);
  warned.sort(compareFindings);
  counted.failing = failing.length;
  counted.unratedWarnings = warned.length;

  const reasons: string[] = [];
  const warnings: string[] = [];
  if (failing.length) {
    const scope = g.scope === 'new' ? 'new ' : '';
    const unrated = failing.filter((f) => f.severity === 'unrated').length;
    reasons.push(
      `${plural(failing.length, `${scope}finding`)} at or above ${g.failOn} severity with ${g.minConfidence}+ confidence` +
        (unrated ? ` (${unrated} unrated, which the policy treats as failing)` : ''),
    );
  }

  const seenCategory = new Set<string>();
  for (const c of result.coverage) {
    if (!gated.has(c.category)) continue;
    if (c.status === 'ok') seenCategory.add(c.category);
    if (c.status === 'failed' || c.status === 'timeout') {
      seenCategory.add(c.category);
      counted.brokenEngines++;
      const what = c.target ? ` on ${c.target}` : '';
      reasons.push(`${c.engine} (${c.category})${what} ${c.status === 'timeout' ? 'timed out' : 'failed'}${c.reason ? `: ${c.reason}` : ''} — it checked nothing, so the gate can't pass`);
    } else if (c.status === 'unavailable' || c.status === 'skipped') {
      warnings.push(`${c.engine} (${c.category}) ${c.status}${c.reason ? `: ${c.reason}` : ''}`);
    }
  }
  for (const cat of g.categories) {
    if (!seenCategory.has(cat)) warnings.push(`no engine scanned ${cat} — the gate says nothing about it`);
  }
  if (warned.length) warnings.push(`${plural(warned.length, 'unrated finding')} (the policy only warns on unrated findings)`);

  return {
    passed: reasons.length === 0,
    reasons,
    warnings,
    counted,
    failingFindings: failing.map((f) => f.fingerprint),
    warningFindings: warned.map((f) => f.fingerprint),
  };
}
