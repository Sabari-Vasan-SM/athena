import pc from 'picocolors';
import { AUTHOR, ATHENA_VERSION, NPM_URL, REPO_URL, WEBSITE_URL } from '../../services/version.js';
import { BRAND, box, cell, center, columns, gradient, gradientBlock, HR, paint, PALETTE, termWidth, vcenter, VR, width } from './layout.js';
import { isJson, isQuiet, line, unicode } from './term.js';

const LETTERS: Record<string, string[]> = {
  A: [' █████╗ ', '██╔══██╗', '███████║', '██╔══██║', '██║  ██║', '╚═╝  ╚═╝'],
  T: ['████████╗', '╚══██╔══╝', '   ██║   ', '   ██║   ', '   ██║   ', '   ╚═╝   '],
  H: ['██╗  ██╗', '██║  ██║', '███████║', '██╔══██║', '██║  ██║', '╚═╝  ╚═╝'],
  E: ['███████╗', '██╔════╝', '█████╗  ', '██╔══╝  ', '███████╗', '╚══════╝'],
  N: ['███╗   ██╗', '████╗  ██║', '██╔██╗ ██║', '██║╚██╗██║', '██║ ╚████║', '╚═╝  ╚═══╝'],
};

const LOGO = [0, 1, 2, 3, 4, 5].map((r) => [...'ATHENA'].map((ch) => LETTERS[ch]![r]).join(''));
const LOGO_WIDTH = width(LOGO[0]!);

/**
 * Pixel-art robot (speech-bubble head, wink, smile). Each text row packs two
 * pixel rows using half blocks, so 20×24 pixels render as 10×24 cells.
 */
const ROBOT_PIXELS = [
  '...........AA...........',
  '..........AAAA..........',
  '...........KK...........',
  '....KKKKKKKKKKKKKKKK....',
  '...KBBBBBBBBBBBBBBBBK...',
  '..KBBBBBBBBBBBBBBBBBBK..',
  '..KBBBBWWBBBBBBYYYYBBK..',
  'YYKBBBWBBWBBBBYYDDYYBKYY',
  'YYKBBBBBBBBBBBYYDDYYBKYY',
  'YYKBBBBBBBBBBBBYYYYBBKYY',
  'YYKBBBBBYYYYYYYYBBBBBKYY',
  '..KBBBBBBYYYYYYBBBBBBK..',
  '..KBBBBBBBYYYYBBBBBBBK..',
  '..KBBBBBBBBBBBBBBBBBBK..',
  '..KBBBBBBBBBBBBBBBBBBK..',
  '..KBBBBBKKKKKKKKKKKK....',
  '...KBBBK................',
  '....KBK.................',
  '.....K..................',
  '........................',
];
const PIXEL_COLORS: Record<string, string> = { K: '#1e40af', B: '#4ba3e3', Y: '#f5c542', D: '#2e3f9e', A: '#5b7cfa', W: '#0f172a' };

/** Line-art fallback for terminals without colour, where pixel art would be a silhouette. */
const ROBOT_ASCII = [
  '      ●      ',
  '      ┃      ',
  '  ╭───┸───╮  ',
  ' ▐│ ◠   ◉ │▌ ',
  ' ▐│  ╰─╯  │▌ ',
  '  │       │  ',
  '  ╰┬──────╯  ',
  '   ╰╯        ',
  '             ',
  '             ',
];

const ROBOT_HEIGHT = ROBOT_PIXELS.length / 2;
const ROBOT_WIDTH = pc.isColorSupported ? ROBOT_PIXELS[0]!.length : ROBOT_ASCII[0]!.length;

const BUBBLE = ['╭────────────╮', '│ Analyze    │', '│ Understand │', '│ Document   │', '│ Empower ✦  │', '╰────────────╯'];
const BUBBLE_WIDTH = 14;

function paintRobot(): string[] {
  if (!pc.isColorSupported) return ROBOT_ASCII;
  const color = (p: string) => PIXEL_COLORS[p] ?? null;
  const out: string[] = [];
  for (let r = 0; r < ROBOT_PIXELS.length; r += 2) {
    const top = ROBOT_PIXELS[r]!;
    const bottom = ROBOT_PIXELS[r + 1]!;
    let row = '';
    for (let x = 0; x < top.length; x++) {
      const [t, b] = [color(top[x]!), color(bottom[x]!)];
      if (!t && !b) row += ' ';
      else if (t === b) row += cell('█', t, null);
      else if (!b) row += cell('▀', t, null);
      else if (!t) row += cell('▄', b, null);
      else row += cell('▀', t, b);
    }
    out.push(row);
  }
  return out;
}

function paintBubble(): string[] {
  return BUBBLE.map((row) => {
    const inner = row.slice(1, -1);
    const edge = (s: string) => paint(PALETTE.slate, s);
    if (row.startsWith('╭') || row.startsWith('╰')) return edge(row);
    return edge('│') + inner.replace('✦', paint(PALETTE.amber, '✦')).replace(/[A-Za-z]+/, (w) => paint(PALETTE.cyan, w)) + edge('│');
  });
}

function logoBlock(w: number): string[] {
  const rule = (label: string) => {
    const side = Math.max(2, Math.floor((w - width(label) - 2) / 2));
    return `${pc.dim(HR.repeat(side))} ${label} ${pc.dim(HR.repeat(side))}`;
  };
  return [
    ...gradientBlock(LOGO),
    '',
    center(gradient('Project Intelligence for AI Coding', [PALETTE.blue, PALETTE.violet], true), w),
    center(rule(`${pc.dim('developed by')} ${paint(PALETTE.cyan, AUTHOR, true)}`), w),
  ];
}

function linksBlock(): string[] {
  return [
    pc.italic('"Turn any codebase into clear knowledge."'),
    '',
    `${paint(PALETTE.green, 'web', true)}     ${paint(PALETTE.cyan, WEBSITE_URL, true)}`,
    `${paint(PALETTE.pink, 'npm', true)}     ${pc.dim(`v${ATHENA_VERSION}`)}`,
    paint(PALETTE.blue, NPM_URL),
    paint(PALETTE.violet, 'github', true),
    paint(PALETTE.blue, REPO_URL),
  ];
}
const LINKS_WIDTH = Math.max(NPM_URL.length, REPO_URL.length);

export function printHeader(): void {
  if (isJson() || isQuiet()) return;
  for (const l of header()) line(l);
}

/** The full-width header. Picks the richest layout that fits the terminal. */
export function header(): string[] {
  if (!unicode) return [pc.bold(pc.cyan('ATHENA')) + pc.dim(`  Project Intelligence for AI Coding · v${ATHENA_VERSION}`), ''];
  const total = termWidth();
  const logoW = LOGO_WIDTH;
  const divider = (h: number) => Array.from({ length: h }, () => pc.dim(VR));
  const robotBubble = columns([paintRobot(), vcenter(paintBubble(), ROBOT_HEIGHT - 2)], [ROBOT_WIDTH, BUBBLE_WIDTH], 1);
  const logo = vcenter(logoBlock(logoW), ROBOT_HEIGHT);
  const links = vcenter(linksBlock(), ROBOT_HEIGHT);
  const H = ROBOT_HEIGHT;

  const layouts: Array<{ w: number; build: () => string[] }> = [
    { w: ROBOT_WIDTH + 1 + BUBBLE_WIDTH + 3 + logoW + 3 + 1 + 3 + LINKS_WIDTH, build: () => columns([robotBubble, logo, divider(H), links], [ROBOT_WIDTH + 1 + BUBBLE_WIDTH, logoW, 1, LINKS_WIDTH], 3) },
    { w: ROBOT_WIDTH + 3 + logoW + 3 + 1 + 3 + LINKS_WIDTH, build: () => columns([paintRobot(), logo, divider(H), links], [ROBOT_WIDTH, logoW, 1, LINKS_WIDTH], 3) },
    { w: ROBOT_WIDTH + 3 + logoW, build: () => [...columns([paintRobot(), logo], [ROBOT_WIDTH, logoW], 3), '', ...compactLinks()] },
    { w: logoW, build: () => [...logoBlock(logoW), '', ...compactLinks()] },
  ];
  // Box borders + one space of padding each side = 4 columns.
  const fit = layouts.find((l) => l.w + 4 <= total);
  if (!fit) return [pc.bold(gradient('ATHENA', BRAND, true)) + pc.dim(`  Project Intelligence for AI Coding · v${ATHENA_VERSION}`), pc.dim(REPO_URL), ''];
  const content = fit.build();
  return [...box(content, Math.min(total, fit.w + 4), { color: PALETTE.blue }), ''];
}

function compactLinks(): string[] {
  return [
    `${paint(PALETTE.green, 'web', true)}     ${paint(PALETTE.cyan, WEBSITE_URL, true)}`,
    `${paint(PALETTE.pink, 'npm', true)}     ${paint(PALETTE.blue, NPM_URL)}`,
    `${paint(PALETTE.violet, 'github', true)}  ${paint(PALETTE.blue, REPO_URL)}`,
  ];
}

/** Closing banner: status on the left, links and author on the right. */
export function footer(title: string, subtitle: string, tone: 'success' | 'warn' = 'success'): string[] {
  const total = termWidth();
  const color = tone === 'success' ? PALETTE.green : PALETTE.amber;
  const mark = tone === 'success' ? '✓' : '!';
  const status = [`${paint(color, ` ${mark} `, true)}  ${paint(color, title, true)}`, `     ${subtitle}`, ''];
  const links = compactLinks();
  const credit = [pc.dim('Developed by'), `${paint(PALETTE.cyan, AUTHOR, true)} ${paint(PALETTE.pink, '♥')}`, ''];
  const statusW = Math.max(...status.map(width));
  const linksW = 8 + LINKS_WIDTH;
  const wide = statusW + 4 + linksW + 3 + 1 + 3 + 14 + 4;
  const content =
    wide <= total
      ? columns([status, links, divider2(), credit], [statusW, linksW, 1, 14], 3)
      : total >= linksW + 4
        ? [...status.filter(Boolean), '', ...links, credit.filter(Boolean).join(' ')]
        : [...status, pc.dim(REPO_URL)];
  const w = wide <= total ? wide : Math.min(total, Math.max(statusW, linksW) + 4);
  return box(content, w, { color });
}

const divider2 = () => [pc.dim(VR), pc.dim(VR), pc.dim(VR)];
