import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Resolve an executable on PATH without running a shell. Returns null when not found. */
export async function whichExecutable(command: string): Promise<string | null> {
  if (command.includes('/') || command.includes('\\')) {
    return (await fs.access(command).then(() => true).catch(() => false)) ? command : null;
  }
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext.toLowerCase());
      try {
        const st = await fs.stat(candidate);
        if (st.isFile()) return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}
