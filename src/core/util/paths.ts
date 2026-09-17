import path from 'node:path';

/** Convert an OS path to a POSIX-style path (stable across Windows/macOS/Linux). */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/').replace(/\\/g, '/');
}

/** Repo-relative POSIX path. */
export function relPosix(root: string, abs: string): string {
  return toPosix(path.relative(root, abs)) || '.';
}

/**
 * Resolve `candidate` inside `root`, rejecting anything that escapes it
 * (path traversal, absolute paths, drive letters).
 */
export function resolveInside(root: string, candidate: string): string | null {
  if (candidate.includes('\0')) return null;
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, candidate);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel === '' ) return resolved;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

export function dirOf(posixPath: string): string {
  const i = posixPath.lastIndexOf('/');
  return i === -1 ? '.' : posixPath.slice(0, i);
}

export function baseName(posixPath: string): string {
  const i = posixPath.lastIndexOf('/');
  return i === -1 ? posixPath : posixPath.slice(i + 1);
}
