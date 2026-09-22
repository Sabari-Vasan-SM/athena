import pc from 'picocolors';
import { mix, padEnd, paint, PALETTE, termWidth, truncate } from './layout.js';
import { isJson, isQuiet, isTTY, line, sym, unicode } from './term.js';

/**
 * Live checklist of the real pipeline stages. Bars fill only when a stage has
 * actually finished; the running stage shows an indeterminate sweep, never a
 * made-up percentage. Timings are measured, results come from the analysis.
 */

export type StageId = 'scan' | 'detect' | 'git' | 'finalize' | 'write' | 'agents';

export const STAGES: Array<{ id: StageId; label: string }> = [
  { id: 'scan', label: 'Scanning project structure' },
  { id: 'detect', label: 'Detecting stack, database, API & auth' },
  { id: 'git', label: 'Reading Git metadata' },
  { id: 'finalize', label: 'Redacting secrets & validating' },
  { id: 'write', label: 'Generating documentation' },
  { id: 'agents', label: 'Configuring AI agents' },
];

type State = 'pending' | 'running' | 'done' | 'skipped' | 'failed';
export interface StageResult {
  text: string;
  tone?: 'ok' | 'warn' | 'dim';
}

const STAGE_ALIASES: Record<string, StageId> = { analyze: 'scan' };
const FRAMES = unicode ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] : ['-', '\\', '|', '/'];
const BAR_STOPS = [PALETTE.green, PALETTE.cyan, PALETTE.blue, PALETTE.violet];

export class StageBoard {
  private state = new Map<StageId, State>(STAGES.map((s) => [s.id, 'pending']));
  private started = new Map<StageId, number>();
  private elapsed = new Map<StageId, number>();
  private results = new Map<StageId, StageResult>();
  private current: StageId | null = null;
  private frame = 0;
  private drawn = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly live = isTTY && !isJson() && !isQuiet();
  private readonly enabled = !isJson() && !isQuiet();
  private readonly restoreCursor = () => process.stdout.write('\x1b[?25h');

  start(): void {
    if (!this.live) return;
    process.stdout.write('\x1b[?25l');
    process.once('exit', this.restoreCursor);
    this.render();
    this.timer = setInterval(() => {
      this.frame++;
      this.render();
    }, 80);
    this.timer.unref();
  }

  /** Accepts raw pipeline stage names; unknown names are ignored. */
  enter(raw: string): void {
    const id = (STAGE_ALIASES[raw] ?? raw) as StageId;
    if (!this.state.has(id) || this.current === id) return;
    this.closeCurrent('done');
    this.current = id;
    this.state.set(id, 'running');
    this.started.set(id, performance.now());
  }

  finish(results: Partial<Record<StageId, StageResult>>): void {
    this.closeCurrent('done');
    for (const [id, st] of this.state) if (st === 'pending') this.state.set(id, 'skipped');
    for (const [id, r] of Object.entries(results)) this.results.set(id as StageId, r);
    this.stop();
  }

  fail(): void {
    this.closeCurrent('failed');
    this.stop();
  }

  private closeCurrent(to: State): void {
    if (!this.current) return;
    this.state.set(this.current, to);
    this.elapsed.set(this.current, performance.now() - this.started.get(this.current)!);
    this.current = null;
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.enabled) return;
    if (this.live) {
      this.render();
      this.restoreCursor();
      process.removeListener('exit', this.restoreCursor);
    } else for (const l of this.lines()) line(l);
  }

  private render(): void {
    const rows = this.lines();
    let s = this.drawn ? `\x1b[${this.drawn}F` : '';
    for (const r of rows) s += `\x1b[2K${r}\n`;
    process.stdout.write(s);
    this.drawn = rows.length;
  }

  lines(): string[] {
    const total = termWidth();
    const showBar = total >= 100;
    const barW = total >= 130 ? 26 : 18;
    return STAGES.map((s, i) => {
      const st = this.state.get(s.id)!;
      const icon =
        st === 'done' ? paint(PALETTE.green, sym.ok, true)
        : st === 'running' ? paint(PALETTE.cyan, FRAMES[this.frame % FRAMES.length]!)
        : st === 'failed' ? pc.red(sym.err)
        : pc.dim(st === 'skipped' ? '–' : sym.ring);
      const label = st === 'pending' || st === 'skipped' ? pc.dim(s.label) : s.label;
      const ms = this.elapsed.get(s.id) ?? (st === 'running' ? performance.now() - this.started.get(s.id)! : undefined);
      const time = st === 'skipped' ? pc.dim('skipped') : ms === undefined ? '' : pc.dim(ms < 1000 ? `${Math.max(1, Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`);
      const r = this.results.get(s.id);
      const result = r ? (r.tone === 'warn' ? paint(PALETTE.amber, `${sym.warn} ${r.text}`) : r.tone === 'dim' ? pc.dim(r.text) : `${paint(PALETTE.green, sym.ok)} ${r.text}`) : '';
      const bar = showBar ? `${this.bar(st, barW, i)}  ` : '';
      return truncate(`  ${icon}  ${padEnd(label, 40)}${bar}${padEnd(time, 8)}${result}`, total - 1);
    });
  }

  private bar(st: State, w: number, row: number): string {
    const fill = unicode ? '━' : '#';
    const track = unicode ? '─' : '-';
    if (st === 'done') return paint(mix(BAR_STOPS, row / (STAGES.length - 1)), fill.repeat(w));
    if (st === 'failed') return pc.red(fill.repeat(w));
    if (st !== 'running') return pc.dim(track.repeat(w));
    // Indeterminate sweep: a short segment bouncing along the track.
    const seg = 6;
    const span = w - seg;
    const t = this.frame % (span * 2);
    const pos = t <= span ? t : span * 2 - t;
    return pc.dim(track.repeat(pos)) + paint(PALETTE.cyan, fill.repeat(seg)) + pc.dim(track.repeat(w - pos - seg));
  }
}
