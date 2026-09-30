import type { Parsed, Warn } from './shared.js';

export function parseMix(text: string, p: string, warn: Warn): Parsed | null {
  if (!text) return null;
  const deps = [...text.matchAll(/\{\s*:([a-z0-9_]+)\s*,/g)].map((m) => m[1]!);
  const name = /app:\s*:([a-z0-9_]+)/.exec(text)?.[1];
  return { manifest: { path: p, ecosystem: 'hex', name, dependencies: deps, devDependencies: [] } };
}
