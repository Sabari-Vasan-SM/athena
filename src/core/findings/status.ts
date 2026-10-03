import { findingPath, PolicyPaths, ruleSetting, type Policy } from '../policy/policy.js';
import type { Baseline } from './baseline.js';
import type { Finding } from './finding.js';
import type { AppliedSuppression } from './suppress.js';
import { CLOSING_TRIAGE, type Triage, type TriageStatus } from './triage.js';

/**
 * Per-finding status, derived on every run from the policy, baseline, triage and inline
 * suppressions. Never stored in findings.json, so editing those files takes effect at once.
 *
 * Precedence: excluded (policy) > suppressed (inline) > triaged (closing) > baselined > open.
 * Every `triaged:*` status is closed; a `to-review` decision leaves the finding `open`
 * (or `baselined`) and is visible in `triage`/`reason`.
 */
export type FindingStatus = 'open' | 'baselined' | 'suppressed' | `triaged:${ClosingTriageStatus}` | 'excluded';
/** Triage statuses that close a finding; `to-review` keeps it `open` (see StatusInfo.triage). */
export type ClosingTriageStatus = Exclude<TriageStatus, 'to-review'>;

export interface StatusInfo {
  status: FindingStatus;
  /** Still needs action: open, baselined or triaged `to-review`. Ratings count these. */
  active: boolean;
  /** In the baseline (also true when another status takes precedence). Gate scope `new` skips these. */
  baselined: boolean;
  /** The triage decision, if any (including `to-review`, which doesn't change the status). */
  triage?: TriageStatus;
  /** In a path the policy marks as tests. Informational. */
  inTests: boolean;
  /** Why it is not open (exclusion rule, suppression or triage reason). */
  reason?: string;
}

export interface StatusContext {
  policy: Policy;
  baseline: Baseline | null;
  triage: Triage | null;
  suppressed: Map<string, AppliedSuppression>;
}

export function deriveStatuses(findings: Finding[], ctx: StatusContext): Map<string, StatusInfo> {
  const paths = new PolicyPaths(ctx.policy);
  const baselined = new Set(ctx.baseline?.entries.map((e) => e.fingerprint) ?? []);
  const out = new Map<string, StatusInfo>();
  for (const f of findings) {
    const file = findingPath(f);
    const inBaseline = baselined.has(f.fingerprint);
    const inTests = file ? paths.isTest(file) : false;
    const base = { baselined: inBaseline, inTests };
    if (ruleSetting(ctx.policy, f.ruleId) === 'off') {
      out.set(f.fingerprint, { ...base, status: 'excluded', active: false, reason: `rule ${f.ruleId} is off in the policy` });
      continue;
    }
    if (file && paths.isExcluded(file)) {
      out.set(f.fingerprint, { ...base, status: 'excluded', active: false, reason: `${file} matches policy paths.exclude` });
      continue;
    }
    const sup = ctx.suppressed.get(f.fingerprint);
    if (sup) {
      out.set(f.fingerprint, { ...base, status: 'suppressed', active: false, reason: `athena-ignore at ${sup.file}:${sup.line}: ${sup.reason}` });
      continue;
    }
    const t = ctx.triage?.entries[f.fingerprint];
    if (t && CLOSING_TRIAGE.has(t.status)) {
      out.set(f.fingerprint, { ...base, status: `triaged:${t.status as ClosingTriageStatus}`, active: false, triage: t.status, reason: t.reason });
      continue;
    }
    out.set(f.fingerprint, { ...base, status: inBaseline ? 'baselined' : 'open', active: true, ...(t ? { triage: t.status, reason: `to review: ${t.reason}` } : {}) });
  }
  return out;
}
