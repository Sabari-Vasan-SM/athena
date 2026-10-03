import { z } from 'zod';

/**
 * One finding shape for everything Athena reports: secrets, vulnerable dependencies,
 * review checks — and later static analysis, IaC, licences and quality. Reporters
 * (text, JSON, Markdown, GitHub annotations, SARIF), the baseline, triage, suppressions
 * and the quality gate all work on this shape.
 *
 * Honesty: `label` says how Athena knows (FACT = a tool reported it, DETECTED = a rule
 * matched with evidence, INFERRED = heuristic or AI). `potential` marks heuristics that
 * must be read as "check this", never "this is a vulnerability".
 */

export const CATEGORIES = ['secret', 'dependency', 'sast', 'iac', 'license', 'quality', 'review', 'memory'] as const;
export type Category = (typeof CATEGORIES)[number];

/** `unrated`: the source reported a problem without a severity — never treated as low. */
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info', 'unrated'] as const;
export type Severity = (typeof SEVERITIES)[number];
/** Most to least severe, for sorting and thresholds (unrated is handled by policy, not order). */
export const SEVERITY_RANK: Record<Severity, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1, unrated: 0 };

export const CONFIDENCES = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCES)[number];
export const CONFIDENCE_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

export const Location = z.object({
  file: z.string(),
  startLine: z.number().int().positive().optional(),
  startColumn: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  endColumn: z.number().int().positive().optional(),
});
export type Location = z.infer<typeof Location>;

export const PackageRef = z.object({
  ecosystem: z.string(),
  name: z.string(),
  version: z.string().optional(),
  /** Manifest or lockfile the package comes from, if known. */
  manifest: z.string().optional(),
  advisoryIds: z.array(z.string()).default([]),
  vulnerableRange: z.string().optional(),
  fixedIn: z.string().optional(),
  fixAvailable: z.boolean().optional(),
});
export type PackageRef = z.infer<typeof PackageRef>;

export const Finding = z.object({
  /** Stable identity (32 hex). Never derived from a secret's value; see fingerprint.ts. */
  fingerprint: z.string().regex(/^[a-f0-9]{32}$/),
  /** e.g. `secret/stripe-key`, `dependency/vulnerable-package`, `review/env-file`, `sast/js/sql-concat`. */
  ruleId: z.string().regex(/^[a-z0-9][a-z0-9._/-]{1,120}$/),
  category: z.enum(CATEGORIES),
  severity: z.enum(SEVERITIES),
  confidence: z.enum(CONFIDENCES),
  label: z.enum(['FACT', 'DETECTED', 'INFERRED']),
  /** Heuristic: "worth checking", not a confirmed problem. Rendered as "Potential …". */
  potential: z.boolean().default(false),
  title: z.string(),
  message: z.string(),
  cwe: z.array(z.string().regex(/^CWE-\d+$/)).default([]),
  owasp: z.array(z.string()).default([]),
  location: Location.optional(),
  package: PackageRef.optional(),
  /** Which engine produced it: `athena`, `npm-audit`, `semgrep`, … */
  engine: z.object({ id: z.string(), version: z.string().optional() }),
  /** Other engines that reported the same problem (after de-duplication). */
  alsoReportedBy: z.array(z.string()).default([]),
  help: z.object({ text: z.string(), url: z.string().optional() }).optional(),
});
export type Finding = z.infer<typeof Finding>;
export type FindingInput = z.input<typeof Finding>;

/** What one engine actually covered. Every report prints this, so gaps are visible. */
export const Coverage = z.object({
  engine: z.string(),
  category: z.enum(CATEGORIES),
  /** ok: ran · unavailable: not installed / nothing to scan · skipped: excluded by policy or options · failed/timeout: ran without usable output */
  status: z.enum(['ok', 'unavailable', 'skipped', 'failed', 'timeout']),
  reason: z.string().optional(),
  /** What was scanned when an engine runs per input (e.g. a requirements file). */
  target: z.string().optional(),
  languages: z.array(z.string()).default([]),
  filesScanned: z.number().int().nonnegative().optional(),
  filesSkipped: z
    .object({
      tooLarge: z.number().int().nonnegative().default(0),
      binary: z.number().int().nonnegative().default(0),
      minified: z.number().int().nonnegative().default(0),
      unreadable: z.number().int().nonnegative().default(0),
      unsupported: z.number().int().nonnegative().default(0),
    })
    .optional(),
  /** Whether the engine contacted the network (e.g. an audit tool querying an advisory database). */
  network: z.boolean().default(false),
  durationMs: z.number().nonnegative(),
});
export type Coverage = z.infer<typeof Coverage>;
export type CoverageInput = z.input<typeof Coverage>;

export const SCAN_SCOPES = ['all', 'base', 'staged', 'changed'] as const;

/** `.athena/findings.json` (gitignored): the latest scan. */
export const ScanResult = z.object({
  schemaVersion: z.literal(1),
  scannedAt: z.string(),
  durationMs: z.number().nonnegative(),
  scope: z.object({ mode: z.enum(SCAN_SCOPES), base: z.string().optional(), files: z.number().int().nonnegative().optional() }),
  findings: z.array(Finding),
  coverage: z.array(Coverage),
});
export type ScanResult = z.infer<typeof ScanResult>;

export function compareFindings(a: Finding, b: Finding): number {
  return (
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
    CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] ||
    a.category.localeCompare(b.category) ||
    a.ruleId.localeCompare(b.ruleId) ||
    (a.location?.file ?? '').localeCompare(b.location?.file ?? '') ||
    (a.location?.startLine ?? 0) - (b.location?.startLine ?? 0) ||
    a.fingerprint.localeCompare(b.fingerprint)
  );
}

/** Merge findings with the same fingerprint (same problem from several engines). Deterministic order. */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const byFp = new Map<string, Finding>();
  for (const f of findings) {
    const prev = byFp.get(f.fingerprint);
    if (!prev) {
      byFp.set(f.fingerprint, { ...f, alsoReportedBy: [...f.alsoReportedBy] });
      continue;
    }
    const other = f.engine.id;
    if (other !== prev.engine.id && !prev.alsoReportedBy.includes(other)) prev.alsoReportedBy.push(other);
    // Keep the most severe rating and the strongest confidence any engine gave.
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[prev.severity]) prev.severity = f.severity;
    if (CONFIDENCE_RANK[f.confidence] > CONFIDENCE_RANK[prev.confidence]) prev.confidence = f.confidence;
  }
  return [...byFp.values()].sort(compareFindings);
}
