import type { Category, Coverage, Finding, ScanResult } from '../findings/finding.js';
import { FINGERPRINT_VERSION } from '../findings/fingerprint.js';
import { sortForDisplay, statusOf, summarize, TOOL_NAME, type CategoryRating, type FindingStatus, type GateVerdict, type ReportInput, type Summary } from './shared.js';

/**
 * `athena scan --format json`: the stable machine format.
 *
 * Compatibility: within `schemaVersion: 1` fields are only added, never renamed,
 * removed or re-typed. Consumers should ignore unknown fields.
 *
 * - `findings[]` are the unified Finding shape (see src/core/findings/finding.ts) plus
 *   `status`. Every finding is included, whatever its status; filter on `status`.
 *   Sorted by severity (critical, high, unrated, medium, low, info), then rule and location.
 * - `fingerprint` is value-free (`fingerprintVersion` says which scheme); it is the key
 *   for baselines, triage and suppressions.
 * - `coverage[]` lists every engine and what it did or did not cover. A scan with
 *   `failed`, `timeout` or `unavailable` records is incomplete, whatever the findings say.
 * - `summary` counts open findings (not baselined, suppressed, triaged or excluded).
 * - `gate` and `ratings` are present only when policy was evaluated.
 */
export interface JsonReport {
  schemaVersion: 1;
  tool: { name: 'athena'; version: string };
  fingerprintVersion: number;
  scope: ScanResult['scope'];
  scannedAt: string;
  durationMs: number;
  summary: Summary;
  findings: (Finding & { status: FindingStatus })[];
  coverage: Coverage[];
  gate?: GateVerdict;
  ratings?: Partial<Record<Category, CategoryRating>>;
}

export function toJsonReport(input: ReportInput): JsonReport {
  const r = input.result;
  return {
    schemaVersion: 1,
    tool: { name: TOOL_NAME, version: input.toolVersion },
    fingerprintVersion: FINGERPRINT_VERSION,
    scope: r.scope,
    scannedAt: r.scannedAt,
    durationMs: r.durationMs,
    summary: summarize(input),
    findings: sortForDisplay(r.findings).map((f) => ({ ...f, status: statusOf(input, f) })),
    coverage: r.coverage,
    ...(input.gate ? { gate: input.gate } : {}),
    ...(input.ratings ? { ratings: input.ratings } : {}),
  };
}

export const renderJson = (input: ReportInput): string => `${JSON.stringify(toJsonReport(input), null, 2)}\n`;
