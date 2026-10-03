import type { AthenaConfig } from '../config.js';
import { Coverage, dedupeFindings, Finding, type Category, type CoverageInput, type FindingInput, type ScanResult } from '../findings/finding.js';

/**
 * A scanner produces findings plus an honest record of what it covered. Built-in
 * scanners (secrets, dependency audits, review checks — later SAST, IaC, licences) and
 * adapters for external tools (Semgrep, Gitleaks, Trivy, OSV-Scanner) share this shape.
 */
export interface ScanContext {
  root: string;
  config: AthenaConfig;
  /** Files in scope (project-relative). Undefined = the whole project. */
  files?: string[];
  mode: ScanResult['scope']['mode'];
  base?: string;
  /** Do not contact the network (audit tools that query advisory databases are skipped). */
  offline?: boolean;
  signal?: AbortSignal;
}

export interface ScannerOutput {
  findings: FindingInput[];
  coverage: CoverageInput[];
}

export interface Scanner {
  id: string;
  category: Category;
  title: string;
  run(ctx: ScanContext): Promise<ScannerOutput>;
}

/**
 * Run scanners in order, validate their output, and merge it. A scanner that throws
 * is reported as `failed` in coverage — it never silently disappears.
 */
export async function runScanners(scanners: Scanner[], ctx: ScanContext): Promise<ScanResult> {
  const started = Date.now();
  const findings: Finding[] = [];
  const coverage: Coverage[] = [];
  for (const s of scanners) {
    ctx.signal?.throwIfAborted();
    const t = Date.now();
    try {
      const out = await s.run(ctx);
      for (const f of out.findings) findings.push(Finding.parse(f));
      for (const c of out.coverage) coverage.push(Coverage.parse(c));
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      coverage.push(Coverage.parse({ engine: s.id, category: s.category, status: 'failed', reason: (err as Error).message.slice(0, 300), durationMs: Date.now() - t }));
    }
  }
  return {
    schemaVersion: 1,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    scope: { mode: ctx.mode, ...(ctx.base ? { base: ctx.base } : {}), ...(ctx.files ? { files: ctx.files.length } : {}) },
    findings: dedupeFindings(findings),
    coverage,
  };
}
