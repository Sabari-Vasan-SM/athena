import pc from 'picocolors';
import type { Finding, Severity } from '../findings/finding.js';
import {
  coverageGaps,
  DISPLAY_ORDER,
  displayTitle,
  engineText,
  filesSkippedText,
  plural,
  scopeText,
  sortForDisplay,
  statusKind,
  statusOf,
  statusTag,
  summarize,
  uncoveredCategories,
  whereOf,
  type ReportInput,
} from './shared.js';

export interface TextOptions {
  /** Default: picocolors' detection (off with NO_COLOR, on a dumb terminal, or when not a TTY). */
  color?: boolean;
  /** Columns. Default: the terminal width (40–160), else 100. */
  width?: number;
}

const BADGE: Record<Severity, string> = { critical: 'CRITICAL', high: 'HIGH', unrated: 'UNRATED', medium: 'MEDIUM', low: 'LOW', info: 'INFO' };
const BADGE_W = 8;
const INDENT = ' '.repeat(4 + BADGE_W + 1);

/** Plain-text truncation to `max` code points (applied before colouring, so no escape is ever cut). */
function cut(s: string, max: number): string {
  const chars = [...s.replace(/[\r\n\t]+/g, ' ')];
  if (chars.length <= max) return chars.join('');
  return max <= 1 ? chars.slice(0, Math.max(0, max)).join('') : `${chars.slice(0, max - 1).join('')}…`;
}
// Strip control characters from tool-provided text so it cannot move the cursor or recolour the terminal.
// eslint-disable-next-line no-control-regex
const clean = (s: string): string => s.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const len = (s: string) => [...s].length;

export function renderText(input: ReportInput, opts: TextOptions = {}): string {
  const c = pc.createColors(opts.color ?? pc.isColorSupported);
  const W = Math.max(40, opts.width ?? (process.stdout.columns ? Math.min(process.stdout.columns, 160) : 100));
  const r = input.result;
  const out: string[] = [];
  const sevColor: Record<Severity, (s: string) => string> = {
    critical: (s) => c.bold(c.red(s)),
    high: c.red,
    unrated: c.magenta,
    medium: c.yellow,
    low: c.cyan,
    info: c.dim,
  };

  out.push(c.bold(cut(`Athena scan — ${scopeText(r)} · ${r.scannedAt}`, W)));
  out.push('');

  // ── Summary ──
  const s = summarize(input);
  const bySev = DISPLAY_ORDER.filter((k) => s.openBySeverity[k] > 0).map((k) => `${s.openBySeverity[k]} ${k}`);
  const headline = `Open findings: ${s.open}`;
  const detail = `${bySev.length ? ` (${bySev.join(' · ')})` : ''}${s.openPotential ? ` · ${s.openPotential} potential (heuristic, check them)` : ''}`;
  out.push(`${c.bold(headline)}${cut(detail, W - headline.length)}`);
  const hidden = (['baselined', 'suppressed', 'triaged', 'excluded'] as const).filter((k) => s[k] > 0).map((k) => `${s[k]} ${k}`);
  if (hidden.length) out.push(c.dim(cut(`Not counted: ${hidden.join(' · ')}`, W)));

  // ── Findings, grouped by severity then category ──
  const findings = sortForDisplay(r.findings);
  for (const sev of DISPLAY_ORDER) {
    const inSev = findings.filter((f) => f.severity === sev);
    if (!inSev.length) continue;
    out.push('', sevColor[sev](BADGE[sev]));
    const cats = [...new Set(inSev.map((f) => f.category))].sort();
    for (const cat of cats) {
      out.push(`  ${c.bold(cat)}`);
      for (const f of inSev.filter((x) => x.category === cat)) out.push(...findingLines(f));
    }
  }
  if (!findings.length) out.push('', 'No findings.');

  function findingLines(f: Finding): string[] {
    const status = statusOf(input, f);
    const open = statusKind(status) === 'open';
    const badge = BADGE[f.severity].padEnd(BADGE_W);
    const where = clean(whereOf(f, input.root));
    const title = clean(displayTitle(f));
    const tag = open ? '' : `  [${statusTag(status)}]`;
    const room = W - 4 - BADGE_W - 1;
    const right = `  ${where}${tag}`;
    // Keep the location visible: shorten the title first, then the whole line.
    const head = cut(cut(title, Math.max(12, room - len(right))) + right, room);
    const meta = cut(`${f.ruleId} · ${f.label} · ${clean(engineText(f))}`, room);
    if (!open) return [c.dim(`    ${badge} ${head}`), c.dim(`${INDENT}${meta}`)];
    const lines = [`    ${sevColor[f.severity](badge)} ${head}`];
    const msg = clean(f.message);
    if (msg && msg !== f.title) lines.push(`${INDENT}${cut(msg, room)}`);
    lines.push(c.dim(`${INDENT}${meta}`));
    return lines;
  }

  // ── Gate ──
  if (input.gate) {
    out.push('', `${c.bold('Gate:')} ${input.gate.passed ? c.green('PASSED') : c.red(c.bold('FAILED'))}`);
    for (const reason of input.gate.reasons) out.push(`  - ${cut(clean(reason), W - 4)}`);
  }

  // ── Ratings ──
  const ratings = Object.entries(input.ratings ?? {});
  if (ratings.length) {
    out.push('', c.bold('Ratings'));
    const cw = Math.max(...ratings.map(([k]) => k.length));
    for (const [cat, rating] of ratings) if (rating) out.push(`  ${cat.padEnd(cw)}  ${c.bold(rating.grade)}  ${cut(clean(rating.basis), W - cw - 7)}`);
  }

  // ── Coverage: always printed, gaps first-class ──
  out.push('', c.bold('Coverage'));
  if (!r.coverage.length) out.push(c.yellow(cut('  No engine reported coverage: nothing was checked.', W)));
  const ew = Math.max(0, ...r.coverage.map((x) => x.engine.length));
  const kw = Math.max(0, ...r.coverage.map((x) => x.category.length));
  const sw = Math.max(0, ...r.coverage.map((x) => x.status.length));
  for (const cov of r.coverage) {
    const details: string[] = [];
    if (cov.target) details.push(cov.target);
    if (cov.filesScanned !== undefined) details.push(plural(cov.filesScanned, 'file') + ' scanned');
    const skipped = filesSkippedText(cov);
    if (skipped) details.push(`skipped ${skipped}`);
    if (cov.network) details.push('used network');
    if (cov.reason) details.push(cov.reason);
    const status = cov.status === 'ok' ? c.green('ok') : cov.status === 'failed' || cov.status === 'timeout' ? c.red(cov.status) : c.yellow(cov.status);
    const prefix = `  ${clean(cov.engine).padEnd(ew)}  ${cov.category.padEnd(kw)}  `;
    const plain = cut(`${prefix}${cov.status.padEnd(sw)}${details.length ? `  ${clean(details.join(' · '))}` : ''}`.trimEnd(), W);
    const head = `${prefix}${cov.status}`;
    out.push(plain.startsWith(head) ? `${prefix}${status}${plain.slice(head.length)}` : plain);
  }
  const gaps = coverageGaps(r.coverage);
  if (gaps.length) out.push(c.yellow(cut(`  ${plural(gaps.length, 'engine')} did not run cleanly; the results above are incomplete.`, W)));
  const uncovered = uncoveredCategories(r.coverage);
  if (uncovered.length) out.push(c.dim(cut(`  Not covered by any engine: ${uncovered.join(', ')}`, W)));

  return `${out.join('\n')}\n`;
}
