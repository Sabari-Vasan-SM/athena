import { parse as parseToml } from 'smol-toml';
import type { Command } from '../../../model/project-model.js';
import { baseName } from '../../../util/paths.js';
import { commandPurpose, isObj, keys, type Obj, type Parsed, type Warn } from './shared.js';

function pyReqName(spec: string): string | null {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec);
  return m ? m[1]!.toLowerCase().replace(/_/g, '-') : null;
}

export function parsePyproject(text: string, p: string, warn: Warn): Parsed | null {
  if (!text) return null;
  let t: Obj;
  try {
    t = parseToml(text) as Obj;
  } catch {
    warn(`Could not parse ${p} (invalid TOML)`);
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

export function parseRequirements(text: string, p: string, warn: Warn): Parsed | null {
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

export function parsePipfile(text: string, p: string, warn: Warn): Parsed | null {
  if (!text) return null;
  try {
    const t = parseToml(text) as Obj;
    return { manifest: { path: p, ecosystem: 'python', dependencies: keys(t.packages).map((k) => k.toLowerCase()), devDependencies: keys(t['dev-packages']).map((k) => k.toLowerCase()) } };
  } catch {
    warn(`Could not parse ${p}`);
    return null;
  }
}
