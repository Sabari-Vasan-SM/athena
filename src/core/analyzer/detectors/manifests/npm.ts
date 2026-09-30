import { parse as parseYaml } from 'yaml';
import type { FactDef } from '../../context.js';
import type { Command } from '../../../model/project-model.js';
import { commandPurpose, isObj, keys, type Obj, type Parsed, type Warn } from './shared.js';

export function parseNpm(text: string, p: string, warn: Warn): Parsed | null {
  if (!text) return null;
  let json: Obj;
  try {
    json = JSON.parse(text) as Obj;
  } catch {
    warn(`Could not parse ${p} (invalid JSON)`);
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

export function parsePnpmWorkspace(text: string): string[] | undefined {
  if (!text) return undefined;
  try {
    const y = parseYaml(text) as Obj;
    return Array.isArray(y.packages) ? y.packages.filter((x): x is string => typeof x === 'string') : undefined;
  } catch {
    return undefined;
  }
}

export interface RootPackageFact {
  /** "packageManager" name, if declared. */
  pm: string | null;
  description: string | null;
  /** [path, detail] for "main"/"module"/"bin" entries. */
  entries: Array<[string, string]>;
}
export const rootPackageFact: FactDef<RootPackageFact> = {
  id: 'root-package',
  applies: (f) => f.path === 'package.json',
  compute(text) {
    const out: RootPackageFact = { pm: null, description: null, entries: [] };
    if (!text) return out;
    out.pm = /"packageManager"\s*:\s*"([a-z]+)@/.exec(text)?.[1] ?? null;
    try {
      const d = (JSON.parse(text) as Obj).description;
      if (typeof d === 'string' && d.trim()) out.description = d.trim();
    } catch {
      /* already warned */
    }
    try {
      const j = JSON.parse(text) as Obj;
      for (const field of ['main', 'module']) {
        const v = j[field];
        if (typeof v === 'string') out.entries.push([v.replace(/^\.\//, ''), `"${field}" field`]);
      }
      if (isObj(j.bin)) for (const v of Object.values(j.bin)) if (typeof v === 'string') out.entries.push([v.replace(/^\.\//, ''), '"bin" field']);
    } catch {
      /* ignore */
    }
    return out;
  },
};

export const pnpmWorkspaceFact: FactDef<string[] | false> = {
  id: 'pnpm-workspace',
  applies: (f) => f.path === 'pnpm-workspace.yaml',
  compute: (text) => parsePnpmWorkspace(text) ?? false,
};
