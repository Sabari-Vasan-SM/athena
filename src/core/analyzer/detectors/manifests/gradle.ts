import type { Parsed, Warn } from './shared.js';

export function parseGradle(text: string, p: string, warn: Warn): Parsed | null {
  if (!text) return null;
  const deps: string[] = [];
  const dev: string[] = [];
  for (const m of text.matchAll(/\b(implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|kapt|ksp|annotationProcessor)\s*\(?\s*["']([^"':]+):([^"':]+)(?::[^"']*)?["']/g)) {
    (m[1]!.startsWith('test') ? dev : deps).push(m[3]!);
  }
  return { manifest: { path: p, ecosystem: 'gradle', dependencies: deps, devDependencies: dev } };
}

export function parseGradleSettings(text: string, p: string, warn: Warn): Parsed | null {
  if (!text) return null;
  const members: string[] = [];
  for (const m of text.matchAll(/include\s*\(?([^)\n]+)\)?/g)) {
    for (const s of m[1]!.matchAll(/["']:?([^"']+)["']/g)) members.push(s[1]!.replace(/:/g, '/'));
  }
  const name = /rootProject\.name\s*=\s*["']([^"']+)["']/.exec(text)?.[1];
  return {
    manifest: { path: p, ecosystem: 'gradle', name, dependencies: [], devDependencies: [] },
    workspaceGlobs: members.length ? members : undefined,
    workspaceTool: members.length ? 'gradle multi-project' : undefined,
  };
}
