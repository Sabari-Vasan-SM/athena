import crypto from 'node:crypto';

/**
 * Stable finding identities for baselines, triage, suppressions and PR comments.
 *
 * - Never derived from a secret's value: the matched span is masked before hashing,
 *   so a fingerprint published in a PR comment or SARIF file reveals nothing.
 * - Survive unrelated edits: no line numbers; the line's own text is normalized
 *   (whitespace collapsed), and identical lines are told apart by occurrence order.
 *
 * Version 1. Changing the scheme invalidates baselines, so bump FINGERPRINT_VERSION
 * (and migrate) instead of editing it in place.
 */
export const FINGERPRINT_VERSION = 1;

const hash = (parts: string[]) => crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);

/** Collapse whitespace; with a [start, end) span, replace that span with a fixed marker first. */
export function normalizeLine(text: string, mask?: [number, number]): string {
  const masked = mask ? `${text.slice(0, mask[0])}⟨v⟩${text.slice(mask[1])}` : text;
  return masked.replace(/\s+/g, ' ').trim();
}

/** A finding at a place in a file. `lineText` is the full source line; `mask` hides a matched value. */
export function codeFingerprint(input: { ruleId: string; file: string; lineText: string; mask?: [number, number]; occurrence?: number }): string {
  return hash(['v1', 'code', input.ruleId, input.file, normalizeLine(input.lineText, input.mask), String(input.occurrence ?? 0)]);
}

/** A problem with a package (e.g. a vulnerable dependency), independent of where it is imported. */
export function packageFingerprint(input: { ruleId: string; ecosystem: string; name: string; manifest?: string; advisoryId?: string }): string {
  return hash(['v1', 'package', input.ruleId, input.ecosystem, input.name, input.manifest ?? '', input.advisoryId ?? '']);
}

/** A finding about a file or the change as a whole (e.g. "env file committed"). */
export function fileFingerprint(input: { ruleId: string; file?: string; key?: string }): string {
  return hash(['v1', 'file', input.ruleId, input.file ?? '', input.key ?? '']);
}

/**
 * Number identical normalized lines per (rule, file) in order of appearance, so two
 * copies of the same problematic line get different, stable fingerprints.
 */
export function occurrenceCounter(): (ruleId: string, file: string, normalized: string) => number {
  const seen = new Map<string, number>();
  return (ruleId, file, normalized) => {
    const key = `${ruleId}\u0000${file}\u0000${normalized}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return n;
  };
}
