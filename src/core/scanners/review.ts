import type { Confidence, CoverageInput, FindingInput, Severity } from '../findings/finding.js';
import { fileFingerprint } from '../findings/fingerprint.js';
import { SECRETS_ENGINE, secretFindings, type SecretHit } from './secrets.js';
import type { ScanContext, Scanner, ScannerOutput } from './types.js';

/**
 * Review checks (`athena review`) as findings. The checks themselves live in
 * services/review.ts (they need Git); this module converts their output:
 *
 * - blocker → high, warning → medium, info → info; ruleId `review/<check>`; label DETECTED.
 * - One finding per file the check lists (location.file), fingerprinted by rule + file.
 *   Checks about the change as a whole (no files) give one finding keyed by the check.
 * - The `secrets` check is replaced by `secret/*` findings at the exact added line,
 *   with masked fingerprints (same rules and severities as the secrets scanner).
 */

export const REVIEW_ENGINE = 'athena-review';

export type ReviewLevel = 'blocker' | 'warning' | 'info';

/** The parts of a review check result the conversion needs (structurally a ReviewFinding). */
export interface ReviewCheck {
  level: ReviewLevel;
  check: string;
  message: string;
  files: string[];
  hint?: string;
}

/** A file a check flagged, optionally at a line. */
export interface ReviewLocation {
  file: string;
  line?: number;
}

export interface ReviewConversionInput {
  /** Check results, each with every location it covers (not only the first ten it prints). */
  checks: Array<{ check: ReviewCheck; locations: ReviewLocation[] }>;
  /** Secret matches in added lines, with line text and masks (never stored). */
  secrets: SecretHit[];
}

const LEVEL_SEVERITY: Record<ReviewLevel, Severity> = { blocker: 'high', warning: 'medium', info: 'info' };

/** Checks that are inferences from paths or patterns rather than facts about content. */
const CHECK_CONFIDENCE: Record<string, Confidence> = { tests: 'medium', api: 'medium', auth: 'medium', database: 'medium', leftovers: 'medium' };
const CHECK_CWE: Record<string, string[]> = { 'env-file': ['CWE-540'] };
const CHECK_TITLE: Record<string, string> = {
  'env-file': 'Environment file in the change',
  dependencies: 'New dependencies',
  tests: 'Source changed without tests',
  api: 'API surface changed',
  database: 'Database schema or migrations changed',
  auth: 'Authentication/authorization code changed',
  'large-files': 'Large file added',
  leftovers: 'TODO/FIXME or debug statement added',
  vulnerabilities: 'Known vulnerable dependencies',
  knowledge: 'Athena knowledge out of date',
  skipped: 'Changed file not checked',
};

function checkFinding(check: ReviewCheck, loc: ReviewLocation | null, lines: number[]): FindingInput {
  const ruleId = `review/${check.check}`;
  return {
    fingerprint: fileFingerprint({ ruleId, file: loc?.file, key: loc ? undefined : check.check }),
    ruleId,
    category: 'review',
    severity: LEVEL_SEVERITY[check.level],
    confidence: CHECK_CONFIDENCE[check.check] ?? 'high',
    label: 'DETECTED',
    potential: false,
    title: CHECK_TITLE[check.check] ?? check.message,
    message: loc && lines.length > 1 ? `${check.message} (${lines.length} lines in this file)` : check.message,
    cwe: CHECK_CWE[check.check] ?? [],
    ...(loc ? { location: { file: loc.file, ...(lines[0] ? { startLine: lines[0] } : {}) } } : {}),
    engine: { id: 'athena' },
    ...(check.hint ? { help: { text: check.hint } } : {}),
  };
}

export function reviewFindings(input: ReviewConversionInput): FindingInput[] {
  const out: FindingInput[] = secretFindings(input.secrets);
  for (const { check, locations } of input.checks) {
    if (check.check === 'secrets') continue; // reported as secret/* findings with exact lines
    if (!locations.length) {
      out.push(checkFinding(check, null, []));
      continue;
    }
    const byFile = new Map<string, number[]>();
    for (const l of locations) {
      const lines = byFile.get(l.file) ?? [];
      if (l.line) lines.push(l.line);
      byFile.set(l.file, lines);
    }
    for (const [file, lines] of byFile) out.push(checkFinding(check, { file }, lines.sort((a, b) => a - b)));
  }
  return out;
}

export interface ReviewCoverageInput {
  /** Changed files whose contents were checked. */
  checked: number;
  skipped: { tooLarge: number; unreadable: number };
  durationMs: number;
  incomplete: boolean;
}

/** Coverage for a review: the review checks, and the secret scan of added lines. */
export function reviewCoverage(c: ReviewCoverageInput): CoverageInput[] {
  const filesSkipped = { tooLarge: c.skipped.tooLarge, unreadable: c.skipped.unreadable, binary: 0, minified: 0, unsupported: 0 };
  const reason = c.incomplete ? `${c.skipped.tooLarge + c.skipped.unreadable} changed file(s) could not be read and were not checked` : undefined;
  return [
    { engine: REVIEW_ENGINE, category: 'review', status: 'ok', ...(reason ? { reason } : {}), target: 'changed files', filesScanned: c.checked, filesSkipped, network: false, durationMs: c.durationMs },
    { engine: SECRETS_ENGINE, category: 'secret', status: 'ok', reason: `added lines only${reason ? `; ${reason}` : ''}`, target: 'added lines', filesScanned: c.checked, filesSkipped, network: false, durationMs: 0 },
  ];
}

/**
 * The review scanner. `run` performs the review for a diff scope and returns its
 * findings and coverage (services/review.ts provides it — core has no Git review).
 * Scope `all` has no diff, so the scanner reports itself as skipped.
 */
export function reviewScanner(run: (ctx: ScanContext) => Promise<ScannerOutput>): Scanner {
  return {
    id: REVIEW_ENGINE,
    category: 'review',
    title: 'Change review checks',
    async run(ctx) {
      if (ctx.mode === 'all') return { findings: [], coverage: [{ engine: REVIEW_ENGINE, category: 'review', status: 'skipped', reason: 'review checks need a diff (staged, changed or base scope)', durationMs: 0 }] };
      return run(ctx);
    },
  };
}
