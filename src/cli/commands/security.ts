import path from 'node:path';
import { ProjectModel } from '../../core/model/project-model.js';
import { readTextIfExists } from '../../core/util/fs.js';
import { athenaDir } from '../../core/state/state.js';
import { analyzeProject } from '../../core/analyzer/analyze.js';
import { loadScan, meetsThreshold, runSecurityScan, saveScan, SEVERITY_ORDER, type SecurityScan, type Severity } from '../../services/security.js';
import { AthenaError, EXIT } from '../../services/errors.js';
import { requireProjectRoot, type GlobalOptions } from '../context.js';
import * as ui from '../ui/term.js';

export interface SecurityOptions extends GlobalOptions {
  noAudit?: boolean;
  failOn?: string;
  last?: boolean;
  signal?: AbortSignal;
}

const TONE: Record<Severity, (s: string) => string> = {
  critical: ui.c.red,
  high: ui.c.red,
  moderate: ui.c.yellow,
  low: ui.c.cyan,
  unknown: ui.c.dim,
};

async function loadModel(root: string, signal?: AbortSignal): Promise<ProjectModel> {
  const raw = await readTextIfExists(path.join(athenaDir(root), 'model.json'));
  if (raw) {
    try {
      const parsed = ProjectModel.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      /* fall through to a fresh analysis */
    }
  }
  return (await analyzeProject(root, { signal })).model;
}

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

  ui.line();
  ui.heading('Dependency audit');
  if (!scan.tools.length) {
    ui.line(ui.dim('  No auditable ecosystems detected (no lockfiles or supported manifests).'));
  }
  for (const t of scan.tools) {
    if (t.status !== 'ok') {
      ui.line(`${ui.c.dim(ui.sym.ring)} ${t.tool} ${ui.dim(`— ${t.status}: ${t.message ?? ''}`)}`);
      continue;
    }
    if (!t.findings.length) {
      ui.ok(`${t.tool} ${ui.dim(`— no known vulnerable dependencies (${(t.durationMs / 1000).toFixed(1)}s)`)}`);
      continue;
    }
    const bySeverity = SEVERITY_ORDER.map((s) => [s, t.findings.filter((f) => f.severity === s).length] as const).filter(([, n]) => n > 0);
    ui.warn(`${t.tool} — ${t.findings.length} finding(s): ${bySeverity.map(([s, n]) => TONE[s](`${n} ${s}`)).join(', ')}`);
    for (const f of t.findings.slice(0, 12)) {
      ui.line(`  ${TONE[f.severity](f.severity.padEnd(8))} ${ui.c.bold(f.package)} ${ui.dim(f.title.slice(0, 70))}${f.fixAvailable ? ui.c.green(' (fix available)') : ''}`);
    }
    if (t.findings.length > 12) ui.line(ui.dim(`  +${t.findings.length - 12} more — see .athena/security-scan.json`));
  }

  ui.line();
  ui.heading('Declared security controls');
  ui.line(model.security.controls.length ? `  ${model.security.controls.map((c) => c.name).join(', ')}` : ui.dim('  None detected'));
  ui.line(ui.dim(`  Security tooling: ${model.security.tooling.length ? [...new Set(model.security.tooling.map((t) => t.name))].join(', ') : 'none detected'}`));
  ui.line();
  ui.line(ui.dim('Findings come from the tools above. Athena has no vulnerability database of its own, and a clean audit is not proof that the project is secure.'));
}

export async function securityCommand(opts: SecurityOptions): Promise<number> {
  const root = await requireProjectRoot(opts);
  let scan: SecurityScan | null = null;
  let model: ProjectModel;

  if (opts.last) {
    scan = await loadScan(root);
    if (!scan) throw new AthenaError('No previous scan found.', 'Run `athena security` to scan now.');
    model = await loadModel(root, opts.signal);
  } else {
    const sp = ui.spinner('Analyzing project...');
    try {
      model = await loadModel(root, opts.signal);
      scan = await runSecurityScan(root, model, { signal: opts.signal, skipAudit: opts.noAudit, onTool: (tool) => sp.update(`Running ${tool}...`) });
      sp.succeed(`Security scan finished in ${(scan.durationMs / 1000).toFixed(1)}s`);
    } catch (err) {
      sp.stop();
      throw err;
    }
    await saveScan(root, scan);
  }

  if (ui.isJson()) ui.json(scan);
  else {
    ui.heading('Athena Security');
    ui.line(ui.dim(`Scanned ${ui.relativeTime(scan.scannedAt)}${opts.last ? ' (cached result)' : ''}`));
    ui.line();
    printScan(scan, model);
    if (!opts.last) ui.line(ui.dim('\nRun `athena sync` to record these results in .athena/security.md.'));
  }

  if (opts.failOn) {
    const level = opts.failOn.toLowerCase() as Severity;
    if (!SEVERITY_ORDER.includes(level)) throw new AthenaError(`Invalid --fail-on value: ${opts.failOn}`, `Use one of: ${SEVERITY_ORDER.join(', ')}`);
    if (scan.secrets.count > 0 || meetsThreshold(scan, level)) return 1;
  }
  return EXIT.OK;
}
