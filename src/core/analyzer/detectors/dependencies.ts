import type { Detector } from '../context.js';
import { CATALOG, ecosystemKey, normalizeDep, type CatalogEntry } from '../catalog.js';
import type { Evidence, Provenance } from '../../model/fact.js';
import type { NamedFact } from '../../model/project-model.js';
import { dirOf } from '../../util/paths.js';

/**
 * Maps declared dependencies to capabilities via the catalog. Output is always
 * "X is a declared dependency" — usage details remain UNKNOWN unless other
 * detectors find direct evidence.
 */
export const dependenciesDetector: Detector = {
  id: 'dependencies',
  version: 1,
  async run(ctx) {
    const { model } = ctx;
    const buckets = {
      database: new Map<string, NamedFact & { kind: 'engine' | 'orm' | 'driver' | 'service' }>(),
      auth: new Map<string, NamedFact & { kind: 'library' | 'provider' | 'hashing' | 'middleware' | 'token' }>(),
      cache: new Map<string, NamedFact>(),
      queue: new Map<string, NamedFact>(),
      observability: new Map<string, NamedFact>(),
      securityControl: new Map<string, NamedFact>(),
      securityTooling: new Map<string, NamedFact>(),
      testing: new Map<string, NamedFact>(),
    };
    const frameworks = new Map<string, (typeof model.frameworks)[number]>();

    const addEvidence = (prov: Provenance, ev: Evidence) => {
      if (!prov.evidence.some((e) => e.file === ev.file && e.detail === ev.detail)) prov.evidence.push(ev);
    };

    for (const manifest of model.manifests) {
      const eco = ecosystemKey(manifest.ecosystem);
      if (!eco) continue;
      const table = CATALOG[eco];
      const lookup = new Map(Object.entries(table).map(([k, v]) => [normalizeDep(manifest.ecosystem, k), v]));
      const root = dirOf(manifest.path);
      const all: Array<[string, boolean]> = [
        ...manifest.dependencies.map((d): [string, boolean] => [d, false]),
        ...manifest.devDependencies.map((d): [string, boolean] => [d, true]),
      ];
      for (const [dep, isDev] of all) {
        const entry: CatalogEntry | undefined = lookup.get(normalizeDep(manifest.ecosystem, dep));
        if (!entry) continue;
        const ev: Evidence = { file: manifest.path, detail: `${isDev ? 'dev ' : ''}dependency "${dep}"` };
        const marker = entry.markers?.flatMap((re) => ctx.find(re).map((f) => f.path)).find((p) => dirOf(p) === root || p.startsWith(root === '.' ? '' : `${root}/`));
        const kind = entry.kind;
        const confidence = marker || !isDev || kind.type === 'testing' || kind.type === 'securityTooling' ? 'high' : 'medium';
        const mkProv = (): Provenance => ({ status: 'DETECTED', confidence, source: 'config', evidence: [] });

        if (kind.type === 'framework') {
          const key = `${entry.name}@${root}`;
          const cur = frameworks.get(key) ?? { name: entry.name, category: kind.category, root, provenance: mkProv() };
          addEvidence(cur.provenance, ev);
          if (marker) addEvidence(cur.provenance, { file: marker, detail: 'framework config file' });
          if (confidence === 'high') cur.provenance.confidence = 'high';
          frameworks.set(key, cur);
          continue;
        }
        const bucket = buckets[kind.type] as Map<string, NamedFact & { kind?: string }>;
        const cur = bucket.get(entry.name) ?? { name: entry.name, provenance: mkProv(), ...('kind' in kind ? { kind: kind.kind } : {}) };
        addEvidence(cur.provenance, ev);
        if (marker) addEvidence(cur.provenance, { file: marker, detail: 'config file' });
        if (confidence === 'high') cur.provenance.confidence = 'high';
        bucket.set(entry.name, cur);
      }
    }

    const sorted = <T extends { name: string }>(m: Map<string, T>) => [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
    model.frameworks = [...frameworks.values()].sort((a, b) => a.root.localeCompare(b.root) || a.name.localeCompare(b.name));
    model.databases.push(...sorted(buckets.database));
    model.auth.push(...sorted(buckets.auth));
    model.caching.push(...sorted(buckets.cache));
    model.queues.push(...sorted(buckets.queue));
    model.observability.push(...sorted(buckets.observability));
    model.security.controls.push(...sorted(buckets.securityControl));
    model.security.tooling.push(...sorted(buckets.securityTooling));
    model.tests.frameworks.push(...sorted(buckets.testing));
  },
};
