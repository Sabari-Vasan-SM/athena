import type { Detector, FactDef } from '../context.js';
import { detected } from '../../model/fact.js';
import { SOURCE_FILE, TEST_FILE } from '../../patterns.js';

export const TEST_FILE_RE = TEST_FILE;
const SOURCE_RE = SOURCE_FILE;

const RUNNER_CONFIGS: Array<[RegExp, string]> = [
  [/(^|\/)jest\.config\.(js|ts|cjs|mjs|json)$/, 'Jest'],
  [/(^|\/)vitest\.config\.(js|ts|mjs|cjs)$/, 'Vitest'],
  [/(^|\/)playwright\.config\.(js|ts)$/, 'Playwright'],
  [/(^|\/)cypress\.config\.(js|ts)$|(^|\/)cypress\.json$/, 'Cypress'],
  [/(^|\/)(pytest\.ini|conftest\.py)$/, 'pytest'],
  [/(^|\/)\.mocharc\.(js|json|ya?ml|cjs)$/, 'Mocha'],
  [/(^|\/)karma\.conf\.(js|ts)$/, 'Karma'],
  [/(^|\/)phpunit\.xml(\.dist)?$/, 'PHPUnit'],
  [/(^|\/)\.rspec$/, 'RSpec'],
];

const COVERAGE: RegExp = /(^|\/)(\.nycrc(\.json)?|\.coveragerc|codecov\.ya?ml|\.codecov\.ya?ml|jacoco[^/]*\.xml|\.c8rc(\.json)?|coverage\.xml|sonar-project\.properties)$/;

const COVERAGE_CONFIG = /(^|\/)(jest|vitest)\.config\.(js|ts|mjs|cjs)$/;

const rustTestFact: FactDef<boolean> = {
  id: 'rust-test-attr',
  applies: (f) => /\.rs$/.test(f.path),
  compute: (text) => !!text && /#\[(tokio::)?test\]/.test(text),
};

const coverageFact: FactDef<boolean> = {
  id: 'runner-coverage',
  applies: (f) => COVERAGE_CONFIG.test(f.path),
  compute: (text) => !!text && /coverage/.test(text),
};

export const testsDetector: Detector = {
  id: 'tests',
  version: 1,
  facts: [rustTestFact, coverageFact],
  async run(ctx) {
    const { model } = ctx;
    const testFiles = ctx.find((f) => !f.binary && SOURCE_RE.test(f.path) && TEST_FILE_RE.test(f.path));
    model.tests.testFileCount = testFiles.length;

    const dirs = new Map<string, number>();
    for (const f of testFiles) {
      const m = /^(.*?(?:__tests__|tests?|spec|specs|e2e))\//.exec(f.path);
      if (m) dirs.set(m[1]!, (dirs.get(m[1]!) ?? 0) + 1);
    }
    model.tests.testDirs = [...dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([d]) => d);

    const known = new Set(model.tests.frameworks.map((f) => f.name));
    for (const [re, name] of RUNNER_CONFIGS) {
      const files = ctx.find(re);
      if (!files.length) continue;
      const existing = model.tests.frameworks.find((f) => f.name === name);
      if (existing) existing.provenance.evidence.push(...files.slice(0, 3).map((f) => ({ file: f.path, detail: 'runner config' })));
      else if (!known.has(name)) model.tests.frameworks.push({ name, provenance: detected('config', files.slice(0, 3).map((f) => ({ file: f.path, detail: 'runner config' }))) });
    }
    if (ctx.find(/_test\.go$/).length && !known.has('go test')) model.tests.frameworks.push({ name: 'go test', provenance: detected('filesystem', ctx.find(/_test\.go$/).slice(0, 3).map((f) => ({ file: f.path }))) });
    if (model.manifests.some((m) => m.ecosystem === 'cargo') && ctx.find(/\.rs$/).length) {
      const withTests: string[] = [];
      for (const f of ctx.find(/\.rs$/).slice(0, 2000)) {
        if (await ctx.fact(f.path, rustTestFact)) withTests.push(f.path);
        if (withTests.length >= 3) break;
      }
      if (withTests.length) model.tests.frameworks.push({ name: 'cargo test', provenance: detected('code', withTests.map((file) => ({ file, detail: '#[test] attribute' }))) });
    }
    model.tests.frameworks.sort((a, b) => a.name.localeCompare(b.name));

    model.tests.coverageConfigs = ctx.find(COVERAGE).map((f) => f.path);
    for (const f of ctx.find(COVERAGE_CONFIG)) {
      if (await ctx.fact(f.path, coverageFact)) model.tests.coverageConfigs.push(f.path);
    }

    // Structural gap: workspace packages with source files but no test files.
    if (model.workspace.isMonorepo) {
      for (const pkg of model.workspace.packages) {
        if (pkg.path === '.') continue;
        const prefix = `${pkg.path}/`;
        const src = ctx.files.some((f) => f.path.startsWith(prefix) && SOURCE_RE.test(f.path) && !TEST_FILE_RE.test(f.path));
        const tests = testFiles.some((f) => f.path.startsWith(prefix));
        if (src && !tests) model.tests.packagesWithoutTests.push(pkg.path);
      }
    }
  },
};
