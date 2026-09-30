import { spawn } from 'node:child_process';
import type { GitInfo } from '../model/project-model.js';

export interface GitResult {
  ok: boolean;
  /** Exit code; null when git could not be started, timed out, was aborted or exceeded `maxBytes`. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when stdout exceeded `maxBytes` and git was stopped (stdout is then incomplete). */
  overflow?: boolean;
  /** True when the run was stopped by `signal`. */
  aborted?: boolean;
  timedOut?: boolean;
}

export interface GitRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Stop git and report `overflow` once stdout exceeds this many bytes (default 32 MB). */
  maxBytes?: number;
  /** Written to git's stdin. */
  input?: string;
}

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

/**
 * Run git with a fixed argv (never through a shell). Never throws: inspect `ok`,
 * `code` and `stderr`. Use `gitOrThrow` where a failure must not be mistaken for
 * "no output".
 */
export function git(cwd: string, args: string[], opts: number | GitRunOptions = {}): Promise<GitResult> {
  const o: GitRunOptions = typeof opts === 'number' ? { timeoutMs: opts } : opts;
  const timeoutMs = o.timeoutMs ?? 15_000;
  const maxBytes = o.maxBytes ?? DEFAULT_MAX_BYTES;
  return new Promise((resolve) => {
    if (o.signal?.aborted) {
      resolve({ ok: false, code: null, stdout: '', stderr: '', aborted: true });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let overflow = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      stdio: [o.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    });
    const kill = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (code: number | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      let stderr = Buffer.concat(err).toString('utf8');
      if (spawnError) stderr = stderr || spawnError.message;
      if (overflow) stderr = `${stderr}${stderr ? '\n' : ''}output exceeded ${maxBytes} bytes`;
      if (timedOut) stderr = `${stderr}${stderr ? '\n' : ''}timed out after ${timeoutMs} ms`;
      const failed = overflow || timedOut || aborted || Boolean(spawnError);
      resolve({
        ok: !failed && code === 0,
        code: failed ? null : code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr,
        ...(overflow ? { overflow } : {}),
        ...(aborted ? { aborted } : {}),
        ...(timedOut ? { timedOut } : {}),
      });
    };
    child.stdout!.on('data', (chunk: Buffer) => {
      if (overflow) return;
      outBytes += chunk.length;
      if (outBytes > maxBytes) {
        overflow = true;
        kill();
        return;
      }
      out.push(chunk);
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      if (errBytes >= MAX_STDERR_BYTES) return;
      errBytes += chunk.length;
      err.push(chunk);
    });
    child.on('error', (e) => finish(null, e));
    child.on('close', (code) => finish(code));
    if (o.input !== undefined) {
      child.stdin!.on('error', () => {});
      child.stdin!.end(o.input);
    }
  });
}

/** Thrown by `gitOrThrow`. Services turn it into a user-facing error. */
export class GitCommandError extends Error {
  constructor(
    readonly args: string[],
    readonly result: GitResult,
  ) {
    const detail = result.stderr.trim().split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 300);
    super(`git ${args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? args[0]} failed${detail ? `: ${detail}` : result.code !== null ? ` (exit ${result.code})` : ''}`);
    this.name = 'GitCommandError';
  }
}

/**
 * Run git and return stdout, throwing when git fails, times out, is aborted or its
 * output exceeds `maxBytes`. An abort rethrows the signal's reason.
 */
export async function gitOrThrow(cwd: string, args: string[], opts: GitRunOptions = {}): Promise<string> {
  const r = await git(cwd, args, opts);
  if (r.aborted) throw opts.signal?.reason ?? new Error('Aborted');
  if (!r.ok) throw new GitCommandError(args, r);
  return r.stdout;
}

/** Options accepted by the higher-level helpers below. */
export interface GitCallOptions {
  signal?: AbortSignal;
}

let availability: Promise<boolean> | null = null;

/** Is a `git` executable on PATH? Checked once per process (an aborted check is not cached). */
export function gitAvailable(opts: GitCallOptions = {}): Promise<boolean> {
  if (availability) return availability;
  const p = git(process.cwd(), ['--version'], { signal: opts.signal }).then((r) => {
    if (r.aborted && availability === p) availability = null;
    return r.ok;
  });
  availability = p;
  return p;
}

/** Test hook: forget the memoized `gitAvailable()` result. */
export function resetGitAvailableCache(): void {
  availability = null;
}

export async function isGitRepo(cwd: string, opts: GitCallOptions = {}): Promise<boolean> {
  const r = await git(cwd, ['rev-parse', '--is-inside-work-tree'], { signal: opts.signal });
  return r.ok && r.stdout.trim() === 'true';
}

/** How much history `gitInfo` reads for hotspots and the contributor count. */
export const HISTORY_DAYS = 180;
export const HISTORY_MAX_COMMITS = 2000;

export interface GitInfoOptions extends GitCallOptions {
  historyDays?: number;
  maxCommits?: number;
}

const AUTHOR_MARK = '\x1e';

/**
 * Summarize the repository. All git processes run concurrently, and history is
 * read once, bounded by `historyDays`/`maxCommits`, for both the hotspots and the
 * contributor count. `contributorCount` is therefore the number of distinct
 * (mailmap-normalized) authors of non-merge commits touching this directory in
 * that window, not over the whole history.
 */
export async function gitInfo(cwd: string, opts: GitInfoOptions = {}): Promise<GitInfo> {
  const { signal } = opts;
  const days = opts.historyDays ?? HISTORY_DAYS;
  const maxCommits = opts.maxCommits ?? HISTORY_MAX_COMMITS;
  const run = (args: string[]) => git(cwd, args, { signal });
  // Nothing below depends on another call's result, so start everything at once;
  // results are simply ignored when git is missing or this is not a work tree.
  const [available, isRepo, branch, head, date, log] = await Promise.all([
    gitAvailable({ signal }),
    isGitRepo(cwd, { signal }),
    run(['rev-parse', '--abbrev-ref', 'HEAD']),
    run(['rev-parse', 'HEAD']),
    run(['log', '-1', '--format=%cI']),
    run(['log', `--since=${days}.days`, `--max-count=${maxCommits}`, '--no-merges', `--format=${AUTHOR_MARK}%aN`, '--name-only', '--relative', '--', '.']),
  ]);
  signal?.throwIfAborted();
  const info: GitInfo = { available, isRepo: false, hotspots: [] };
  if (!info.available) return info;
  info.isRepo = isRepo;
  if (!info.isRepo) return info;
  if (branch.ok) info.branch = branch.stdout.trim();
  if (head.ok) info.head = head.stdout.trim();
  if (date.ok && date.stdout.trim()) info.lastCommitDate = date.stdout.trim();
  if (log.ok) {
    // Count only — contributor names are personal data and are not kept.
    const authors = new Set<string>();
    const counts = new Map<string, number>();
    for (const line of log.stdout.split('\n')) {
      if (line.startsWith(AUTHOR_MARK)) {
        authors.add(line.slice(1));
        continue;
      }
      const p = line.trim();
      // Athena's own output is not a code hotspot; counting it would make every knowledge commit change the hotspots.
      if (!p || p === '.athena' || p.startsWith('.athena/')) continue;
      const dir = p.includes('/') ? p.split('/').slice(0, 2).join('/') : '.';
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
    info.contributorCount = authors.size;
    info.hotspots = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, 10).map(([path, commits]) => ({ path, commits }));
  }
  return info;
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'other';
  from?: string;
}

/** Working-tree changes (staged, unstaged, untracked) relative to HEAD. */
export async function workingChanges(cwd: string, opts: GitCallOptions = {}): Promise<ChangedFile[] | null> {
  const [r, prefix] = await Promise.all([git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'], { signal: opts.signal }), repoPrefix(cwd, opts)]);
  if (!r.ok) return null;
  const out: ChangedFile[] = [];
  const parts = r.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const p = entry.slice(3);
    if (code.includes('R')) {
      out.push({ path: p, status: 'renamed', from: parts[++i] });
    } else if (code === '??') out.push({ path: p, status: 'untracked' });
    else if (code.includes('D')) out.push({ path: p, status: 'deleted' });
    else if (code.includes('A')) out.push({ path: p, status: 'added' });
    else if (code.includes('M')) out.push({ path: p, status: 'modified' });
    else out.push({ path: p, status: 'other' });
  }
  return stripPrefix(out, prefix);
}

/** Path of `cwd` relative to the repository root ("" at the root). Git reports paths repo-relative. */
export async function repoPrefix(cwd: string, opts: GitCallOptions = {}): Promise<string> {
  const r = await git(cwd, ['rev-parse', '--show-prefix'], { signal: opts.signal });
  return r.ok ? r.stdout.trim() : '';
}

function stripPrefix(files: ChangedFile[], prefix: string): ChangedFile[] {
  if (!prefix) return files;
  return files
    .filter((f) => f.path.startsWith(prefix))
    .map((f) => ({ ...f, path: f.path.slice(prefix.length), from: f.from?.startsWith(prefix) ? f.from.slice(prefix.length) : f.from }));
}

/**
 * Files changed on HEAD since it diverged from `fromRef` (`merge-base..HEAD`, the
 * same range a pull request shows). Returns null when the range can't be computed.
 */
export async function changesSince(cwd: string, fromRef: string, opts: GitCallOptions = {}): Promise<ChangedFile[] | null> {
  // Accept commit SHAs and ordinary ref expressions (HEAD~1, origin/main, v1.2.3),
  // but never anything that could be read as an option or shell metacharacter.
  if (!isSafeRef(fromRef)) return null;
  const mb = await git(cwd, ['merge-base', fromRef, 'HEAD'], { signal: opts.signal });
  if (!mb.ok || !mb.stdout.trim()) return null;
  const r = await git(cwd, ['diff', '--name-status', '-M', '-z', '--relative', '--no-color', mb.stdout.trim(), 'HEAD', '--', '.'], { signal: opts.signal });
  if (!r.ok) return null;
  return parseNameStatusZ(r.stdout);
}

/** Parse `git diff --name-status -z` output. */
export function parseNameStatusZ(stdout: string): ChangedFile[] {
  const out: ChangedFile[] = [];
  const parts = stdout.split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i]!;
    if (code.startsWith('R') || code.startsWith('C')) {
      const from = parts[++i];
      const to = parts[++i];
      if (to === undefined) break;
      out.push(code.startsWith('R') ? { path: to, status: 'renamed', from } : { path: to, status: 'added' });
    } else {
      const p = parts[++i];
      if (p === undefined) break;
      out.push({ path: p, status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : code === 'M' ? 'modified' : 'other' });
    }
  }
  return out;
}

/** Conservative allowlist for user-supplied git refs. */
export function isSafeRef(ref: string): boolean {
  return /^[A-Za-z0-9][\w./@^~-]{0,119}$/.test(ref);
}

export interface CommitSummary {
  sha: string;
  subject: string;
}

export interface HeadMovement {
  /** Commits reachable from `to` but not `from` (newest first), when `from` is an ancestor. */
  commits: CommitSummary[];
  /** True when `from` is not an ancestor of `to` (branch switch, rebase, reset). */
  diverged: boolean;
  truncated: boolean;
}

export async function headMovement(cwd: string, from: string, to: string, limit = 20, opts: GitCallOptions = {}): Promise<HeadMovement | null> {
  if (!/^[0-9a-f]{7,64}$/i.test(from) || !/^[0-9a-f]{7,64}$/i.test(to)) return null;
  if (from === to) return { commits: [], diverged: false, truncated: false };
  const { signal } = opts;
  const exists = await git(cwd, ['cat-file', '-e', `${from}^{commit}`], { signal });
  if (!exists.ok) return { commits: [], diverged: true, truncated: false };
  const [ancestor, log] = await Promise.all([git(cwd, ['merge-base', '--is-ancestor', from, to], { signal }), git(cwd, ['log', `-n${limit + 1}`, '--format=%H%x1f%s', `${from}..${to}`], { signal })]);
  if (!log.ok) return null;
  const commits = log.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, subject] = l.split('\x1f');
      return { sha: sha!, subject: subject ?? '' };
    });
  return { commits: commits.slice(0, limit), diverged: !ancestor.ok, truncated: commits.length > limit };
}
