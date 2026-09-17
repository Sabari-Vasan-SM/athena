import type { ProjectModel } from '../../model/project-model.js';
import type { Section } from '../managed-blocks.js';
import { bullets, code, esc, evidenceList, notDetected, table, unknown } from '../md.js';

export function renderTesting(m: ProjectModel): Section[] {
  const t = m.tests;
  const s: Section[] = [];
  s.push({
    id: 'frameworks',
    content: ['## Test Frameworks', '', t.frameworks.length ? table(['Framework', 'Evidence'], t.frameworks.map((f) => [esc(f.name), evidenceList(f.provenance.evidence, 3)])) : notDetected('test frameworks')].join('\n'),
  });
  const kinds: string[] = [];
  const names = t.frameworks.map((f) => f.name);
  if (names.some((n) => /Playwright|Cypress|Detox|integration_test/.test(n))) kinds.push('End-to-end / UI tests: framework DETECTED');
  if (names.some((n) => /Supertest|Testcontainers|pytest-django|Spring Boot Test/.test(n))) kinds.push('Integration tests: supporting library DETECTED');
  if (names.some((n) => /Jest|Vitest|Mocha|pytest|go test|cargo test|JUnit|RSpec|PHPUnit|xUnit|NUnit|flutter_test|Minitest|Pest|testify/.test(n))) kinds.push('Unit tests: runner DETECTED');
  s.push({
    id: 'layout',
    content: [
      '## Test Layout',
      '',
      `**Test files detected:** ${t.testFileCount}`,
      '',
      t.testDirs.length ? `**Test directories:** ${t.testDirs.map(code).join(', ')}` : '_No dedicated test directories detected._',
      '',
      kinds.length ? bullets(kinds) : unknown('Unit/integration/E2E split'),
    ].join('\n'),
  });
  const cmds = m.commands.filter((c) => c.purpose === 'test');
  s.push({ id: 'commands', content: ['## Test Commands', '', cmds.length ? table(['Name', 'Command', 'Defined in'], cmds.slice(0, 20).map((c) => [code(c.name), code(c.command), code(c.source)])) : notDetected('test commands')].join('\n') });
  s.push({
    id: 'coverage',
    content: ['## Coverage', '', t.coverageConfigs.length ? `Coverage configuration found in: ${[...new Set(t.coverageConfigs)].map(code).join(', ')}` : notDetected('coverage configuration'), '', unknown('Actual coverage percentage', 'Athena does not run tests or read coverage reports in this version')].join('\n'),
  });
  const gaps: string[] = [];
  if (t.testFileCount === 0 && m.stats.filesScanned > 0) gaps.push('**Detected:** no test files found in the project.');
  if (t.packagesWithoutTests.length) gaps.push(`**Detected:** workspace packages with source files but no test files: ${t.packagesWithoutTests.map(code).join(', ')}`);
  if (m.routes.length && !names.some((n) => /Supertest|Playwright|Cypress|pytest|Spring Boot Test|Testcontainers/.test(n))) gaps.push('**Potential:** HTTP routes exist but no API/integration testing library was detected.');
  s.push({ id: 'gaps', content: ['## Missing Coverage (structural)', '', gaps.length ? bullets(gaps) : '_No structural gaps detected._ This does not measure test quality or coverage.'].join('\n') });
  s.push({ id: 'critical-areas', content: '## Critical Test Areas\n\n_Not inferred. List business-critical flows (payments, auth, data deletion, migrations) in Developer Notes so agents prioritize tests for them._' });
  return s;
}

export function renderDebugging(m: ProjectModel): Section[] {
  const s: Section[] = [];
  s.push({ id: 'known-bugs', content: '## Known Bugs\n\n_None recorded._ Add known bugs and their status in Developer Notes.' });
  const cmds = m.commands.filter((c) => ['dev', 'start', 'test', 'lint'].includes(c.purpose)).slice(0, 15);
  s.push({ id: 'commands', content: ['## Debugging & Diagnostic Commands', '', cmds.length ? table(['Purpose', 'Command', 'Defined in'], cmds.map((c) => [c.purpose, code(c.command), code(c.source)])) : notDetected('runnable dev/test commands')].join('\n') });
  s.push({
    id: 'logging',
    content: ['## Logging & Observability', '', m.observability.length ? table(['Tool', 'Evidence'], m.observability.map((o) => [esc(o.name), evidenceList(o.provenance.evidence, 2)])) : notDetected('logging/monitoring libraries'), '', unknown('Log locations and formats', 'document where logs are written and how to access them')].join('\n'),
  });
  const hot = m.git.hotspots;
  s.push({
    id: 'hotspots',
    content: ['## Change Hotspots', '', hot.length ? `Directories with the most file changes in the last 180 days (git history). **INFERRED** as areas more likely to contain regressions:\n\n${table(['Path', 'File changes'], hot.map((h) => [code(h.path), String(h.commits)]))}` : '_Not available (no git history)._'].join('\n'),
  });
  s.push({ id: 'common-errors', content: '## Common Errors & Workarounds\n\n_None recorded._ When an agent or developer resolves a recurring error, record the symptom, cause and fix in Developer Notes.' });
  return s;
}

export function renderPerformance(m: ProjectModel): Section[] {
  const s: Section[] = [];
  s.push({ id: 'caching', content: ['## Caching', '', m.caching.length ? table(['Technology', 'Evidence'], m.caching.map((c) => [esc(c.name), evidenceList(c.provenance.evidence, 2)])) : notDetected('caching libraries or cache services'), '', unknown('Cache strategy and invalidation rules')].join('\n') });
  s.push({ id: 'queues', content: ['## Background Jobs & Queues', '', m.queues.length ? table(['Technology', 'Evidence'], m.queues.map((c) => [esc(c.name), evidenceList(c.provenance.evidence, 2)])) : notDetected('queue or background-job systems')].join('\n') });
  const idx = m.dbEntities.filter((e) => e.indexes.length).length;
  s.push({
    id: 'database',
    content: ['## Database Performance', '', m.dbEntities.length ? `${m.dbEntities.length} entities detected; ${idx} with explicit indexes/constraints (see \`database.md\`).` : notDetected('database entities'), '', unknown('Query patterns, N+1 risks and slow queries', 'requires runtime data or deeper analysis')].join('\n'),
  });
  const fe = m.frameworks.filter((f) => ['frontend', 'fullstack'].includes(f.category));
  s.push({ id: 'frontend', content: ['## Frontend Performance', '', fe.length ? `Frontend frameworks: ${[...new Set(fe.map((f) => f.name))].map(esc).join(', ')}.` : '_No frontend framework detected._', '', unknown('Bundle size, rendering strategy and Core Web Vitals')].join('\n') });
  s.push({ id: 'bottlenecks', content: '## Known Bottlenecks\n\n_None recorded._ Athena does not invent benchmarks. Record measured bottlenecks (with how they were measured) in Developer Notes.' });
  return s;
}

export function renderCodeReview(m: ProjectModel): Section[] {
  const s: Section[] = [];
  const general = [
    'Change is limited to the stated task; no unrelated files modified.',
    'Follows every enabled rule in `rules.md`.',
    'No secrets, credentials or tokens added to code, config, logs or tests.',
    'New dependencies are justified and actively maintained.',
    'Breaking changes (API, schema, config) are called out explicitly.',
    'Athena knowledge updated (`athena analyze`) if structure, routes, schema or infrastructure changed.',
  ];
  s.push({ id: 'general', content: ['## General Checklist', '', bullets(general.map((g) => `[ ] ${g}`))].join('\n') });

  const arch: string[] = [];
  if (m.workspace.isMonorepo) arch.push('Cross-package imports go through declared workspace dependencies (no deep relative imports into other packages).');
  if (m.frameworks.some((f) => ['backend', 'fullstack'].includes(f.category))) arch.push('Business logic is not added directly to route handlers/controllers when a service layer exists.');
  arch.push('New modules follow the existing directory conventions (see `project.md` → Structure).');
  s.push({ id: 'architecture', content: ['## Architecture', '', bullets(arch.map((a) => `[ ] ${a}`))].join('\n') });

  const sec: string[] = [];
  if (m.routes.length) sec.push('New/changed endpoints enforce authentication and authorization as required.', 'Request input is validated before use.');
  if (m.databases.length) sec.push('Database access uses parameterized queries / ORM APIs — no string-built SQL with user input.');
  if (m.frameworks.some((f) => ['frontend', 'fullstack', 'mobile'].includes(f.category))) sec.push('No server-only secrets or privileged keys exposed to client bundles.', 'User-provided content is not rendered as raw HTML without sanitization.');
  sec.push('Errors do not leak stack traces, secrets or internal identifiers to clients.');
  s.push({ id: 'security', content: ['## Security', '', bullets(sec.map((x) => `[ ] ${x}`))].join('\n') });

  const testing = [m.tests.frameworks.length ? `New logic has tests using the project's framework(s): ${m.tests.frameworks.map((f) => esc(f.name)).join(', ')}.` : 'Consider adding tests — no test framework was detected.'];
  const testCmd = m.commands.find((c) => c.purpose === 'test');
  if (testCmd) testing.push(`Tests pass: ${code(testCmd.command)}`);
  const lintCmd = m.commands.find((c) => c.purpose === 'lint');
  if (lintCmd) testing.push(`Lint/type checks pass: ${code(lintCmd.command)}`);
  s.push({ id: 'testing', content: ['## Testing Expectations', '', bullets(testing.map((x) => `[ ] ${x}`))].join('\n') });

  const perf: string[] = [];
  if (m.databases.length) perf.push('New queries on large tables use indexes; no N+1 query patterns introduced.');
  if (m.caching.length) perf.push('Cache invalidation is handled for changed data.');
  if (m.queues.length) perf.push('Long-running work is offloaded to background jobs where appropriate.');
  perf.push('No unbounded loops/fetches over user-controlled sizes.');
  s.push({ id: 'performance', content: ['## Performance', '', bullets(perf.map((x) => `[ ] ${x}`))].join('\n') });
  s.push({ id: 'common-mistakes', content: '## Common Mistakes in This Project\n\n_None recorded._ Add recurring review findings in Developer Notes.' });
  return s;
}
