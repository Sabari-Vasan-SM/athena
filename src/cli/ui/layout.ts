import pc from 'picocolors';
import { unicode } from './term.js';

/**
 * Width-aware layout primitives for the terminal dashboard: ANSI-safe measuring,
 * padding and truncation, gradients, boxes and side-by-side columns.
 * Every glyph used by the dashboard is single-width, so width = code points.
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\]8;;[^\x07]*\x07/g;

export const strip = (s: string): string => s.replace(ANSI, '');
export const width = (s: string): number => [...strip(s)].length;

export function termWidth(): number {
  const cols = process.stdout.columns || Number(process.env.COLUMNS) || 80;
  return Math.max(40, Math.min(cols, 160));
}

/** Cut to `max` visible characters, keeping escape sequences intact. */
export function truncate(s: string, max: number): string {
  if (width(s) <= max) return s;
  if (max <= 0) return '';
  let out = '';
  let visible = 0;
  let i = 0;
  while (i < s.length) {
    ANSI.lastIndex = 0;
    const rest = s.slice(i);
    const m = rest.match(new RegExp(`^(?:${ANSI.source})`));
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    if (visible === max - 1) {
      out += unicode ? '…' : '.';
      break;
    }
    out += ch;
    visible++;
    i += ch.length;
  }
  return pc.isColorSupported ? `${out}\x1b[0m` : out;
}

export const padEnd = (s: string, w: number): string => {
  const cut = truncate(s, w);
  return cut + ' '.repeat(Math.max(0, w - width(cut)));
};

export const center = (s: string, w: number): string => {
  const n = width(s);
  if (n >= w) return truncate(s, w);
  const left = Math.floor((w - n) / 2);
  return ' '.repeat(left) + s + ' '.repeat(w - n - left);
};

// ── Color ────────────────────────────────────────────────────────────────────

type RGB = [number, number, number];

const truecolor = /^(truecolor|24bit)$/i.test(process.env.COLORTERM ?? '') || ['iTerm.app', 'vscode', 'WezTerm', 'ghostty', 'Hyper'].includes(process.env.TERM_PROGRAM ?? '');

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

function ansi256([r, g, b]: RGB): number {
  const q = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.round((v - 35) / 40));
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

export function paint(color: string | RGB, s: string, bold = false): string {
  if (!pc.isColorSupported || !s) return s;
  const rgb = typeof color === 'string' ? hex(color) : color;
  const fg = truecolor ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : `\x1b[38;5;${ansi256(rgb)}m`;
  return `${bold ? '\x1b[1m' : ''}${fg}${s}\x1b[0m`;
}

export const PALETTE = {
  green: '#34d399',
  cyan: '#22d3ee',
  blue: '#3b82f6',
  violet: '#a855f7',
  pink: '#f472b6',
  amber: '#fbbf24',
  slate: '#64748b',
};

export const BRAND = [PALETTE.cyan, PALETTE.blue, PALETTE.violet];

/** Color at position t ∈ [0,1] along a list of hex stops. */
export function mix(stops: string[], t: number): RGB {
  const rgb = stops.map(hex);
  if (rgb.length === 1) return rgb[0]!;
  const x = Math.min(0.9999, Math.max(0, t)) * (rgb.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const [a, b] = [rgb[i]!, rgb[i + 1]!];
  return [0, 1, 2].map((k) => Math.round(a[k]! + (b[k]! - a[k]!) * f)) as RGB;
}

/** Horizontal gradient across a block of lines, aligned by column. */
export function gradientBlock(lines: string[], stops: string[] = BRAND, bold = true): string[] {
  const w = Math.max(...lines.map((l) => [...l].length));
  return lines.map((l) => [...l].map((ch, i) => (ch === ' ' ? ch : paint(mix(stops, i / Math.max(1, w - 1)), ch, bold))).join(''));
}

export const gradient = (s: string, stops: string[] = BRAND, bold = false): string => gradientBlock([s], stops, bold)[0]!;

// ── Boxes and columns ────────────────────────────────────────────────────────

const B = unicode ? { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' } : { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' };
export const HR = B.h;
export const VR = B.v;

/** A rounded box of exactly `w` columns. An optional title sits in the top border. */
export function box(content: string[], w: number, opts: { color?: string; title?: string; padX?: number } = {}): string[] {
  const color = opts.color ?? PALETTE.slate;
  const padX = opts.padX ?? 1;
  const inner = w - 2;
  const edge = (s: string) => paint(color, s);
  const title = opts.title ? ` ${opts.title} ` : '';
  const top = title ? edge(`${B.tl}${B.h}`) + title + edge(B.h.repeat(Math.max(0, inner - 1 - width(title))) + B.tr) : edge(B.tl + B.h.repeat(inner) + B.tr);
  const body = content.map((l) => edge(B.v) + ' '.repeat(padX) + padEnd(l, inner - padX * 2) + ' '.repeat(padX) + edge(B.v));
  return [top, ...body, edge(B.bl + B.h.repeat(inner) + B.br)];
}

/** Lay blocks side by side. Shorter blocks are padded with blank lines. */
export function columns(blocks: string[][], widths: number[], gap = 2): string[] {
  const h = Math.max(...blocks.map((b) => b.length));
  const rows: string[] = [];
  for (let r = 0; r < h; r++) rows.push(blocks.map((b, i) => padEnd(b[r] ?? '', widths[i]!)).join(' '.repeat(gap)).trimEnd());
  return rows;
}

/** Vertically center a block within `h` lines. */
export function vcenter(block: string[], h: number): string[] {
  const top = Math.max(0, Math.floor((h - block.length) / 2));
  return [...Array<string>(top).fill(''), ...block];
}
