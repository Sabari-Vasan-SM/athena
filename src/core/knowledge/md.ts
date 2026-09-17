import type { Evidence, Provenance } from '../model/fact.js';

/** Escape text for use inside a Markdown table cell or inline context. */
export function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;')).replace(/\r?\n/g, ' ');
}

export function code(s: string): string {
  const clean = s.replace(/\r?\n/g, ' ');
  const ticks = clean.includes('`') ? '``' : '`';
  return `${ticks}${ticks.length === 2 ? ' ' : ''}${clean}${ticks.length === 2 ? ' ' : ''}${ticks}`;
}

export function evidenceRef(e: Evidence): string {
  return code(`${e.file}${e.line ? `:${e.line}` : ''}`);
}

export function evidenceList(evidence: Evidence[], max = 3): string {
  if (!evidence.length) return '—';
  const shown = evidence.slice(0, max).map(evidenceRef).join(', ');
  return evidence.length > max ? `${shown} +${evidence.length - max} more` : shown;
}

/** Compact provenance label, e.g. "DETECTED · high". */
export function status(p: Provenance): string {
  return p.status === 'UNKNOWN' ? 'UNKNOWN' : `${p.status} · ${p.confidence}`;
}

export function table(headers: string[], rows: string[][]): string {
  if (!rows.length) return '';
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  return [head, sep, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

export function unknown(what: string, hint?: string): string {
  return `**${what}:** UNKNOWN${hint ? ` — ${hint}` : ''}`;
}

export function notDetected(what: string): string {
  return `_No ${what} detected._ Status: **UNKNOWN** (absence of detection is not proof of absence).`;
}

export function bullets(items: string[]): string {
  return items.map((i) => `- ${i}`).join('\n');
}

export function truncatedNote(shown: number, total: number, what: string): string {
  return total > shown ? `\n\n_Showing ${shown} of ${total} ${what}. The full list is in \`.athena/model.json\`._` : '';
}

/** Sanitize a label for use inside a Mermaid node. */
export function mermaidLabel(s: string): string {
  return s.replace(/["`<>{}[\]()|#;]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'node';
}

export function mermaidId(s: string): string {
  return `n_${s.replace(/[^A-Za-z0-9]/g, '_')}`.slice(0, 64);
}

export const LEGEND = [
  '**Status legend** — `FACT`: declared or developer-asserted · `DETECTED`: found by analysis, with evidence · `INFERRED`: heuristic, verify before relying on it · `UNKNOWN`: could not be determined.',
].join('\n');
