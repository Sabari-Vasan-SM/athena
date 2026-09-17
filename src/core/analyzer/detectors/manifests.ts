import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import ignoreFactory from 'ignore';
import type { AnalysisContext, Detector } from '../context.js';
import type { Command, Manifest, WorkspacePackage } from '../../model/project-model.js';
import { detected, fact } from '../../model/fact.js';
import { baseName, dirOf } from '../../util/paths.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: unknown): string[] => (isObj(v) ? Object.keys(v) : []);

interface Parsed {
  manifest: Manifest;
  workspaceGlobs?: string[];
  workspaceTool?: string;
  commands?: Command[];
}

function commandPurpose(name: string, cmd: string): Command['purpose'] {
  const n = name.toLowerCase();
  if (/^(dev|develop|serve|watch)(:|$)/.test(n)) return 'dev';
  if (/^build(:|$)/.test(n)) return 'build';
  if (/^(test|e2e|spec|coverage)(:|$)/.test(n) || /\b(jest|vitest|pytest|playwright|cypress)\b/.test(cmd)) return 'test';
  if (/^lint(:|$)|typecheck|type-check/.test(n)) return 'lint';
  if (/^(format|fmt|prettier)(:|$)/.test(n)) return 'format';
  if (/^start(:|$)/.test(n)) return 'start';
  if (/migrat|db:/.test(n)) return 'migrate';
  if (/deploy|release|publish/.test(n)) return 'deploy';
  return 'other';
}

async function parseNpm(ctx: AnalysisContext, p: string): Promise<Parsed | null> {
  const text = await ctx.read(p);
  if (!text) return null;
  let json: Obj;
  try {
    json = JSON.parse(text) as Obj;
  } catch {
    ctx.warn(`Could not parse ${p} (invalid JSON)`);
    return null;
  }
  const scripts = isObj(json.scripts) ? json.scripts : {};
  const commands: Command[] = Object.entries(scripts)
    .filter(([, v]) => typeof v === 'string')
    .map(([name, v]) => ({ name, command: v as string, source: p, purpose: commandPurpose(name, v as string) }));
  let workspaceGlobs: string[] | undefined;
  if (Array.isArray(json.workspaces)) workspaceGlobs = json.workspaces.filter((x): x is string => typeof x === 'string');
  else if (isObj(json.workspaces) && Array.isArray(json.workspaces.packages)) workspaceGlobs = (json.workspaces.packages as unknown[]).filter((x): x is string => typeof x === 'string');
  return {
    manifest: {
      path: p,
      ecosystem: 'npm',
      name: typeof json.name === 'string' ? json.name : undefined,
      version: typeof json.version === 'string' ? json.version : undefined,
      dependencies: [...keys(json.dependencies), ...keys(json.peerDependencies)],
      devDependencies: keys(json.devDependencies),
    },
    workspaceGlobs,
    workspaceTool: workspaceGlobs ? 'npm/yarn workspaces' : undefined,
    commands,
  };
}

function pyReqName(spec: string): string | null {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec);
  return m ? m[1]!.toLowerCase().replace(/_/g, '-') : null;
}

async function parsePyproject(ctx: AnalysisContext, p: string): Promise<Parsed | null> {
  const text = await ctx.read(p);
  if (!text) return null;
  let t: Obj;
  try {
    t = parseToml(text) as Obj;
  } catch {
    ctx.warn(`Could not parse ${p} (invalid TOML)`);
    return null;
  }
  const project = isObj(t.project) ? t.project : {};
  const tool = isObj(t.tool) ? t.tool : {};
  const poetry = isObj(tool.poetry) ? tool.poetry : {};
  const deps = new Set<string>();
  const dev = new Set<string>();
  for (const d of Array.isArray(project.dependencies) ? project.dependencies : []) {
    const n = typeof d === 'string' ? pyReqName(d) : null;
    if (n) deps.add(n);
  }
  if (isObj(project['optional-dependencies'])) {
    for (const group of Object.values(project['optional-dependencies'])) {
      for (const d of Array.isArray(group) ? group : []) {
        const n = typeof d === 'string' ? pyReqName(d) : null;
        if (n) dev.add(n);
      }
    }
  }
  if (isObj(t['dependency-groups'])) {
    for (const group of Object.values(t['dependency-groups'])) {
      for (const d of Array.isArray(group) ? group : []) {
        const n = typeof d === 'string' ? pyReqName(d) : null;
        if (n) dev.add(n);
      }
    }
  }
  for (const k of keys(poetry.dependencies)) if (k.toLowerCase() !== 'python') deps.add(k.toLowerCase());
  for (const k of keys(poetry['dev-dependencies'])) dev.add(k.toLowerCase());
  if (isObj(poetry.group)) for (const g of Object.values(poetry.group)) if (isObj(g)) for (const k of keys(g.dependencies)) dev.add(k.toLowerCase());
  const commands: Command[] = [];
  const scripts = isObj(project.scripts) ? project.scripts : isObj(poetry.scripts) ? poetry.scripts : {};
  for (const [name, v] of Object.entries(scripts)) if (typeof v === 'string') commands.push({ name, command: v, source: p, purpose: commandPurpose(name, v) });
  const uvWs = isObj(tool.uv) && isObj(tool.uv.workspace) && Array.isArray(tool.uv.workspace.members) ? (tool.uv.workspace.members as string[]) : undefined;
  return {
    manifest: {
      path: p,
      ecosystem: 'python',
      name: typeof project.name === 'string' ? project.name : typeof poetry.name === 'string' ? poetry.name : undefined,
      version: typeof project.version === 'string' ? project.version : undefined,
      dependencies: [...deps],
      devDependencies: [...dev],
    },
    workspaceGlobs: uvWs,
    workspaceTool: uvWs ? 'uv workspace' : undefined,
    commands,
  };
}

async function parseRequirements(ctx: AnalysisContext, p: string): Promise<Parsed | null> {
  const text = await ctx.read(p);
  if (text === null) return null;
  const deps: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith('#') || l.startsWith('-')) continue;
    const n = pyReqName(l);
    if (n) deps.push(n);
  }
  const isDev = /dev|test|lint/i.test(baseName(p));
  return { manifest: { path: p, ecosystem: 'python', dependencies: isDev ? [] : deps, devDependencies: isDev ? deps : [] } };
}

async function parsePipfile(ctx: AnalysisContext, p: string): Promise<Parsed | null> {
  const text = await ctx.read(p);
  if (!text) return null;
  try {
    const t = parseToml(text) as Obj;
    return { manifest: { path: p, ecosystem: 'python', dependencies: keys(t.packages).map((k) => k.toLowerCase()), devDependencies: keys(t['dev-packages']).map((k) => k.toLowerCase()) } };
  } catch {
    ctx.warn(`Could not parse ${p}`);
    return null;
  }
}

async function parseGoMod(ctx: AnalysisContext, p: string): Promise<Parsed | null> {
  const text = await ctx.read(p);
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

async function parseGoWork(ctx: AnalysisContext, p: string): Promise<Parsed | null> {
  const text = await ctx.read(p);
  if (!text) return null;
  const members: string[] = [];
  for (const m of text.matchAll(/use\s*\(([\s\S]*?)\)/g)) for (const l of m[1]!.split('\n')) if (l.trim()) members.push(l.trim().replace(/^\.\//, ''));
  for (const m of text.matchAll(/^use\s+(\S+)/gm)) if (m[1] !== '(') members.push(m[1]!.replace(/^\.\//, ''));
  return { manifest: { path: p, ecosystem: 'go', dependencies: [], devDependencies: [] }, workspaceGlobs: members, workspaceTool: 'go workspace' };
}

async function parseCargo(ctx: AnalysisContext, p: string): Promise<Parsed | null> {
  const text = await ctx.read(p);
  if (!text) return null;
  let t: Obj;
  try {
    t = parseToml(text) as Obj;
  } catch {
    ctx.warn(`Could not parse ${p} (invalid TOML)`);
    return null;
  }
  const pkg = isObj(t.package) ? t.package : {};
  const ws = isObj(t.workspace) && Array.isArray(t.workspace.members) ? (t.workspace.members as string[]) : undefined;
  return {
    manifest: {
      path: p,
      ecosystem: 'cargo',
      name: typeof pkg.name === 'string' ? pkg.name : undefined,
      version: typeof pkg.version === 'string' ? pkg.version : undefined,
      dependencies: keys(t.dependencies),
      devDependencies: keys(t['dev-dependencies']),
    },
    workspaceGlobs: ws,
    workspaceTool: ws ? 'cargo workspace' : undefined,
  };
}

async function parsePom(ctx: AnalysisContext, p: string): Promise<Parsed | null> {
  const text = await ctx.read(p);
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

async function parseGradle(ctx: AnalysisContext, p: string): Promise<Parsed | null> {
  const text = await ctx.read(p);
  if (!text) return null;
  const deps: string[] = [];
  const dev: string[] = [];
  for (const m of text.matchAll(/\b(implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|kapt|ksp|annotationProcessor)\s*\(?\s*["']([^"':]+):([^"':]+)(?::[^"']*)?["']/g)) {
    (m[1]!.startsWith('test') ? dev : deps).push(m[3]!);
  }
  return { manifest: { path: p, ecosystem: 'gradle', dependencies: deps, devDependencies: dev } };
}

async function parseGradleSettings(ctx: AnalysisContext, p: string): Promise<Parsed | null> {
  const text = await ctx.read(p);
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

async function parseComposer(ctx: AnalysisContext, p: string): Promise<Parsed | null> {
  const text = await ctx.read(p);
  if (!text) return null;
  try {
    const j = JSON.parse(text) as Obj;
    const scripts = isObj(j.scripts) ? j.scripts : {};
    const commands = Object.entries(scripts).filter(([, v]) => typeof v === 'string').map(([name, v]) => ({ name, command: v as string, source: p, purpose: commandPurpose(name, v as string) }));
    return {
      manifest: { path: p, ecosystem: 'composer', name: typeof j.name === 'string' ? j.name : undefined, dependencies: keys(j.require).filter((k) => k !== 'php' && !k.startsWith('ext-')), devDependencies: keys(j['require-dev']) },
      commands,
    };
  } catch {
    ctx.warn(`Could not parse ${p} (invalid JSON)`);
    return null;
  }
}

async function parseCsproj(ctx: AnalysisContext, p: string): Promise<Parsed | null> {
  const text = await ctx.read(p);
  if (!text) return null;
  const deps = [...text.matchAll(/<PackageReference\s+Include=["']([^"']+)["']/g)].map((m) => m[1]!);
  if (/Sdk=["']Microsoft\.NET\.Sdk\.Web["']/.test(text)) deps.push('Microsoft.AspNetCore.App');
  const isTest = /xunit|nunit|mstest/i.test(deps.join(' '));
  return { manifest: { path: p, ecosystem: 'nuget', name: baseName(p).replace(/\.(cs|fs|vb)proj$/, ''), dependencies: isTest ? [] : deps, devDependencies: isTest ? deps : [] } };
}

async function parseGemfile(ctx: AnalysisContext, p: string): Promise<Parsed | null> {
  const text = await ctx.read(p);
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

async function parsePubspec(ctx: AnalysisContext, p: string): Promise<Parsed | null> {
  const text = await ctx.read(p);
  if (!text) return null;
  try {
    const y = parseYaml(text) as Obj;
    return { manifest: { path: p, ecosystem: 'pub', name: typeof y.name === 'string' ? y.name : undefined, dependencies: keys(y.dependencies), devDependencies: keys(y.dev_dependencies) } };
  } catch {
    ctx.warn(`Could not parse ${p} (invalid YAML)`);
    return null;
  }
}

async function parseMix(ctx: AnalysisContext, p: string): Promise<Parsed | null> {
  const text = await ctx.read(p);
  if (!text) return null;
  const deps = [...text.matchAll(/\{\s*:([a-z0-9_]+)\s*,/g)].map((m) => m[1]!);
  const name = /app:\s*:([a-z0-9_]+)/.exec(text)?.[1];
  return { manifest: { path: p, ecosystem: 'hex', name, dependencies: deps, devDependencies: [] } };
}

async function parsePnpmWorkspace(ctx: AnalysisContext, p: string): Promise<string[] | undefined> {
  const text = await ctx.read(p);
  if (!text) return undefined;
  try {
    const y = parseYaml(text) as Obj;
    return Array.isArray(y.packages) ? y.packages.filter((x): x is string => typeof x === 'string') : undefined;
  } catch {
    return undefined;
  }
}

const PARSERS: Array<[RegExp, (ctx: AnalysisContext, p: string) => Promise<Parsed | null>]> = [
  [/(^|\/)package\.json$/, parseNpm],
  [/(^|\/)pyproject\.toml$/, parsePyproject],
  [/(^|\/)requirements[^/]*\.txt$/, parseRequirements],
  [/(^|\/)Pipfile$/, parsePipfile],
  [/(^|\/)go\.mod$/, parseGoMod],
  [/(^|\/)go\.work$/, parseGoWork],
  [/(^|\/)Cargo\.toml$/, parseCargo],
  [/(^|\/)pom\.xml$/, parsePom],
  [/(^|\/)build\.gradle(\.kts)?$/, parseGradle],
  [/(^|\/)settings\.gradle(\.kts)?$/, parseGradleSettings],
  [/(^|\/)composer\.json$/, parseComposer],
  [/\.(cs|fs|vb)proj$/, parseCsproj],
  [/(^|\/)Gemfile$/, parseGemfile],
  [/(^|\/)pubspec\.yaml$/, parsePubspec],
  [/(^|\/)mix\.exs$/, parseMix],
];

const LOCKFILES: Array<[RegExp, string]> = [
  [/(^|\/)package-lock\.json$/, 'npm'],
  [/(^|\/)npm-shrinkwrap\.json$/, 'npm'],
  [/(^|\/)yarn\.lock$/, 'yarn'],
  [/(^|\/)pnpm-lock\.yaml$/, 'pnpm'],
  [/(^|\/)bun\.lockb?$/, 'bun'],
  [/(^|\/)poetry\.lock$/, 'poetry'],
  [/(^|\/)uv\.lock$/, 'uv'],
  [/(^|\/)Pipfile\.lock$/, 'pipenv'],
  [/(^|\/)pdm\.lock$/, 'pdm'],
  [/(^|\/)go\.sum$/, 'go modules'],
  [/(^|\/)Cargo\.lock$/, 'cargo'],
  [/(^|\/)composer\.lock$/, 'composer'],
  [/(^|\/)Gemfile\.lock$/, 'bundler'],
  [/(^|\/)pubspec\.lock$/, 'pub'],
  [/(^|\/)mix\.lock$/, 'mix'],
  [/(^|\/)packages\.lock\.json$/, 'nuget'],
];

const BUILD_SYSTEMS: Array<[RegExp, string]> = [
  [/(^|\/)turbo\.json$/, 'Turborepo'],
  [/(^|\/)nx\.json$/, 'Nx'],
  [/(^|\/)lerna\.json$/, 'Lerna'],
  [/(^|\/)(vite|vitest)\.config\.(js|ts|mjs|cjs)$/, 'Vite'],
  [/(^|\/)webpack\.config\.(js|ts|cjs|mjs)$/, 'webpack'],
  [/(^|\/)rollup\.config\.(js|ts|mjs)$/, 'Rollup'],
  [/(^|\/)tsup\.config\.(js|ts)$/, 'tsup'],
  [/(^|\/)tsconfig\.json$/, 'TypeScript compiler'],
  [/(^|\/)(Makefile|makefile|GNUmakefile)$/, 'Make'],
  [/(^|\/)justfile$/i, 'just'],
  [/(^|\/)Taskfile\.ya?ml$/, 'Task'],
  [/(^|\/)CMakeLists\.txt$/, 'CMake'],
  [/(^|\/)BUILD(\.bazel)?$|(^|\/)WORKSPACE(\.bazel)?$|(^|\/)MODULE\.bazel$/, 'Bazel'],
  [/(^|\/)build\.gradle(\.kts)?$/, 'Gradle'],
  [/(^|\/)pom\.xml$/, 'Maven'],
  [/\.sln$/, '.NET solution'],
];

export const manifestsDetector: Detector = {
  id: 'manifests',
  version: 1,
  async run(ctx) {
    const { model } = ctx;
    const parsed: Parsed[] = [];
    for (const [re, parser] of PARSERS) {
      for (const f of ctx.find(re)) {
        ctx.signal?.throwIfAborted();
        const r = await parser(ctx, f.path);
        if (r) parsed.push(r);
      }
    }
    parsed.sort((a, b) => a.manifest.path.localeCompare(b.manifest.path));
    model.manifests = parsed.map((p) => p.manifest);
    model.commands.push(...parsed.flatMap((p) => p.commands ?? []));

    // Makefile / justfile targets
    for (const f of ctx.find(/(^|\/)(Makefile|makefile|justfile)$/)) {
      if (f.path.split('/').length > 3) continue;
      const text = await ctx.read(f.path);
      if (!text) continue;
      const isJust = baseName(f.path) === 'justfile';
      for (const m of text.matchAll(/^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/gm)) {
        const name = m[1]!;
        if (name === 'PHONY' || name.startsWith('.')) continue;
        model.commands.push({ name, command: isJust ? `just ${name}` : `make ${name}`, source: f.path, purpose: commandPurpose(name, '') });
      }
    }

    // Package managers
    const pm = new Map<string, string[]>();
    for (const [re, name] of LOCKFILES) for (const f of ctx.find(re)) pm.set(name, [...(pm.get(name) ?? []), f.path]);
    for (const m of parsed) {
      const eco = m.manifest.ecosystem;
      const implied = eco === 'python' && baseName(m.manifest.path).startsWith('requirements') ? 'pip' : eco === 'maven' ? 'maven' : eco === 'gradle' ? 'gradle' : eco === 'nuget' ? 'dotnet' : null;
      if (implied && !pm.has(implied)) pm.set(implied, [m.manifest.path]);
    }
    const rootPkg = parsed.find((p) => p.manifest.path === 'package.json');
    if (rootPkg) {
      const text = await ctx.read('package.json');
      const declared = text ? /"packageManager"\s*:\s*"([a-z]+)@/.exec(text)?.[1] : undefined;
      if (declared && !pm.has(declared)) pm.set(declared, ['package.json']);
    }
    model.packageManagers = [...pm.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, files]) => ({
      name,
      provenance: detected('filesystem', files.slice(0, 5).map((file) => ({ file }))),
    }));

    // Build systems
    const bs = new Map<string, string[]>();
    for (const [re, name] of BUILD_SYSTEMS) for (const f of ctx.find(re)) bs.set(name, [...(bs.get(name) ?? []), f.path]);
    model.buildSystems = [...bs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, files]) => ({
      name,
      provenance: detected('filesystem', files.slice(0, 5).map((file) => ({ file }))),
    }));

    // Workspace / monorepo
    const globs: string[] = [];
    let tool: string | undefined;
    for (const p of parsed) {
      if (p.workspaceGlobs?.length && dirOf(p.manifest.path) === '.') {
        globs.push(...p.workspaceGlobs);
        tool ??= p.workspaceTool;
      }
    }
    if (ctx.has('pnpm-workspace.yaml')) {
      const g = await parsePnpmWorkspace(ctx, 'pnpm-workspace.yaml');
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

    const rootManifest = model.manifests.find((m) => dirOf(m.path) === '.' && m.name);
    if (rootManifest?.name) model.name = rootManifest.name;
    const pkgJson = rootPkg ? await ctx.read('package.json') : null;
    if (pkgJson) {
      try {
        const d = (JSON.parse(pkgJson) as Obj).description;
        if (typeof d === 'string' && d.trim()) model.description = d.trim();
      } catch {
        /* already warned */
      }
    }

    // Record root manifest names as FACT-level provenance on entry points where declared.
    if (pkgJson) {
      try {
        const j = JSON.parse(pkgJson) as Obj;
        for (const field of ['main', 'module']) {
          const v = j[field];
          if (typeof v === 'string') model.entryPoints.push({ path: v.replace(/^\.\//, ''), provenance: fact('config', [{ file: 'package.json', detail: `"${field}" field` }]) });
        }
        if (isObj(j.bin)) for (const v of Object.values(j.bin)) if (typeof v === 'string') model.entryPoints.push({ path: v.replace(/^\.\//, ''), provenance: fact('config', [{ file: 'package.json', detail: '"bin" field' }]) });
      } catch {
        /* ignore */
      }
    }
  },
};
