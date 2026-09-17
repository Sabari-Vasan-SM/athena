import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ATHENA_DIR } from '../core/config.js';
import { AthenaError, EXIT } from './errors.js';

export interface GlobalOptions {
  cwd?: string;
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  color?: boolean;
}

export async function resolveCwd(opts: GlobalOptions): Promise<string> {
  const dir = path.resolve(opts.cwd ?? process.cwd());
  try {
    const st = await fs.stat(dir);
    if (!st.isDirectory()) throw new AthenaError(`Not a directory: ${dir}`);
    return await fs.realpath(dir);
  } catch (err) {
    if (err instanceof AthenaError) throw err;
    throw new AthenaError(`Directory not accessible: ${dir}`, 'Check the path and your permissions.');
  }
}

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

export async function requireProjectRoot(opts: GlobalOptions): Promise<string> {
  const cwd = await resolveCwd(opts);
  const root = await findProjectRoot(cwd);
  if (!root) throw new AthenaError('Athena is not initialized in this project.', 'Run `athena init` in the project root.', EXIT.NOT_INITIALIZED);
  return root;
}
