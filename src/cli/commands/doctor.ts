import { runDoctor } from '../../services/doctor.js';
import { resolveCwd, type GlobalOptions } from '../context.js';
import * as ui from '../ui/term.js';

export async function doctorCommand(opts: GlobalOptions): Promise<number> {
  const cwd = await resolveCwd(opts);
  const { checks, root } = await runDoctor(cwd);
  if (root) {
    const m = await (await import('./memory.js')).memorySummary(root);
    if (m?.total) {
      const pending = [m.unreviewed ? `${m.unreviewed} unreviewed` : '', m.stale ? `${m.stale} stale` : ''].filter(Boolean);
      checks.push({ area: 'Memory', level: 'info', message: `${m.total} project memory ${m.total === 1 ? 'entry' : 'entries'}${pending.length ? ` (${pending.join(', ')})` : ''}`, hint: pending.length ? 'Review with `athena memory review` and `athena memory stale`.' : undefined });
    }
  }
  const errors = checks.filter((c) => c.level === 'error').length;
  if (ui.isJson()) {
    ui.json({ ok: errors === 0, checks });
    return errors ? 1 : 0;
  }
  ui.heading('Athena Doctor');
  ui.line();
  for (const c of checks) {
    const icon = c.level === 'ok' ? ui.c.green(ui.sym.ok) : c.level === 'warn' ? ui.c.yellow(ui.sym.warn) : c.level === 'error' ? ui.c.red(ui.sym.err) : ui.c.dim(ui.sym.ring);
    ui.line(`${icon} ${ui.c.bold(c.area)} ${ui.dim('—')} ${c.message}`);
    if (c.hint) ui.line(`  ${ui.dim(c.hint)}`);
  }
  ui.line();
  const warns = checks.filter((c) => c.level === 'warn').length;
  if (errors) ui.line(ui.c.red(`${errors} problem${errors === 1 ? '' : 's'} found.`));
  else ui.line(ui.c.green(`Athena is ready.${warns ? ui.dim(` (${warns} warning${warns === 1 ? '' : 's'})`) : ''}`));
  return errors ? 1 : 0;
}
