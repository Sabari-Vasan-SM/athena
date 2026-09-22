import pc from 'picocolors';
import { box, columns, gradient, HR, padEnd, paint, PALETTE, termWidth, width } from './layout.js';
import { unicode } from './term.js';

/** Panels and small building blocks for the init/analyze summary. */

export const C = PALETTE;
export type Row = [label: string, value: string];

export const accent = (s: string) => paint(PALETTE.amber, s, true);
export const warnText = (s: string) => paint(PALETTE.amber, s);

export function sectionTitle(title: string): string[] {
  const total = termWidth();
  const head = `  ${paint(PALETTE.violet, unicode ? '✦' : '*', true)} ${gradient(title, [PALETTE.cyan, PALETTE.violet], true)} `;
  const rest = Math.max(0, total - width(head) - 2);
  return [head + paint(PALETTE.blue, HR.repeat(rest))];
}

/** Two-column label/value rows; empty values render as "Not detected". */
export function rows(items: Row[]): (w: number) => string[] {
  const labelW = Math.max(...items.map(([l]) => l.length)) + 2;
  return (w) => items.map(([label, value]) => pc.dim(padEnd(label, labelW)) + padEnd(value ? paint(PALETTE.cyan, value) : pc.dim('Not detected'), w - labelW));
}

export function fileTree(root: string, files: Array<{ name: string; note: string; highlight?: boolean }>): (w: number) => string[] {
  const nameW = Math.max(...files.map((f) => f.name.length)) + 2;
  return (w) => [
    pc.bold(root),
    ...files.map((f, i) => {
      const branch = unicode ? (i === files.length - 1 ? '└── ' : '├── ') : i === files.length - 1 ? '`-- ' : '|-- ';
      const name = f.highlight ? paint(PALETTE.amber, padEnd(f.name, nameW)) : padEnd(f.name, nameW);
      return padEnd(pc.dim(branch) + name + pc.dim(f.note ? `# ${f.note}` : ''), w);
    }),
  ];
}

/** Word-wrap plain text, then colour `code` spans (state carries across lines). */
function wrapCode(text: string, w: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const word of text.split(' ')) {
    if (cur && cur.length + 1 + word.length > w) {
      out.push(cur);
      cur = word;
    } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) out.push(cur);
  let inCode = false;
  return out.map((l) =>
    l
      .split('`')
      .map((part, i) => {
        if (i > 0) inCode = !inCode;
        return inCode ? paint(PALETTE.cyan, part) : part;
      })
      .join(''),
  );
}

export function numbered(steps: string[]): (w: number) => string[] {
  return (w) =>
    steps.flatMap((s, i) => {
      const badge = paint(PALETTE.green, ` ${i + 1} `, true);
      const [first = '', ...rest] = wrapCode(s, Math.max(10, w - 5));
      return [`${badge}  ${first}`, ...rest.map((r) => `     ${r}`)];
    });
}

export function quote(text: string): (w: number) => string[] {
  return (w) => {
    const lines = wrapCode(`“${text}”`, Math.max(10, w - 6)).map((l) => pc.italic(l));
    return box([...lines, paint(PALETTE.cyan, `— Sabarivasan`)], Math.min(w, Math.max(...lines.map(width)) + 6), { color: PALETTE.slate, padX: 2 });
  };
}

type Body = string[] | ((w: number) => string[]);
export interface Panel {
  title: string;
  icon: string;
  color: string;
  body: Body | Body[];
}

function renderBody(body: Body | Body[], w: number): string[] {
  const parts: Body[] = Array.isArray(body) && body.length && typeof body[0] !== 'string' ? (body as Body[]) : [body as Body];
  return parts.flatMap((p) => (typeof p === 'function' ? p(w) : p));
}

/** Three panels side by side on wide terminals, stacked otherwise. */
export function panels(list: Panel[]): string[] {
  const total = termWidth();
  const title = (p: Panel) => `${paint(p.color, unicode ? p.icon : '*', true)} ${paint(p.color, p.title, true)}`;
  if (total >= 120) {
    const gap = 2;
    const avail = total - gap * (list.length - 1) - 1;
    const weights = [0.36, 0.32, 0.32];
    const widths = list.map((_, i) => Math.floor(avail * (weights[i] ?? 1 / list.length)));
    const bodies = list.map((p, i) => renderBody(p.body, widths[i]! - 4));
    const h = Math.max(...bodies.map((b) => b.length));
    const boxes = list.map((p, i) => box([title(p), '', ...bodies[i]!, ...Array<string>(h - bodies[i]!.length).fill('')], widths[i]!, { color: p.color, padX: 1 }));
    return columns(boxes, widths, gap);
  }
  const w = Math.min(total - 1, 100);
  return list.flatMap((p, i) => [...(i ? [''] : []), ...box([title(p), '', ...renderBody(p.body, w - 4)], w, { color: p.color })]);
}
