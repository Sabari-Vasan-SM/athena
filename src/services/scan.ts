import { loadConfig } from '../core/config.js';
import { git, isSafeRef, workingChanges, changesSince } from '../core/git/git.js';
import { Coverage, Finding, type Category, type ScanResult } from '../core/findings/finding.js';
import { saveFindings } from '../core/findings/store.js';
import { builtinScanners } from '../core/scanners/index.js';
import { runScanners, type ScanContext } from '../core/scanners/types.js';
import type { CategoryRating, FindingStatus, ReportInput } from '../core/report/index.js';
import { projectSession } from './project-session.js';
import { analyzeProject } from '../core/analyzer/analyze.js';
import { createReviewScanner } from './review.js';
import { evaluateFindings, type EvaluatedFindings, type EvaluateOptions } from './findings.js';
import { AthenaError, EXIT } from './errors.js';
import { ATHENA_VERSION } from './version.js';

/**
 * `athena scan`: run the built-in scanners over the whole project or a change, then
 * apply the policy (baseline, triage, suppressions, gate, ratings). Scanners that can't
 * run are reported in coverage, never dropped; a scope Git can't compute is an error.
 */

export const SCAN_TARGETS = ['secrets', 'deps', 'review'] as const;
export type ScanTarget = (typeof SCAN_TARGETS)[number];
export type ScanMode = ScanResult['scope']['mode'];

export interface RunScanOptions {
  mode: ScanMode;
  /** Base ref for mode `base`. */
  base?: string;
  /** Scanners to run. Default: secrets and deps; review too when scanning a change. */
  only?: ScanTarget[];
  /** Don't contact the network: dependency audits are skipped (and reported as skipped). */
  offline?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  onTool?: (tool: string) => void;
  /** Write `.athena/findings.json` (only full-project scans are saved). */
  save?: boolean;
}

export function parseTargets(raw: string | undefined): ScanTarget[] | undefined {
  if (raw === undefined) return undefined;
  const alias: Record<string, ScanTarget> = { secret: 'secrets', secrets: 'secrets', dep: 'deps', deps: 'deps', dependencies: 'deps', dependency: 'deps', review: 'review' };
  const out = new Set<ScanTarget>();
  for (const part of raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const t = alias[part];
    if (!t) throw new AthenaError(`Unknown scanner in --only: ${part}`, `Use a comma-separated list of: ${SCAN_TARGETS.join(', ')}`);
    out.add(t);
  }
  if (!out.size) throw new AthenaError('--only needs at least one scanner', `Use a comma-separated list of: ${SCAN_TARGETS.join(', ')}`);
  return [...out];
}

/** Files in scope for a change scan (deleted files excluded), or undefined for the whole project. */
async function filesInScope(root: string, mode: ScanMode, base: string | undefined, signal?: AbortSignal): Promise<string[] | undefined> {
  if (mode === 'all') return undefined;
  const hint = 'Athena did not scan this change. Fix the Git problem and run the scan again.';
  if (mode === 'base') {
    if (!base || !isSafeRef(base)) throw new AthenaError(`Invalid base ref: ${base ?? '(none)'}`);
    const changes = await changesSince(root, base, { signal });
    if (!changes) throw new AthenaError(`Could not compute the changes since ${base}.`, `Check that the ref exists and that the clone has enough history (fetch-depth: 0 in CI). ${hint}`, EXIT.NOT_AVAILABLE);
    return changes.filter((c) => c.status !== 'deleted').map((c) => c.path);
  }
  if (mode === 'staged') {
    const r = await git(root, ['diff', '--cached', '--name-only', '-z', '--relative', '--no-color', '--diff-filter=d'], { signal });
    if (!r.ok) throw new AthenaError('Could not list staged files.', hint, EXIT.NOT_AVAILABLE);
    return r.stdout.split('\0').filter(Boolean);
  }
  const changes = await workingChanges(root, { signal });
  if (!changes) throw new AthenaError('Could not list changed files (is this a Git repository?).', hint, EXIT.NOT_AVAILABLE);
  return changes.filter((c) => c.status !== 'deleted').map((c) => c.path);
}

export async function runScan(root: string, opts: RunScanOptions): Promise<ScanResult> {
  const targets = new Set<ScanTarget>(opts.only ?? (opts.mode === 'all' ? ['secrets', 'deps'] : ['secrets', 'deps', 'review']));
  const { config } = await loadConfig(root);
  const files = await filesInScope(root, opts.mode, opts.base, opts.signal);
  const ctx: ScanContext = { root, config, mode: opts.mode, ...(opts.base ? { base: opts.base } : {}), ...(files ? { files } : {}), offline: opts.offline, signal: opts.signal };

  // Dependency audits pick tools from the project model's ecosystems.
  const model = targets.has('deps') ? ((await projectSession(root).model()) ?? (await analyzeProject(root, { signal: opts.signal })).model) : undefined;
  const scanners = builtinScanners({
    review: targets.has('review') ? createReviewScanner() : undefined,
    skipAudit: !targets.has('deps'),
    model,
    timeoutMs: opts.timeoutMs,
    onTool: opts.onTool,
  }).filter((s) => targets.has('secrets') || s.category !== 'secret');

  const result = await runScanners(scanners, ctx);
  if (targets.has('review') && opts.mode === 'all') {
    // The review scanner reported itself skipped: say why in words a reader can act on.
    result.coverage = result.coverage.map((c) => (c.category === 'review' && c.status === 'skipped' ? Coverage.parse({ ...c, reason: 'review checks need a change: use --base <ref>, --staged or --changed' }) : c));
  }
  if (opts.save && opts.mode === 'all') await saveFindings(root, result);
  return result;
}

/** Ratings and statuses in the shape the report renderers take. */
export function reportInput(root: string, result: ScanResult, evaluated?: EvaluatedFindings): ReportInput {
  if (!evaluated) return { result, root, toolVersion: ATHENA_VERSION };
  const statuses: Record<string, FindingStatus> = {};
  for (const [fp, s] of Object.entries(evaluated.statuses)) statuses[fp] = s.status;
  const ratings: Partial<Record<Category, CategoryRating>> = {};
  for (const r of evaluated.ratings) if (r.rating) ratings[r.category] = { grade: r.rating, basis: r.basis };
  return {
    result: { ...result, findings: evaluated.findings },
    statuses,
    notes: evaluated.notes,
    gate: { passed: evaluated.gate.passed, reasons: [...evaluated.gate.reasons, ...evaluated.gate.warnings.map((w) => `warning: ${w}`)] },
    ratings,
    root,
    toolVersion: ATHENA_VERSION,
  };
}

export interface ScanAndEvaluate {
  result: ScanResult;
  evaluated: EvaluatedFindings;
}

export async function scanAndEvaluate(root: string, opts: RunScanOptions & Omit<EvaluateOptions, 'signal'>): Promise<ScanAndEvaluate> {
  const result = await runScan(root, opts);
  const evaluated = await evaluateFindings(root, result, opts);
  return { result, evaluated };
}

/** Find one finding by a fingerprint prefix (at least 6 hex characters). */
export function findByPrefix(findings: Finding[], prefix: string): Finding {
  const p = prefix.trim().toLowerCase();
  if (!/^[a-f0-9]{6,32}$/.test(p)) throw new AthenaError(`Not a fingerprint: ${prefix}`, 'Use at least 6 hex characters of a fingerprint from `athena findings list`.');
  const hits = findings.filter((f) => f.fingerprint.startsWith(p));
  if (!hits.length) throw new AthenaError(`No finding with fingerprint ${p} in the last scan.`, 'Run `athena scan` and `athena findings list` to see current fingerprints.', EXIT.ERROR, 'not-found');
  if (hits.length > 1) throw new AthenaError(`Fingerprint prefix ${p} matches ${hits.length} findings.`, 'Use more characters.');
  return hits[0]!;
}
