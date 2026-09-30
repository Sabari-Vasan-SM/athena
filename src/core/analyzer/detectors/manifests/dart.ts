import { parse as parseYaml } from 'yaml';
import { keys, type Obj, type Parsed, type Warn } from './shared.js';

export function parsePubspec(text: string, p: string, warn: Warn): Parsed | null {
  if (!text) return null;
  try {
    const y = parseYaml(text) as Obj;
    return { manifest: { path: p, ecosystem: 'pub', name: typeof y.name === 'string' ? y.name : undefined, dependencies: keys(y.dependencies), devDependencies: keys(y.dev_dependencies) } };
  } catch {
    warn(`Could not parse ${p} (invalid YAML)`);
    return null;
  }
}
