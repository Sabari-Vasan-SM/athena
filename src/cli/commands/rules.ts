import path from 'node:path';
import { addRule, listRules, parseRules, removeRule, serializeRules, updateRule, type RulesDocument } from '../../core/knowledge/rules.js';
import { athenaDir } from '../../core/state/state.js';
import { readTextIfExists, writeFileAtomic } from '../../core/util/fs.js';
import { requireProjectRoot, type GlobalOptions } from '../context.js';
import { AthenaError } from '../errors.js';
import * as ui from '../ui/term.js';

async function load(root: string): Promise<{ file: string; doc: RulesDocument }> {
  const file = path.join(athenaDir(root), 'rules.md');
  const text = await readTextIfExists(file);
  if (text === null) throw new AthenaError('.athena/rules.md not found.', 'Run `athena analyze` to recreate it.');
  return { file, doc: parseRules(text) };
}

function parseIndex(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new AthenaError(`Invalid rule number: ${raw}`, 'Use `athena rules list` to see rule numbers.');
  return n;
}

async function mutate(opts: GlobalOptions, fn: (doc: RulesDocument) => RulesDocument, message: string): Promise<void> {
  const root = await requireProjectRoot(opts);
  const { file, doc } = await load(root);
  let next: RulesDocument;
  try {
    next = fn(doc);
  } catch (err) {
    throw new AthenaError((err as Error).message, 'Use `athena rules list` to see rule numbers.');
  }
  await writeFileAtomic(file, serializeRules(next));
  if (ui.isJson()) ui.json({ ok: true, rules: listRules(next) });
  else ui.ok(message);
}

export async function rulesListCommand(opts: GlobalOptions & { all?: boolean }): Promise<void> {
  const root = await requireProjectRoot(opts);
  const { doc } = await load(root);
  const rules = listRules(doc);
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
