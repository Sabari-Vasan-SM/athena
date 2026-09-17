import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AthenaConfig } from '../../src/core/config.js';
import { walkProject } from '../../src/core/fs/walker.js';
import { relPosix, resolveInside, toPosix } from '../../src/core/util/paths.js';
import { cleanupProjects, makeProject } from '../helpers.js';

const config = (o: Partial<AthenaConfig> = {}) => AthenaConfig.parse(o);
afterAll(cleanupProjects);

describe('walker', () => {
  it('handles an empty project', async () => {
    const dir = await makeProject({});
    const r = await walkProject(dir, { config: config() });
    expect(r.files).toEqual([]);
  });

  it('applies default ignores, .gitignore and config ignores', async () => {
    const dir = await makeProject({
      'src/a.ts': 'a',
      'node_modules/x/index.js': 'x',
      'dist/out.js': 'x',
      '__pycache__/m.pyc': 'x',
      '.athena/project.md': 'x',
      'generated/big.ts': 'x',
      'secret.log': 'x',
      '.gitignore': '*.log\n',
    });
    const r = await walkProject(dir, { config: config({ ignore: ['generated/'] }) });
    expect(r.files.map((f) => f.path)).toEqual(['.gitignore', 'src/a.ts']);
  });

  it('flags binary and large files without reading large ones', async () => {
    const dir = await makeProject({ 'img.bin': Buffer.from([0x89, 0x50, 0, 0, 1]), 'big.txt': 'x'.repeat(2000), 'ok.txt': 'fine' });
    const r = await walkProject(dir, { config: config({ maxFileBytes: 1000 }) });
    const byPath = Object.fromEntries(r.files.map((f) => [f.path, f]));
    expect(byPath['img.bin']!.binary).toBe(true);
    expect(byPath['big.txt']!.large).toBe(true);
    expect(byPath['big.txt']!.hash.startsWith('meta:')).toBe(true);
    expect(r.skippedBinary).toBe(1);
    expect(r.skippedLarge).toBe(1);
  });

  it.skipIf(process.platform === 'win32')('does not follow symlinks outside the root and survives loops', async () => {
    const outside = await makeProject({ 'leak.txt': 'outside' });
    const dir = await makeProject({ 'src/a.ts': 'a' });
    await fs.symlink(outside, path.join(dir, 'escape'));
    await fs.symlink(path.join(dir, 'src'), path.join(dir, 'src', 'loop'));
    const r = await walkProject(dir, { config: config() });
    expect(r.files.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports unreadable directories as warnings', async () => {
    const dir = await makeProject({ 'locked/a.ts': 'a', 'b.ts': 'b' });
    await fs.chmod(path.join(dir, 'locked'), 0o000);
    try {
      const r = await walkProject(dir, { config: config() });
      expect(r.files.map((f) => f.path)).toEqual(['b.ts']);
      expect(r.warnings.join()).toMatch(/Cannot read directory locked/);
    } finally {
      await fs.chmod(path.join(dir, 'locked'), 0o755);
    }
  });

  it('stops at maxFiles and warns', async () => {
    const files = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}.txt`, String(i)]));
    const dir = await makeProject(files);
    const r = await walkProject(dir, { config: config({ maxFiles: 10 }) });
    expect(r.files.length).toBe(10);
    expect(r.truncated).toBe(true);
  });

  it('honors abort signals', async () => {
    const dir = await makeProject({ 'a.txt': 'a' });
    const ac = new AbortController();
    ac.abort();
    await expect(walkProject(dir, { config: config(), signal: ac.signal })).rejects.toThrow();
  });

  it('reuses hashes when size and mtime match', async () => {
    const dir = await makeProject({ 'a.txt': 'hello' });
    const first = await walkProject(dir, { config: config() });
    const f = first.files[0]!;
    const second = await walkProject(dir, { config: config(), reuse: { 'a.txt': { h: 'cached', s: f.size, m: f.mtimeMs } } });
    expect(second.files[0]!.hash).toBe('cached');
  });
});

describe('path utilities', () => {
  it('normalizes to POSIX', () => {
    expect(toPosix(['src', 'api', 'x.ts'].join(path.sep))).toBe('src/api/x.ts');
    expect(toPosix('src\\api\\x.ts')).toBe('src/api/x.ts');
    expect(relPosix(path.join(os.tmpdir(), 'p'), path.join(os.tmpdir(), 'p', 'a', 'b.ts'))).toBe('a/b.ts');
  });

  it('rejects path traversal', () => {
    const root = path.join(os.tmpdir(), 'root');
    expect(resolveInside(root, 'a/b.md')).toBe(path.join(root, 'a', 'b.md'));
    expect(resolveInside(root, '../etc/passwd')).toBeNull();
    expect(resolveInside(root, 'a/../../x')).toBeNull();
    expect(resolveInside(root, path.resolve('/etc/passwd'))).toBeNull();
    expect(resolveInside(root, 'a\0b')).toBeNull();
  });
});
