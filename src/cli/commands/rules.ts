import { addRule, removeRule, updateRule, type RulesDocument } from '../../core/knowledge/rules.js';
import { getRules, mutateRules } from '../../services/rules.js';
import { requireProjectRoot, type GlobalOptions } from '../context.js';
import { AthenaError } from '../../services/errors.js';
import * as ui from '../ui/term.js';

function parseIndex(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new AthenaError(`Invalid rule number: ${raw}`, 'Use `athena rules list` to see rule numbers.');
  return n;
}

async function mutate(opts: GlobalOptions, fn: (doc: RulesDocument) => RulesDocument, message: string): Promise<void> {
  const root = await requireProjectRoot(opts);
  const view = await mutateRules(root, undefined, fn);
  if (ui.isJson()) ui.json({ ok: true, rules: view.rules });
  else ui.ok(message);
}

export async function rulesListCommand(opts: GlobalOptions): Promise<void> {
  const root = await requireProjectRoot(opts);
  const { rules } = await getRules(root);
  if (ui.isJson()) {
    ui.json(rules);
    return;
  }
  if (!rules.length) {
    ui.line(ui.dim('No rules defined. Add one with `athena rules add "<rule>" --section <name>`.'));
    return;
  }
  let section = '';
  for (const r of rules) {
    if (r.section !== section) {
      section = r.section;
      ui.line();
      ui.heading(section);
    }
    const num = ui.dim(`${String(r.index).padStart(3)}.`);
    ui.line(r.enabled ? `${num} ${r.text}` : `${num} ${ui.dim(`[disabled] ${r.text}`)}`);
  }
  ui.line();
  ui.line(ui.dim(`${rules.filter((r) => r.enabled).length} enabled · ${rules.filter((r) => !r.enabled).length} disabled · source: .athena/rules.md`));
}

export const rulesAddCommand = (text: string, opts: GlobalOptions & { section?: string }) => mutate(opts, (d) => addRule(d, opts.section ?? 'General', text), `Rule added to "${opts.section ?? 'General'}".`);
export const rulesEnableCommand = (n: string, opts: GlobalOptions) => mutate(opts, (d) => updateRule(d, parseIndex(n), { enabled: true }), `Rule ${n} enabled.`);
export const rulesDisableCommand = (n: string, opts: GlobalOptions) => mutate(opts, (d) => updateRule(d, parseIndex(n), { enabled: false }), `Rule ${n} disabled.`);
export const rulesEditCommand = (n: string, text: string, opts: GlobalOptions) => mutate(opts, (d) => updateRule(d, parseIndex(n), { text }), `Rule ${n} updated.`);
export const rulesRemoveCommand = (n: string, opts: GlobalOptions) => mutate(opts, (d) => removeRule(d, parseIndex(n)), `Rule ${n} removed.`);
