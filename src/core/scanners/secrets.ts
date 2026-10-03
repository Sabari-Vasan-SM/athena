import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CoverageInput, FindingInput, Severity, Confidence } from '../findings/finding.js';
import { codeFingerprint, normalizeLine, occurrenceCounter } from '../findings/fingerprint.js';
import { MAX_SECRET_FINDINGS, scanFilesForSecrets } from '../analyzer/detectors/secrets.js';
import { ephemeralFingerprint, MAX_GENERIC_LINE, SECRET_PATTERNS, type SecretMatch } from '../security/secrets.js';
import { walkProject, type FileEntry } from '../fs/walker.js';
import type { ScanContext, Scanner, ScannerOutput } from './types.js';

/**
 * Secrets scanner: Athena's built-in credential patterns (src/core/security/secrets.ts)
 * over the project's files, one finding per match.
 *
 * Never stores a value: findings carry the pattern, file, line and column, and a
 * fingerprint computed from the line with the matched span masked — so the
 * fingerprint is stable when only the secret's value changes (e.g. after rotation)
 * and reveals nothing about it.
 */

export const SECRETS_ENGINE = 'athena-secrets';

/** Private keys and cloud provider credentials grant broad access: critical. */
const CRITICAL = new Set(['private-key', 'aws-access-key-id', 'aws-secret-access-key', 'gcp-service-account', 'azure-storage-key']);
/** Keyword heuristics ("password = '…'"): worth checking, not a confirmed credential. */
const GENERIC = new Set(['generic-secret-assignment', 'env-secret-assignment']);
/** Formats that also match non-credentials often enough to be less certain. */
const MEDIUM_CONFIDENCE = new Set(['jwt', 'connection-string-credentials']);

const DESCRIPTION = new Map(SECRET_PATTERNS.map((p) => [p.id, p.description]));

export function secretSeverity(type: string): { severity: Severity; confidence: Confidence; potential: boolean } {
  if (CRITICAL.has(type)) return { severity: 'critical', confidence: 'high', potential: false };
  if (GENERIC.has(type)) return { severity: 'medium', confidence: 'low', potential: true };
  return { severity: 'high', confidence: MEDIUM_CONFIDENCE.has(type) ? 'medium' : 'high', potential: false };
}

export interface SecretHit {
  /** Pattern id (`SECRET_PATTERNS[].id`). */
  type: string;
  file: string;
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  /** The full source line. Used only to compute the fingerprint; never stored. */
  lineText: string;
  /** [start, end) of the matched value within `lineText`, masked before hashing. */
  mask: [number, number];
}

/**
 * Build a finding for one secret match. `occurrence` numbers identical masked lines
 * within a file (see occurrenceCounter). The value is never part of the output.
 */
export function secretFinding(hit: SecretHit, occurrence = 0, engineId = 'athena'): FindingInput {
  const ruleId = `secret/${hit.type}`;
  const { severity, confidence, potential } = secretSeverity(hit.type);
  const description = DESCRIPTION.get(hit.type) ?? hit.type;
  return {
    fingerprint: codeFingerprint({ ruleId, file: hit.file, lineText: hit.lineText, mask: hit.mask, occurrence }),
    ruleId,
    category: 'secret',
    severity,
    confidence,
    label: 'DETECTED',
    potential,
    title: potential ? `Potential hardcoded secret (${description.toLowerCase()})` : `Hardcoded ${description}`,
    message: `${potential ? 'A value that looks like a secret' : `A ${description}`} appears in ${hit.file}:${hit.line}. Athena does not store the value.`,
    cwe: ['CWE-798'],
    owasp: ['A07:2021'],
    location: {
      file: hit.file,
      startLine: hit.line,
      ...(hit.column ? { startColumn: hit.column } : {}),
      ...(hit.endLine ? { endLine: hit.endLine } : {}),
      ...(hit.endColumn ? { endColumn: hit.endColumn } : {}),
    },
    engine: { id: engineId },
    help: {
      text: potential
        ? 'Check whether this is a real credential. If it is, move it to an environment variable or secret manager and rotate it.'
        : 'Remove the value, load it from an environment variable or secret manager, and rotate the credential — assume it is compromised once committed.',
    },
  };
}

/** Locate matches (offsets into `text`) as hits with line text and masks. */
export function hitsFromMatches(file: string, text: string, matches: SecretMatch[]): SecretHit[] {
  const lineStart = (offset: number) => text.lastIndexOf('\n', offset - 1) + 1;
  return matches.map((m) => {
    const start = lineStart(m.start);
    let end = text.indexOf('\n', m.start);
    if (end < 0) end = text.length;
    let lineText = text.slice(start, end);
    if (lineText.endsWith('\r')) lineText = lineText.slice(0, -1);
    const maskEnd = Math.min(m.end, start + lineText.length) - start;
    const span = text.slice(m.start, m.end);
    const extraLines = (span.match(/\n/g) ?? []).length;
    const lastStart = extraLines ? lineStart(m.end) : start;
    return {
      type: m.type,
      file,
      line: m.line,
      column: m.start - start + 1,
      endLine: m.line + extraLines,
      endColumn: m.end - lastStart + 1,
      lineText,
      mask: [m.start - start, Math.max(maskEnd, m.start - start)] as [number, number],
    };
  });
}

/** Turn hits into findings with per-file occurrence numbering (hits in file order). */
export function secretFindings(hits: SecretHit[], engineId = 'athena'): FindingInput[] {
  const occurrence = occurrenceCounter();
  return hits.map((h) => secretFinding(h, occurrence(`secret/${h.type}`, h.file, normalizeLine(h.lineText, h.mask)), engineId));
}

export interface SecretScanSummary {
  /** Number of matches (same as findings.length). */
  count: number;
  files: string[];
  skippedLongLines: number;
  truncated: boolean;
}

export interface SecretScanOptions {
  /** A project walk to reuse (otherwise the project is walked). */
  walk?: FileEntry[];
}

/**
 * Scan the files in scope (ctx.files, or the whole project) for secrets. Gitignored,
 * binary, oversized and lock/minified files are not read; coverage says how many.
 */
export async function scanSecrets(ctx: ScanContext, opts: SecretScanOptions = {}): Promise<ScannerOutput & { summary: SecretScanSummary }> {
  const started = Date.now();
  let files = opts.walk ?? (await walkProject(ctx.root, { config: ctx.config, signal: ctx.signal })).files;
  if (ctx.files) {
    const scope = new Set(ctx.files);
    files = files.filter((f) => scope.has(f.path));
  }
  const hits: SecretHit[] = [];
  const read = async (rel: string) => fs.readFile(path.join(ctx.root, rel), 'utf8').catch(() => null);
  const r = await scanFilesForSecrets(files, read, {
    fingerprint: ephemeralFingerprint,
    signal: ctx.signal,
    onFile: (file, text, matches) => hits.push(...hitsFromMatches(file, text, matches)),
  });
  const notes: string[] = [];
  if (r.truncated) notes.push(`stopped after ${MAX_SECRET_FINDINGS} findings; remaining files were not scanned`);
  if (r.skippedLongLines) notes.push(`generic keyword patterns not applied to ${r.skippedLongLines} line(s) longer than ${MAX_GENERIC_LINE} characters`);
  if (r.files.excluded) notes.push(`${r.files.excluded} lockfile/snapshot/SVG file(s) not scanned`);
  const coverage: CoverageInput = {
    engine: SECRETS_ENGINE,
    category: 'secret',
    status: 'ok',
    ...(notes.length ? { reason: notes.join('; ') } : {}),
    filesScanned: r.files.scanned,
    filesSkipped: { tooLarge: r.files.tooLarge, binary: r.files.binary, minified: r.files.minified, unreadable: r.files.unreadable, unsupported: r.files.excluded },
    network: false,
    durationMs: Date.now() - started,
  };
  return {
    findings: secretFindings(hits),
    coverage: [coverage],
    summary: { count: hits.length, files: [...new Set(hits.map((h) => h.file))], skippedLongLines: r.skippedLongLines, truncated: r.truncated },
  };
}

export const secretsScanner: Scanner = {
  id: SECRETS_ENGINE,
  category: 'secret',
  title: 'Hardcoded secrets',
  async run(ctx) {
    const { findings, coverage } = await scanSecrets(ctx);
    return { findings, coverage };
  },
};
