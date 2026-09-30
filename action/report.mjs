#!/usr/bin/env node
// Helper for the Athena GitHub Action (action.yml). Dependency-free, Node >= 18.
//
//   node report.mjs sync <sync.json>                  log the result, write `in-sync` to $GITHUB_OUTPUT
//   node report.mjs review <review.json>              log findings, write `blockers` to $GITHUB_OUTPUT
//   node report.mjs markdown <review.json> [sync.json] print the PR comment body (Markdown)
//   node report.mjs find-comment <comments.jsonl>     print the id of Athena's previous PR comment (or nothing)
//
// Input files are `athena sync --check --json` and `athena review --json` output.
// Findings carry a type and a location only, never a secret value, and this
// script prints nothing else from the diff.
import { appendFileSync, readFileSync } from 'node:fs';

export const MARKER = '<!-- athena-review:v1 -->';
/** Marker written by earlier versions; still recognised so their comment is updated in place. */
export const LEGACY_MARKER = '<!-- athena-review -->';
/** Only comments by this account are ever edited: anyone can post a comment containing the marker. */
export const BOT_LOGIN = 'github-actions[bot]';

function load(file) {
  if (!file) return null;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return { error: 'Athena did not return JSON output.' };
  }
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

/** Escape a value for a workflow command (::error::) so untrusted text cannot inject commands. */
function cmdEscape(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Escape a workflow command property value (file=, title=). */
function propEscape(s) {
  return cmdEscape(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/** Split "path:line" (as review findings report secrets) into a path and a line number. */
function location(entry) {
  const m = /^(.*):(\d+)$/.exec(String(entry));
  return m ? { file: m[1], line: Number(m[2]) } : { file: String(entry), line: null };
}

const ANNOTATION = { blocker: 'error', warning: 'warning' };
const MAX_ANNOTATIONS = 50;

/**
 * File annotations for findings that point at files. Messages come from Athena and
 * carry a finding type and location only, never a matched value.
 */
export function annotations(review) {
  const out = [];
  for (const f of review?.findings ?? []) {
    const kind = ANNOTATION[f.level];
    if (!kind) continue;
    for (const entry of f.files ?? []) {
      if (out.length >= MAX_ANNOTATIONS) return out;
      const { file, line } = location(entry);
      if (!file) continue;
      const props = [`file=${propEscape(file.replace(/^\.\//, ''))}`, line ? `line=${line}` : '', `title=${propEscape(`Athena: ${f.check}`)}`].filter(Boolean).join(',');
      out.push(`::${kind} ${props}::${cmdEscape(`${f.message}${f.hint ? ` ${f.hint}` : ''}`)}`);
    }
  }
  return out;
}

/** Pick Athena's previous comment from `gh api --paginate --jq '.[] | {id, login: .user.login, body}'` output. */
export function findComment(jsonl) {
  for (const line of String(jsonl).split('\n')) {
    if (!line.trim()) continue;
    let c;
    try {
      c = JSON.parse(line);
    } catch {
      continue;
    }
    const login = c.login ?? c.user?.login;
    const body = typeof c.body === 'string' ? c.body : '';
    if (login === BOT_LOGIN && (body.includes(MARKER) || body.startsWith(LEGACY_MARKER)) && /^\d+$/.test(String(c.id))) return String(c.id);
  }
  return '';
}

/** One line of plain text that never starts a workflow command. */
function logLine(s) {
  return `  ${String(s).replace(/[\r\n]+/g, ' ')}`;
}

/** Inline Markdown text from untrusted input: one line, no HTML. */
function md(s) {
  return String(s).replace(/[\r\n]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A path or location as inline code. */
function code(s) {
  return `\`${String(s).replace(/[\r\n`]+/g, '')}\``;
}

const blockersOf = (review) => (review?.findings ?? []).filter((f) => f.level === 'blocker');

function syncCommand(file) {
  const sync = load(file);
  if (!sync || sync.error) {
    console.log(`::error::${cmdEscape(`athena sync --check failed: ${sync?.error ?? 'no output'}${sync?.hint ? ` ${sync.hint}` : ''}`)}`);
    setOutput('in-sync', 'false');
    return 2;
  }
  const inSync = sync.inSync ?? sync.upToDate;
  setOutput('in-sync', inSync ? 'true' : 'false');
  if (inSync) {
    console.log(logLine('Athena knowledge is in sync with the code.'));
    return 0;
  }
  const stale = new Set(sync.stale ?? (sync.documents ?? []).map((d) => d.file));
  console.log(`::error::${cmdEscape('Athena knowledge (.athena/) is out of date. Run `athena sync` locally and commit the updated .athena/ files.')}`);
  for (const d of sync.documents ?? []) {
    if (!stale.has(d.file)) continue;
    console.log(logLine(`.athena/${d.file}: ${(d.changedSections ?? []).join(', ')}`));
    for (const r of (d.reasons ?? []).slice(0, 3)) console.log(logLine(`  - ${r}`));
  }
  return 0;
}

function reviewCommand(file) {
  const review = load(file);
  if (!review || review.error) {
    console.log(`::error::${cmdEscape(`athena review failed: ${review?.error ?? 'no output'}${review?.hint ? ` ${review.hint}` : ''}`)}`);
    setOutput('blockers', '0');
    return 2;
  }
  const blockers = blockersOf(review);
  setOutput('blockers', String(blockers.length));
  const files = review.stats?.files ?? 0;
  console.log(logLine(`Reviewed ${files} changed file${files === 1 ? '' : 's'} against ${String(review.base).slice(0, 12)}.`));
  for (const f of review.findings ?? []) {
    console.log(logLine(`[${f.level}] ${f.message} (${f.check})${f.files?.length ? `: ${f.files.slice(0, 6).join(', ')}` : ''}`));
  }
  for (const a of annotations(review)) console.log(a);
  if (blockers.length) console.log(`::error::${cmdEscape(`athena review found ${blockers.length} blocker${blockers.length === 1 ? '' : 's'} (possible secrets or committed env files).`)}`);
  return 0;
}

const LEVEL = { blocker: '**Blocker**', warning: 'Warning', info: 'Info' };

export function renderMarkdown(review, sync) {
  const lines = [MARKER, '### Athena review', ''];
  if (!review || review.error) {
    lines.push(`Athena could not review this change: ${md(review?.error ?? 'no output')}`);
    return `${lines.join('\n')}\n`;
  }
  const s = review.stats ?? { files: 0, added: 0, removed: 0 };
  lines.push(`${s.files} file${s.files === 1 ? '' : 's'} changed (+${s.added} −${s.removed}) compared with ${code(String(review.base).slice(0, 12))}.`, '');
  if (sync && !sync.error) {
    const inSync = sync.inSync ?? sync.upToDate;
    lines.push(inSync ? 'Athena knowledge (`.athena/`) is in sync.' : `**Athena knowledge is out of date:** ${(sync.stale ?? []).map((f) => code(`.athena/${f}`)).join(', ')}. Run \`athena sync\` and commit the result.`, '');
  }
  const findings = review.findings ?? [];
  if (!findings.length) lines.push('No findings from the automated checks.');
  for (const f of findings) {
    const where = (f.files ?? []).slice(0, 10).map(code).join(', ');
    const more = (f.files ?? []).length > 10 ? ` +${f.files.length - 10} more` : '';
    lines.push(`- ${LEVEL[f.level] ?? md(f.level)}: ${md(f.message)} (${code(f.check)})${where ? ` in ${where}${more}` : ''}`);
    if (f.hint) lines.push(`  ${md(f.hint)}`);
  }
  const blockers = blockersOf(review).length;
  lines.push('', blockers ? `**${blockers} blocker${blockers === 1 ? '' : 's'} found.**` : 'No blockers found.');
  lines.push('', '<sub>Generated by <a href="https://github.com/Sabari-Vasan-SM/athena">Athena</a> from facts about the diff. Findings show a type and location only, never the matched value.</sub>');
  return `${lines.join('\n')}\n`;
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'sync') process.exitCode = syncCommand(a);
else if (cmd === 'review') process.exitCode = reviewCommand(a);
else if (cmd === 'markdown') process.stdout.write(renderMarkdown(load(a), load(b)));
else if (cmd === 'find-comment') {
  let text = '';
  try {
    text = readFileSync(a, 'utf8');
  } catch {
    /* no comments */
  }
  const id = findComment(text);
  if (id) process.stdout.write(`${id}\n`);
}
else if (cmd) {
  console.error(`Unknown command: ${cmd}`);
  process.exitCode = 1;
}
