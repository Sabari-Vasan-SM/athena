import type { Parsed, Warn } from './shared.js';

export function parsePom(text: string, p: string, warn: Warn): Parsed | null {
  if (!text) return null;
  const noParent = text.replace(/<parent>[\s\S]*?<\/parent>/, '').replace(/<dependencies>[\s\S]*<\/dependencies>/, '').replace(/<build>[\s\S]*<\/build>/, '');
  const name = /<artifactId>([^<]+)<\/artifactId>/.exec(noParent)?.[1];
  const deps: string[] = [];
  const dev: string[] = [];
  for (const m of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const a = /<artifactId>([^<]+)<\/artifactId>/.exec(m[1]!)?.[1];
    if (!a) continue;
    if (/<scope>\s*test\s*<\/scope>/.test(m[1]!)) dev.push(a);
    else deps.push(a);
  }
  const modules = [...text.matchAll(/<module>([^<]+)<\/module>/g)].map((m) => m[1]!.trim());
  return {
    manifest: { path: p, ecosystem: 'maven', name, dependencies: deps, devDependencies: dev },
    workspaceGlobs: modules.length ? modules : undefined,
    workspaceTool: modules.length ? 'maven multi-module' : undefined,
  };
}
