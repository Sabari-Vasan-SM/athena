import type { Parsed, Warn } from './shared.js';

export function parseGoMod(text: string, p: string, warn: Warn): Parsed | null {
  if (!text) return null;
  const mod = /^module\s+(\S+)/m.exec(text)?.[1];
  const deps = new Set<string>();
  const block = /require\s*\(([\s\S]*?)\)/g;
  for (const m of text.matchAll(block)) for (const line of m[1]!.split('\n')) {
    const dep = /^\s*(\S+)\s+v/.exec(line)?.[1];
    if (dep) deps.add(dep);
  }
  for (const m of text.matchAll(/^require\s+(\S+)\s+v/gm)) deps.add(m[1]!);
  return { manifest: { path: p, ecosystem: 'go', name: mod, dependencies: [...deps], devDependencies: [] } };
}

export function parseGoWork(text: string, p: string, warn: Warn): Parsed | null {
  if (!text) return null;
  const members: string[] = [];
  for (const m of text.matchAll(/use\s*\(([\s\S]*?)\)/g)) for (const l of m[1]!.split('\n')) if (l.trim()) members.push(l.trim().replace(/^\.\//, ''));
  for (const m of text.matchAll(/^use\s+(\S+)/gm)) if (m[1] !== '(') members.push(m[1]!.replace(/^\.\//, ''));
  return { manifest: { path: p, ecosystem: 'go', dependencies: [], devDependencies: [] }, workspaceGlobs: members, workspaceTool: 'go workspace' };
}
