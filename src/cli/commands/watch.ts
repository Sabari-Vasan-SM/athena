import { watchProject, type WatchEvent } from '../../services/watch.js';
import { AthenaError } from '../../services/errors.js';
import { requireProjectRoot, type GlobalOptions } from '../context.js';
import * as ui from '../ui/term.js';

export interface WatchOptions extends GlobalOptions {
  autoApply?: boolean;
  debounce?: string;
  signal: AbortSignal;
}

const time = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export async function watchCommand(opts: WatchOptions): Promise<void> {
  const root = await requireProjectRoot(opts);
  let debounceMs: number | undefined;
  if (opts.debounce !== undefined) {
    debounceMs = Number(opts.debounce);
    if (!Number.isInteger(debounceMs) || debounceMs < 100 || debounceMs > 60_000) throw new AthenaError('--debounce must be between 100 and 60000 ms');
  }
  const burst = new Set<string>();

  const log = (line: string) => {
    if (ui.isJson()) return;
    ui.line(`${ui.dim(time())}  ${line}`);
  };

  const onEvent = (e: WatchEvent) => {
    if (ui.isJson()) {
      const { plan, error, ...rest } = e;
      if (e.type !== 'changes') process.stdout.write(`${JSON.stringify({ ...rest, ts: new Date().toISOString(), ...(plan ? { planId: plan.id, upToDate: plan.upToDate, documents: plan.documents.map((d) => ({ file: d.file, reasons: d.reasons })) } : {}), ...(error ? { error: error.message } : {}) })}\n`);
      return;
    }
    switch (e.type) {
      case 'changes':
        for (const p of e.paths ?? []) burst.add(p);
        break;
      case 'git-head':
        log(`${ui.c.cyan('git')} HEAD moved ${ui.dim(`${e.head?.from?.slice(0, 8) ?? '?'} → ${e.head?.to?.slice(0, 8) ?? '?'}`)}`);
        break;
      case 'planning': {
        const n = burst.size;
        if (n) log(`${n} file${n === 1 ? '' : 's'} changed ${ui.dim(`(${[...burst].slice(0, 3).join(', ')}${n > 3 ? ', …' : ''})`)} — checking knowledge…`);
        burst.clear();
        break;
      }
      case 'refreshed':
        log(`${ui.c.green(ui.sym.ok)} Knowledge up to date ${ui.dim('(index refreshed)')}`);
        break;
      case 'plan': {
        const plan = e.plan!;
        if (plan.upToDate) {
          log(`${ui.c.green(ui.sym.ok)} Knowledge up to date`);
          break;
        }
        if (plan.ignored) {
          log(ui.dim(`Proposal unchanged since you ignored it (${plan.documents.map((d) => d.file).join(', ')})`));
          break;
        }
        log(`${ui.c.yellow(ui.sym.dot)} Update proposed for ${ui.c.bold(plan.documents.map((d) => d.file).join(', '))}`);
        for (const d of plan.documents) log(`   ${ui.dim(`${d.file}: ${d.reasons[0] ?? ''}`)}`);
        log(ui.dim('   Review and apply with `athena sync` (or in the web UI).'));
        break;
      }
      case 'applied':
        log(`${ui.c.green(ui.sym.ok)} Applied ${e.result?.applied.join(', ')} ${ui.dim('(auto-apply)')}`);
        for (const p of e.result?.preserved ?? []) log(`   ${ui.c.yellow(ui.sym.warn)} ${p.file}: kept your edits in ${p.sections.join(', ')}`);
        break;
      case 'error':
        log(`${ui.c.red(ui.sym.err)} ${e.error?.message ?? 'Watcher error'}`);
        break;
      default:
        break;
    }
  };

  const watcher = await watchProject(root, { autoApply: opts.autoApply, debounceMs, onEvent, signal: opts.signal });
  ui.setInterruptMessage('Stopped watching.');
  if (!ui.isJson()) {
    ui.line(`${ui.c.bold('Athena is watching')} ${ui.dim(root)}`);
    ui.line(opts.autoApply ? ui.c.yellow('Auto-apply is ON: knowledge updates are written automatically (your edited sections are still preserved).') : ui.dim('Proposals only — no knowledge document is changed without your review. Press Ctrl+C to stop.'));
    ui.line();
  }
  // Check once at startup so changes made while Athena wasn't running are caught.
  await watcher.planNow();

  await new Promise<void>((resolve) => {
    if (opts.signal.aborted) resolve();
    opts.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  await watcher.close();
}
