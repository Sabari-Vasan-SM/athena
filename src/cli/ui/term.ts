import pc from 'picocolors';

const out = process.stdout;
export const isTTY = Boolean(out.isTTY) && process.env.TERM !== 'dumb' && !process.env.CI;
export const unicode = process.platform !== 'win32' || Boolean(process.env.WT_SESSION) || process.env.TERM_PROGRAM === 'vscode' || Boolean(process.env.TERMINAL_EMULATOR);

export const sym = {
  ok: unicode ? '✓' : '√',
  warn: unicode ? '⚠' : '!',
  err: unicode ? '✗' : '×',
  info: unicode ? '•' : '*',
  dot: unicode ? '●' : '*',
  ring: unicode ? '○' : 'o',
  arrow: unicode ? '→' : '->',
};

export const c = pc;

let quiet = false;
let jsonMode = false;
export function setOutputMode(opts: { quiet?: boolean; json?: boolean }): void {
  quiet = Boolean(opts.quiet);
  jsonMode = Boolean(opts.json);
}
export const isJson = () => jsonMode;
export const isQuiet = () => quiet;

let interruptMessage = 'No partial knowledge was written.';
export const setInterruptMessage = (m: string) => (interruptMessage = m);
export const getInterruptMessage = () => interruptMessage;

export function line(s = ''): void {
  if (jsonMode) return;
  out.write(`${s}\n`);
}
export function info(s: string): void {
  if (!quiet) line(s);
}
export const ok = (s: string) => line(`${c.green(sym.ok)} ${s}`);
export const warn = (s: string) => line(`${c.yellow(sym.warn)} ${s}`);
export const fail = (s: string) => line(`${c.red(sym.err)} ${s}`);
export const bullet = (s: string) => line(`${c.dim(sym.info)} ${s}`);
export const heading = (s: string) => line(c.bold(s));
export const dim = (s: string) => c.dim(s);

export function json(value: unknown): void {
  out.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Render a list of paths as a tree under a root label. */
export function tree(rootLabel: string, items: string[]): void {
  line(rootLabel);
  items.forEach((item, i) => {
    const last = i === items.length - 1;
    line(`${c.dim(unicode ? (last ? '└── ' : '├── ') : last ? '`-- ' : '|-- ')}${item}`);
  });
}

export interface Spinner {
  update(text: string): void;
  succeed(text?: string): void;
  warn(text?: string): void;
  fail(text?: string): void;
  stop(): void;
}

const FRAMES = unicode ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] : ['-', '\\', '|', '/'];

export function spinner(text: string): Spinner {
  let current = text;
  let timer: NodeJS.Timeout | null = null;
  let frame = 0;
  const clear = () => {
    if (isTTY) out.write('\r\x1b[2K');
  };
  const done = (symbol: string, msg?: string, suppressible = false) => {
    const wasSpinning = timer !== null;
    if (timer) clearInterval(timer);
    timer = null;
    if (jsonMode) return;
    if (wasSpinning) {
      clear();
      out.write('\x1b[?25h');
    }
    if (!(suppressible && quiet)) line(`${symbol} ${msg ?? current}`);
  };
  if (!jsonMode && !quiet && isTTY) {
    out.write('\x1b[?25l');
    timer = setInterval(() => {
      clear();
      out.write(`${c.cyan(FRAMES[(frame = (frame + 1) % FRAMES.length)]!)} ${current}`);
    }, 80);
    timer.unref();
  }
  return {
    update(t) {
      current = t;
    },
    succeed: (msg) => done(c.green(sym.ok), msg, true),
    warn: (msg) => done(c.yellow(sym.warn), msg),
    fail: (msg) => done(c.red(sym.err), msg),
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      clear();
      out.write('\x1b[?25h');
    },
  };
}

export function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return 'unknown';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
