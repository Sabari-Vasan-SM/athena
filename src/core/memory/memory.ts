import { scanText } from '../security/secrets.js';
import { tokenize } from '../context/context-engine.js';

/**
 * Project memory: durable learnings (decisions, gotchas, bug causes, conventions…)
 * that agents and developers record so later sessions don't rediscover them.
 *
 * Stored as plain Markdown under `.athena/memory/<kind>s.md` and committed, so the team
 * shares it and reviews changes in pull requests. Each entry is wrapped in
 * `<!-- athena:memory … -->` / `<!-- /athena:memory -->` markers; everything outside
 * the markers is the developer's and is preserved as written.
 *
 * Honesty: an entry written by an agent is `unreviewed` (INFERRED) until a developer
 * confirms it (FACT). An entry is `stale` when a file it was anchored to has changed
 * since — that is computed, never stored.
 */

export const MEMORY_KINDS = ['decision', 'gotcha', 'bug', 'convention', 'todo', 'fact'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export const MEMORY_STATUSES = ['unreviewed', 'confirmed', 'superseded'] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const MEMORY_FILES: Record<MemoryKind, string> = {
  decision: 'decisions.md',
  gotcha: 'gotchas.md',
  bug: 'bugs.md',
  convention: 'conventions.md',
  todo: 'todos.md',
  fact: 'facts.md',
};

const TITLES: Record<MemoryKind, string> = {
  decision: 'Decisions',
  gotcha: 'Gotchas',
  bug: 'Bugs and their causes',
  convention: 'Conventions',
  todo: 'To-dos',
  fact: 'Facts',
};

export const LIMITS = {
  title: 200,
  details: 4000,
  evidence: 500,
  files: 20,
  tags: 10,
  entries: 500,
  totalBytes: 1_000_000,
};

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  status: MemoryStatus;
  /** `developer`, or `agent:<id>` (e.g. `agent:claude-code`). */
  source: string;
  title: string;
  details: string;
  files: string[];
  tags: string[];
  evidence?: string;
  createdAt: string;
  confirmedAt?: string;
  supersedes?: string;
  supersededBy?: string;
  /** Content hash (16 hex) of each linked file when the entry was recorded or confirmed. */
  anchors: Record<string, string>;
}

/** Input when recording a new entry. */
export interface MemoryInput {
  kind: MemoryKind;
  title: string;
  details?: string;
  files?: string[];
  tags?: string[];
  evidence?: string;
  supersedes?: string;
}

export class MemoryError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

// ── Format ──────────────────────────────────────────────────────────────────

const START = '<!-- athena:memory ';
const END = '<!-- /athena:memory -->';
const META_RE = /^<!-- athena:memory (.*?) -->\s*$/;

type Block = { kind: 'entry'; entry: MemoryEntry } | { kind: 'text'; raw: string };
export interface MemoryFile {
  kind: MemoryKind;
  blocks: Block[];
}

function parseMeta(line: string): Record<string, string> | null {
  const m = META_RE.exec(line);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const pair of m[1]!.trim().split(/\s+/)) {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i)] = decodeURIComponent(pair.slice(i + 1));
  }
  return out;
}

const enc = (v: string) => encodeURIComponent(v);

function trailer(lines: string[], label: string): string | undefined {
  const re = new RegExp(`^-\\s+${label}:\\s*(.*)$`, 'i');
  for (const l of lines) {
    const m = re.exec(l.trim());
    if (m) return m[1]!.trim();
  }
  return undefined;
}

const splitList = (v: string | undefined, strip: RegExp) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim().replace(strip, '').trim())
    .filter(Boolean);

function parseEntry(kind: MemoryKind, meta: Record<string, string>, body: string[]): MemoryEntry | null {
  const id = meta.id;
  if (!id || !/^m-[a-z0-9]{4,16}$/.test(id)) return null;
  const titleIdx = body.findIndex((l) => /^###\s+/.test(l));
  if (titleIdx < 0) return null;
  const title = body[titleIdx]!.replace(/^###\s+/, '').trim();
  const rest = body.slice(titleIdx + 1);
  const isTrailer = (l: string) => /^-\s+(Files|Tags|Evidence):/i.test(l.trim());
  const firstTrailer = rest.findIndex(isTrailer);
  const detailLines = firstTrailer < 0 ? rest : rest.slice(0, firstTrailer);
  const trailerLines = firstTrailer < 0 ? [] : rest.slice(firstTrailer);
  const anchors: Record<string, string> = {};
  for (const pair of (meta.anchors ?? '').split(',').filter(Boolean)) {
    const at = pair.lastIndexOf('@');
    if (at > 0) anchors[pair.slice(0, at)] = pair.slice(at + 1);
  }
  const status = (MEMORY_STATUSES as readonly string[]).includes(meta.status ?? '') ? (meta.status as MemoryStatus) : 'unreviewed';
  return {
    id,
    kind,
    status,
    source: meta.source ?? 'unknown',
    title,
    details: detailLines.join('\n').trim(),
    files: splitList(trailer(trailerLines, 'Files'), /^`|`$/g),
    tags: splitList(trailer(trailerLines, 'Tags'), /^#/),
    evidence: trailer(trailerLines, 'Evidence') || undefined,
    createdAt: meta.created ?? '',
    confirmedAt: meta.confirmed,
    supersedes: meta.supersedes,
    supersededBy: meta['superseded-by'],
    anchors,
  };
}

export function parseMemoryFile(kind: MemoryKind, text: string): MemoryFile {
  const blocks: Block[] = [];
  const lines = text.split(/\r?\n/);
  let buf: string[] = [];
  const flushText = () => {
    if (buf.length) blocks.push({ kind: 'text', raw: buf.join('\n') });
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const meta = lines[i]!.startsWith(START) ? parseMeta(lines[i]!) : null;
    if (!meta) {
      buf.push(lines[i]!);
      continue;
    }
    const end = lines.indexOf(END, i + 1);
    if (end < 0) {
      // Unterminated block: keep it as developer text rather than guessing its extent.
      buf.push(lines[i]!);
      continue;
    }
    const entry = parseEntry(kind, meta, lines.slice(i + 1, end));
    if (!entry) {
      buf.push(...lines.slice(i, end + 1));
      i = end;
      continue;
    }
    flushText();
    blocks.push({ kind: 'entry', entry });
    i = end;
  }
  flushText();
  return { kind, blocks };
}

function renderEntry(e: MemoryEntry): string {
  const meta: string[] = [`id=${e.id}`, `status=${e.status}`, `source=${enc(e.source)}`, `created=${enc(e.createdAt)}`];
  if (e.confirmedAt) meta.push(`confirmed=${enc(e.confirmedAt)}`);
  if (e.supersedes) meta.push(`supersedes=${e.supersedes}`);
  if (e.supersededBy) meta.push(`superseded-by=${e.supersededBy}`);
  const anchors = Object.entries(e.anchors).map(([f, h]) => `${f}@${h}`);
  if (anchors.length) meta.push(`anchors=${anchors.map(enc).join(',')}`);
  const out = [`${START}${meta.join(' ')} -->`, `### ${e.title}`];
  if (e.details) out.push('', e.details);
  const trailers: string[] = [];
  if (e.files.length) trailers.push(`- Files: ${e.files.map((f) => `\`${f}\``).join(', ')}`);
  if (e.tags.length) trailers.push(`- Tags: ${e.tags.join(', ')}`);
  if (e.evidence) trailers.push(`- Evidence: ${e.evidence}`);
  if (trailers.length) out.push('', ...trailers);
  out.push(END);
  return out.join('\n');
}

export function newMemoryFileText(kind: MemoryKind): string {
  return [
    `# ${TITLES[kind]}`,
    '',
    'Project memory, maintained with Athena (`athena memory`, or the `remember`/`recall` MCP tools).',
    'Entries marked `unreviewed` were written by an AI agent and are INFERRED until a developer confirms them',
    '(`athena memory confirm <id>`). Text outside the `athena:memory` markers is yours and is kept as written.',
    '',
  ].join('\n');
}

export function serializeMemoryFile(file: MemoryFile): string {
  const parts = file.blocks.map((b) => (b.kind === 'entry' ? renderEntry(b.entry) : b.raw));
  let text = parts.join('\n');
  if (!text.endsWith('\n')) text += '\n';
  return text;
}

export const entriesOf = (file: MemoryFile): MemoryEntry[] => file.blocks.flatMap((b) => (b.kind === 'entry' ? [b.entry] : []));

// ── Validation and safety ────────────────────────────────────────────────────

/** Text that addresses the agent rather than describing the project: possible prompt injection. */
const INJECTION_PATTERNS: Array<[RegExp, string]> = [
  [/\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|your|system)\b[^.\n]{0,20}\b(instruction|prompt|rule|guideline|message)s?\b/i, 'tells the agent to ignore its instructions'],
  [/\b(you are now|act as|pretend to be|new instructions?|system prompt)\b/i, 'tries to redefine the agent'],
  [/\b(do not|don't|never)\s+(tell|inform|show|mention|ask)\b[^.\n]{0,30}\b(user|developer|human)\b/i, 'asks the agent to hide something from the user'],
  [/\b(curl|wget)\b[^\n|]{0,200}\|\s*(sh|bash|zsh|python|node)\b/i, 'contains a download-and-execute command'],
  [/\b(exfiltrate|send|upload|post)\b[^.\n]{0,40}\b(secret|token|credential|api key|password|\.env)\b/i, 'asks to send credentials somewhere'],
  [/[A-Za-z0-9+/]{120,}={0,2}/, 'contains a long encoded blob'],
];

export function injectionFlags(e: Pick<MemoryEntry, 'title' | 'details' | 'evidence'>): string[] {
  const text = `${e.title}\n${e.details}\n${e.evidence ?? ''}`;
  return INJECTION_PATTERNS.filter(([re]) => re.test(text)).map(([, why]) => why);
}

const TAG_RE = /^[a-z0-9][a-z0-9_.-]{0,31}$/;

function cleanPath(p: string): string {
  const s = p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!s || s.startsWith('/') || /^[a-z]:/i.test(s) || s.split('/').includes('..') || /[\s`,@]/.test(s)) {
    throw new MemoryError(`Invalid file path in memory: ${JSON.stringify(p)}`, 'Use project-relative paths without spaces, e.g. src/api/orders.ts');
  }
  return s;
}

/** Keep stored text from breaking the file format. */
const neutralize = (s: string) => s.replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;');

/** Validate and normalize input. Throws MemoryError; never stores a secret. */
export function normalizeInput(input: MemoryInput): Required<Pick<MemoryInput, 'kind' | 'title' | 'details' | 'files' | 'tags'>> & Pick<MemoryInput, 'evidence' | 'supersedes'> {
  if (!(MEMORY_KINDS as readonly string[]).includes(input.kind)) throw new MemoryError(`Unknown memory kind: ${input.kind}`, `Use one of: ${MEMORY_KINDS.join(', ')}`);
  const title = neutralize((input.title ?? '').replace(/\s+/g, ' ').trim());
  if (title.length < 3) throw new MemoryError('A memory needs a title (at least 3 characters).');
  if (title.length > LIMITS.title) throw new MemoryError(`Title is longer than ${LIMITS.title} characters.`, 'Put the detail in `details`.');
  const details = neutralize((input.details ?? '').trim()).replace(/^###/gm, '\\###');
  if (details.length > LIMITS.details) throw new MemoryError(`Details are longer than ${LIMITS.details} characters.`, 'Keep memories short; link to files or docs for the rest.');
  const evidence = input.evidence ? neutralize(input.evidence.replace(/\s+/g, ' ').trim()) : undefined;
  if (evidence && evidence.length > LIMITS.evidence) throw new MemoryError(`Evidence is longer than ${LIMITS.evidence} characters.`);
  const files = [...new Set((input.files ?? []).map(cleanPath))];
  if (files.length > LIMITS.files) throw new MemoryError(`At most ${LIMITS.files} files per memory.`);
  const tags = [...new Set((input.tags ?? []).map((t) => t.trim().toLowerCase().replace(/^#/, '')).filter(Boolean))];
  for (const t of tags) if (!TAG_RE.test(t)) throw new MemoryError(`Invalid tag: ${JSON.stringify(t)}`, 'Tags are short lowercase words: letters, digits, - _ .');
  if (tags.length > LIMITS.tags) throw new MemoryError(`At most ${LIMITS.tags} tags per memory.`);
  if (input.supersedes && !/^m-[a-z0-9]{4,16}$/.test(input.supersedes)) throw new MemoryError(`Invalid memory id: ${input.supersedes}`);

  const secrets = scanText(`${title}\n${details}\n${evidence ?? ''}`);
  if (secrets.length) {
    throw new MemoryError(`Refusing to store a memory that contains a possible secret (${[...new Set(secrets.map((s) => s.type))].join(', ')}).`, 'Describe where the value lives (e.g. "set via STRIPE_KEY env var") instead of the value itself.');
  }
  return { kind: input.kind, title, details, files, tags, evidence, supersedes: input.supersedes };
}

// ── Recall ───────────────────────────────────────────────────────────────────

export interface MemoryView extends MemoryEntry {
  /** INFERRED until a developer confirms; superseded entries are history. */
  label: 'FACT' | 'INFERRED';
  stale: boolean;
  /** Linked files that changed (or disappeared) since the entry was anchored. */
  changedFiles: string[];
  /** Heuristic prompt-injection warnings; such entries are never recalled automatically. */
  flags: string[];
}

export interface RecallQuery {
  task?: string;
  files?: string[];
  tags?: string[];
  limit?: number;
  /** Include flagged (possible prompt-injection) entries. Default false. */
  includeFlagged?: boolean;
}

export interface RecallHit {
  entry: MemoryView;
  score: number;
  why: string[];
}

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** Deterministic ranking: linked files first, then tags, then shared words; confirmed beats unreviewed. */
export function recall(entries: MemoryView[], q: RecallQuery): RecallHit[] {
  const files = new Set((q.files ?? []).map((f) => f.replace(/\\/g, '/').replace(/^\.\//, '')));
  const taskWords = new Set(tokenize(q.task ?? ''));
  for (const w of taskWords) if (/[./]/.test(w)) files.add(w.replace(/^\.\//, ''));
  const tags = new Set((q.tags ?? []).map((t) => t.toLowerCase()));
  const dirs = new Set([...files].map(dirOf).filter(Boolean));

  const hits: RecallHit[] = [];
  for (const e of entries) {
    if (e.status === 'superseded') continue;
    if (e.flags.length && !q.includeFlagged) continue;
    let score = 0;
    const why: string[] = [];
    const exact = e.files.filter((f) => files.has(f) || [...files].some((x) => x.endsWith(`/${f}`) || f.endsWith(`/${x}`)));
    if (exact.length) {
      score += 10 * exact.length;
      why.push(`linked to ${exact.slice(0, 3).join(', ')}`);
    } else {
      const near = e.files.filter((f) => dirs.has(dirOf(f)));
      if (near.length) {
        score += 3;
        why.push(`same folder as ${near[0]}`);
      }
    }
    const tagHits = e.tags.filter((t) => tags.has(t) || taskWords.has(t));
    if (tagHits.length) {
      score += 4 * tagHits.length;
      why.push(`tag ${tagHits.join(', ')}`);
    }
    const words = new Set(tokenize(`${e.title} ${e.details}`));
    const shared = [...taskWords].filter((w) => words.has(w));
    if (shared.length) {
      score += Math.min(6, shared.length);
      why.push(`mentions ${shared.slice(0, 4).join(', ')}`);
    }
    if (score === 0) continue;
    if (e.status === 'confirmed') score += 3;
    if (e.stale) {
      score -= 4;
      why.push('stale: linked files changed since');
    }
    hits.push({ entry: e, score, why });
  }
  hits.sort((a, b) => b.score - a.score || b.entry.createdAt.localeCompare(a.entry.createdAt) || a.entry.id.localeCompare(b.entry.id));
  return hits.slice(0, Math.max(1, Math.min(q.limit ?? 8, 50)));
}
