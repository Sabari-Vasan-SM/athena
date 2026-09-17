import { promises as fs } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { athenaDir } from '../../core/state/state.js';
import { ADAPTERS } from '../../agents/registry.js';
import { requireProjectRoot, type GlobalOptions } from '../context.js';
import { AthenaError } from '../../services/errors.js';
import * as ui from '../ui/term.js';

export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} ${ui.dim('[y/N]')} `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function cleanCommand(opts: GlobalOptions & { yes?: boolean; keepAgents?: boolean }): Promise<void> {
  const root = await requireProjectRoot(opts);
  if (!opts.yes) {
    if (!process.stdin.isTTY) throw new AthenaError('Refusing to delete .athena/ without confirmation.', 'Re-run with --yes in non-interactive environments.');
    ui.line(`This removes ${ui.c.bold('.athena/')} (including rules.md and your Developer Notes)${opts.keepAgents ? '' : ' and Athena blocks/files in agent configurations'}.`);
    ui.line(ui.dim('If .athena/ is committed to Git you can restore it from history.'));
    if (!(await confirm('Continue?'))) {
      ui.line('Cancelled.');
      return;
    }
  }
  const touched: string[] = [];
  if (!opts.keepAgents) for (const a of ADAPTERS) touched.push(...(await a.remove(root)));
  await fs.rm(athenaDir(root), { recursive: true, force: true });
  if (ui.isJson()) ui.json({ ok: true, removed: ['.athena/', ...touched] });
  else {
    ui.ok('Removed .athena/');
    for (const t of touched) ui.ok(`Removed Athena integration from ${t}`);
  }
}
