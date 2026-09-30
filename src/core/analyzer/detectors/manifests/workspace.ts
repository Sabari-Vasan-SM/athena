import ignoreFactory from 'ignore';
import type { AnalysisContext } from '../../context.js';
import type { Manifest, WorkspacePackage } from '../../../model/project-model.js';
import { baseName, dirOf } from '../../../util/paths.js';
import { pnpmWorkspaceFact } from './npm.js';
import type { Parsed } from './shared.js';

/** Workspace / monorepo layout from root manifests' workspace globs, pnpm-workspace.yaml and monorepo tool markers. */
export async function detectWorkspace(ctx: AnalysisContext, parsed: Parsed[]): Promise<void> {
  const { model } = ctx;
  const globs: string[] = [];
  let tool: string | undefined;
  for (const p of parsed) {
    if (p.workspaceGlobs?.length && dirOf(p.manifest.path) === '.') {
      globs.push(...p.workspaceGlobs);
      tool ??= p.workspaceTool;
    }
  }
  if (ctx.has('pnpm-workspace.yaml')) {
    const g = (await ctx.fact('pnpm-workspace.yaml', pnpmWorkspaceFact)) || undefined;
    if (g?.length) {
      globs.push(...g);
      tool = 'pnpm workspaces';
    }
  }
  const markerTool = ctx.has('turbo.json') ? 'Turborepo' : ctx.has('nx.json') ? 'Nx' : ctx.has('lerna.json') ? 'Lerna' : undefined;
  if (markerTool) tool = tool ? `${tool} + ${markerTool}` : markerTool;

  const manifestDirs = new Map<string, Manifest[]>();
  for (const m of model.manifests) {
    const d = dirOf(m.path);
    manifestDirs.set(d, [...(manifestDirs.get(d) ?? []), m]);
  }
  const matcher = globs.length ? ignoreFactory().add(globs.map((g) => g.replace(/^\.\//, '').replace(/\/$/, ''))) : null;
  const pkgDirs = [...manifestDirs.keys()].filter((d) => d !== '.' && (matcher ? matcher.ignores(d) : true));
  const isMonorepo = globs.length > 0 || !!markerTool || (pkgDirs.length >= 2 && !manifestDirs.has('.'));
  model.workspace.isMonorepo = isMonorepo;
  model.workspace.tool = tool;

  const packages: WorkspacePackage[] = [];
  const dirsForPackages = isMonorepo ? ['.', ...pkgDirs] : manifestDirs.has('.') ? ['.'] : pkgDirs;
  for (const d of dirsForPackages) {
    const ms = manifestDirs.get(d);
    if (!ms) continue;
    const primary = ms.find((m) => m.name) ?? ms[0]!;
    const seg = d.split('/')[0] ?? '';
    const kind: WorkspacePackage['kind'] = d === '.' ? 'root' : /^(apps|services|examples)$/.test(seg) ? 'app' : /^(packages|libs|crates|modules|shared|internal)$/.test(seg) ? 'package' : 'unknown';
    packages.push({ name: primary.name ?? (d === '.' ? model.name : baseName(d)), path: d, kind, ecosystem: primary.ecosystem, internalDependencies: [] });
  }
  const names = new Set(packages.map((p) => p.name));
  for (const pkg of packages) {
    const deps = (manifestDirs.get(pkg.path) ?? []).flatMap((m) => [...m.dependencies, ...m.devDependencies]);
    pkg.internalDependencies = [...new Set(deps.filter((d) => names.has(d) && d !== pkg.name))].sort();
  }
  model.workspace.packages = packages;
}
