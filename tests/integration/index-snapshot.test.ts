import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { snapshotReader, updateIndexSnapshot } from '../../src/core/git/index-snapshot.js';
import { cleanupProjects, gitInit, makeProject } from '../helpers.js';

afterAll(cleanupProjects);

const isWin = process.platform === 'win32';
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString();
const read = (p: string) => fs.readFile(p, 'utf8');

describe('index snapshot', () => {
  it('mirrors the index incrementally: placeholders for clean files, blobs for the rest, no untracked files', async () => {
    const dir = await makeProject({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 1;\n',
      'src/gone.ts': 'export {};\n',
      '.gitignore': 'dist/\n',
      '.athena/api.md': '# API\n',
      'big.bin': Buffer.alloc(4096, 1),
    });
    if (!isWin) await fs.symlink('src/a.ts', path.join(dir, 'link.ts'));
    if (!isWin) await fs.symlink('../../outside', path.join(dir, 'escape'));
    await gitInit(dir);
    // Staged, then edited again (unstaged); an unstaged deletion; an untracked file.
    await fs.writeFile(path.join(dir, 'src/b.ts'), 'export const b = 2;\n');
    git(dir, 'add', 'src/b.ts');
    await fs.writeFile(path.join(dir, 'src/b.ts'), 'export const b = 3; // unstaged\n');
    await fs.rm(path.join(dir, 'src/gone.ts'));
    await fs.writeFile(path.join(dir, 'src/untracked.ts'), 'export {};\n');

    const dest = path.join(await makeProject({}), 'tree');
    await fs.mkdir(dest);
    const snap = await updateIndexSnapshot(dir, dest, { maxFileBytes: 1024, previous: null });

    expect(snap.placeholders.has('src/a.ts')).toBe(true);
    const a = await fs.stat(path.join(dest, 'src/a.ts'));
    const aWork = await fs.stat(path.join(dir, 'src/a.ts'));
    expect(a.size).toBe(aWork.size);
    expect(Math.floor(a.mtimeMs)).toBe(Math.floor(aWork.mtimeMs));
    expect(await snapshotReader(dest, dir, snap.placeholders)(path.join(dest, 'src/a.ts'))).toEqual(await fs.readFile(path.join(dir, 'src/a.ts')));

    expect(await read(path.join(dest, 'src/b.ts'))).toBe('export const b = 2;\n'); // the staged version
    expect(await read(path.join(dest, 'src/gone.ts'))).toBe('export {};\n'); // deletion not staged
    expect(await read(path.join(dest, '.gitignore'))).toBe('dist/\n'); // read directly by the walker: real content
    expect(await read(path.join(dest, '.athena/api.md'))).toBe('# API\n');
    expect((await fs.stat(path.join(dest, 'big.bin'))).size).toBe(4096); // oversized: sparse, never read
    await expect(fs.access(path.join(dest, 'src/untracked.ts'))).rejects.toThrow();
    if (!isWin) {
      expect(await fs.readlink(path.join(dest, 'link.ts'))).toBe('src/a.ts');
      await expect(fs.lstat(path.join(dest, 'escape'))).rejects.toThrow(); // would leave the tree
    }

    // Nothing changed: nothing is rewritten.
    const again = await updateIndexSnapshot(dir, dest, { maxFileBytes: 1024, previous: snap.manifest });
    expect(again).toMatchObject({ written: 0, removed: 0 });

    // Stage the deletion and a new file: only those entries change.
    git(dir, 'rm', '-q', '--cached', 'src/gone.ts');
    git(dir, 'add', 'src/untracked.ts');
    const next = await updateIndexSnapshot(dir, dest, { maxFileBytes: 1024, previous: again.manifest });
    expect(next).toMatchObject({ written: 1, removed: 1 });
    await expect(fs.access(path.join(dest, 'src/gone.ts'))).rejects.toThrow();
    expect(next.placeholders.has('src/untracked.ts')).toBe(true);
  });

  it('refuses an index with unresolved conflicts', async () => {
    const dir = await makeProject({ 'f.txt': 'base\n' });
    await gitInit(dir);
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' };
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', env });
    const base = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    run('checkout', '-q', '-b', 'other');
    await fs.writeFile(path.join(dir, 'f.txt'), 'other\n');
    run('commit', '-q', '--no-gpg-sign', '-am', 'other');
    run('checkout', '-q', base);
    await fs.writeFile(path.join(dir, 'f.txt'), 'mine\n');
    run('commit', '-q', '--no-gpg-sign', '-am', 'mine');
    expect(() => run('merge', '-q', 'other')).toThrow();
    const dest = path.join(await makeProject({}), 'tree');
    await expect(updateIndexSnapshot(dir, dest, { maxFileBytes: 1024, previous: null })).rejects.toThrow(/unresolved merge conflicts \(f\.txt\)/);
  });
});
