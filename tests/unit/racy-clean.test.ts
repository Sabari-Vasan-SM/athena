import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { walkProject } from '../../src/core/fs/walker.js';
import { AthenaConfig } from '../../src/core/config.js';
import { RACY_WINDOW_MS, readFileIndex, writeFileIndex, type FileIndex } from '../../src/core/state/state.js';
import { sha256 } from '../../src/core/util/fs.js';
import { cleanupProjects, makeProject } from '../helpers.js';

afterAll(cleanupProjects);

const config = AthenaConfig.parse({});

/**
 * "Racily clean": a file edited in the same clock tick as the index was written keeps its
 * size and mtime, so a stat-only check can't see the edit. Like Git, the index writer
 * stores an unmatchable mtime for such entries, forcing a re-read on the next walk.
 */
describe('racily clean index entries', () => {
  async function setup() {
    const dir = await makeProject({ 'a.ts': 'export const x = 1;\n' });
    const file = path.join(dir, 'a.ts');
    const st = await fs.stat(file);
    const entry = { h: sha256('export const x = 1;\n'), s: st.size, m: Math.floor(st.mtimeMs) };
    // Same size, same mtime, different content: invisible to the stat.
    await fs.writeFile(file, 'export const x = 2;\n');
    await fs.utimes(file, st.atime, st.mtime);
    return { dir, entry };
  }

  const hashAfterWalk = async (dir: string, reuse: FileIndex) => (await walkProject(dir, { config, reuse })).files.find((f) => f.path === 'a.ts')!.hash;

  it('an index written within the window forces a re-read, so the edit is seen', async () => {
    const { dir, entry } = await setup();
    const athena = path.join(dir, '.athena');
    await writeFileIndex(athena, { 'a.ts': entry }, entry.m + 10); // written 10 ms after the file changed
    const reuse = await readFileIndex(athena);
    expect(reuse['a.ts']!.m).toBe(-1);
    expect(await hashAfterWalk(dir, reuse)).toBe(sha256('export const x = 2;\n'));
  });

  it('without the protection the stat would be trusted and the edit missed (why it exists)', async () => {
    const { dir, entry } = await setup();
    // Simulate an index written long after the file changed: the entry is trusted as-is.
    expect(await hashAfterWalk(dir, { 'a.ts': entry })).toBe(sha256('export const x = 1;\n'));
  });

  it('entries older than the window keep their real mtime (no needless re-reads)', async () => {
    const { dir, entry } = await setup();
    const athena = path.join(dir, '.athena');
    await writeFileIndex(athena, { 'a.ts': entry }, entry.m + RACY_WINDOW_MS + 1);
    expect((await readFileIndex(athena))['a.ts']!.m).toBe(entry.m);
  });
});
