import { ProjectModel } from '../core/model/project-model.js';
import { saveScan as saveLegacyScan, type SecurityScan, type Severity } from '../core/model/security-scan.js';
import { loadConfig } from '../core/config.js';
import { walkProject } from '../core/fs/walker.js';
import { Coverage, dedupeFindings, Finding, type ScanResult } from '../core/findings/finding.js';
import { saveFindings } from '../core/findings/store.js';
import { auditDependencies, legacyToolResult } from '../core/scanners/dependencies.js';
import { scanSecrets } from '../core/scanners/secrets.js';
import type { ScanContext, ScannerOutput } from '../core/scanners/types.js';

export { loadScan, totalFindings, meetsThreshold, unratedFindings, SCAN_FILE, SEVERITY_ORDER, RATED_SEVERITIES } from '../core/model/security-scan.js';
export type { SecurityScan, Severity, ToolResult, Vulnerability, ThresholdOptions } from '../core/model/security-scan.js';
// The audit runners and parsers moved to the dependency scanner; re-exported for existing callers.
export {
  AuditToolError,
  MAX_PIP_TARGETS,
  parseCargoAudit,
  parseComposerAudit,
  parseGovulncheck,
  parseNpmAudit,
  parsePipAudit,
  parsePnpmAudit,
  planPipAudit,
  RUNNERS,
  splitJsonStream,
  type Invocation,
  type PlanContext,
} from '../core/scanners/dependencies.js';

export interface ScanOptions {
  signal?: AbortSignal;
  /** Per-tool timeout. */
  timeoutMs?: number;
  /** Skip dependency audits (secrets only). */
  skipAudit?: boolean;
  onTool?: (tool: string) => void;
}

export interface SecurityScanOutput {
  /** Legacy `security-scan.json` (v1), still read by the web UI and `security.md`. */
  scan: SecurityScan;
  /** The same scan as unified findings (`.athena/findings.json`). */
  result: ScanResult;
}

/** Scans produced by runSecurityScan → their findings, so saveScan can write both files. */
const resultsByScan = new WeakMap<SecurityScan, ScanResult>();

/**
 * Run the audit tools the project's ecosystems provide, and scan the project's
 * files for secrets (fresh — not from a cached model). Athena never bundles a
 * vulnerability database: findings are attributed to the tool that produced them,
 * and a missing tool is reported as "not installed" rather than "no problems".
 *
 * Built on the secrets and dependency scanners; returns both the legacy scan and
 * the unified findings. Errors propagate (a scan that could not run is never
 * reported as clean).
 */
export async function runSecurityScanWithFindings(root: string, model: ProjectModel, opts: ScanOptions = {}): Promise<SecurityScanOutput> {
  const started = Date.now();
  const { config } = await loadConfig(root);
  const walk = await walkProject(root, { config, signal: opts.signal });
  const ctx: ScanContext = { root, config, mode: 'all', signal: opts.signal };

  const deps = opts.skipAudit ? null : await auditDependencies(ctx, { model, walk: walk.files, timeoutMs: opts.timeoutMs, onTool: opts.onTool });
  const tools = (deps?.runs ?? []).map(legacyToolResult);
  const counts: Record<Severity, number> = { critical: 0, high: 0, moderate: 0, low: 0, unrated: 0 };
  for (const t of tools) for (const f of t.findings) counts[f.severity]++;

  const secrets = await scanSecrets(ctx, { walk: walk.files });

  const scannedAt = new Date().toISOString();
  const durationMs = Date.now() - started;
  const scan: SecurityScan = {
    schemaVersion: 1,
    scannedAt,
    durationMs,
    tools,
    counts,
    secrets: {
      count: secrets.summary.count,
      files: secrets.summary.files.slice(0, 50),
      skippedLongLines: secrets.summary.skippedLongLines,
      ...(secrets.summary.truncated ? { truncated: true } : {}),
    },
  };
  const outputs: ScannerOutput[] = [secrets, ...(deps ? [deps] : [])];
  const result: ScanResult = {
    schemaVersion: 1,
    scannedAt,
    durationMs,
    scope: { mode: 'all' },
    findings: dedupeFindings(outputs.flatMap((o) => o.findings.map((f) => Finding.parse(f)))),
    coverage: [...(deps?.coverage ?? []), ...secrets.coverage].map((c) => Coverage.parse(c)),
  };
  resultsByScan.set(scan, result);
  return { scan, result };
}

/** Legacy entry point (the server's "Run scan" uses it): the v1 scan only. */
export async function runSecurityScan(root: string, model: ProjectModel, opts: ScanOptions = {}): Promise<SecurityScan> {
  return (await runSecurityScanWithFindings(root, model, opts)).scan;
}

/**
 * Write `security-scan.json`, and — when the scan came from runSecurityScan in this
 * process — the matching `findings.json`, so both stay in step.
 */
export async function saveScan(root: string, scan: SecurityScan): Promise<void> {
  await saveLegacyScan(root, scan);
  const result = resultsByScan.get(scan);
  if (result) await saveFindings(root, result);
}
