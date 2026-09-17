import { sha256 } from '../util/fs.js';

/**
 * Generated content lives inside managed blocks:
 *
 *   <!-- athena:generated:start id=overview hash=abc123def456 -->
 *   ...
 *   <!-- athena:generated:end id=overview -->
 *
 * Content outside blocks belongs to the developer and is never modified. The hash
 * records what Athena last wrote, so manual edits inside a block are detected and
 * preserved unless the caller forces regeneration.
 */

export interface Section {
  id: string;
  content: string;
}

export interface ParsedBlock {
  id: string;
  hash: string;
  content: string;
  start: number;
  end: number;
}

const START_RE = /<!-- athena:generated:start id=([a-z0-9-]+) hash=([a-f0-9]*) -->\n?/g;

export function blockHash(content: string): string {
  return sha256(content.trim()).slice(0, 12);
}

export function renderBlock(section: Section): string {
  const body = section.content.trim();
  return `<!-- athena:generated:start id=${section.id} hash=${blockHash(body)} -->\n${body}\n<!-- athena:generated:end id=${section.id} -->`;
}

export function parseBlocks(text: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  START_RE.lastIndex = 0;
  for (let m = START_RE.exec(text); m; m = START_RE.exec(text)) {
    const id = m[1]!;
    const endMarker = `<!-- athena:generated:end id=${id} -->`;
    const endIdx = text.indexOf(endMarker, m.index + m[0].length);
    if (endIdx === -1) continue; // malformed: treat as developer content
    blocks.push({ id, hash: m[2]!, content: text.slice(m.index + m[0].length, endIdx).trim(), start: m.index, end: endIdx + endMarker.length });
    START_RE.lastIndex = endIdx + endMarker.length;
  }
  return blocks;
}

export function isBlockModified(block: ParsedBlock): boolean {
  return blockHash(block.content) !== block.hash;
}

export interface MergeResult {
  text: string;
  changed: boolean;
  /** Blocks left untouched because the developer edited them. */
  preservedModified: string[];
  updated: string[];
  added: string[];
}

export interface MergeOptions {
  force?: boolean;
  /** Block ids Athena previously wrote; if one is missing now, the developer removed it — don't re-add. */
  previouslyKnown?: string[];
  /** Marker before which newly introduced sections are inserted. */
  insertBefore?: string;
}

export function mergeDocument(existing: string, sections: Section[], opts: MergeOptions = {}): MergeResult {
  const blocks = parseBlocks(existing);
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const result: MergeResult = { text: existing, changed: false, preservedModified: [], updated: [], added: [] };
  const replacements: Array<{ start: number; end: number; text: string }> = [];

  for (const s of sections) {
    const b = byId.get(s.id);
    if (!b) continue;
    if (isBlockModified(b) && !opts.force) {
      result.preservedModified.push(s.id);
      continue;
    }
    if (b.content === s.content.trim() && !isBlockModified(b)) continue;
    replacements.push({ start: b.start, end: b.end, text: renderBlock(s) });
    result.updated.push(s.id);
  }

  let text = existing;
  for (const r of replacements.sort((a, b) => b.start - a.start)) text = text.slice(0, r.start) + r.text + text.slice(r.end);

  const known = new Set(opts.previouslyKnown ?? []);
  const toAdd = sections.filter((s) => !byId.has(s.id) && !known.has(s.id));
  if (toAdd.length) {
    const insert = toAdd.map((s) => renderBlock(s)).join('\n\n');
    const marker = opts.insertBefore ? text.indexOf(opts.insertBefore) : -1;
    text = marker >= 0 ? `${text.slice(0, marker)}${insert}\n\n${text.slice(marker)}` : `${text.replace(/\s*$/, '')}\n\n${insert}\n`;
    result.added.push(...toAdd.map((s) => s.id));
  }

  result.text = text;
  result.changed = text !== existing;
  return result;
}

/**
 * Markers for Athena-managed regions inside files owned by other tools
 * (e.g. agent instruction files). Separate from generated blocks: these are always
 * fully owned by Athena.
 */
export const INTEGRATION_START = '<!-- athena:start -->';
export const INTEGRATION_END = '<!-- athena:end -->';

export function upsertIntegrationBlock(existing: string | null, body: string): string {
  const block = `${INTEGRATION_START}\n${body.trim()}\n${INTEGRATION_END}`;
  if (!existing) return `${block}\n`;
  const s = existing.indexOf(INTEGRATION_START);
  const e = existing.indexOf(INTEGRATION_END);
  if (s !== -1 && e > s) return existing.slice(0, s) + block + existing.slice(e + INTEGRATION_END.length);
  return `${existing.replace(/\s*$/, '')}\n\n${block}\n`;
}

export function removeIntegrationBlock(existing: string): string {
  const s = existing.indexOf(INTEGRATION_START);
  const e = existing.indexOf(INTEGRATION_END);
  if (s === -1 || e < s) return existing;
  const before = existing.slice(0, s).replace(/\s*$/, '');
  const after = existing.slice(e + INTEGRATION_END.length).replace(/^\s*/, '');
  const joined = [before, after.replace(/\s*$/, '')].filter(Boolean).join('\n\n');
  return joined ? `${joined}\n` : '';
}
