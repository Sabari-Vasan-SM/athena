import { baseName } from '../../../util/paths.js';
import type { Parsed, Warn } from './shared.js';

export function parseCsproj(text: string, p: string, warn: Warn): Parsed | null {
  if (!text) return null;
  const deps = [...text.matchAll(/<PackageReference\s+Include=["']([^"']+)["']/g)].map((m) => m[1]!);
  if (/Sdk=["']Microsoft\.NET\.Sdk\.Web["']/.test(text)) deps.push('Microsoft.AspNetCore.App');
  const isTest = /xunit|nunit|mstest/i.test(deps.join(' '));
  return { manifest: { path: p, ecosystem: 'nuget', name: baseName(p).replace(/\.(cs|fs|vb)proj$/, ''), dependencies: isTest ? [] : deps, devDependencies: isTest ? deps : [] } };
}
