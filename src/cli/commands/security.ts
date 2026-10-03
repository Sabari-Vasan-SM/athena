import type { ProjectModel } from '../../core/model/project-model.js';
import { analyzeProject } from '../../core/analyzer/analyze.js';
import { projectSession } from '../../services/project-session.js';
import { meetsThreshold, RATED_SEVERITIES, runSecurityScanWithFindings, saveScan, SEVERITY_ORDER, unratedFindings, type SecurityScan, type Severity } from '../../services/security.js';
import { AthenaError, EXIT } from '../../services/errors.js';
import { requireProjectRoot, type GlobalOptions } from '../context.js';
import * as ui from '../ui/term.js';

export interface SecurityOptions extends GlobalOptions {
  noAudit?: boolean;
  failOn?: string;
  /** How unrated findings (no severity reported by the tool) affect --fail-on: fail (default) or warn. */
  unrated?: string;
  last?: boolean;
  signal?: AbortSignal;
}

const TONE: Record<Severity, (s: string) => string> = {
  critical: ui.c.red,
  high: ui.c.red,
  moderate: ui.c.yellow,
  low: ui.c.cyan,
  unrated: ui.c.magenta,
};

/**
 * Model for the report's context (declared controls, tooling) and for choosing
 * which audit tools apply. Secret findings are NOT taken from it: the scan
 * re-scans the files.
 */
async function loadModel(root: string, signal?: AbortSignal): Promise<ProjectModel> {
  // A missing or unusable model.json falls back to a fresh analysis.
  return (await projectSession(root).model()) ?? (await analyzeProject(root, { signal })).model;
}

const toolLabel = (t: { tool: string; target?: string }) => (t.target ? `${t.tool} (${t.target})` : t.tool);

export function printScan(scan: SecurityScan, model: ProjectModel): void {
  ui.heading('Secrets');
  if (scan.secrets.count) {
    ui.warn(`${scan.secrets.count} potential hardcoded secret(s) in ${scan.secrets.files.length} file(s)`);
    for (const f of scan.secrets.files.slice(0, 8)) ui.line(`  ${ui.dim(f)}`);
    ui.line(ui.dim('  Values are never stored. See .athena/security.md for types and locations.'));
  } else {
    ui.ok('No likely secrets matched Athena\'s patterns in scanned files');
    ui.line(ui.dim('  Gitignored and oversized files are not scanned — this is not proof that none exist.'));
  }
  if (scan.secrets.skippedLongLines) ui.line(ui.dim(`  Generic keyword patterns were not applied to ${scan.secrets.skippedLongLines} line(s) longer than 4096 characters.`));
  if (scan.secrets.truncated) ui.warn('Secret scan stopped early after too many findings.');

  ui.line();
  ui.heading('Dependency audit');
  if (!scan.tools.length) {
    ui.line(ui.dim('  No auditable ecosystems detected (no lockfiles or supported manifests).'));
  }
  for (const t of scan.tools) {
    if (t.status !== 'ok') {
      ui.line(`${ui.c.dim(ui.sym.ring)} ${toolLabel(t)} ${ui.dim(`— ${t.status}: ${t.message ?? ''}`)}`);
      continue;
    }
    if (!t.findings.length) {
      ui.ok(`${toolLabel(t)} ${ui.dim(`— no known vulnerable dependencies (${(t.durationMs / 1000).toFixed(1)}s)`)}`);
      continue;
    }
    const bySeverity = SEVERITY_ORDER.map((s) => [s, t.findings.filter((f) => f.severity === s).length] as const).filter(([, n]) => n > 0);
    ui.warn(`${toolLabel(t)} — ${t.findings.length} finding(s): ${bySeverity.map(([s, n]) => TONE[s](`${n} ${s}`)).join(', ')}`);
    for (const f of t.findings.slice(0, 12)) {
      ui.line(`  ${TONE[f.severity](f.severity.padEnd(8))} ${ui.c.bold(f.package)} ${ui.dim(f.title.slice(0, 70))}${f.fixAvailable ? ui.c.green(' (fix available)') : ''}`);
    }
    if (t.findings.length > 12) ui.line(ui.dim(`  +${t.findings.length - 12} more — see .athena/security-scan.json`));
  }
  if (scan.tools.some((t) => t.status === 'ok' && t.findings.some((f) => f.severity === 'unrated'))) {
    ui.line(ui.dim('  "unrated": the tool reports vulnerabilities without a severity. Treat them as unreviewed, not as low.'));
  }

  ui.line();
  ui.heading('Declared security controls');
  ui.line(model.security.controls.length ? `  ${model.security.controls.map((c) => c.name).join(', ')}` : ui.dim('  None detected'));
  ui.line(ui.dim(`  Security tooling: ${model.security.tooling.length ? [...new Set(model.security.tooling.map((t) => t.name))].join(', ') : 'none detected'}`));
  ui.line();
  ui.line(ui.dim('Findings come from the tools above. Athena has no vulnerability database of its own, and a clean audit is not proof that the project is secure.'));
}

/** Explanations for a --fail-on decision go to stderr so `--json` output stays parseable. */
const explain = (s: string) => process.stderr.write(`${s}\n`);

export async function securityCommand(opts: SecurityOptions): Promise<number> {
  const root = await requireProjectRoot(opts);

  // Validate flags before doing any work.
  let level: Severity | null = null;
  if (opts.failOn) {
    const raw = opts.failOn.toLowerCase();
    const normalized = (raw === 'unknown' ? 'unrated' : raw) as Severity;
    if (!SEVERITY_ORDER.includes(normalized)) throw new AthenaError(`Invalid --fail-on value: ${opts.failOn}`, `Use one of: ${RATED_SEVERITIES.join(', ')}`);
    level = normalized;
  }
  const unratedPolicy = (opts.unrated ?? 'fail').toLowerCase();
  if (unratedPolicy !== 'fail' && unratedPolicy !== 'warn') throw new AthenaError(`Invalid --unrated value: ${opts.unrated}`, 'Use one of: fail, warn');

  let scan: SecurityScan | null = null;
  let model: ProjectModel;

  if (opts.last) {
    scan = await projectSession(root).scan();
    if (!scan) throw new AthenaError('No previous scan found.', 'Run `athena security` to scan now.');
    model = await loadModel(root, opts.signal);
  } else {
    const sp = ui.spinner('Analyzing project...');
    try {
      model = await loadModel(root, opts.signal);
      sp.update('Scanning files for secrets...');
      scan = (await runSecurityScanWithFindings(root, model, { signal: opts.signal, skipAudit: opts.noAudit, onTool: (tool) => sp.update(`Running ${tool}...`) })).scan;
      sp.succeed(`Security scan finished in ${(scan.durationMs / 1000).toFixed(1)}s`);
    } catch (err) {
      sp.stop();
      throw err;
    }
    // Writes the legacy security-scan.json (web UI, security.md) and .athena/findings.json.
    await saveScan(root, scan);
  }

  // `--json` keeps the v1 security-scan.json shape for compatibility. The unified
  // findings shape is in .athena/findings.json (and `athena scan --format json`).
  if (ui.isJson()) ui.json(scan);
  else {
    ui.heading('Athena Security');
    ui.line(ui.dim(`Scanned ${ui.relativeTime(scan.scannedAt)}${opts.last ? ' (cached result)' : ''}`));
    ui.line();
    printScan(scan, model);
    if (!opts.last) ui.line(ui.dim('\nRun `athena sync` to record these results in .athena/security.md.'));
  }

  if (level) {
    const unrated = unratedFindings(scan);
    const ratedHit = meetsThreshold(scan, level, { unrated: 'warn' });
    if (scan.secrets.count > 0) {
      explain(`athena security: failing (--fail-on ${level}): ${scan.secrets.count} potential secret(s) found.`);
      return 1;
    }
    if (ratedHit) {
      explain(`athena security: failing (--fail-on ${level}): findings at or above ${level}.`);
      return 1;
    }
    if (unrated.length) {
      const tools = [...new Set(scan.tools.filter((t) => t.findings.some((f) => f.severity === 'unrated')).map((t) => t.tool))].join(', ');
      if (unratedPolicy === 'fail') {
        explain(`athena security: failing (--fail-on ${level}): ${unrated.length} unrated finding(s) from ${tools}. These tools do not report severity, so the finding may be at or above ${level}. Pass --unrated warn to not fail on unrated findings.`);
        return 1;
      }
      explain(`athena security: warning: ${unrated.length} unrated finding(s) from ${tools} were not counted toward --fail-on ${level} (--unrated warn).`);
    }
    // A tool that ran but failed or timed out checked nothing, so it can't count as a pass.
    const broken = scan.tools.filter((t) => t.status === 'failed' || t.status === 'timeout');
    if (broken.length) {
      explain(`athena security: failing (--fail-on ${level}): ${broken.map((t) => `${t.tool} ${t.status}`).join(', ')}, so those dependencies were not checked.`);
      return 1;
    }
    const missing = scan.tools.filter((t) => t.status === 'unavailable');
    if (missing.length) explain(`athena security: note: not checked because the tool is unavailable: ${missing.map((t) => t.tool).join(', ')}.`);
  }
  return EXIT.OK;
}
