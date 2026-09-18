import { z } from 'zod';
import path from 'node:path';
import { athenaDir } from '../state/state.js';
import { readTextIfExists, writeFileAtomic } from '../util/fs.js';

/**
 * Results of a dependency/secret security scan. Kept beside the knowledge files
 * (gitignored) because findings are time-sensitive and machine-specific: they
 * depend on which audit tools are installed and when they last ran.
 */
export const SCAN_FILE = 'security-scan.json';

export const Severity = z.enum(['critical', 'high', 'moderate', 'low', 'unknown']);
export type Severity = z.infer<typeof Severity>;
export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'moderate', 'low', 'unknown'];

export const Vulnerability = z.object({
  package: z.string(),
  severity: Severity,
  title: z.string(),
  id: z.string().optional(),
  url: z.string().optional(),
  vulnerableRange: z.string().optional(),
  fixAvailable: z.boolean().optional(),
});
export type Vulnerability = z.infer<typeof Vulnerability>;

export const ToolResult = z.object({
  tool: z.string(),
  ecosystem: z.string(),
  /** ok: ran and produced results · unavailable: not installed · failed/timeout: ran but no usable output */
  status: z.enum(['ok', 'unavailable', 'failed', 'timeout']),
  message: z.string().optional(),
  durationMs: z.number(),
  findings: z.array(Vulnerability),
});
export type ToolResult = z.infer<typeof ToolResult>;

export const SecurityScan = z.object({
  schemaVersion: z.literal(1),
  scannedAt: z.string(),
  durationMs: z.number(),
  tools: z.array(ToolResult),
  counts: z.record(Severity, z.number()),
  secrets: z.object({ count: z.number(), files: z.array(z.string()) }),
});
export type SecurityScan = z.infer<typeof SecurityScan>;

export const loadScan = (root: string) => loadScanFromDir(athenaDir(root));

export async function saveScan(root: string, scan: SecurityScan): Promise<void> {
  await writeFileAtomic(path.join(athenaDir(root), SCAN_FILE), `${JSON.stringify(scan, null, 2)}\n`);
}

export async function loadScanFromDir(dir: string): Promise<SecurityScan | null> {
  const raw = await readTextIfExists(path.join(dir, SCAN_FILE));
  if (!raw) return null;
  try {
    const parsed = SecurityScan.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function totalFindings(scan: SecurityScan): number {
  return scan.tools.reduce((n, t) => n + t.findings.length, 0);
}

/** True when the scan contains a finding at or above `level`. */
export function meetsThreshold(scan: SecurityScan, level: Severity): boolean {
  const max = SEVERITY_ORDER.indexOf(level);
  return scan.tools.some((t) => t.findings.some((f) => SEVERITY_ORDER.indexOf(f.severity) <= max && f.severity !== 'unknown'));
}
