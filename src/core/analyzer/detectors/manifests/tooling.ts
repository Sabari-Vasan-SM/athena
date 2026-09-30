import type { FactDef } from '../../context.js';

/** Lockfiles, build systems and Makefile/justfile targets: detected from file names (and targets from content). */

export const MAKE_RE = /(^|\/)(Makefile|makefile|justfile)$/;
export const makeTargetsFact: FactDef<string[]> = {
  id: 'make-targets',
  applies: (f) => MAKE_RE.test(f.path) && f.path.split('/').length <= 3,
  compute(text) {
    const out: string[] = [];
    if (!text) return out;
    for (const m of text.matchAll(/^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/gm)) {
      const name = m[1]!;
      if (name === 'PHONY' || name.startsWith('.')) continue;
      out.push(name);
    }
    return out;
  },
};

export const LOCKFILES: Array<[RegExp, string]> = [
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

export const BUILD_SYSTEMS: Array<[RegExp, string]> = [
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
