import type { Severity } from '../findings/finding.js';
import { coverageGapText, coverageGaps, displayTitle, fileOf, plural, sortForDisplay, statusKind, statusOf, summarize, uncoveredCategories, type ReportInput } from './shared.js';

/**
 * GitHub Actions workflow commands (`::error file=…,line=…::message`), one per open
 * finding, capped, plus a summary, the gate verdict and every coverage gap.
 */
export const MAX_ANNOTATIONS = 50;

type Kind = 'error' | 'warning' | 'notice';
const KIND: Record<Severity, Kind> = { critical: 'error', high: 'error', medium: 'warning', unrated: 'warning', low: 'notice', info: 'notice' };

/** Escape command data (after `::`) so untrusted text cannot end the command or start another. */
export const ghData = (s: string): string => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
/** Escape a property value (file=, title=): also `:` and `,`, which delimit properties. */
export const ghProp = (s: string): string => ghData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

function command(kind: Kind, props: Record<string, string | number | undefined>, message: string): string {
  const p = Object.entries(props)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'number' ? v : ghProp(v!)}`)
    .join(',');
  return `::${kind}${p ? ` ${p}` : ''}::${ghData(message)}`;
}

export function renderGithub(input: ReportInput): string {
  const r = input.result;
  const s = summarize(input);
  const out: string[] = [];
  const open = sortForDisplay(r.findings).filter((f) => statusKind(statusOf(input, f)) === 'open');

  for (const f of open.slice(0, MAX_ANNOTATIONS)) {
    const loc = f.location;
    const message = f.message && f.message !== f.title ? `${f.message} (${f.ruleId}, ${f.label}, ${f.engine.id})` : `${f.ruleId}, ${f.label}, ${f.engine.id}`;
    out.push(
      command(
        KIND[f.severity],
        {
          file: fileOf(f, input.root),
          line: loc?.startLine,
          col: loc?.startLine ? loc.startColumn : undefined,
          endLine: loc?.startLine ? loc.endLine : undefined,
          endColumn: loc?.startLine && loc.endLine === loc.startLine ? loc.endColumn : undefined,
          title: `Athena [${f.severity}]: ${displayTitle(f)}`,
        },
        message,
      ),
    );
  }

  const rest = open.length - Math.min(open.length, MAX_ANNOTATIONS);
  const hidden = (['baselined', 'suppressed', 'triaged', 'excluded'] as const).filter((k) => s[k] > 0).map((k) => `${s[k]} ${k}`);
  const summary = `Athena: ${plural(s.open, 'open finding')}${rest ? `, ${rest} not annotated (limit ${MAX_ANNOTATIONS})` : ''}${hidden.length ? `; not counted: ${hidden.join(', ')}` : ''}.`;
  out.push(command(s.openBySeverity.critical + s.openBySeverity.high ? 'error' : s.open ? 'warning' : 'notice', { title: 'Athena scan' }, summary));

  if (input.gate) {
    const text = `Gate ${input.gate.passed ? 'passed' : 'failed'}${input.gate.reasons.length ? `: ${input.gate.reasons.join('; ')}` : '.'}`;
    out.push(command(input.gate.passed ? 'notice' : 'error', { title: 'Athena gate' }, text));
  }

  // Coverage gaps are never silent: each one is its own annotation (not counted in the cap).
  for (const g of coverageGaps(r.coverage)) {
    out.push(command(g.status === 'failed' || g.status === 'timeout' ? 'warning' : 'notice', { title: 'Athena coverage gap' }, coverageGapText(g)));
  }
  if (!r.coverage.length) out.push(command('warning', { title: 'Athena coverage gap' }, 'No engine reported coverage: nothing was checked.'));
  const uncovered = uncoveredCategories(r.coverage);
  if (uncovered.length) out.push(command('notice', { title: 'Athena coverage' }, `Not covered by any engine: ${uncovered.join(', ')}.`));

  return `${out.join('\n')}\n`;
}
