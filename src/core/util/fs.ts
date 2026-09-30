import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Write a file atomically: write to a temp file in the same dir, then rename. */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, data, 'utf8');
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readTextIfExists(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export type InsideRootRead =
  | { ok: true; text: string; bytes: number }
  | { ok: false; reason: 'missing' | 'outside-root' | 'too-large' | 'not-a-file' | 'unreadable'; bytes?: number };

/**
 * Read `rel` (relative to `root`) as UTF-8 without following a symlink out of
 * `root`, and without reading more than `maxBytes`. Never throws for per-file
 * problems: the reason is returned so callers can report the file as skipped.
 */
export async function readTextInsideRoot(root: string, rel: string, maxBytes: number): Promise<InsideRootRead> {
  const abs = path.resolve(root, rel);
  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  const inside = (p: string) => {
    const r = path.relative(realRoot, p);
    return r === '' || (!r.startsWith(`..${path.sep}`) && r !== '..' && !path.isAbsolute(r));
  };
  let target = abs;
  try {
    const st = await fs.lstat(abs);
    if (st.isSymbolicLink() || !inside(await fs.realpath(path.dirname(abs)))) {
      target = await fs.realpath(abs);
      if (!inside(target)) return { ok: false, reason: 'outside-root' };
    }
  } catch (err) {
    return { ok: false, reason: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(target, 'r');
    const st = await handle.stat();
    if (!st.isFile()) return { ok: false, reason: 'not-a-file' };
    if (st.size > maxBytes) return { ok: false, reason: 'too-large', bytes: st.size };
    const buf = Buffer.alloc(maxBytes + 1);
    let n = 0;
    while (n < buf.length) {
      const { bytesRead } = await handle.read(buf, n, buf.length - n, n);
      if (!bytesRead) break;
      n += bytesRead;
    }
    if (n > maxBytes) return { ok: false, reason: 'too-large', bytes: n };
    return { ok: true, text: buf.subarray(0, n).toString('utf8'), bytes: n };
  } catch (err) {
    return { ok: false, reason: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' };
  } finally {
    await handle?.close().catch(() => {});
  }
}
