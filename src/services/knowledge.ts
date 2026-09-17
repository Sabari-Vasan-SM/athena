import path from 'node:path';
import { KNOWLEDGE_DOCS, type DocId } from '../core/knowledge/documents.js';
import { isBlockModified, parseBlocks } from '../core/knowledge/managed-blocks.js';
import { git } from '../core/git/git.js';
import { scanText } from '../core/security/secrets.js';
import { athenaDir, readState } from '../core/state/state.js';
import { readTextIfExists, sha256, writeFileAtomic } from '../core/util/fs.js';
import { AthenaError, conflict, notFound } from './errors.js';

export const MAX_DOC_BYTES = 1_000_000;

export type Segment =
  | { kind: 'generated'; id: string; modified: boolean; content: string }
  | { kind: 'developer'; content: string };

export interface DocMeta {
  id: DocId;
  file: string;
  title: string;
  purpose: string;
  present: boolean;
  bytes: number;
  /** Content hash used for optimistic concurrency on save. */
  hash: string | null;
  lastGeneratedAt: string | null;
  lastChangedAt: string | null;
  generatedSections: number;
  editedSections: string[];
}

export interface DocContent extends DocMeta {
  content: string;
  segments: Segment[];
}

/** Resolve a document id strictly against the fixed allowlist. Never builds paths from user input. */
export function resolveDoc(id: string) {
  const doc = KNOWLEDGE_DOCS.find((d) => d.id === id);
  if (!doc) throw notFound(`Unknown knowledge document: ${id.slice(0, 64)}`);
  return doc;
}

export function contentHash(text: string): string {
  return sha256(text).slice(0, 16);
}

export function segmentDocument(text: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  for (const b of parseBlocks(text)) {
    const before = text.slice(cursor, b.start);
    if (before.trim()) segments.push({ kind: 'developer', content: before });
    segments.push({ kind: 'generated', id: b.id, modified: isBlockModified(b), content: b.content });
    cursor = b.end;
  }
  const rest = text.slice(cursor);
  if (rest.trim()) segments.push({ kind: 'developer', content: rest });
  return segments;
}

async function meta(root: string, id: DocId, text: string | null): Promise<DocMeta> {
  const doc = resolveDoc(id);
  const st = await readState(athenaDir(root));
  const ds = st.kind === 'ok' ? st.state.documents[id] : undefined;
  const blocks = text ? parseBlocks(text) : [];
  return {
    id,
    file: doc.file,
    title: doc.title,
    purpose: doc.purpose,
    present: text !== null,
    bytes: text ? Buffer.byteLength(text) : 0,
    hash: text === null ? null : contentHash(text),
    lastGeneratedAt: ds?.lastGeneratedAt ?? (st.kind === 'ok' && id === 'rules' ? st.state.createdAt : null),
    lastChangedAt: ds?.lastChangedAt ?? null,
    generatedSections: blocks.length,
    editedSections: blocks.filter(isBlockModified).map((b) => b.id),
  };
}

export async function listDocs(root: string): Promise<DocMeta[]> {
  const out: DocMeta[] = [];
  for (const d of KNOWLEDGE_DOCS) out.push(await meta(root, d.id, await readTextIfExists(path.join(athenaDir(root), d.file))));
  return out;
}

export async function readDoc(root: string, id: string): Promise<DocContent> {
  const doc = resolveDoc(id);
  const text = await readTextIfExists(path.join(athenaDir(root), doc.file));
  if (text === null) throw notFound(`${doc.file} does not exist. Run \`athena analyze\` to regenerate it.`);
  return { ...(await meta(root, doc.id, text)), content: text, segments: segmentDocument(text) };
}

/**
 * Save a knowledge document. Refuses when:
 *  - the file changed on disk since the client loaded it (409, optimistic concurrency)
 *  - the content contains likely secrets (422) — knowledge files must never hold secrets
 */
export async function saveDoc(root: string, id: string, content: string, baseHash: string | null): Promise<DocContent> {
  const doc = resolveDoc(id);
  if (typeof content !== 'string') throw new AthenaError('content must be a string');
  if (Buffer.byteLength(content) > MAX_DOC_BYTES) throw new AthenaError(`Document exceeds ${MAX_DOC_BYTES} bytes`, undefined, 1, 'unprocessable');
  const file = path.join(athenaDir(root), doc.file);
  const current = await readTextIfExists(file);
  const currentHash = current === null ? null : contentHash(current);
  if (currentHash !== baseHash) {
    throw conflict(`${doc.file} was changed on disk since you opened it.`, 'Reload to see the latest version, then re-apply your edits.', { currentHash });
  }
  const secrets = scanText(content);
  if (secrets.length) {
    throw new AthenaError(
      `Refusing to save: ${secrets.length} likely secret(s) found (${[...new Set(secrets.map((s) => s.type))].join(', ')}).`,
      'Knowledge files must never contain secrets. Replace values with placeholders such as <configured externally>.',
      1,
      'unprocessable',
      { secrets: secrets.map((s) => ({ type: s.type, line: s.line })) },
    );
  }
  const normalized = content.replace(/\r\n/g, '\n');
  await writeFileAtomic(file, normalized.endsWith('\n') ? normalized : `${normalized}\n`);
  return readDoc(root, doc.id);
}

export interface SearchHit {
  id: DocId;
  file: string;
  title: string;
  line: number;
  text: string;
}

export async function searchDocs(root: string, query: string, limit = 50): Promise<SearchHit[]> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const hits: SearchHit[] = [];
  for (const d of KNOWLEDGE_DOCS) {
    const text = await readTextIfExists(path.join(athenaDir(root), d.file));
    if (!text) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && hits.length < limit; i++) {
      const line = lines[i]!;
      if (line.startsWith('<!-- athena:')) continue;
      if (line.toLowerCase().includes(q)) hits.push({ id: d.id, file: d.file, title: d.title, line: i + 1, text: line.trim().slice(0, 240) });
    }
    if (d.title.toLowerCase().includes(q) && !hits.some((h) => h.id === d.id)) hits.unshift({ id: d.id, file: d.file, title: d.title, line: 1, text: d.purpose });
  }
  return hits.slice(0, limit);
}

export interface HistoryEntry {
  sha: string;
  date: string;
  subject: string;
}

export interface DocHistory {
  available: boolean;
  reason?: string;
  entries: HistoryEntry[];
}

/** Knowledge history comes from Git — Athena does not maintain its own version store. */
export async function docHistory(root: string, id: string, limit = 50): Promise<DocHistory> {
  const doc = resolveDoc(id);
  const rel = `.athena/${doc.file}`;
  const r = await git(root, ['log', `-n${limit}`, '--follow', '--format=%H%x1f%cI%x1f%s', '--', rel]);
  if (!r.ok) return { available: false, reason: 'Git history is not available (not a Git repository, or git is not installed).', entries: [] };
  const entries = r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, date, subject] = l.split('\x1f');
      return { sha: sha!, date: date!, subject: subject ?? '' };
    });
  if (!entries.length) return { available: true, reason: `${rel} has not been committed yet.`, entries };
  return { available: true, entries };
}

export async function docAtRevision(root: string, id: string, sha: string): Promise<string> {
  const doc = resolveDoc(id);
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new AthenaError('Invalid revision');
  const prefix = (await git(root, ['rev-parse', '--show-prefix'])).stdout.trim();
  const r = await git(root, ['show', `${sha}:${prefix}.athena/${doc.file}`]);
  if (!r.ok) throw notFound(`${doc.file} does not exist at revision ${sha.slice(0, 12)}`);
  return r.stdout;
}
