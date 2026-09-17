import { execFile } from 'node:child_process';
import type { GitInfo } from '../model/project-model.js';

export interface GitResult {
  ok: boolean;
  stdout: string;
}

/** Run git with a fixed argv (never through a shell). */
export function git(cwd: string, args: string[], timeoutMs = 15_000): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } }, (err, stdout) => {
      resolve({ ok: !err, stdout: typeof stdout === 'string' ? stdout : '' });
    });
  });
}

export async function gitAvailable(): Promise<boolean> {
  return (await git(process.cwd(), ['--version'])).ok;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  return r.ok && r.stdout.trim() === 'true';
}

export async function gitInfo(cwd: string): Promise<GitInfo> {
  const info: GitInfo = { available: await gitAvailable(), isRepo: false, hotspots: [] };
  if (!info.available) return info;
  info.isRepo = await isGitRepo(cwd);
  if (!info.isRepo) return info;
  const [branch, head, date, authors, log] = await Promise.all([
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cwd, ['rev-parse', 'HEAD']),
    git(cwd, ['log', '-1', '--format=%cI']),
    git(cwd, ['shortlog', '-sn', '--no-merges', 'HEAD']),
    git(cwd, ['log', '--since=180.days', '--name-only', '--format=', '--no-merges', '--relative', '-n', '2000', '--', '.']),
  ]);
  if (branch.ok) info.branch = branch.stdout.trim();
  if (head.ok) info.head = head.stdout.trim();
  if (date.ok && date.stdout.trim()) info.lastCommitDate = date.stdout.trim();
  // Count only — contributor names are personal data and not needed.
  if (authors.ok) info.contributorCount = authors.stdout.split('\n').filter((l) => l.trim()).length;
  if (log.ok) {
    const counts = new Map<string, number>();
    for (const line of log.stdout.split('\n')) {
      const p = line.trim();
      if (!p) continue;
      const dir = p.includes('/') ? p.split('/').slice(0, 2).join('/') : '.';
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
    info.hotspots = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([path, commits]) => ({ path, commits }));
  }
  return info;
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'other';
  from?: string;
}

/** Working-tree changes (staged, unstaged, untracked) relative to HEAD. */
export async function workingChanges(cwd: string): Promise<ChangedFile[] | null> {
  const r = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']);
  if (!r.ok) return null;
  const prefix = await repoPrefix(cwd);
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
export async function repoPrefix(cwd: string): Promise<string> {
  const r = await git(cwd, ['rev-parse', '--show-prefix']);
  return r.ok ? r.stdout.trim() : '';
}

function stripPrefix(files: ChangedFile[], prefix: string): ChangedFile[] {
  if (!prefix) return files;
  return files
    .filter((f) => f.path.startsWith(prefix))
    .map((f) => ({ ...f, path: f.path.slice(prefix.length), from: f.from?.startsWith(prefix) ? f.from.slice(prefix.length) : f.from }));
}

/** Files changed in commits between `fromRef` and HEAD. */
export async function changesSince(cwd: string, fromRef: string): Promise<ChangedFile[] | null> {
  if (!/^[0-9a-f]{7,64}$/i.test(fromRef)) return null;
  const r = await git(cwd, ['diff', '--name-status', '-M', '-z', `${fromRef}..HEAD`, '--', '.']);
  if (!r.ok) return null;
  const prefix = await repoPrefix(cwd);
  const out: ChangedFile[] = [];
  const parts = r.stdout.split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i]!;
    if (code.startsWith('R')) {
      const from = parts[++i];
      out.push({ path: parts[++i]!, status: 'renamed', from });
    } else {
      const p = parts[++i]!;
      out.push({ path: p, status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : code === 'M' ? 'modified' : 'other' });
    }
  }
  return stripPrefix(out, prefix);
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

export async function headMovement(cwd: string, from: string, to: string, limit = 20): Promise<HeadMovement | null> {
  if (!/^[0-9a-f]{7,64}$/i.test(from) || !/^[0-9a-f]{7,64}$/i.test(to)) return null;
  if (from === to) return { commits: [], diverged: false, truncated: false };
  const exists = await git(cwd, ['cat-file', '-e', `${from}^{commit}`]);
  if (!exists.ok) return { commits: [], diverged: true, truncated: false };
  const ancestor = await git(cwd, ['merge-base', '--is-ancestor', from, to]);
  const log = await git(cwd, ['log', `-n${limit + 1}`, '--format=%H%x1f%s', `${from}..${to}`]);
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
