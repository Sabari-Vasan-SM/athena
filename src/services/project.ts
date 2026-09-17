import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ATHENA_DIR } from '../core/config.js';

/** Walk up from `start` to find the nearest directory containing `.athena/`. */
export async function findProjectRoot(start: string): Promise<string | null> {
  let dir = start;
  for (;;) {
    try {
      const st = await fs.stat(path.join(dir, ATHENA_DIR));
      if (st.isDirectory()) return dir;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
