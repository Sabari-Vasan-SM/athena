import { CATEGORIES, compareFindings, type Category, type Coverage, type Finding, type ScanResult, type Severity } from '../findings/finding.js';

/**
 * Input types and helpers shared by every report format. The types are structural on
 * purpose: the policy layer (baseline, triage, suppressions, gate, ratings) produces
 * values of these shapes, and the renderers only read them.
 */

/** Where a finding stands after baseline, triage, suppressions and policy exclusions. */
export type FindingStatus = 'open' | 'baselined' | 'suppressed' | 'excluded' | `triaged:${string}`;

export interface GateVerdict {
  passed: boolean;
  reasons: string[];
}

export type Grade = 'A' | 'B' | 'C' | 'D' | 'E';
export interface CategoryRating {
  grade: Grade;
  /** Why this grade, in words ("2 open high findings"). Always shown next to the grade. */
  basis: string;
}

export interface ReportInput {
  result: ScanResult;
  /** By fingerprint. Missing = open. */
  statuses?: Record<string, FindingStatus>;
  /** Optional justification per fingerprint (from triage or an inline suppression comment). */
  notes?: Record<string, string>;
  gate?: GateVerdict;
  ratings?: Partial<Record<Category, CategoryRating>>;
  /** Project root, used to make absolute locations relative. */
  root?: string;
  toolVersion: string;
}

export const TOOL_NAME = 'athena';
export const INFORMATION_URI = 'https://athena.sabari.me';

/**
 * Display order. `unrated` (the source gave no severity) sits between high and medium:
 * it is never treated as low, and SARIF maps it to 7.0 (GitHub's "high" band).
 */
export const DISPLAY_ORDER: Severity[] = ['critical', 'high', 'unrated', 'medium', 'low', 'info'];

export const statusOf = (input: ReportInput, f: Finding): FindingStatus => input.statuses?.[f.fingerprint] ?? 'open';

/** Status kind without the triage state. */
export type StatusKind = 'open' | 'baselined' | 'suppressed' | 'excluded' | 'triaged';
export const statusKind = (s: FindingStatus): StatusKind => (s.startsWith('triaged:') ? 'triaged' : (s as StatusKind));
/** `triaged:false-positive` → `triaged (false-positive)`. */
export const statusTag = (s: FindingStatus): string => (s.startsWith('triaged:') ? `triaged (${s.slice('triaged:'.length) || 'unspecified'})` : s);

export interface Summary {
  total: number;
  open: number;
  openBySeverity: Record<Severity, number>;
  openPotential: number;
  baselined: number;
  suppressed: number;
  triaged: number;
  excluded: number;
}

export function summarize(input: ReportInput): Summary {
  const s: Summary = {
    total: input.result.findings.length,
    open: 0,
    openBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0, unrated: 0 },
    openPotential: 0,
    baselined: 0,
    suppressed: 0,
    triaged: 0,
    excluded: 0,
  };
  for (const f of input.result.findings) {
    const k = statusKind(statusOf(input, f));
    if (k === 'open') {
      s.open++;
      s.openBySeverity[f.severity]++;
      if (f.potential) s.openPotential++;
    } else s[k]++;
  }
  return s;
}

/** Findings sorted for display: severity (display order), then the core comparator. */
export function sortForDisplay(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => DISPLAY_ORDER.indexOf(a.severity) - DISPLAY_ORDER.indexOf(b.severity) || compareFindings(a, b));
}

/** "Potential SQL built by concatenation" for heuristics; the title as-is otherwise. */
export const displayTitle = (f: Finding): string => (f.potential && !/^potential\b/i.test(f.title) ? `Potential ${lowerFirst(f.title)}` : f.title);
const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);

/** Project-relative POSIX path. Absolute paths under `root` are made relative; others are kept. */
export function relPath(file: string, root?: string): string {
  let p = file.replace(/\\/g, '/');
  if (root) {
    const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (p === r) p = '.';
    else if (p.startsWith(`${r}/`)) p = p.slice(r.length + 1);
  }
  return p.replace(/^(?:\.\/)+/, '');
}

/** The file a finding points at: its location, or the manifest of a package finding. */
export const fileOf = (f: Finding, root?: string): string | undefined => {
  const file = f.location?.file ?? f.package?.manifest;
  return file ? relPath(file, root) : undefined;
};

/** `src/a.ts:12`, `package-lock.json (lodash@4.17.20)`, or `lodash@4.17.20`. */
export function whereOf(f: Finding, root?: string): string {
  const file = fileOf(f, root);
  const pkg = f.package ? `${f.package.name}${f.package.version ? `@${f.package.version}` : ''}` : '';
  if (f.location) return `${file}${f.location.startLine ? `:${f.location.startLine}` : ''}`;
  if (file && pkg) return `${file} (${pkg})`;
  return pkg || file || '(no location)';
}

export const engineText = (f: Finding): string => `${f.engine.id}${f.alsoReportedBy.length ? ` (+${f.alsoReportedBy.join(', ')})` : ''}`;

/** Coverage records that are gaps: anything that did not run cleanly. */
export const coverageGaps = (coverage: Coverage[]): Coverage[] => coverage.filter((c) => c.status !== 'ok');

/** Categories no engine covered successfully in this scan. */
export const uncoveredCategories = (coverage: Coverage[]): Category[] => CATEGORIES.filter((cat) => !coverage.some((c) => c.category === cat && c.status === 'ok'));

export function filesSkippedTotal(c: Coverage): number {
  const s = c.filesSkipped;
  return s ? s.tooLarge + s.binary + s.minified + s.unreadable + s.unsupported : 0;
}

/** "3 too large, 1 binary" — only non-zero counts. */
export function filesSkippedText(c: Coverage): string {
  const s = c.filesSkipped;
  if (!s) return '';
  const parts = (
    [
      ['too large', s.tooLarge],
      ['binary', s.binary],
      ['minified', s.minified],
      ['unreadable', s.unreadable],
      ['unsupported', s.unsupported],
    ] as const
  )
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`);
  return parts.join(', ');
}

export const coverageGapText = (c: Coverage): string => `${c.engine} (${c.category}${c.target ? `, ${c.target}` : ''}): ${c.status}${c.reason ? ` — ${c.reason}` : ''}`;

export const scopeText = (r: ScanResult): string => `${r.scope.mode}${r.scope.base ? ` vs ${r.scope.base}` : ''}${r.scope.files !== undefined ? ` (${r.scope.files} file${r.scope.files === 1 ? '' : 's'})` : ''}`;

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
