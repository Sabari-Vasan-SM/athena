import path from 'node:path';
import { readTextInsideRoot } from '../util/fs.js';
import { Finding } from './finding.js';
import { codeFingerprint, normalizeLine, occurrenceCounter } from './fingerprint.js';

/**
 * Inline suppressions: a comment on the finding's line, or on the line directly above,
 *
 *   // athena-ignore <ruleId> -- <reason>
 *   #  athena-ignore <ruleId> -- <reason>
 *   /* athena-ignore <ruleId> -- <reason> *\/
 *   <!-- athena-ignore <ruleId> -- <reason> -->
 *   -- athena-ignore <ruleId> -- <reason>
 *
 * One exact rule id per comment (no wildcards: a blanket "ignore everything here" would
 * hide future, unrelated problems). The reason is required: a suppression without one is
 * ignored and reported as an `info` finding, so it can't silently hide anything.
 */

export const SUPPRESSION_WITHOUT_REASON = 'review/suppression-without-reason';
export const INVALID_SUPPRESSION = 'review/invalid-suppression';
/** Findings about the policy itself can't be silenced inline. */
export const UNSUPPRESSIBLE_RULES: ReadonlySet<string> = new Set(['review/policy-weakened', SUPPRESSION_WITHOUT_REASON, INVALID_SUPPRESSION]);

export const DEFAULT_SUPPRESSION_MAX_BYTES = 2 * 1024 * 1024;

export interface Suppression {
  /** 1-based line of the comment. It covers this line and the next one. */
  line: number;
  /** Missing when the comment names no (valid) rule id. */
  ruleId?: string;
  /** Missing or empty = not a valid suppression. */
  reason?: string;
  /** Why this comment does not suppress anything. */
  problem?: 'missing-reason' | 'missing-rule';
  /** The full source line (for fingerprints). */
  lineText: string;
}

const RULE_ID = /^[a-z0-9][a-z0-9._/-]{1,120}$/;
// A comment marker at the start of the line or after whitespace/`;`, then `athena-ignore`.
const MARKER = /(?<=^|[\s;])(?:\/\/|#|\/\*|<!--|--)[ \t]*athena-ignore(?![\w-])(.*)$/;

/** Parse one line; null when it has no `athena-ignore` comment. */
export function parseSuppressionLine(text: string, line: number): Suppression | null {
  if (!text.includes('athena-ignore')) return null;
  const m = MARKER.exec(text);
  if (!m) return null;
  const rest = m[1]!.replace(/\s*(?:\*\/|-->)\s*$/, '').trim();
  const first = rest.split(/\s+/)[0] ?? '';
  const after = rest.slice(first.length).trim();
  if (!first || first === '--' || !RULE_ID.test(first)) return { line, problem: 'missing-rule', lineText: text };
  const reason = after.startsWith('--') ? after.slice(2).trim() : '';
  return reason ? { line, ruleId: first, reason, lineText: text } : { line, ruleId: first, problem: 'missing-reason', lineText: text };
}

/** Every `athena-ignore` comment in a file, valid or not. */
export function findSuppressions(fileText: string): Suppression[] {
  const out: Suppression[] = [];
  const lines = fileText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const s = parseSuppressionLine(lines[i]!, i + 1);
    if (s) out.push(s);
  }
  return out;
}

/** The valid suppression (if any) that covers `ruleId` at `line`: same line, or the line above. */
export function suppressionFor(suppressions: Suppression[], ruleId: string, line: number): Suppression | undefined {
  if (UNSUPPRESSIBLE_RULES.has(ruleId)) return undefined;
  return suppressions.find((s) => !s.problem && s.ruleId === ruleId && (s.line === line || s.line === line - 1));
}

export interface AppliedSuppression {
  file: string;
  line: number;
  ruleId: string;
  reason: string;
}

export interface SuppressionOutcome {
  /** fingerprint → the suppression that silenced it. */
  suppressed: Map<string, AppliedSuppression>;
  /** `info` findings for suppressions without a reason / rule id (in the files that were read). */
  findings: Finding[];
  /** Files that could not be read (too large, outside the root, missing); their findings stay as they are. */
  skippedFiles: Array<{ file: string; reason: string }>;
}

export interface ApplySuppressionOptions {
  maxBytes?: number;
}

function problemFinding(file: string, s: Suppression, occurrence: number): Finding {
  const missingRule = s.problem === 'missing-rule';
  const ruleId = missingRule ? INVALID_SUPPRESSION : SUPPRESSION_WITHOUT_REASON;
  return Finding.parse({
    fingerprint: codeFingerprint({ ruleId, file, lineText: s.lineText, occurrence }),
    ruleId,
    category: 'review',
    severity: 'info',
    confidence: 'high',
    label: 'DETECTED',
    title: missingRule ? 'Suppression without a rule id' : 'Suppression without a reason',
    message: missingRule
      ? `This athena-ignore comment names no valid rule id, so it suppresses nothing. Write \`athena-ignore <ruleId> -- <reason>\`.`
      : `\`athena-ignore ${s.ruleId}\` has no reason, so it is ignored. Add \`-- <why this is safe>\` after the rule id.`,
    location: { file, startLine: s.line },
    engine: { id: 'athena' },
  });
}

/**
 * Read each file that has located findings (once, inside `root`, size-capped), and
 * work out which findings are suppressed. Findings without a file/line can't be
 * suppressed inline (use triage instead).
 */
export async function applySuppressions(root: string, findings: Finding[], opts: ApplySuppressionOptions = {}): Promise<SuppressionOutcome> {
  const maxBytes = opts.maxBytes ?? DEFAULT_SUPPRESSION_MAX_BYTES;
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    if (!f.location?.file || !f.location.startLine || UNSUPPRESSIBLE_RULES.has(f.ruleId)) continue;
    const list = byFile.get(f.location.file) ?? [];
    list.push(f);
    byFile.set(f.location.file, list);
  }
  const out: SuppressionOutcome = { suppressed: new Map(), findings: [], skippedFiles: [] };
  for (const file of [...byFile.keys()].sort()) {
    const norm = path.posix.normalize(file.replace(/\\/g, '/'));
    if (path.isAbsolute(file) || path.posix.isAbsolute(norm) || norm === '..' || norm.startsWith('../')) {
      out.skippedFiles.push({ file, reason: 'outside-root' });
      continue;
    }
    const read = await readTextInsideRoot(root, file, maxBytes);
    if (!read.ok) {
      out.skippedFiles.push({ file, reason: read.reason });
      continue;
    }
    const all = findSuppressions(read.text);
    if (!all.length) continue;
    const occ = occurrenceCounter();
    for (const s of all) {
      if (s.problem) {
        const rule = s.problem === 'missing-rule' ? INVALID_SUPPRESSION : SUPPRESSION_WITHOUT_REASON;
        out.findings.push(problemFinding(file, s, occ(rule, file, normalizeLine(s.lineText))));
      }
    }
    for (const f of byFile.get(file)!) {
      const s = suppressionFor(all, f.ruleId, f.location!.startLine!);
      if (s) out.suppressed.set(f.fingerprint, { file, line: s.line, ruleId: s.ruleId!, reason: s.reason! });
    }
  }
  return out;
}
