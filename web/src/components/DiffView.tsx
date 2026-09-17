import { useMemo } from 'react';

type Row = { kind: 'hunk' | 'add' | 'del' | 'ctx' | 'note'; text: string; oldNo?: number; newNo?: number };

/** Parse a unified diff into rows with line numbers. Rendered as text only (no HTML injection). */
export function parseUnifiedDiff(patch: string): Row[] {
  const rows: Row[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('===') || line.startsWith('Index:') || line.startsWith('---') || line.startsWith('+++')) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      rows.push({ kind: 'hunk', text: line });
    } else if (line.startsWith('+')) rows.push({ kind: 'add', text: line.slice(1), newNo: newNo++ });
    else if (line.startsWith('-')) rows.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ });
    else if (line.startsWith(' ')) rows.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    else if (line.startsWith('\\') || line.startsWith('…')) rows.push({ kind: 'note', text: line });
  }
  return rows;
}

export function DiffView({ patch, truncated }: { patch: string; truncated?: boolean }) {
  const rows = useMemo(() => parseUnifiedDiff(patch), [patch]);
  return (
    <div className="diff" role="table" aria-label="Proposed changes">
      {rows.map((r, i) => (
        <div key={i} className={`diff__row diff__row--${r.kind}`} role="row">
          <span className="diff__no" aria-hidden="true">{r.oldNo ?? ''}</span>
          <span className="diff__no" aria-hidden="true">{r.newNo ?? ''}</span>
          <span className="diff__sign" aria-hidden="true">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ''}</span>
          <span className="diff__text">{r.kind === 'hunk' ? r.text.replace(/^@@.*@@\s?/, '') || '…' : r.text}</span>
        </div>
      ))}
      {truncated && <div className="diff__row diff__row--note"><span className="diff__text">Diff truncated. Run <code>athena sync --diff</code> for the full change.</span></div>}
    </div>
  );
}
