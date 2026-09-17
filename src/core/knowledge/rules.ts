/**
 * Round-trip parser for `.athena/rules.md`.
 *
 * The file is plain Markdown and the single source of truth. A rule is a top-level
 * bullet ("- ...") under a "## Section" heading. A disabled rule is written as
 * "- [disabled] ...". Every other line (prose, nested bullets, code, comments) is
 * preserved exactly.
 */

export interface RuleLine {
  kind: 'rule';
  section: string;
  text: string;
  enabled: boolean;
  bullet: '-' | '*' | '+';
}
export interface OtherLine {
  kind: 'other';
  raw: string;
}
export type Line = RuleLine | OtherLine;

export interface RulesDocument {
  lines: Line[];
  eol: '\n' | '\r\n';
}

export interface Rule {
  /** 1-based position among rules in file order — stable for a given file version. */
  index: number;
  section: string;
  text: string;
  enabled: boolean;
}

const RULE_RE = /^([-*+])\s+(?:\[(disabled)\]\s+)?(.+?)\s*$/;
const SECTION_RE = /^##\s+(.+?)\s*#*\s*$/;
const DISABLED_PREFIX = '[disabled]';

export function parseRules(text: string): RulesDocument {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines: Line[] = [];
  let section = 'General';
  let inFence = false;
  const raw = text.split(/\r?\n/);
  if (raw.length && raw[raw.length - 1] === '') raw.pop();
  for (const l of raw) {
    if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
    const sm = !inFence ? SECTION_RE.exec(l) : null;
    if (sm) section = sm[1]!;
    const rm = !inFence ? RULE_RE.exec(l) : null;
    if (rm && !/^\[[ xX]\]/.test(rm[3]!)) {
      lines.push({ kind: 'rule', section, text: rm[3]!, enabled: rm[2] !== 'disabled', bullet: rm[1] as RuleLine['bullet'] });
    } else {
      lines.push({ kind: 'other', raw: l });
    }
  }
  return { lines, eol };
}

export function serializeRules(doc: RulesDocument): string {
  return (
    doc.lines
      .map((l) => (l.kind === 'other' ? l.raw : `${l.bullet} ${l.enabled ? '' : `${DISABLED_PREFIX} `}${l.text}`))
      .join(doc.eol) + doc.eol
  );
}

export function listRules(doc: RulesDocument): Rule[] {
  const out: Rule[] = [];
  for (const l of doc.lines) if (l.kind === 'rule') out.push({ index: out.length + 1, section: l.section, text: l.text, enabled: l.enabled });
  return out;
}

function ruleAt(doc: RulesDocument, index: number): RuleLine {
  let n = 0;
  for (const l of doc.lines) if (l.kind === 'rule' && ++n === index) return l;
  throw new RangeError(`No rule #${index} (there are ${n} rules)`);
}

export function validateRuleText(text: string): string {
  const t = text.replace(/[\r\n]+/g, ' ').trim();
  if (!t) throw new Error('Rule text cannot be empty');
  if (t.length > 1000) throw new Error('Rule text is too long (max 1000 characters)');
  return t;
}

export function addRule(doc: RulesDocument, section: string, text: string): RulesDocument {
  const clean = validateRuleText(text);
  const sec = section.replace(/[\r\n#]+/g, ' ').trim() || 'General';
  const lines = [...doc.lines];
  let lastRuleIdx = -1;
  let headingIdx = -1;
  lines.forEach((l, i) => {
    if (l.kind === 'other' && SECTION_RE.exec(l.raw)?.[1]?.toLowerCase() === sec.toLowerCase()) headingIdx = i;
    if (l.kind === 'rule' && l.section.toLowerCase() === sec.toLowerCase()) lastRuleIdx = i;
  });
  const existingSection = headingIdx >= 0 ? (SECTION_RE.exec((lines[headingIdx] as OtherLine).raw)?.[1] ?? sec) : sec;
  const rule: RuleLine = { kind: 'rule', section: existingSection, text: clean, enabled: true, bullet: '-' };
  if (lastRuleIdx >= 0) lines.splice(lastRuleIdx + 1, 0, rule);
  else if (headingIdx >= 0) {
    let at = headingIdx + 1;
    while (at < lines.length && lines[at]!.kind === 'other' && (lines[at] as OtherLine).raw.trim() === '') at++;
    lines.splice(at, 0, rule);
  } else {
    while (lines.length && lines[lines.length - 1]!.kind === 'other' && (lines[lines.length - 1] as OtherLine).raw.trim() === '') lines.pop();
    lines.push({ kind: 'other', raw: '' }, { kind: 'other', raw: `## ${sec}` }, { kind: 'other', raw: '' }, rule);
  }
  return { ...doc, lines };
}

export function updateRule(doc: RulesDocument, index: number, patch: { text?: string; enabled?: boolean }): RulesDocument {
  const target = ruleAt(doc, index);
  return {
    ...doc,
    lines: doc.lines.map((l) => (l === target ? { ...target, ...(patch.text !== undefined ? { text: validateRuleText(patch.text) } : {}), ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}) } : l)),
  };
}

export function removeRule(doc: RulesDocument, index: number): RulesDocument {
  const target = ruleAt(doc, index);
  return { ...doc, lines: doc.lines.filter((l) => l !== target) };
}
