import type { Detector, FactDef } from '../../context.js';
import { detected, fact } from '../../../model/fact.js';
import { baseName, dirOf } from '../../../util/paths.js';
import { commandPurpose, type Parsed, type Parser } from './shared.js';
import { parseNpm, rootPackageFact, pnpmWorkspaceFact } from './npm.js';
import { parsePipfile, parsePyproject, parseRequirements } from './python.js';
import { parseGoMod, parseGoWork } from './go.js';
import { parseCargo } from './cargo.js';
import { parsePom } from './maven.js';
import { parseGradle, parseGradleSettings } from './gradle.js';
import { parseComposer } from './composer.js';
import { parseCsproj } from './dotnet.js';
import { parseGemfile } from './ruby.js';
import { parsePubspec } from './dart.js';
import { parseMix } from './elixir.js';
import { BUILD_SYSTEMS, LOCKFILES, MAKE_RE, makeTargetsFact } from './tooling.js';
import { detectWorkspace } from './workspace.js';

/**
 * Manifest parsers by file pattern. The order is part of the facts-cache key
 * (`manifest<i>`) and of the order manifests are parsed in: append new parsers at
 * the end (and bump the detector version if an existing parser changes).
 */
const PARSERS: Array<[RegExp, Parser]> = [
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

/** Parse result plus the warnings the parser emitted (replayed in order by the detector). */
interface ManifestFact {
  r: Parsed | null;
  w: string[];
}

/** One fact per parser; the manifest records its own path, so the path is part of the key. */
const MANIFEST_FACTS: FactDef<ManifestFact>[] = PARSERS.map(([re, parser], i) => ({
  id: `manifest${i}`,
  pathKeyed: true,
  applies: (f) => re.test(f.path),
  compute(text, rel) {
    const w: string[] = [];
    const r = parser(text, rel, (m) => w.push(m));
    return { r, w };
  },
}));

/**
 * Dependency names (runtime and dev) declared by a manifest, parsed from `text` with
 * the same parsers the analyzer uses. Null when the file type is not supported or
 * the text can't be parsed; an empty file yields an empty set.
 */
export async function manifestDependencyNames(p: string, text: string): Promise<Set<string> | null> {
  const parser = PARSERS.find(([re]) => re.test(p))?.[1];
  if (!parser) return null;
  if (!text.trim()) return new Set();
  let failed = false;
  const r = parser(text, p, () => (failed = true));
  if (!r || failed) return null;
  return new Set([...r.manifest.dependencies, ...r.manifest.devDependencies]);
}

export const manifestsDetector: Detector = {
  id: 'manifests',
  version: 1,
  facts: [...MANIFEST_FACTS, makeTargetsFact, rootPackageFact, pnpmWorkspaceFact],
  async run(ctx) {
    const { model } = ctx;
    const parsed: Parsed[] = [];
    for (const [i, [re]] of PARSERS.entries()) {
      for (const f of ctx.find(re)) {
        ctx.signal?.throwIfAborted();
        const v = await ctx.fact(f.path, MANIFEST_FACTS[i]!);
        if (!v) continue;
        for (const w of v.w) ctx.warn(w);
        if (v.r) parsed.push(v.r);
      }
    }
    parsed.sort((a, b) => a.manifest.path.localeCompare(b.manifest.path));
    model.manifests = parsed.map((p) => p.manifest);
    model.commands.push(...parsed.flatMap((p) => p.commands ?? []));

    // Makefile / justfile targets
    for (const f of ctx.find(MAKE_RE)) {
      if (f.path.split('/').length > 3) continue;
      const names = await ctx.fact(f.path, makeTargetsFact);
      if (!names) continue;
      const isJust = baseName(f.path) === 'justfile';
      for (const name of names) model.commands.push({ name, command: isJust ? `just ${name}` : `make ${name}`, source: f.path, purpose: commandPurpose(name, '') });
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
    const rootMeta = rootPkg ? await ctx.fact('package.json', rootPackageFact) : null;
    if (rootMeta) {
      const declared = rootMeta.pm;
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

    await detectWorkspace(ctx, parsed);

    const rootManifest = model.manifests.find((m) => dirOf(m.path) === '.' && m.name);
    if (rootManifest?.name) model.name = rootManifest.name;
    // Root package.json description and FACT-level entry points ("main"/"module"/"bin").
    if (rootMeta) {
      if (rootMeta.description) model.description = rootMeta.description;
      for (const [p, detail] of rootMeta.entries) model.entryPoints.push({ path: p, provenance: fact('config', [{ file: 'package.json', detail }]) });
    }
  },
};
