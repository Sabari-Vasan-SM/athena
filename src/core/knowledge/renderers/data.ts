import type { ProjectModel } from '../../model/project-model.js';
import type { Section } from '../managed-blocks.js';
import { bullets, code, esc, evidenceList, notDetected, status, table, truncatedNote, unknown } from '../md.js';

const MAX_ENTITIES = 60;
const MAX_ROUTES = 200;

export function renderDatabase(m: ProjectModel): Section[] {
  const s: Section[] = [];
  s.push({
    id: 'technology',
    content: ['## Database Technology', '', m.databases.length ? table(['Technology', 'Kind', 'Status', 'Evidence'], m.databases.map((d) => [esc(d.name), d.kind, status(d.provenance), evidenceList(d.provenance.evidence, 2)])) : notDetected('database engines, ORMs or drivers')].join('\n'),
  });

  const ents = m.dbEntities.slice(0, MAX_ENTITIES);
  const entityDocs = ents.map((e) => {
    const fields = e.fields.slice(0, 40).map((f) => `${code(f.name)}${f.type ? ` ${esc(f.type)}` : ''}${f.attributes.length ? ` — ${f.attributes.map(esc).join(' ')}` : ''}`);
    const parts = [`### ${esc(e.name)} (${e.kind})`, '', `Defined in ${evidenceList(e.provenance.evidence, 1)} · ${status(e.provenance)}`];
    if (fields.length) parts.push('', bullets(fields));
    if (e.relations.length) parts.push('', `**Relations:** ${e.relations.map(esc).join('; ')}`);
    if (e.indexes.length) parts.push('', `**Indexes/constraints:** ${e.indexes.map((i) => code(i)).join(', ')}`);
    return parts.join('\n');
  });
  s.push({
    id: 'schema',
    content: ['## Schema & Entities', '', entityDocs.length ? entityDocs.join('\n\n') + truncatedNote(ents.length, m.dbEntities.length, 'entities') : notDetected('schema definitions (Prisma, SQL DDL, Django/SQLAlchemy models, Mongoose models)')].join('\n'),
  });

  s.push({
    id: 'migrations',
    content: ['## Migrations', '', m.migrations.length ? table(['Location', 'Tool', 'Files'], m.migrations.map((x) => [code(x.path), esc(x.tool), String(x.count)])) : notDetected('migration directories'), '', m.commands.filter((c) => c.purpose === 'migrate').length ? `Migration commands: ${m.commands.filter((c) => c.purpose === 'migrate').map((c) => code(c.command)).join(', ')}` : ''].join('\n').trim(),
  });

  const tenantCols = m.dbEntities.filter((e) => e.fields.some((f) => /^(tenant|organization|org|workspace|account)_?id$/i.test(f.name)));
  const iso: string[] = ['## Data Ownership & Tenant Isolation', ''];
  if (tenantCols.length) {
    iso.push(`Entities with tenant/organization-style key columns (DETECTED column names): ${tenantCols.map((e) => code(e.name)).join(', ')}`, '', unknown('Whether tenant isolation is enforced for all queries', 'column presence does not prove enforcement'));
  } else {
    iso.push(unknown('Tenancy model', 'no tenant/organization key columns detected'));
  }
  s.push({ id: 'ownership', content: iso.join('\n') });
  s.push({ id: 'constraints', content: '## Important Constraints\n\n_Business-level data constraints are not inferred. Record them in Developer Notes or `rules.md`._' });
  return s;
}

export function renderApi(m: ProjectModel): Section[] {
  const s: Section[] = [];
  const be = m.frameworks.filter((f) => ['backend', 'fullstack'].includes(f.category));
  const styles: string[] = [];
  if (m.routes.length) styles.push(`HTTP routes (${m.routes.length} detected)`);
  if (m.apiSpecs.some((x) => x.kind === 'graphql') || m.frameworks.some((f) => /GraphQL|Apollo/.test(f.name))) styles.push('GraphQL');
  if (m.apiSpecs.some((x) => x.kind === 'grpc') || m.frameworks.some((f) => /gRPC|tonic/.test(f.name))) styles.push('gRPC / Protocol Buffers');
  if (m.frameworks.some((f) => f.name === 'tRPC')) styles.push('tRPC');
  s.push({
    id: 'architecture',
    content: ['## API Architecture', '', be.length ? `**Server frameworks:** ${[...new Set(be.map((f) => f.name))].map(esc).join(', ')} (DETECTED)` : unknown('Server framework', 'no known backend framework detected'), '', styles.length ? `**API styles:** ${styles.join(', ')}` : unknown('API style')].join('\n'),
  });

  const routes = m.routes.slice(0, MAX_ROUTES);
  s.push({
    id: 'endpoints',
    content: [
      '## Endpoints',
      '',
      routes.length
        ? `Paths are as written in code. Router prefixes applied elsewhere (mounting, include_router, blueprints) may not be reflected.\n\n${table(['Method', 'Path', 'Framework', 'Location', 'Status'], routes.map((r) => [r.method, code(r.path), esc(r.framework), code(`${r.file}${r.line ? `:${r.line}` : ''}`), status(r.provenance)]))}${truncatedNote(routes.length, m.routes.length, 'routes')}`
        : notDetected('HTTP routes'),
    ].join('\n'),
  });

  s.push({
    id: 'specs',
    content: ['## API Specifications', '', m.apiSpecs.length ? bullets(m.apiSpecs.slice(0, 30).map((x) => `${x.kind}: ${code(x.path)}`)) : notDetected('OpenAPI, GraphQL or protobuf specifications')].join('\n'),
  });

  s.push({
    id: 'auth-requirements',
    content: ['## Authentication & Authorization Requirements', '', unknown('Per-endpoint auth requirements', 'static route detection does not determine which middleware/guards apply to each route'), '', 'See `auth.md` for detected auth mechanisms.'].join('\n'),
  });
  s.push({
    id: 'errors',
    content: ['## Request/Response & Error Handling', '', unknown('Request/response schemas', 'not extracted in this version'), '', unknown('Error response format', 'document the convention in Developer Notes or rules.md')].join('\n'),
  });
  return s;
}

export function renderAuth(m: ProjectModel): Section[] {
  const s: Section[] = [];
  const by = (k: string) => m.auth.filter((a) => a.kind === k);
  const row = (a: (typeof m.auth)[number]) => [esc(a.name), status(a.provenance), evidenceList(a.provenance.evidence, 3)];

  s.push({
    id: 'mechanism',
    content: [
      '## Authentication Mechanism',
      '',
      [...by('library'), ...by('provider')].length ? table(['Library / Provider', 'Status', 'Evidence'], [...by('library'), ...by('provider')].map(row)) : notDetected('authentication libraries or identity providers'),
      '',
      '_A declared auth dependency shows the capability is available, not that every route is protected._',
    ].join('\n'),
  });
  s.push({
    id: 'tokens-sessions',
    content: ['## Sessions & Tokens', '', by('token').length ? table(['Library', 'Status', 'Evidence'], by('token').map(row)) : notDetected('token (JWT/JWE) libraries'), '', unknown('Session storage, token lifetime and refresh-token strategy', 'not determinable from dependencies alone')].join('\n'),
  });
  const rbac = m.auth.filter((a) => a.kind === 'middleware');
  s.push({
    id: 'authorization',
    content: ['## Authorization, Roles & Permissions', '', rbac.length ? table(['Signal', 'Status', 'Evidence'], rbac.map(row)) : notDetected('role/permission definitions or auth middleware'), '', unknown('Authorization model (RBAC/ABAC/ownership checks)', 'confirm and document in Developer Notes')].join('\n'),
  });
  s.push({
    id: 'passwords-mfa',
    content: ['## Password Handling, OAuth & MFA', '', by('hashing').length ? `**Password hashing libraries:** ${by('hashing').map((h) => `${esc(h.name)} (${evidenceList(h.provenance.evidence, 1)})`).join(', ')} — DETECTED` : unknown('Password hashing', 'no known hashing library detected (may be delegated to a provider)'), '', unknown('OAuth providers & MFA', 'not detected in this version')].join('\n'),
  });
  s.push({
    id: 'assumptions',
    content: ['## Security Assumptions', '', '_No auth security assumptions are inferred automatically._ Document assumptions (e.g. "all /admin routes require the admin role") in Developer Notes so agents can check changes against them.', '', '> Athena never stores passwords, API keys, tokens or private keys in this file.'].join('\n'),
  });
  return s;
}
