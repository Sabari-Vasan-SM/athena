import { KNOWLEDGE_DOCS, RELEVANCE_MAP, type DocId } from '../knowledge/documents.js';
import { parseBlocks } from '../knowledge/managed-blocks.js';
import { listRules, parseRules, type Rule } from '../knowledge/rules.js';
import { expandFromFiles, type GraphNode, type ProjectGraph } from '../graph/graph.js';

/**
 * Deterministic context selection: given a task description, decide which parts of
 * the knowledge base an agent should read. No AI, no guessing about the code —
 * keyword matching over the developer's own documents plus the project graph.
 */

export interface TaskArea {
  id: DocId;
  score: number;
  why: string[];
}

export interface ContextSection {
  doc: DocId;
  file: string;
  section: string;
  content: string;
  score: number;
}

export interface RelevantContext {
  task: string;
  /** Documents ranked by relevance, with the reason each was chosen. */
  areas: TaskArea[];
  sections: ContextSection[];
  rules: Rule[];
  graphNodes: GraphNode[];
  /** Files the task text referred to directly. */
  mentionedFiles: string[];
  truncated: boolean;
  approxChars: number;
}

/** Keywords that map a task to knowledge areas. Extend here, not in the renderers. */
const AREA_KEYWORDS: Array<{ id: DocId; words: RegExp }> = [
  { id: 'database', words: /\b(database|db|schema|migration|migrate|sql|query|queries|table|column|index|prisma|orm|entity|model|postgres|mysql|mongo|supabase)\b/i },
  { id: 'api', words: /\b(api|endpoint|route|router|controller|handler|rest|graphql|grpc|request|response|webhook|http|status code)\b/i },
  { id: 'auth', words: /\b(auth|authentication|authorization|login|logout|session|token|jwt|oauth|sso|permission|role|rbac|acl|password|mfa|2fa)\b/i },
  { id: 'security', words: /\b(security|secure|vulnerab|xss|csrf|ssrf|injection|sanitiz|escape|secret|credential|encrypt|audit|cors|rate limit)\b/i },
  { id: 'testing', words: /\b(test|tests|testing|spec|coverage|e2e|unit|integration|mock|fixture|vitest|jest|pytest|playwright|cypress)\b/i },
  { id: 'performance', words: /\b(performance|perf|slow|fast|latency|cache|caching|queue|worker|background job|optimi[sz]|n\+1|bottleneck|memory|profil)\b/i },
  { id: 'deployment', words: /\b(deploy|deployment|docker|container|kubernetes|k8s|ci|cd|pipeline|release|env var|environment variable|infra|terraform|vercel|hosting)\b/i },
  { id: 'debugging', words: /\b(bug|debug|error|exception|crash|stack trace|failing|broken|regression|log|logging|troubleshoot)\b/i },
  { id: 'architecture', words: /\b(architecture|structure|module|package|refactor|boundary|layer|service layer|dependency|monorepo|design)\b/i },
  { id: 'code-review', words: /\b(review|pull request|pr|merge|checklist|convention|style guide)\b/i },
  { id: 'project', words: /\b(setup|install|build|command|script|getting started|onboard|dependency|dependencies|tooling)\b/i },
];

const UI_WORDS = /\b(ui|css|style|styling|layout|component|button|form|page|responsive|dark mode|design|frontend|tailwind)\b/i;
const SMALL_WORDS = /\b(typo|rename|comment|whitespace|format|wording|copy|spelling)\b/i;
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'add', 'new', 'use', 'using', 'make', 'need', 'should', 'when', 'what', 'where', 'which', 'must', 'have', 'has', 'are', 'was', 'can', 'will', 'our', 'their', 'its', 'not', 'all', 'any', 'get', 'set', 'run']);

export function tokenize(task: string): string[] {
  return [...new Set(task.toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? [])].filter((w) => !STOP.has(w));
}

/** File-like tokens in the task ("src/api/payments.ts", "payments.ts"). */
export function mentionedFiles(task: string, knownFiles: string[]): string[] {
  const candidates = task.match(/[\w./-]+\.[a-z]{1,5}\b/gi) ?? [];
  const out: string[] = [];
  for (const c of candidates) {
    const norm = c.replace(/^\.\//, '');
    const exact = knownFiles.find((f) => f === norm || f.endsWith(`/${norm}`));
    if (exact) out.push(exact);
  }
  return [...new Set(out)];
}

export interface SelectOptions {
  task: string;
  /** Section text per document, as parsed from .athena/*.md. */
  documents: Array<{ id: DocId; file: string; sections: Array<{ id: string; content: string }> }>;
  rulesMarkdown: string | null;
  graph?: ProjectGraph | null;
  /** Character budget for returned sections. */
  maxChars?: number;
}

export function selectContext(opts: SelectOptions): RelevantContext {
  const task = opts.task.trim();
  const words = tokenize(task);
  const maxChars = opts.maxChars ?? 12_000;

  // 1. Areas from keywords, with the mapped task types as a fallback.
  const areas = new Map<DocId, TaskArea>();
  const bump = (id: DocId, score: number, why: string) => {
    const cur = areas.get(id) ?? { id, score: 0, why: [] };
    cur.score += score;
    if (!cur.why.includes(why)) cur.why.push(why);
    areas.set(id, cur);
  };
  for (const { id, words: re } of AREA_KEYWORDS) {
    const hit = task.match(re);
    if (hit) bump(id, 10, `task mentions "${hit[0]}"`);
  }
  if (UI_WORDS.test(task)) {
    for (const id of ['project', 'architecture'] as DocId[]) bump(id, 6, 'frontend/UI task');
  }
  if (!areas.size && !SMALL_WORDS.test(task)) {
    for (const id of RELEVANCE_MAP.find((r) => r.task.startsWith('New feature'))!.docs) bump(id, 3, 'no specific area detected — using the broad feature set');
  }
  // Security and testing ride along with database/API/auth work.
  if (areas.has('database') || areas.has('api') || areas.has('auth')) {
    bump('security', 4, 'security implications of data/API changes');
    bump('testing', 3, 'tests for changed behavior');
  }

  // 2. Files and graph
  const knownFiles = opts.graph?.nodes.filter((n) => n.path).map((n) => n.path!) ?? [];
  const files = mentionedFiles(task, knownFiles);
  const graphNodes = opts.graph ? expandFromFiles(opts.graph, files, 1, 30) : [];
  for (const n of graphNodes) {
    if (n.kind === 'route') bump('api', 5, `task touches route ${n.name}`);
    if (n.kind === 'entity') bump('database', 5, `task touches entity ${n.name}`);
  }
  // Graph nodes matching task words (e.g. "payments" → entity Payment)
  if (opts.graph) {
    for (const n of opts.graph.nodes) {
      if (graphNodes.some((g) => g.id === n.id)) continue;
      const hay = `${n.name} ${n.path ?? ''}`.toLowerCase();
      if (words.some((w) => w.length > 3 && hay.includes(w))) {
        graphNodes.push(n);
        if (graphNodes.length >= 40) break;
      }
    }
  }

  // 3. Score sections within the chosen documents
  const ranked = [...areas.values()].sort((a, b) => b.score - a.score);
  const sections: ContextSection[] = [];
  for (const area of ranked) {
    const doc = opts.documents.find((d) => d.id === area.id);
    if (!doc) continue;
    for (const s of doc.sections) {
      if (s.id === 'about') continue;
      const text = s.content.toLowerCase();
      const matches = words.filter((w) => text.includes(w)).length;
      const score = area.score + matches * 2;
      sections.push({ doc: doc.id, file: doc.file, section: s.id, content: s.content, score });
    }
  }
  sections.sort((a, b) => b.score - a.score);

  let used = 0;
  const kept: ContextSection[] = [];
  let truncated = false;
  for (const s of sections) {
    if (used + s.content.length > maxChars) {
      truncated = true;
      continue;
    }
    kept.push(s);
    used += s.content.length;
  }

  const rules = opts.rulesMarkdown ? listRules(parseRules(opts.rulesMarkdown)).filter((r) => r.enabled) : [];
  return {
    task,
    areas: ranked,
    sections: kept.sort((a, b) => a.doc.localeCompare(b.doc) || b.score - a.score),
    rules,
    graphNodes: graphNodes.slice(0, 40),
    mentionedFiles: files,
    truncated,
    approxChars: used,
  };
}

/** Parse a knowledge document into its generated sections plus developer notes. */
export function documentSections(markdown: string): Array<{ id: string; content: string }> {
  const blocks = parseBlocks(markdown);
  const sections = blocks.map((b) => ({ id: b.id, content: b.content }));
  // Developer content after the last generated block is high-value context.
  const last = blocks.at(-1);
  const tail = last ? markdown.slice(last.end) : markdown;
  const notes = tail.replace(/^#+ Developer Notes\s*/im, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  if (notes) sections.push({ id: 'developer-notes', content: `## Developer Notes\n\n${notes}` });
  return sections;
}

/** Render selected context as Markdown for an agent. */
export function formatContext(ctx: RelevantContext): string {
  const out: string[] = [`# Athena context for: ${ctx.task}`, ''];
  out.push('_Selected deterministically from this project\'s knowledge. Statements keep their FACT/DETECTED/INFERRED/UNKNOWN labels; verify anything not marked FACT or DETECTED._', '');

  if (ctx.rules.length) {
    out.push('## Project rules (always apply)', '');
    for (const r of ctx.rules) out.push(`- [${r.section}] ${r.text}`);
    out.push('');
  }
  if (ctx.areas.length) {
    out.push(`## Why these documents`, '');
    for (const a of ctx.areas) out.push(`- **${KNOWLEDGE_DOCS.find((d) => d.id === a.id)!.file}** — ${a.why.join('; ')}`);
    out.push('');
  }
  if (ctx.mentionedFiles.length || ctx.graphNodes.length) {
    out.push('## Related code (from the project graph)', '');
    for (const f of ctx.mentionedFiles) out.push(`- file: \`${f}\` (named in the task)`);
    for (const n of ctx.graphNodes.filter((n) => !ctx.mentionedFiles.includes(n.path ?? ''))) {
      out.push(`- ${n.kind}: ${n.name}${n.path ? ` (\`${n.path}\`)` : ''}`);
    }
    out.push('');
  }
  let currentDoc = '';
  for (const s of ctx.sections) {
    if (s.doc !== currentDoc) {
      currentDoc = s.doc;
      out.push(`## From ${s.file}`, '');
    }
    out.push(s.content.trim(), '');
  }
  if (ctx.truncated) out.push('_Some lower-ranked sections were omitted to stay within the context budget._');
  return out.join('\n');
}
