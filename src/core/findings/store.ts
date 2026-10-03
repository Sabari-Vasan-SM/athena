import path from 'node:path';
import { athenaDir } from '../state/state.js';
import { readTextIfExists, writeFileAtomic } from '../util/fs.js';
import { loadScanFromDir, type SecurityScan } from '../model/security-scan.js';
import { auditCoverage, auditFindings, engineIdForTool } from '../scanners/dependencies.js';
import { SECRETS_ENGINE } from '../scanners/secrets.js';
import { Coverage, dedupeFindings, Finding, ScanResult } from './finding.js';

/**
 * `.athena/findings.json` (gitignored): the latest scan as unified findings.
 *
 * Older projects only have `security-scan.json` (v1). It is converted on read: its
 * dependency findings become `dependency/vulnerable-package` findings; its secret
 * scan recorded only a count and file names (no lines), so it becomes a coverage
 * note rather than findings without locations.
 */
export const FINDINGS_FILE = 'findings.json';

export type FindingsSource = 'findings' | 'migrated';

export interface LoadedFindings {
  result: ScanResult;
  /** `migrated`: converted from a legacy `security-scan.json`. */
  source: FindingsSource;
}

async function readFindingsFile(root: string): Promise<ScanResult | null> {
  const raw = await readTextIfExists(path.join(athenaDir(root), FINDINGS_FILE));
  if (!raw) return null;
  try {
    const parsed = ScanResult.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The latest scan with where it came from, or null when there is none. When the
 * legacy file is newer than findings.json (e.g. written by an older Athena), the
 * legacy scan wins — findings never silently lag behind the last scan.
 */
export async function loadFindingsWithSource(root: string): Promise<LoadedFindings | null> {
  const [current, legacy] = await Promise.all([readFindingsFile(root), loadScanFromDir(athenaDir(root))]);
  if (current && (!legacy || Date.parse(legacy.scannedAt) <= Date.parse(current.scannedAt))) return { result: current, source: 'findings' };
  if (legacy) return { result: migrateLegacyScan(legacy), source: 'migrated' };
  return null;
}

export async function loadFindings(root: string): Promise<ScanResult | null> {
  return (await loadFindingsWithSource(root))?.result ?? null;
}

/** Validate and write `.athena/findings.json`. */
export async function saveFindings(root: string, result: ScanResult): Promise<void> {
  const valid = ScanResult.parse(result);
  await writeFileAtomic(path.join(athenaDir(root), FINDINGS_FILE), `${JSON.stringify(valid, null, 2)}\n`);
}

/** Convert a v1 `security-scan.json` to a ScanResult. */
export function migrateLegacyScan(scan: SecurityScan): ScanResult {
  const findings: Finding[] = [];
  const coverage: Coverage[] = [];
  for (const t of scan.tools) {
    const engine = engineIdForTool(t.tool);
    const ran = t.status !== 'unavailable';
    if (t.status === 'ok') {
      for (const f of auditFindings({ engine, ecosystem: t.ecosystem, target: t.target, findings: t.findings })) findings.push(Finding.parse(f));
    }
    coverage.push(Coverage.parse(auditCoverage({ engine, status: t.status, message: t.message, target: t.target, network: ran, durationMs: t.durationMs })));
  }
  const s = scan.secrets;
  const notes = [
    s.count
      ? `migrated from security-scan.json (v1): ${s.count} potential secret(s) in ${s.files.length} file(s) (${s.files.slice(0, 10).join(', ')}${s.files.length > 10 ? ', …' : ''}); v1 did not record lines, so they are not listed as findings — run the scan again for locations`
      : 'migrated from security-scan.json (v1): no secrets matched',
    ...(s.skippedLongLines ? [`generic keyword patterns not applied to ${s.skippedLongLines} long line(s)`] : []),
    ...(s.truncated ? ['the scan stopped early after too many findings'] : []),
  ];
  coverage.push(Coverage.parse({ engine: SECRETS_ENGINE, category: 'secret', status: 'ok', reason: notes.join('; '), network: false, durationMs: 0 }));
  return ScanResult.parse({
    schemaVersion: 1,
    scannedAt: scan.scannedAt,
    durationMs: scan.durationMs,
    scope: { mode: 'all' },
    findings: dedupeFindings(findings),
    coverage,
  });
}
