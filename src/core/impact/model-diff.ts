import type { DocId } from '../knowledge/documents.js';
import type { ProjectModel } from '../model/project-model.js';

/**
 * Semantic impact: which parts of the structured project model changed between two
 * analyses, and which knowledge documents consume those parts. This complements the
 * path heuristics in impact.ts with evidence ("2 routes added") instead of guesses.
 */

type Key = keyof ProjectModel;

interface SectionSpec {
  label: string;
  keys: Key[];
  docs: DocId[];
  /** Identity of an array item, for added/removed summaries. */
  identity?: (item: Record<string, unknown>) => string;
  /** Human label for an item in summaries (defaults to identity). */
  display?: (item: Record<string, unknown>) => string;
  unit?: [singular: string, plural: string];
}

const named = (i: Record<string, unknown>) => String(i.name ?? i.path ?? JSON.stringify(i));

export const MODEL_SECTIONS: SectionSpec[] = [
  { label: 'Project identity', keys: ['name', 'description'], docs: ['project'] },
  { label: 'Languages', keys: ['languages'], docs: ['project'], identity: named, unit: ['language', 'languages'] },
  { label: 'Project structure', keys: ['topLevelDirs', 'stats'], docs: ['project'] },
  { label: 'Dependencies & manifests', keys: ['manifests'], docs: ['project', 'security'], identity: (i) => String(i.path), unit: ['manifest', 'manifests'] },
  { label: 'Package managers & build tools', keys: ['packageManagers', 'buildSystems'], docs: ['project'], identity: named, unit: ['tool', 'tools'] },
  { label: 'Workspace packages', keys: ['workspace'], docs: ['project', 'architecture', 'code-review', 'testing'] },
  { label: 'Frameworks', keys: ['frameworks'], docs: ['project', 'architecture', 'api', 'security', 'code-review', 'performance'], identity: (i) => `${i.name}@${i.root}`, display: (i) => String(i.name), unit: ['framework', 'frameworks'] },
  { label: 'Entry points', keys: ['entryPoints'], docs: ['project'], identity: (i) => String(i.path), unit: ['entry point', 'entry points'] },
  { label: 'Commands', keys: ['commands'], docs: ['project', 'testing', 'debugging', 'deployment', 'code-review', 'database'], identity: (i) => `${i.source}:${i.name}`, display: (i) => String(i.name), unit: ['command', 'commands'] },
  { label: 'Database technology', keys: ['databases'], docs: ['database', 'architecture', 'security', 'code-review', 'performance'], identity: named, unit: ['technology', 'technologies'] },
  { label: 'Database schema', keys: ['dbEntities'], docs: ['database', 'auth', 'performance'], identity: (i) => `${i.name}@${i.file}`, display: (i) => String(i.name), unit: ['entity', 'entities'] },
  { label: 'Migrations', keys: ['migrations'], docs: ['database', 'deployment'], identity: (i) => `${i.tool}:${i.path}`, display: (i) => String(i.path), unit: ['migration directory', 'migration directories'] },
  { label: 'API routes', keys: ['routes'], docs: ['api', 'security', 'testing', 'code-review'], identity: (i) => `${i.method} ${i.path} ${i.file}`, display: (i) => `${i.method} ${i.path}`, unit: ['route', 'routes'] },
  { label: 'API specifications', keys: ['apiSpecs'], docs: ['api', 'security'], identity: (i) => String(i.path), unit: ['spec', 'specs'] },
  { label: 'Authentication', keys: ['auth'], docs: ['auth', 'security', 'architecture'], identity: named, unit: ['auth signal', 'auth signals'] },
  { label: 'Containers', keys: ['containers'], docs: ['deployment', 'architecture', 'security'] },
  { label: 'Infrastructure', keys: ['infrastructure'], docs: ['deployment', 'architecture'], identity: (i) => `${i.name}@${i.file}`, display: (i) => String(i.name), unit: ['resource', 'resources'] },
  { label: 'CI/CD', keys: ['ci'], docs: ['deployment'], identity: (i) => `${i.system}:${i.file}:${i.name}`, unit: ['CI job', 'CI jobs'] },
  { label: 'Tests', keys: ['tests'], docs: ['testing', 'code-review'] },
  { label: 'Environment variables', keys: ['env'], docs: ['deployment', 'project', 'security'] },
  { label: 'Security findings & controls', keys: ['security'], docs: ['security'] },
  { label: 'Caching & queues', keys: ['caching', 'queues'], docs: ['performance', 'architecture', 'security'], identity: named, unit: ['technology', 'technologies'] },
  { label: 'Observability', keys: ['observability'], docs: ['debugging', 'architecture'], identity: named, unit: ['tool', 'tools'] },
  { label: 'Git hotspots', keys: ['git'], docs: ['debugging'] },
  { label: 'Analysis warnings', keys: ['warnings'], docs: ['project'] },
];

export interface ModelChange {
  label: string;
  summary: string;
  docs: DocId[];
}

function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) => (val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : val));
}

/** Git fields that change on every commit and don't affect rendered knowledge. */
function normalize(key: Key, value: unknown): unknown {
  if (key === 'git' && value && typeof value === 'object') return { hotspots: (value as ProjectModel['git']).hotspots };
  if (key === 'root') return null;
  return value;
}

export function diffModels(prev: ProjectModel | null, next: ProjectModel): ModelChange[] {
  if (!prev) return [{ label: 'Previous analysis', summary: 'no previous model.json to compare against — full comparison of rendered documents used', docs: [] }];
  const changes: ModelChange[] = [];
  for (const spec of MODEL_SECTIONS) {
    const differing = spec.keys.filter((k) => stable(normalize(k, prev[k])) !== stable(normalize(k, next[k])));
    if (!differing.length) continue;
    const parts: string[] = [];
    for (const k of differing) {
      const a = prev[k];
      const b = next[k];
      if (Array.isArray(a) && Array.isArray(b) && spec.identity) {
        const labels = new Map<string, string>();
        const ids = (xs: unknown[]) =>
          new Map(
            xs.map((x) => {
              const item = x as Record<string, unknown>;
              const id = spec.identity!(item);
              labels.set(id, (spec.display ?? spec.identity)!(item));
              return [id, stable(x)];
            }),
          );
        const ma = ids(a);
        const mb = ids(b);
        const show = (xs: string[]) => [...new Set(xs.map((x) => labels.get(x) ?? x))];
        const added = show([...mb.keys()].filter((x) => !ma.has(x)));
        const removed = show([...ma.keys()].filter((x) => !mb.has(x)));
        const changed = show([...mb.keys()].filter((x) => ma.has(x) && ma.get(x) !== mb.get(x)));
        const [one, many] = spec.unit ?? ['item', 'items'];
        const fmt = (n: number, verb: string, list: string[]) => (n ? `${n} ${n === 1 ? one : many} ${verb}${list.length <= 3 ? ` (${list.join(', ')})` : ''}` : '');
        parts.push(...[fmt(added.length, 'added', added), fmt(removed.length, 'removed', removed), fmt(changed.length, 'changed', changed)].filter(Boolean));
      } else if (k === 'stats') {
        const sa = a as ProjectModel['stats'];
        const sb = b as ProjectModel['stats'];
        if (sa.filesScanned !== sb.filesScanned) parts.push(`files analyzed ${sa.filesScanned} → ${sb.filesScanned}`);
        else parts.push('file statistics changed');
      } else {
        parts.push(describeObjectChange(k, a, b));
      }
    }
    changes.push({ label: spec.label, summary: parts.join('; ') || 'changed', docs: spec.docs });
  }
  return changes;
}

function names(xs: Array<{ name: string }>): Set<string> {
  return new Set(xs.map((x) => x.name));
}

function setDelta(label: string, a: Set<string>, b: Set<string>): string[] {
  const added = [...b].filter((x) => !a.has(x));
  const removed = [...a].filter((x) => !b.has(x));
  const out: string[] = [];
  const list = (xs: string[]) => (xs.length <= 3 ? ` (${xs.join(', ')})` : '');
  if (added.length) out.push(`${added.length} ${label} added${list(added)}`);
  if (removed.length) out.push(`${removed.length} ${label} removed${list(removed)}`);
  return out;
}

function describeObjectChange(key: Key, a: unknown, b: unknown): string {
  const parts: string[] = [];
  switch (key) {
    case 'env': {
      const ea = a as ProjectModel['env'];
      const eb = b as ProjectModel['env'];
      parts.push(...setDelta('variable name(s)', names(ea.vars), names(eb.vars)));
      parts.push(...setDelta('env file(s)', new Set(ea.envFilesPresent), new Set(eb.envFilesPresent)));
      if (!parts.length) parts.push('variable references moved');
      break;
    }
    case 'security': {
      const sa = a as ProjectModel['security'];
      const sb = b as ProjectModel['security'];
      if (sa.secrets.length !== sb.secrets.length) parts.push(`potential secrets ${sa.secrets.length} → ${sb.secrets.length}`);
      parts.push(...setDelta('control(s)', names(sa.controls), names(sb.controls)));
      parts.push(...setDelta('tool(s)', names(sa.tooling), names(sb.tooling)));
      if (!parts.length) parts.push('evidence locations changed');
      break;
    }
    case 'tests': {
      const ta = a as ProjectModel['tests'];
      const tb = b as ProjectModel['tests'];
      if (ta.testFileCount !== tb.testFileCount) parts.push(`test files ${ta.testFileCount} → ${tb.testFileCount}`);
      parts.push(...setDelta('framework(s)', names(ta.frameworks), names(tb.frameworks)));
      if (!parts.length) parts.push('test layout changed');
      break;
    }
    case 'containers': {
      const ca = a as ProjectModel['containers'];
      const cb = b as ProjectModel['containers'];
      parts.push(...setDelta('Dockerfile(s)', new Set(ca.dockerfiles.map((d) => d.path)), new Set(cb.dockerfiles.map((d) => d.path))));
      parts.push(...setDelta('service(s)', names(ca.services), names(cb.services)));
      if (!parts.length) parts.push('container configuration changed');
      break;
    }
    case 'workspace': {
      const wa = a as ProjectModel['workspace'];
      const wb = b as ProjectModel['workspace'];
      parts.push(...setDelta('package(s)', names(wa.packages), names(wb.packages)));
      if (!parts.length) parts.push('package dependencies changed');
      break;
    }
    case 'topLevelDirs':
      parts.push(...setDelta('top-level director(ies)', new Set(a as string[]), new Set(b as string[])));
      break;
    case 'git':
      parts.push('change hotspots updated from recent commits');
      break;
    case 'name':
    case 'description':
      parts.push(`${key} changed`);
      break;
    default:
      parts.push(`${String(key)} changed`);
  }
  return parts.join('; ');
}
