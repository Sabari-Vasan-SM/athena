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

/**
 * `unrated` = the tool reported a vulnerability without a severity (pip-audit and
 * govulncheck never do). It is not "low": `--fail-on` treats it as failing unless
 * `--unrated warn` is given. Scans written by older versions used `unknown`; it is
 * read as `unrated`.
 */
export const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'unrated'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const SEVERITY_ORDER: Severity[] = [...SEVERITIES];
/** Severities `--fail-on` accepts as a threshold. */
export const RATED_SEVERITIES: Severity[] = ['critical', 'high', 'moderate', 'low'];

const legacySeverity = (v: unknown) => (v === 'unknown' ? 'unrated' : v);
export const Severity = z.preprocess(legacySeverity, z.enum(SEVERITIES));

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
  /** What was audited when a tool runs once per input (e.g. a requirements file). */
  target: z.string().optional(),
  /** ok: ran and produced results · unavailable: not installed / nothing to audit · failed/timeout: ran but no usable output */
  status: z.enum(['ok', 'unavailable', 'failed', 'timeout']),
  message: z.string().optional(),
  durationMs: z.number(),
  findings: z.array(Vulnerability),
});
export type ToolResult = z.infer<typeof ToolResult>;

const Counts = z.preprocess(
  (v) => {
    if (!v || typeof v !== 'object') return v;
    const { unknown, ...rest } = v as Record<string, unknown>;
    return { critical: 0, high: 0, moderate: 0, low: 0, unrated: 0, ...rest, ...(typeof unknown === 'number' ? { unrated: ((rest.unrated as number) ?? 0) + unknown } : {}) };
  },
  z.object({ critical: z.number(), high: z.number(), moderate: z.number(), low: z.number(), unrated: z.number() }),
);

export const SecurityScan = z.object({
  schemaVersion: z.literal(1),
  scannedAt: z.string(),
  durationMs: z.number(),
  tools: z.array(ToolResult),
  counts: Counts,
  secrets: z.object({
    count: z.number(),
    files: z.array(z.string()),
    /** Lines longer than 4096 chars on which generic keyword patterns were not applied. */
    skippedLongLines: z.number().optional(),
    truncated: z.boolean().optional(),
  }),
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

export interface ThresholdOptions {
  /** How unrated findings count: `fail` (default) — they meet any threshold; `warn` — they never do. */
  unrated?: 'fail' | 'warn';
}

/** Unrated findings from tools that ran. */
export function unratedFindings(scan: SecurityScan): Vulnerability[] {
  return scan.tools.flatMap((t) => (t.status === 'ok' ? t.findings.filter((f) => f.severity === 'unrated') : []));
}

/**
 * True when the scan contains a finding at or above `level`. Unrated findings (no
 * severity reported by the tool) meet every threshold unless `unrated: 'warn'` —
 * a missing severity is not evidence that a vulnerability is minor.
 */
export function meetsThreshold(scan: SecurityScan, level: Severity, opts: ThresholdOptions = {}): boolean {
  const max = SEVERITY_ORDER.indexOf(level);
  const unrated = opts.unrated ?? 'fail';
  return scan.tools.some((t) =>
    t.findings.some((f) => {
      if (f.severity === 'unrated') return unrated === 'fail';
      return SEVERITY_ORDER.indexOf(f.severity) <= max;
    }),
  );
}
