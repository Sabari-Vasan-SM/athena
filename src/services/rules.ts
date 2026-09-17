import path from 'node:path';
import { addRule, listRules, parseRules, removeRule, serializeRules, updateRule, type Rule, type RulesDocument } from '../core/knowledge/rules.js';
import { scanText } from '../core/security/secrets.js';
import { athenaDir } from '../core/state/state.js';
import { readTextIfExists, writeFileAtomic } from '../core/util/fs.js';
import { AthenaError, conflict, notFound } from './errors.js';
import { contentHash } from './knowledge.js';

export interface RulesView {
  hash: string;
  rules: Rule[];
  sections: string[];
}

async function load(root: string): Promise<{ file: string; text: string; doc: RulesDocument }> {
  const file = path.join(athenaDir(root), 'rules.md');
  const text = await readTextIfExists(file);
  if (text === null) throw notFound('.athena/rules.md not found. Run `athena analyze` to recreate it.');
  return { file, text, doc: parseRules(text) };
}

function view(text: string, doc: RulesDocument): RulesView {
  const rules = listRules(doc);
  const sections = [...new Set([...doc.lines.flatMap((l) => (l.kind === 'other' ? (/^##\s+(.+?)\s*#*\s*$/.exec(l.raw)?.[1] ?? []) : [])), ...rules.map((r) => r.section)])];
  return { hash: contentHash(text), rules, sections };
}

export async function getRules(root: string): Promise<RulesView> {
  const { text, doc } = await load(root);
  return view(text, doc);
}

/**
 * Apply a rule mutation. Rules are addressed by index, so every mutation requires
 * the hash of the file the client last saw; a mismatch means indexes may have shifted.
 */
export async function mutateRules(root: string, baseHash: string | undefined, fn: (doc: RulesDocument) => RulesDocument): Promise<RulesView> {
  const { file, text, doc } = await load(root);
  if (baseHash !== undefined && baseHash !== contentHash(text)) {
    throw conflict('rules.md changed since it was loaded.', 'Reload the rules and try again.', { currentHash: contentHash(text) });
  }
  let next: RulesDocument;
  try {
    next = fn(doc);
  } catch (err) {
    throw new AthenaError((err as Error).message);
  }
  const out = serializeRules(next);
  const secrets = scanText(out).filter((s) => !scanText(text).some((o) => o.fingerprint === s.fingerprint));
  if (secrets.length) throw new AthenaError('Refusing to save a rule that appears to contain a secret.', 'Rules must never contain credentials.', 1, 'unprocessable');
  await writeFileAtomic(file, out);
  return view(out, next);
}

export const rulesAdd = (root: string, baseHash: string | undefined, section: string, text: string) => mutateRules(root, baseHash, (d) => addRule(d, section, text));
export const rulesUpdate = (root: string, baseHash: string | undefined, index: number, patch: { text?: string; enabled?: boolean }) => mutateRules(root, baseHash, (d) => updateRule(d, index, patch));
export const rulesRemove = (root: string, baseHash: string | undefined, index: number) => mutateRules(root, baseHash, (d) => removeRule(d, index));
