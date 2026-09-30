import { parse as parseToml } from 'smol-toml';
import { isObj, keys, type Obj, type Parsed, type Warn } from './shared.js';

export function parseCargo(text: string, p: string, warn: Warn): Parsed | null {
  if (!text) return null;
  let t: Obj;
  try {
    t = parseToml(text) as Obj;
  } catch {
    warn(`Could not parse ${p} (invalid TOML)`);
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
