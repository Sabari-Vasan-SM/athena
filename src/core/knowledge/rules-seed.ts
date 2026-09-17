import type { ProjectModel } from '../model/project-model.js';

/**
 * Initial rules.md. Universal, low-risk rules are enabled. Stack-specific rules are
 * seeded as `[disabled]` suggestions: Athena must not silently turn its own
 * guesses into project policy — the developer opts in.
 */
export function seedRules(m: ProjectModel): string {
  const hasBackend = m.frameworks.some((f) => ['backend', 'fullstack'].includes(f.category));
  const hasFrontend = m.frameworks.some((f) => ['frontend', 'fullstack', 'mobile'].includes(f.category));
  const hasDb = m.databases.length > 0;
  const hasMigrations = m.migrations.length > 0;
  const hasTests = m.tests.frameworks.length > 0;
  const tenant = m.dbEntities.some((e) => e.fields.some((f) => /^(tenant|organization|org|workspace|account)_?id$/i.test(f.name)));

  const out: string[] = [
    '# Athena Project Rules',
    '',
    '<!--',
    'This file is owned by you. Athena creates it once and never regenerates it.',
    'AI agents configured by Athena are instructed to follow every enabled rule.',
    '',
    'Format: one rule per top-level bullet under a "## Section" heading.',
    'Disable a rule without deleting it by writing "- [disabled] ...".',
    'Rules marked [disabled] below are SUGGESTIONS based on the detected stack — enable the ones that apply.',
    '-->',
    '',
    '## AI Agent Rules',
    '',
    '- Read the relevant Athena knowledge (see the relevance map in your agent instructions) before making significant changes.',
    '- Do not modify files unrelated to the task.',
    '- Do not introduce new dependencies without stating the justification.',
    '- Explain breaking changes (API, schema, configuration) before implementing them.',
    '- Never add secrets, credentials or tokens to code, config, tests or logs.',
    '- Treat statements marked INFERRED or UNKNOWN in Athena knowledge as unverified.',
    '',
    '## Security',
    '',
    '- Validate all external input at trust boundaries.',
  ];
  if (hasFrontend) out.push('- Never expose server-side secrets to frontend code or client bundles.');
  if (hasDb) out.push('- Use parameterized queries or ORM query APIs; never build SQL from user input.');

  out.push('', '## Architecture', '');
  out.push(hasBackend ? '- [disabled] Keep business logic out of route handlers/controllers; use the service layer.' : '- [disabled] Keep modules focused; do not create circular dependencies.');
  if (m.workspace.isMonorepo) out.push('- [disabled] Packages may only import other workspace packages through declared dependencies.');

  if (hasDb) {
    out.push('', '## Database', '');
    if (hasMigrations) out.push('- [disabled] All schema changes must go through migrations; never modify production schema manually.');
    else out.push('- [disabled] Schema changes must be reviewed before applying them to shared environments.');
    if (tenant) out.push('- [disabled] Every tenant-owned table must include the tenant key, and every query must filter by it.');
  }
  if (m.routes.length || hasBackend) {
    out.push('', '## API', '');
    out.push('- [disabled] Return consistent error responses across endpoints.');
    out.push('- [disabled] New endpoints must declare their authentication and authorization requirements.');
  }
  out.push('', '## Testing', '');
  out.push(hasTests ? '- [disabled] New business logic requires tests.' : '- [disabled] Add a test framework before adding complex business logic.');
  out.push('');
  return out.join('\n');
}
