import { GitCommandError } from '../core/git/git.js';
import { applyRuleOverrides, loadPolicy, PolicyError, type Policy } from '../core/policy/policy.js';
import { checkPolicyFrom, type PolicyFromResult } from '../core/policy/tamper.js';
import { emptyBaseline, loadBaseline, pruneBaseline, saveBaseline, updateBaseline, type Baseline, type BaselineEntry } from '../core/findings/baseline.js';
import { dedupeFindings, type Finding, type ScanResult } from '../core/findings/finding.js';
import { evaluateGate, type GateResult } from '../core/findings/gate.js';
import { rateCategories, type CategoryRating } from '../core/findings/rating.js';
import { deriveStatuses, type StatusInfo } from '../core/findings/status.js';
import { applySuppressions } from '../core/findings/suppress.js';
import { emptyTriage, loadTriage, removeTriage, saveTriage, setTriage, type Triage, type TriageInput } from '../core/findings/triage.js';
import { AthenaError, EXIT } from './errors.js';

/**
 * Policy layer over a scan result: load the policy, baseline and triage (from the
 * working tree, or from a base ref with `policyFrom`), apply rule overrides and inline
 * suppressions, derive a status per finding, evaluate the gate and rate each category.
 * Nothing here is written to findings.json — statuses are recomputed every run.
 */

function rethrow(err: unknown): never {
  if (err instanceof PolicyError) throw new AthenaError(err.message, err.hint);
  if (err instanceof GitCommandError) throw new AthenaError(err.message, undefined, EXIT.NOT_AVAILABLE);
  throw err;
}

export interface EvaluateOptions {
  /** Use the policy/baseline/triage committed at this ref and report changes to them (CI anti-tamper). */
  policyFrom?: string;
  signal?: AbortSignal;
  /** Rule counts per engine for rating bases. */
  rulesByEngine?: Record<string, number>;
  /** Size cap for files read to find inline suppressions. */
  maxFileBytes?: number;
  /** Ignore the baseline (every finding counts as new). */
  noBaseline?: boolean;
  /** Command-line overrides of the policy's gate thresholds. */
  gate?: Partial<Pick<Policy['gate'], 'failOn' | 'minConfidence' | 'unrated'>>;
}

export type PolicySource = { kind: 'working-tree' } | { kind: 'ref'; ref: string; commit: string; mergeBase: string };

export interface EvaluatedFindings {
  /** The scan's findings with rule overrides applied, plus policy findings (reasonless suppressions, policy-weakened). */
  findings: Finding[];
  statuses: Record<string, StatusInfo>;
  /** fingerprint → justification (exclusion rule, suppression or triage reason), for reporters. */
  notes: Record<string, string>;
  gate: GateResult;
  ratings: CategoryRating[];
  policy: Policy;
  policySource: PolicySource;
  suppressions: { applied: number; skippedFiles: Array<{ file: string; reason: string }> };
  /** Present with `policyFrom`: what changed in the policy files and which suppressions were added. */
  tamper?: Pick<PolicyFromResult, 'changes' | 'addedSuppressions'>;
}

export async function evaluateFindings(root: string, result: ScanResult, opts: EvaluateOptions = {}): Promise<EvaluatedFindings> {
  try {
    let policy: Policy;
    let baseline: Baseline | null;
    let triage: Triage | null;
    let policySource: PolicySource = { kind: 'working-tree' };
    let tamper: PolicyFromResult | undefined;
    if (opts.policyFrom !== undefined) {
      tamper = await checkPolicyFrom(root, opts.policyFrom, { signal: opts.signal });
      ({ policy, baseline, triage } = tamper.base);
      policySource = { kind: 'ref', ref: tamper.ref, commit: tamper.commit, mergeBase: tamper.mergeBase };
    } else {
      [policy, baseline, triage] = await Promise.all([loadPolicy(root), loadBaseline(root), loadTriage(root)]);
    }
    opts.signal?.throwIfAborted();
    if (opts.noBaseline) baseline = null;
    if (opts.gate) policy = { ...policy, gate: { ...policy.gate, ...Object.fromEntries(Object.entries(opts.gate).filter(([, v]) => v !== undefined)) } };

    const scanned = applyRuleOverrides(policy, result.findings);
    const sup = await applySuppressions(root, scanned, { maxBytes: opts.maxFileBytes });
    const extra = applyRuleOverrides(policy, [...sup.findings, ...(tamper?.findings ?? [])]);
    const findings = dedupeFindings([...scanned, ...extra]);
    const statuses = deriveStatuses(findings, { policy, baseline, triage, suppressed: sup.suppressed });
    const view = { findings, coverage: result.coverage };
    const gate = evaluateGate(view, { policy, statuses });
    const ratings = rateCategories(view, { policy, statuses, rulesByEngine: opts.rulesByEngine });
    return {
      findings,
      statuses: Object.fromEntries(statuses),
      notes: Object.fromEntries([...statuses].filter(([, s]) => s.reason).map(([fp, s]) => [fp, s.reason!])),
      gate,
      ratings,
      policy,
      policySource,
      suppressions: { applied: [...sup.suppressed.keys()].filter((fp) => statuses.get(fp)?.status === 'suppressed').length, skippedFiles: sup.skippedFiles },
      ...(tamper ? { tamper: { changes: tamper.changes, addedSuppressions: tamper.addedSuppressions } } : {}),
    };
  } catch (err) {
    rethrow(err);
  }
}

// ── Baseline ────────────────────────────────────────────────────────────────

const NEVER_BASELINED = new Set(['review/policy-weakened', 'review/suppression-without-reason', 'review/invalid-suppression']);

export interface BaselineUpdate {
  added: BaselineEntry[];
  total: number;
  created: boolean;
}

/**
 * Add every current finding to `.athena/baseline.json` (creating it if needed). Policy
 * findings (`review/policy-weakened`, reasonless suppressions) are never baselined.
 */
export async function baselineFindings(root: string, result: ScanResult, opts: { reason?: string; now?: Date } = {}): Promise<BaselineUpdate> {
  try {
    const existing = await loadBaseline(root);
    const eligible = result.findings.filter((f) => !NEVER_BASELINED.has(f.ruleId));
    const { baseline, added } = updateBaseline(existing ?? emptyBaseline(opts.now), eligible, opts);
    await saveBaseline(root, baseline);
    return { added, total: baseline.entries.length, created: existing === null };
  } catch (err) {
    rethrow(err);
  }
}

/** Drop baseline entries a full scan no longer reports (entries of categories not fully scanned are kept). */
export async function pruneBaselineFile(root: string, result: ScanResult): Promise<{ removed: BaselineEntry[]; keptUnverified: BaselineEntry[]; total: number }> {
  try {
    const existing = await loadBaseline(root);
    if (!existing) return { removed: [], keptUnverified: [], total: 0 };
    const r = pruneBaseline(existing, result);
    if (r.removed.length) await saveBaseline(root, r.baseline);
    return { removed: r.removed, keptUnverified: r.keptUnverified, total: r.baseline.entries.length };
  } catch (err) {
    rethrow(err);
  }
}

// ── Triage ──────────────────────────────────────────────────────────────────

export async function triageFinding(root: string, fingerprint: string, input: TriageInput): Promise<Triage> {
  try {
    const t = setTriage((await loadTriage(root)) ?? emptyTriage(), fingerprint, input);
    await saveTriage(root, t);
    return t;
  } catch (err) {
    rethrow(err);
  }
}

export async function untriageFinding(root: string, fingerprint: string): Promise<boolean> {
  try {
    const t = await loadTriage(root);
    if (!t || !(fingerprint in t.entries)) return false;
    await saveTriage(root, removeTriage(t, fingerprint));
    return true;
  } catch (err) {
    rethrow(err);
  }
}
