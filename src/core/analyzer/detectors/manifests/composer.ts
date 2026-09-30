import { commandPurpose, isObj, keys, type Obj, type Parsed, type Warn } from './shared.js';

export function parseComposer(text: string, p: string, warn: Warn): Parsed | null {
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
    warn(`Could not parse ${p} (invalid JSON)`);
    return null;
  }
}
