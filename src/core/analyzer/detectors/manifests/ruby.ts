import type { Parsed, Warn } from './shared.js';

export function parseGemfile(text: string, p: string, warn: Warn): Parsed | null {
  if (!text) return null;
  const deps: string[] = [];
  const dev: string[] = [];
  let inDevGroup = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*group\s+.*:(development|test)/.test(line)) inDevGroup = true;
    else if (/^\s*end\b/.test(line)) inDevGroup = false;
    const m = /^\s*gem\s+["']([^"']+)["']/.exec(line);
    if (m) (inDevGroup ? dev : deps).push(m[1]!);
  }
  return { manifest: { path: p, ecosystem: 'rubygems', dependencies: deps, devDependencies: dev } };
}
