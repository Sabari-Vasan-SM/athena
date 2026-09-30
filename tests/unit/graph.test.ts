import { describe, expect, it } from 'vitest';
import { emptyModel, type ProjectModel } from '../../src/core/model/project-model.js';
import { buildGraph, expandFromFiles, neighbors, nodeId, type ProjectGraph } from '../../src/core/graph/graph.js';
import * as legacy from './legacy/graph-0.2.1.js';

/** Deterministic PRNG (mulberry32) so failures reproduce. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(xs: T[]): T => xs[int(xs.length)]!;
  return { next, int, pick };
}

const prov = { status: 'DETECTED', confidence: 1, evidence: [] } as unknown as ProjectModel['routes'][number]['provenance'];

/** A random project: nested/duplicate/root packages, routes, entities, commands, infra and import-linked files. */
function fixture(seed: number) {
  const r = rng(seed);
  const m = emptyModel('fx', '/fx');
  const pkgPaths = ['.', 'packages/a', 'packages/a/sub', 'packages/b', 'apps/web', 'apps/web', 'Packages/a', 'packages'];
  m.workspace.packages = pkgPaths.map((p, i) => ({ name: `pkg${i}`, path: p, kind: 'package' as const, ecosystem: 'npm', internalDependencies: [] }));
  // Duplicate names too (addNode keeps the first).
  m.workspace.packages.push({ name: 'pkg1', path: 'packages/dup', kind: 'app', ecosystem: 'npm', internalDependencies: ['pkg0'] });
  for (const p of m.workspace.packages) p.internalDependencies.push(...Array.from({ length: r.int(4) }, () => `pkg${r.int(10)}`));

  const dirs = ['packages/a/src', 'packages/a/sub/lib', 'packages/b', 'apps/web/src/pages', 'src', 'packages/dup', 'Packages/a', 'lib/py'];
  const exts = ['.ts', '.tsx', '.js', '.py', '.md', '.mjs'];
  const files: string[] = [];
  for (let i = 0; i < 120; i++) {
    const dir = r.pick(dirs);
    const ext = dir === 'lib/py' ? '.py' : r.pick(exts);
    files.push(`${dir}/f${i}${ext}`);
  }
  files.push('packages/a/src/util/index.ts', 'lib/py/__init__.py', 'README.md');

  const contents = new Map<string, string>();
  for (const f of files) {
    const lines: string[] = [];
    const n = r.int(8);
    for (let k = 0; k < n; k++) {
      const target = r.pick(files);
      const dir = f.split('/').slice(0, -1);
      const tdir = target.split('/').slice(0, -1);
      let common = 0;
      while (common < dir.length && common < tdir.length && dir[common] === tdir[common]) common++;
      const up = dir.length - common;
      const rel = `${up ? '../'.repeat(up) : './'}${[...tdir.slice(common), target.split('/').pop()!.replace(/\.(ts|tsx|js|mjs)$/, '')].join('/')}`;
      const style = r.int(5);
      if (f.endsWith('.py')) lines.push(`from ${target.replace(/\.py$/, '').split('/').pop()} import x`, 'import os');
      else if (style === 0) lines.push(`import { a } from '${rel}';`);
      else if (style === 1) lines.push(`import '${rel}';`);
      else if (style === 2) lines.push(`export * from '${rel}';`);
      else if (style === 3) lines.push(`const x = require('${rel}');`);
      else lines.push(`import pkg from 'external-${k}';`);
    }
    if (r.int(4) === 0) lines.push("import u from './util';");
    contents.set(f, lines.join('\n'));
  }

  const referenced = () => r.pick(files);
  m.frameworks = Array.from({ length: 6 }, (_, i) => ({ name: `fw${i % 4}`, category: 'backend' as const, root: r.pick(pkgPaths), provenance: prov }));
  m.routes = Array.from({ length: 25 }, (_, i) => ({ method: r.pick(['GET', 'POST']), path: `/r${i % 20}`, framework: 'express', file: referenced(), ...(i % 3 ? { line: i } : {}), provenance: prov }));
  const names = ['User', 'Order', 'Payment', 'user', 'Item'];
  m.dbEntities = Array.from({ length: 8 }, (_, i) => ({
    name: names[i % names.length]!,
    kind: 'model' as const,
    fields: [],
    indexes: [],
    relations: Array.from({ length: r.int(3) }, () => `x → ${r.pick([...names, 'ORDER', 'Missing'])}`),
    file: `prisma/schema${i % 2}.prisma`,
    provenance: prov,
  }));
  m.entryPoints = Array.from({ length: 5 }, () => ({ path: referenced(), provenance: prov }));
  m.commands = Array.from({ length: 6 }, (_, i) => ({ name: `c${i}`, command: 'x'.repeat(150), source: i % 2 ? 'package.json' : referenced(), purpose: 'dev' as const }));
  m.infrastructure = [{ name: 'tf', kind: 'terraform', file: 'infra/main.tf', provenance: prov }];
  m.containers.dockerfiles = [{ path: 'Dockerfile' } as ProjectModel['containers']['dockerfiles'][number]];
  m.containers.services = [{ name: 'db', file: 'compose.yml', image: 'postgres' } as ProjectModel['containers']['services'][number]];
  return { model: m, files, read: async (p: string) => contents.get(p) ?? null };
}

const strip = (g: ProjectGraph) => ({ ...g, builtAt: '' });

describe('graph builder equivalence with 0.2.1', () => {
  for (const seed of [1, 2, 3, 42, 1337, 9001]) {
    it(`produces identical graph JSON (seed ${seed})`, async () => {
      const fx = fixture(seed);
      for (const maxImportFiles of [undefined, 10]) {
        const opts = { files: fx.files, read: fx.read, maxImportFiles };
        const before = await legacy.buildGraph(fx.model, opts);
        const after = await buildGraph(fx.model, opts);
        expect(JSON.stringify(strip(after))).toBe(JSON.stringify(strip(before as ProjectGraph)));
        expect(after.edges.length).toBeGreaterThan(0);
      }
    });

    it(`answers neighbors/expandFromFiles identically (seed ${seed})`, async () => {
      const fx = fixture(seed);
      const g = await buildGraph(fx.model, { files: fx.files, read: fx.read });
      const r = rng(seed + 1);
      for (const n of [...g.nodes.slice(0, 40), { id: 'file:nope' }]) {
        expect(neighbors(g, n.id)).toEqual(legacy.neighbors(g, n.id));
      }
      for (let k = 0; k < 20; k++) {
        const seeds = Array.from({ length: 1 + r.int(4) }, () => r.pick(fx.files));
        const depth = r.int(4);
        const limit = r.pick([5, 30, 40, 1000]);
        expect(expandFromFiles(g, seeds, depth, limit).map((x) => x.id)).toEqual(legacy.expandFromFiles(g, seeds, depth, limit).map((x) => x.id));
      }
    });
  }
});

describe('graph performance', () => {
  it('builds a graph with 100k import edges in well under a second', async () => {
    const N = 5000;
    const PER = 20;
    const files = Array.from({ length: N }, (_, i) => `src/m${i}.ts`);
    const text = (i: number) => Array.from({ length: PER }, (_, k) => `import x${k} from './m${(i * 7 + k * 131 + 1) % N}';`).join('\n');
    const m = emptyModel('big', '/big');
    m.entryPoints = [{ path: 'src/m0.ts', provenance: prov }];
    const started = performance.now();
    const g = await buildGraph(m, { files, read: async (p) => text(Number(p.slice(5, -3))), maxImportFiles: N });
    const ms = performance.now() - started;
    expect(g.stats.edges).toBeGreaterThanOrEqual(95_000);
    expect(ms).toBeLessThan(1000);

    const t2 = performance.now();
    for (let i = 0; i < 200; i++) neighbors(g, nodeId('file', `src/m${i}.ts`));
    expandFromFiles(g, files.slice(0, 50), 2, 40);
    expect(performance.now() - t2).toBeLessThan(500);
  });
});
