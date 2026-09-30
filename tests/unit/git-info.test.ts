import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { gitAvailable, gitInfo, headMovement, isGitRepo, repoPrefix, workingChanges } from '../../src/core/git/git.js';

const tmpDirs: string[] = [];
afterAll(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'athena-gitinfo-')));
  tmpDirs.push(d);
  return d;
}

function commit(dir: string, files: Record<string, string>, author: string, daysAgo = 0): void {
  for (const [f, c] of Object.entries(files)) {
    execFileSync('mkdir', ['-p', path.dirname(path.join(dir, f))]);
    execFileSync('sh', ['-c', 'cat > "$1"', 'sh', path.join(dir, f)], { input: c });
  }
  const date = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  const env = { ...process.env, GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: `${author}@e.com`, GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: `${author}@e.com`, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  execFileSync('git', ['add', '-A'], { cwd: dir, env });
  execFileSync('git', ['commit', '-qm', `c by ${author}`], { cwd: dir, env });
}

async function repo(): Promise<string> {
  const dir = await tmp();
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  commit(dir, { 'old/a.ts': '1', 'src/x/a.ts': '0' }, 'ancient', 400);
  commit(dir, { 'src/x/a.ts': '1', 'src/x/b.ts': '1', 'README.md': '1' }, 'alice', 10);
  commit(dir, { 'src/x/a.ts': '2', 'src/y/c.ts': '1', '.athena/model.json': '{}' }, 'bob', 5);
  commit(dir, { 'src/x/a.ts': '3' }, 'alice', 1);
  return dir;
}

describe('gitInfo', () => {
  it('reports branch, head, hotspots and recent contributors from bounded history', async () => {
    const dir = await repo();
    const info = await gitInfo(dir);
    expect(info.available).toBe(true);
    expect(info.isRepo).toBe(true);
    expect(info.branch).toBe('main');
    expect(info.head).toMatch(/^[0-9a-f]{40}$/);
    expect(info.lastCommitDate).toBeTruthy();
    // Only the three commits in the last 180 days count; `.athena/` is excluded.
    expect(info.hotspots).toEqual([
      { path: 'src/x', commits: 4 },
      { path: '.', commits: 1 },
      { path: 'src/y', commits: 1 },
    ]);
    expect(info.contributorCount).toBe(2); // alice, bob — not "ancient" (outside the window)
    expect((await gitInfo(dir, { historyDays: 1000 })).contributorCount).toBe(3);
    expect((await gitInfo(dir, { maxCommits: 1 })).hotspots).toEqual([{ path: 'src/x', commits: 1 }]);
  });

  it('is scoped to a subdirectory like before (--relative)', async () => {
    const dir = await repo();
    const info = await gitInfo(path.join(dir, 'src'));
    expect(info.hotspots).toEqual([
      { path: 'x/a.ts', commits: 3 },
      { path: 'x/b.ts', commits: 1 },
      { path: 'y/c.ts', commits: 1 },
    ]);
    expect(info.contributorCount).toBe(2);
  });

  it('handles a non-repository and an empty repository', async () => {
    const plain = await tmp();
    expect(await gitInfo(plain)).toEqual({ available: true, isRepo: false, hotspots: [] });
    const empty = await tmp();
    execFileSync('git', ['init', '-q'], { cwd: empty });
    const info = await gitInfo(empty);
    expect(info.isRepo).toBe(true);
    expect(info.head).toBeUndefined();
    expect(info.hotspots).toEqual([]);
  });

  it('memoizes git availability and honors abort signals', async () => {
    const a = gitAvailable();
    expect(gitAvailable()).toBe(a);
    expect(await a).toBe(true);
    const dir = await repo();
    const ac = new AbortController();
    ac.abort(new Error('stop'));
    await expect(gitInfo(dir, { signal: ac.signal })).rejects.toThrow('stop');
    expect(await isGitRepo(dir, { signal: ac.signal })).toBe(false);
    expect(await workingChanges(dir, { signal: ac.signal })).toBeNull();
    expect(await repoPrefix(path.join(dir, 'src'))).toBe('src/');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    const first = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    const mv = await headMovement(dir, first, head);
    expect(mv).toMatchObject({ diverged: false, truncated: false });
    expect(mv!.commits).toHaveLength(3);
  });
});
