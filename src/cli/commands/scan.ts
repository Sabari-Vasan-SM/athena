import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CONFIDENCES, type Finding } from '../../core/findings/finding.js';
import { loadFindings } from '../../core/findings/store.js';
import { TRIAGE_STATUSES, type TriageStatus } from '../../core/findings/triage.js';
import { loadBaseline } from '../../core/findings/baseline.js';
import { GATE_SEVERITIES } from '../../core/policy/policy.js';
import { listRules, render, REPORT_FORMATS, ruleInfo, type ReportFormat } from '../../core/report/index.js';
import { writeFileAtomic } from '../../core/util/fs.js';
import { AthenaError, EXIT } from '../../services/errors.js';
import { baselineFindings, evaluateFindings, pruneBaselineFile, triageFinding, untriageFinding } from '../../services/findings.js';
import { findByPrefix, parseTargets, reportInput, runScan, scanAndEvaluate, type ScanMode } from '../../services/scan.js';
import { requireProjectRoot, type GlobalOptions } from '../context.js';
import * as ui from '../ui/term.js';

export interface ScanOptions extends GlobalOptions {
  only?: string;
  base?: string;
  staged?: boolean;
  changed?: boolean;
  format?: string;
  output?: string;
  failOn?: string;
  minConfidence?: string;
  unrated?: string;
  noBaseline?: boolean;
  policyFrom?: string;
  offline?: boolean;
  listRules?: boolean;
  noFail?: boolean;
  signal?: AbortSignal;
}

function scanMode(o: { base?: string; staged?: boolean; changed?: boolean }): ScanMode {
  const picked = [o.base !== undefined, Boolean(o.staged), Boolean(o.changed)].filter(Boolean).length;
  if (picked > 1) throw new AthenaError('Use only one of --base, --staged and --changed.');
  return o.base !== undefined ? 'base' : o.staged ? 'staged' : o.changed ? 'changed' : 'all';
}

function pick<T extends string>(flag: string, value: string | undefined, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  const v = value.toLowerCase() as T;
  if (!allowed.includes(v)) throw new AthenaError(`Invalid ${flag} value: ${value}`, `Use one of: ${allowed.join(', ')}`);
  return v;
}

function printRules(): void {
  const rules = listRules();
  if (ui.isJson()) return ui.json(rules);
  ui.heading(`Athena rules (${rules.length})`);
  for (const r of rules) ui.line(`  ${r.id.padEnd(44)} ${ui.dim(`${r.category}${r.potential ? ', potential' : ''}`)}  ${r.title}`);
  ui.line(ui.dim('\nRun `athena explain <ruleId>` for details. External engines (later releases) bring their own rules.'));
}

export async function scanCommand(opts: ScanOptions): Promise<number> {
  if (opts.listRules) {
    printRules();
    return EXIT.OK;
  }
  const root = await requireProjectRoot(opts);
  const mode = scanMode(opts);
  const only = parseTargets(opts.only);
  const format = pick<ReportFormat>('--format', opts.format ?? (ui.isJson() ? 'json' : 'text'), REPORT_FORMATS)!;
  const failOn = pick('--fail-on', opts.failOn === 'moderate' ? 'medium' : opts.failOn, GATE_SEVERITIES);
  const minConfidence = pick('--min-confidence', opts.minConfidence, CONFIDENCES);
  const unrated = pick('--unrated', opts.unrated, ['fail', 'warn'] as const);

  // Spinner only for human output on a terminal; machine formats keep stdout clean.
  const interactive = format === 'text' && !opts.output && !ui.isJson();
  const sp = interactive ? ui.spinner('Scanning...') : null;
  let scanned;
  try {
    scanned = await scanAndEvaluate(root, {
      mode,
      base: opts.base,
      only,
      offline: opts.offline,
      signal: opts.signal,
      onTool: (tool) => sp?.update(`Running ${tool}...`),
      save: true,
      noBaseline: opts.noBaseline,
      policyFrom: opts.policyFrom,
      gate: { failOn, minConfidence, unrated },
    });
    sp?.stop();
  } catch (err) {
    sp?.stop();
    throw err;
  }
  const { result, evaluated } = scanned;
  const report = render(format, reportInput(root, result, evaluated), { color: interactive ? undefined : false });

  if (opts.output) {
    const out = path.resolve(opts.output);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await writeFileAtomic(out, report.endsWith('\n') ? report : `${report}\n`);
    if (!ui.isJson()) {
      const open = Object.values(evaluated.statuses).filter((s) => s.status === 'open').length;
      ui.info(`${format} report written to ${path.relative(process.cwd(), out) || out}: ${open} open finding(s); gate ${evaluated.gate.passed ? 'passed' : 'failed'}`);
    }
  } else {
    process.stdout.write(report.endsWith('\n') ? report : `${report}\n`);
  }
  if (!evaluated.gate.passed && !opts.noFail) {
    process.stderr.write(`athena scan: quality gate failed: ${evaluated.gate.reasons.join('; ')}\n`);
    return 1;
  }
  return EXIT.OK;
}

// ── explain ─────────────────────────────────────────────────────────────────

export async function explainCommand(ruleId: string, opts: GlobalOptions): Promise<number> {
  const r = ruleInfo(ruleId.trim().toLowerCase());
  if (!r) throw new AthenaError(`Unknown rule: ${ruleId}`, 'Run `athena scan --list-rules` for the rule ids Athena knows.', EXIT.ERROR, 'not-found');
  void opts;
  if (ui.isJson()) {
    ui.json(r);
    return EXIT.OK;
  }
  ui.heading(`${r.id}${r.potential ? ui.dim('  (heuristic: findings are "potential")') : ''}`);
  ui.line(r.title);
  ui.line(ui.dim(`Category: ${r.category}${r.cwe.length ? ` · ${r.cwe.join(', ')}` : ''}`));
  ui.line();
  ui.line(r.description);
  ui.line();
  ui.heading('What to do');
  ui.line(r.help);
  if (r.helpUrl) ui.line(ui.dim(r.helpUrl));
  ui.line();
  ui.line(ui.dim(`To accept a specific finding: \`athena findings triage <fingerprint> <status> --reason …\` or an inline \`athena-ignore ${r.id} -- <reason>\` comment.`));
  return EXIT.OK;
}

// ── baseline ────────────────────────────────────────────────────────────────

export interface BaselineOptions extends GlobalOptions {
  reason?: string;
  last?: boolean;
  offline?: boolean;
  signal?: AbortSignal;
}

/** The scan a baseline command works from: the last full scan with --last, else a fresh full scan. */
async function fullScan(root: string, opts: BaselineOptions) {
  if (opts.last) {
    const last = await loadFindings(root);
    if (!last) throw new AthenaError('No previous scan found.', 'Run `athena scan` first, or drop --last.');
    if (last.scope.mode !== 'all') throw new AthenaError('The last scan was not a full-project scan.', 'Run `athena scan` (no --base/--staged/--changed) first.');
    return last;
  }
  const sp = ui.isJson() ? null : ui.spinner('Scanning the whole project...');
  try {
    const r = await runScan(root, { mode: 'all', offline: opts.offline, signal: opts.signal, save: true, onTool: (t) => sp?.update(`Running ${t}...`) });
    sp?.stop();
    return r;
  } catch (err) {
    sp?.stop();
    throw err;
  }
}

export async function baselineCreateCommand(opts: BaselineOptions & { force?: boolean; update?: boolean }): Promise<number> {
  const root = await requireProjectRoot(opts);
  if (!opts.update && !opts.force && (await loadBaseline(root))) {
    throw new AthenaError('.athena/baseline.json already exists.', 'Use `athena baseline update` to add new findings, or `--force` to add to it anyway.');
  }
  const result = await fullScan(root, opts);
  const r = await baselineFindings(root, result, { reason: opts.reason });
  if (ui.isJson()) ui.json({ added: r.added.length, total: r.total, created: r.created });
  else {
    ui.ok(`${r.created ? 'Created' : 'Updated'} .athena/baseline.json: ${r.added.length} finding(s) added, ${r.total} in total`);
    ui.line(ui.dim('  Commit it. Baselined findings stay visible but only new findings fail the gate (scope "new").'));
    const broken = result.coverage.filter((c) => c.status === 'failed' || c.status === 'timeout');
    if (broken.length) ui.warn(`Not in the baseline because the engine did not complete: ${broken.map((c) => `${c.engine} (${c.status})`).join(', ')}`);
  }
  return EXIT.OK;
}

export async function baselinePruneCommand(opts: BaselineOptions): Promise<number> {
  const root = await requireProjectRoot(opts);
  if (!(await loadBaseline(root))) throw new AthenaError('No .athena/baseline.json to prune.', 'Create one with `athena baseline create`.');
  const result = await fullScan(root, opts);
  const r = await pruneBaselineFile(root, result);
  if (ui.isJson()) ui.json({ removed: r.removed.length, keptUnverified: r.keptUnverified.length, total: r.total });
  else {
    ui.ok(`Removed ${r.removed.length} baseline entr${r.removed.length === 1 ? 'y' : 'ies'} the scan no longer reports; ${r.total} remain`);
    if (r.keptUnverified.length) ui.line(ui.dim(`  Kept ${r.keptUnverified.length} entr${r.keptUnverified.length === 1 ? 'y' : 'ies'} whose engine did not run fully, so Athena can't tell whether they were fixed.`));
  }
  return EXIT.OK;
}

export async function baselineShowCommand(opts: GlobalOptions): Promise<number> {
  const root = await requireProjectRoot(opts);
  const b = await loadBaseline(root);
  if (ui.isJson()) {
    ui.json(b ?? { entries: [] });
    return EXIT.OK;
  }
  if (!b) {
    ui.line('No baseline (.athena/baseline.json). Every finding counts as new.');
    return EXIT.OK;
  }
  ui.heading(`Baseline: ${b.entries.length} entr${b.entries.length === 1 ? 'y' : 'ies'} (created ${ui.relativeTime(b.createdAt)})`);
  const byRule = new Map<string, number>();
  for (const e of b.entries) byRule.set(e.ruleId, (byRule.get(e.ruleId) ?? 0) + 1);
  for (const [rule, n] of [...byRule].sort((a, z) => z[1] - a[1])) ui.line(`  ${String(n).padStart(4)}  ${rule}`);
  return EXIT.OK;
}

// ── findings ────────────────────────────────────────────────────────────────

export interface FindingsListOptions extends GlobalOptions {
  status?: string;
  severity?: string;
  category?: string;
  all?: boolean;
  signal?: AbortSignal;
}

async function lastEvaluated(root: string, signal?: AbortSignal) {
  const result = await loadFindings(root);
  if (!result) throw new AthenaError('No scan results yet.', 'Run `athena scan` first.');
  return { result, evaluated: await evaluateFindings(root, result, { signal }) };
}

const short = (fp: string) => fp.slice(0, 12);
const where = (f: Finding) => f.location ? `${f.location.file}${f.location.startLine ? `:${f.location.startLine}` : ''}` : f.package ? `${f.package.name}${f.package.version ? `@${f.package.version}` : ''}` : '';

export async function findingsListCommand(opts: FindingsListOptions): Promise<number> {
  const root = await requireProjectRoot(opts);
  const { result, evaluated } = await lastEvaluated(root, opts.signal);
  const wantStatus = opts.status?.toLowerCase();
  const rows = evaluated.findings
    .map((f) => ({ f, s: evaluated.statuses[f.fingerprint]! }))
    .filter(({ s }) => (opts.all || wantStatus ? true : s.active))
    .filter(({ s }) => !wantStatus || s.status === wantStatus || s.status.startsWith(`${wantStatus}:`) || s.triage === wantStatus)
    .filter(({ f }) => !opts.severity || f.severity === opts.severity.toLowerCase())
    .filter(({ f }) => !opts.category || f.category === opts.category.toLowerCase());
  if (ui.isJson()) {
    ui.json({ scannedAt: result.scannedAt, scope: result.scope, findings: rows.map(({ f, s }) => ({ ...f, status: s.status, ...(s.triage ? { triage: s.triage } : {}) })) });
    return EXIT.OK;
  }
  ui.heading(`Findings from the scan ${ui.relativeTime(result.scannedAt)} (${rows.length} shown)`);
  for (const { f, s } of rows) {
    const title = f.potential && !/^potential\b/i.test(f.title) ? `Potential ${f.title.charAt(0).toLowerCase()}${f.title.slice(1)}` : f.title;
    ui.line(`  ${ui.dim(short(f.fingerprint))}  ${f.severity.padEnd(8)} ${title}  ${ui.dim(where(f))}${s.status === 'open' ? '' : ui.dim(`  [${s.status}]`)}`);
  }
  if (!rows.length) ui.line(ui.dim('  None.'));
  if (!opts.all && !wantStatus) ui.line(ui.dim('\nShowing active findings. Use --all for baselined, suppressed, triaged and excluded ones too.'));
  return EXIT.OK;
}

export async function findingsShowCommand(fp: string, opts: GlobalOptions & { signal?: AbortSignal }): Promise<number> {
  const root = await requireProjectRoot(opts);
  const { evaluated } = await lastEvaluated(root, opts.signal);
  const f = findByPrefix(evaluated.findings, fp);
  const s = evaluated.statuses[f.fingerprint]!;
  if (ui.isJson()) {
    ui.json({ ...f, status: s.status, ...(s.triage ? { triage: s.triage } : {}), ...(s.reason ? { statusReason: s.reason } : {}), rule: ruleInfo(f.ruleId) ?? null });
    return EXIT.OK;
  }
  ui.heading(f.title);
  ui.line(ui.dim(`${f.fingerprint} · ${f.ruleId} · ${f.category} · ${f.severity} · confidence ${f.confidence} · ${f.label}${f.potential ? ' · potential' : ''}`));
  if (where(f)) ui.line(`Where: ${where(f)}`);
  ui.line(`Status: ${s.status}${s.triage === 'to-review' ? ' (triaged: to-review)' : ''}${s.reason ? ui.dim(` — ${s.reason}`) : ''}`);
  ui.line(`Engine: ${f.engine.id}${f.alsoReportedBy.length ? ` (also: ${f.alsoReportedBy.join(', ')})` : ''}`);
  if (f.cwe.length) ui.line(`CWE: ${f.cwe.join(', ')}`);
  if (f.package?.advisoryIds.length) ui.line(`Advisories: ${f.package.advisoryIds.join(', ')}${f.package.fixedIn ? ` · fixed in ${f.package.fixedIn}` : ''}`);
  ui.line();
  ui.line(f.message);
  const help = f.help?.text ?? ruleInfo(f.ruleId)?.help;
  if (help) {
    ui.line();
    ui.line(ui.dim(help));
  }
  return EXIT.OK;
}

export async function findingsTriageCommand(fp: string, status: string, opts: GlobalOptions & { reason?: string; by?: string; clear?: boolean; signal?: AbortSignal }): Promise<number> {
  const root = await requireProjectRoot(opts);
  const { evaluated } = await lastEvaluated(root, opts.signal);
  const f = findByPrefix(evaluated.findings, fp);
  if (opts.clear || status === 'clear') {
    const removed = await untriageFinding(root, f.fingerprint);
    if (ui.isJson()) ui.json({ fingerprint: f.fingerprint, removed });
    else ui.ok(removed ? `Removed the triage decision for ${short(f.fingerprint)}` : `${short(f.fingerprint)} had no triage decision`);
    return EXIT.OK;
  }
  const st = pick<TriageStatus>('status', status, TRIAGE_STATUSES)!;
  if (!opts.reason?.trim()) throw new AthenaError('A triage decision needs a reason.', 'Add --reason "<why>" (it is committed in .athena/triage.json for reviewers).');
  await triageFinding(root, f.fingerprint, { status: st, reason: opts.reason.trim(), ...(opts.by ? { by: opts.by } : {}) });
  if (ui.isJson()) ui.json({ fingerprint: f.fingerprint, status: st });
  else {
    ui.ok(`${short(f.fingerprint)} (${f.ruleId}) triaged as ${st}`);
    ui.line(ui.dim('  Recorded in .athena/triage.json — commit it so the decision is reviewed with the code.'));
  }
  return EXIT.OK;
}
