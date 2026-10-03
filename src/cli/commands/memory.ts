import { createInterface } from 'node:readline/promises';
import { MEMORY_FILES, MEMORY_KINDS, MEMORY_STATUSES } from '../../core/memory/memory.js';
import {
  addMemory,
  confirmMemory,
  forgetMemory,
  getMemory,
  listMemory,
  recallMemory,
  searchMemory,
  supersedeMemory,
  updateMemory,
  type MemoryKind,
  type MemoryStatus,
  type MemoryView,
  type RecallHit,
} from '../../services/memory.js';
import { AthenaError } from '../../services/errors.js';
import { requireProjectRoot, type GlobalOptions } from '../context.js';
import * as ui from '../ui/term.js';

const ID_RE = /^m-[a-z0-9]{4,16}$/;

// ── Helpers ─────────────────────────────────────────────────────────────────


function parseKind(k: string | undefined): MemoryKind | undefined {
  if (k === undefined) return undefined;
  if (!(MEMORY_KINDS as readonly string[]).includes(k)) throw new AthenaError(`Unknown memory kind: ${k}`, `Use one of: ${MEMORY_KINDS.join(', ')}`);
  return k as MemoryKind;
}

function parseStatus(s: string | undefined): MemoryStatus | undefined {
  if (s === undefined) return undefined;
  if (!(MEMORY_STATUSES as readonly string[]).includes(s)) throw new AthenaError(`Unknown memory status: ${s}`, `Use one of: ${MEMORY_STATUSES.join(', ')}`);
  return s as MemoryStatus;
}

function checkIds(ids: string[]): void {
  for (const id of ids) if (!ID_RE.test(id)) throw new AthenaError(`Invalid memory id: ${id}`, 'Ids look like m-1a2b3c; list them with `athena memory list`.');
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new AthenaError('`--details -` reads the details from stdin, but stdin is a terminal.', 'Pipe the text in, e.g. `cat notes.txt | athena memory add … --details -`.');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length));

function labelOf(v: MemoryView): string {
  if (v.status === 'superseded') return ui.dim(pad('history', 8));
  return v.label === 'FACT' ? ui.c.green(pad('FACT', 8)) : ui.c.yellow(pad('INFERRED', 8));
}

function statusOf(v: MemoryView): string {
  const s = pad(v.status, 10);
  return v.status === 'unreviewed' ? ui.c.yellow(s) : v.status === 'superseded' ? ui.dim(s) : s;
}

/** One table row: id, kind, label, status, markers, title, source. */
function row(v: MemoryView): string {
  const markers = `${v.stale ? ui.c.yellow('stale') : '     '} ${v.flags.length ? ui.c.red(ui.sym.warn) : ' '}`;
  const title = v.status === 'superseded' ? ui.dim(trunc(v.title, 60)) : trunc(v.title, 60);
  return `${ui.c.bold(pad(v.id, 9))} ${pad(v.kind, 10)} ${labelOf(v)} ${statusOf(v)} ${markers} ${title} ${ui.dim(`· ${v.source}`)}`;
}

function table(views: MemoryView[]): void {
  ui.line(ui.dim(`${pad('ID', 9)} ${pad('KIND', 10)} ${pad('LABEL', 8)} ${pad('STATUS', 10)} ${pad('', 7)} TITLE · SOURCE`));
  for (const v of views) ui.line(row(v));
}

export interface MemoryCounts {
  total: number;
  unreviewed: number;
  confirmed: number;
  superseded: number;
  stale: number;
  flagged: number;
}

export function countMemory(views: MemoryView[]): MemoryCounts {
  return {
    total: views.length,
    unreviewed: views.filter((v) => v.status === 'unreviewed').length,
    confirmed: views.filter((v) => v.status === 'confirmed').length,
    superseded: views.filter((v) => v.status === 'superseded').length,
    stale: views.filter((v) => v.stale).length,
    flagged: views.filter((v) => v.flags.length && v.status !== 'superseded').length,
  };
}

/** Cheap summary for `athena status` / `athena doctor`; never throws. */
export async function memorySummary(root: string): Promise<MemoryCounts | null> {
  try {
    return countMemory(await listMemory(root));
  } catch {
    return null;
  }
}

function countsLine(c: MemoryCounts): string {
  const parts = [plural(c.total, 'entry', 'entries'), `${c.confirmed} confirmed`, `${c.unreviewed} unreviewed`];
  if (c.superseded) parts.push(`${c.superseded} superseded`);
  if (c.stale) parts.push(`${c.stale} stale`);
  if (c.flagged) parts.push(`${c.flagged} flagged`);
  return parts.join(' · ');
}

function flagsBlock(v: MemoryView): void {
  if (!v.flags.length) return;
  ui.warn(ui.c.red('Possible prompt injection — this entry addresses the agent instead of describing the project:'));
  for (const f of v.flags) ui.line(`    ${ui.dim('-')} ${f}`);
  ui.line(ui.dim('    Flagged entries are never recalled automatically. Read it before confirming; forget it if it is not a real project fact.'));
}

function detail(v: MemoryView): void {
  ui.line(`${ui.c.bold(v.id)}  ${ui.c.bold(v.title)}`);
  ui.line(`${ui.dim('Kind:')}     ${v.kind} ${ui.dim(`(.athena/memory/${MEMORY_FILES[v.kind]})`)}`);
  ui.line(`${ui.dim('Label:')}    ${v.status === 'superseded' ? ui.dim('history (superseded)') : v.label === 'FACT' ? ui.c.green('FACT') : ui.c.yellow('INFERRED')} ${ui.dim(`· ${v.status}`)}`);
  ui.line(`${ui.dim('Source:')}   ${v.source}`);
  ui.line(`${ui.dim('Created:')}  ${v.createdAt} ${ui.dim(`(${ui.relativeTime(v.createdAt)})`)}`);
  if (v.confirmedAt) ui.line(`${ui.dim('Confirmed:')} ${v.confirmedAt}`);
  if (v.supersedes) ui.line(`${ui.dim('Replaces:')} ${v.supersedes}`);
  if (v.supersededBy) ui.line(`${ui.dim('Superseded by:')} ${v.supersededBy}`);
  if (v.tags.length) ui.line(`${ui.dim('Tags:')}     ${v.tags.map((t) => `#${t}`).join(' ')}`);
  if (v.evidence) ui.line(`${ui.dim('Evidence:')} ${v.evidence}`);
  if (v.files.length) {
    ui.line(ui.dim('Files:'));
    for (const f of v.files) {
      const state = v.changedFiles.includes(f) ? ui.c.yellow('changed since recorded') : f in v.anchors ? ui.c.green('unchanged') : ui.dim('not anchored (file did not exist when recorded)');
      ui.line(`  ${f} ${ui.dim('—')} ${state}`);
    }
  }
  if (v.details) {
    ui.line();
    for (const l of v.details.split('\n')) ui.line(`  ${l}`);
  }
  if (v.stale) {
    ui.line();
    ui.warn(`Stale: ${v.changedFiles.join(', ')} changed since this was recorded.`);
  }
  if (v.flags.length) {
    ui.line();
    flagsBlock(v);
  }
}

// ── Commands ────────────────────────────────────────────────────────────────

export async function memoryListCommand(opts: GlobalOptions & { kind?: string; status?: string; stale?: boolean }): Promise<number> {
  const root = await requireProjectRoot(opts);
  const kind = parseKind(opts.kind);
  const status = parseStatus(opts.status);
  const all = await listMemory(root);
  const views = all.filter((v) => (!kind || v.kind === kind) && (!status || v.status === status) && (!opts.stale || v.stale));
  const counts = countMemory(all);
  if (ui.isJson()) {
    ui.json({ entries: views, counts });
    return 0;
  }
  if (!all.length) {
    ui.line(ui.dim('No project memory yet. Record one with `athena memory add --kind decision --title "…"`, or let your agent use the `remember` MCP tool.'));
    return 0;
  }
  if (!views.length) ui.line(ui.dim('No entries match.'));
  else table(views);
  ui.line();
  ui.line(ui.dim(`${countsLine(counts)} · source: .athena/memory/`));
  if (counts.unreviewed) ui.line(ui.dim(`${plural(counts.unreviewed, 'entry', 'entries')} written by agents ${counts.unreviewed === 1 ? 'is' : 'are'} INFERRED until reviewed: run \`athena memory review\`.`));
  if (counts.stale && !opts.stale) ui.line(ui.dim('Some entries are stale (their linked files changed): run `athena memory stale`.'));
  return 0;
}

export async function memoryShowCommand(id: string, opts: GlobalOptions): Promise<void> {
  checkIds([id]);
  const root = await requireProjectRoot(opts);
  const v = await getMemory(root, id);
  if (ui.isJson()) ui.json(v);
  else detail(v);
}

export interface EditFlags {
  title?: string;
  details?: string;
  file?: string[];
  tag?: string[];
  evidence?: string;
}

export async function memoryAddCommand(opts: GlobalOptions & EditFlags & { kind?: string; supersedes?: string }): Promise<void> {
  const root = await requireProjectRoot(opts);
  if (!opts.kind) throw new AthenaError('Missing --kind.', `Use one of: ${MEMORY_KINDS.join(', ')}`);
  const kind = parseKind(opts.kind)!;
  if (!opts.title) throw new AthenaError('Missing --title.', 'A memory needs a short title, e.g. --title "Money is stored in cents".');
  if (opts.supersedes) checkIds([opts.supersedes]);
  const details = opts.details === '-' ? await readStdin() : opts.details;
  const v = await addMemory(root, { kind, title: opts.title, details, files: opts.file, tags: opts.tag, evidence: opts.evidence, supersedes: opts.supersedes }, 'developer');
  if (ui.isJson()) {
    ui.json({ ok: true, entry: v });
    return;
  }
  ui.ok(`Recorded ${ui.c.bold(v.id)} ${ui.dim(`(${v.kind}, FACT) in .athena/memory/${MEMORY_FILES[v.kind]}`)}`);
  if (v.supersedes) ui.line(ui.dim(`  ${v.supersedes} is now superseded by ${v.id}.`));
  const unanchored = v.files.filter((f) => !(f in v.anchors));
  if (unanchored.length) ui.warn(`Not found, so not tracked for staleness: ${unanchored.join(', ')}`);
  if (v.flags.length) flagsBlock(v);
}

export async function memorySearchCommand(query: string, opts: GlobalOptions): Promise<void> {
  const root = await requireProjectRoot(opts);
  const views = await searchMemory(root, query);
  if (ui.isJson()) {
    ui.json({ query, entries: views });
    return;
  }
  if (!views.length) {
    ui.line(ui.dim(`No memory mentions "${query}".`));
    return;
  }
  table(views);
  ui.line();
  ui.line(ui.dim(`${plural(views.length, 'match', 'matches')} · details: athena memory show <id>`));
}

export async function memoryRecallCommand(task: string[], opts: GlobalOptions & { file?: string[]; tag?: string[]; limit?: string }): Promise<void> {
  const root = await requireProjectRoot(opts);
  const text = task.join(' ').trim();
  const limit = opts.limit === undefined ? undefined : Number(opts.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new AthenaError(`Invalid --limit: ${opts.limit}`);
  const hits: RecallHit[] = await recallMemory(root, { task: text, files: opts.file, tags: opts.tag, limit });
  if (ui.isJson()) {
    ui.json({ task: text, files: opts.file ?? [], hits });
    return;
  }
  if (!hits.length) {
    ui.line(ui.dim('No relevant memory for this task.'));
    return;
  }
  ui.heading(`Memory relevant to "${trunc(text, 60)}"`);
  ui.line();
  hits.forEach((h, i) => {
    const v = h.entry;
    ui.line(`${ui.dim(`${String(i + 1).padStart(2)}.`)} ${ui.c.bold(v.id)} ${labelOf(v)} ${v.kind} ${ui.dim('—')} ${v.title}`);
    ui.line(`    ${ui.dim(`score ${h.score} · ${h.why.join('; ')}`)}`);
  });
  ui.line();
  ui.line(ui.dim('Flagged (possible prompt-injection) and superseded entries are not recalled. Details: athena memory show <id>'));
}

export async function memoryConfirmCommand(ids: string[], opts: GlobalOptions): Promise<void> {
  checkIds(ids);
  const root = await requireProjectRoot(opts);
  for (const id of ids) await getMemory(root, id); // all exist before changing any
  const out: MemoryView[] = [];
  for (const id of ids) out.push(await confirmMemory(root, id));
  if (ui.isJson()) {
    ui.json({ ok: true, entries: out });
    return;
  }
  for (const v of out) {
    ui.ok(`Confirmed ${ui.c.bold(v.id)} ${ui.dim(`— ${trunc(v.title, 60)} (now FACT${v.files.length ? ', re-anchored to current files' : ''})`)}`);
    if (v.flags.length) flagsBlock(v);
  }
}

export async function memorySupersedeCommand(id: string, opts: GlobalOptions & { by?: string }): Promise<void> {
  if (!opts.by) throw new AthenaError('Missing --by <id>.', 'Name the newer memory that replaces this one: athena memory supersede <old-id> --by <new-id>');
  checkIds([id, opts.by]);
  const root = await requireProjectRoot(opts);
  const v = await supersedeMemory(root, id, opts.by);
  if (ui.isJson()) ui.json({ ok: true, entry: v });
  else ui.ok(`${ui.c.bold(id)} is now superseded by ${ui.c.bold(opts.by)} ${ui.dim('(kept as history; no longer recalled)')}`);
}

async function ask(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} ${ui.dim('[y/N]')} `)).trim());
  } finally {
    rl.close();
  }
}

export async function memoryForgetCommand(ids: string[], opts: GlobalOptions & { yes?: boolean }): Promise<void> {
  checkIds(ids);
  const root = await requireProjectRoot(opts);
  const views: MemoryView[] = [];
  for (const id of ids) views.push(await getMemory(root, id));
  if (!opts.yes) {
    if (!process.stdin.isTTY || ui.isJson()) throw new AthenaError(`Refusing to forget ${plural(ids.length, 'memory', 'memories')} without confirmation.`, 'Re-run with --yes in non-interactive environments.');
    ui.line('This permanently removes from .athena/memory/:');
    for (const v of views) ui.line(`  ${ui.c.bold(v.id)} ${v.kind} ${ui.dim('—')} ${v.title}`);
    ui.line(ui.dim('If .athena/memory/ is committed to Git you can restore entries from history. To keep an outdated entry as history, use `athena memory supersede` instead.'));
    if (!(await ask('Forget?'))) {
      ui.line('Cancelled.');
      return;
    }
  }
  for (const id of ids) await forgetMemory(root, id);
  if (ui.isJson()) ui.json({ ok: true, forgotten: ids });
  else for (const v of views) ui.ok(`Forgot ${ui.c.bold(v.id)} ${ui.dim(`— ${trunc(v.title, 60)}`)}`);
}

export async function memoryEditCommand(id: string, opts: GlobalOptions & EditFlags): Promise<void> {
  checkIds([id]);
  const root = await requireProjectRoot(opts);
  const details = opts.details === '-' ? await readStdin() : opts.details;
  const patch = { title: opts.title, details, files: opts.file, tags: opts.tag, evidence: opts.evidence };
  if (Object.values(patch).every((v) => v === undefined)) throw new AthenaError('Nothing to change.', 'Pass at least one of --title, --details, --file, --tag, --evidence.');
  const v = await updateMemory(root, id, patch);
  if (ui.isJson()) {
    ui.json({ ok: true, entry: v });
    return;
  }
  ui.ok(`Updated ${ui.c.bold(v.id)} ${ui.dim(`— ${trunc(v.title, 60)}`)}`);
  if (v.status === 'unreviewed') ui.line(ui.dim(`  Still INFERRED (unreviewed). Confirm it with \`athena memory confirm ${v.id}\`.`));
  if (v.flags.length) flagsBlock(v);
}

export async function memoryStaleCommand(opts: GlobalOptions): Promise<number> {
  const root = await requireProjectRoot(opts);
  const views = await listMemory(root, { stale: true });
  if (ui.isJson()) {
    ui.json({ entries: views });
    return 0;
  }
  if (!views.length) {
    ui.ok('No stale memory: no linked file changed since its entry was recorded or confirmed.');
    return 0;
  }
  ui.heading(`${plural(views.length, 'stale entry', 'stale entries')}`);
  ui.line();
  for (const v of views) {
    ui.line(`${ui.c.bold(v.id)} ${labelOf(v)} ${v.kind} ${ui.dim('—')} ${v.title}`);
    ui.line(`    ${ui.c.yellow('changed:')} ${v.changedFiles.join(', ')}`);
  }
  ui.line();
  ui.line(ui.dim('For each: still true → `athena memory confirm <id>` (re-anchors to the current files);'));
  ui.line(ui.dim('partly wrong → `athena memory edit <id> --details …`; no longer true → `athena memory forget <id>`.'));
  return 0;
}

export async function memoryReviewCommand(opts: GlobalOptions): Promise<number> {
  const root = await requireProjectRoot(opts);
  const pending = (await listMemory(root, { status: 'unreviewed' })).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const interactive = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY) && !ui.isJson();
  if (!interactive) {
    if (ui.isJson()) ui.json({ interactive: false, entries: pending });
    else if (!pending.length) ui.ok('Nothing to review: no unreviewed memory.');
    else {
      table(pending);
      ui.line();
      ui.line(ui.dim(`${plural(pending.length, 'unreviewed entry', 'unreviewed entries')}. \`athena memory review\` is interactive in a terminal;`));
      ui.line(ui.dim('here, use `athena memory confirm <id…>` or `athena memory forget <id…> --yes`.'));
    }
    return 0;
  }
  if (!pending.length) {
    ui.ok('Nothing to review: no unreviewed memory.');
    return 0;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const tally = { confirmed: 0, forgotten: 0, skipped: 0 };
  try {
    for (let i = 0; i < pending.length; i++) {
      const v = pending[i]!;
      ui.line();
      ui.line(ui.dim(`── ${i + 1}/${pending.length} ──`));
      detail(v);
      ui.line();
      let answer = '';
      for (;;) {
        // Ctrl+D (end of input) rejects the question: treat it as quit.
        answer = (await rl.question(`${ui.c.bold('[c]')}onfirm  ${ui.c.bold('[e]')}dit later  ${ui.c.bold('[f]')}orget  ${ui.c.bold('[s]')}kip  ${ui.c.bold('[q]')}uit ${ui.dim('›')} `).catch(() => 'q')).trim().toLowerCase();
        if (/^[cefsq]/.test(answer)) break;
      }
      const a = answer[0];
      if (a === 'q') break;
      if (a === 'c') {
        await confirmMemory(root, v.id);
        tally.confirmed++;
        ui.ok(`Confirmed ${v.id} (now FACT)`);
      } else if (a === 'f') {
        await forgetMemory(root, v.id);
        tally.forgotten++;
        ui.ok(`Forgot ${v.id}`);
      } else {
        tally.skipped++;
        if (a === 'e') ui.line(ui.dim(`  Skipped. Edit it with \`athena memory edit ${v.id} --title … --details …\`, then confirm it.`));
      }
    }
  } finally {
    rl.close();
  }
  ui.line();
  ui.line(`${tally.confirmed} confirmed · ${tally.forgotten} forgotten · ${tally.skipped} skipped`);
  return 0;
}
