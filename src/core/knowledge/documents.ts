/**
 * The canonical registry of Athena knowledge documents. Everything that needs to
 * know "which docs exist" (renderers, agents, impact analysis, future web API
 * allowlist) derives from this list.
 */
export const KNOWLEDGE_DOCS = [
  { id: 'project', file: 'project.md', title: 'Project', purpose: 'What this project is, its technologies, structure, entry points, commands and development workflow.' },
  { id: 'architecture', file: 'architecture.md', title: 'Architecture', purpose: 'System and module architecture, service relationships, data flow and external services.' },
  { id: 'database', file: 'database.md', title: 'Database', purpose: 'Database technologies, schemas, entities, relationships, indexes and migrations.' },
  { id: 'api', file: 'api.md', title: 'API', purpose: 'API style, endpoints, specifications, and authentication/error-handling expectations.' },
  { id: 'auth', file: 'auth.md', title: 'Authentication & Authorization', purpose: 'Authentication mechanisms, sessions/tokens, roles and permissions, and security assumptions.' },
  { id: 'security', file: 'security.md', title: 'Security', purpose: 'Attack surface, security controls, secret handling, tooling, and known/potential issues.' },
  { id: 'testing', file: 'testing.md', title: 'Testing', purpose: 'Test frameworks, commands, layout, coverage configuration and detectable gaps.' },
  { id: 'debugging', file: 'debugging.md', title: 'Debugging', purpose: 'Known bugs, common errors, debugging commands, logs and troubleshooting procedures.' },
  { id: 'performance', file: 'performance.md', title: 'Performance', purpose: 'Performance-sensitive areas, caching, queues, background jobs and performance rules.' },
  { id: 'code-review', file: 'code-review.md', title: 'Code Review', purpose: 'Project-specific review checklist covering architecture, security, testing and performance.' },
  { id: 'deployment', file: 'deployment.md', title: 'Deployment', purpose: 'Deployment architecture, environments, containers, CI/CD, hosting and environment variables.' },
  { id: 'rules', file: 'rules.md', title: 'Project Rules', purpose: 'Developer-defined rules that AI agents must follow. Owned by the developer.' },
] as const;

export type DocId = (typeof KNOWLEDGE_DOCS)[number]['id'];
export type GeneratedDocId = Exclude<DocId, 'rules'>;

export const DOC_FILES: ReadonlySet<string> = new Set(KNOWLEDGE_DOCS.map((d) => d.file));

export function docById(id: DocId) {
  return KNOWLEDGE_DOCS.find((d) => d.id === id)!;
}

/**
 * Task-type → documents to load. Agents use this instead of reading everything
 * for every task. `rules.md` is always relevant.
 */
export const RELEVANCE_MAP: Array<{ task: string; docs: DocId[] }> = [
  { task: 'Database / schema / migrations / queries', docs: ['database', 'architecture', 'api', 'security', 'testing', 'rules'] },
  { task: 'API endpoints / controllers / request handling', docs: ['api', 'auth', 'security', 'architecture', 'testing', 'rules'] },
  { task: 'Authentication / authorization / sessions / permissions', docs: ['auth', 'security', 'api', 'database', 'testing', 'rules'] },
  { task: 'Frontend UI / styling / components', docs: ['project', 'architecture', 'rules'] },
  { task: 'New feature spanning multiple layers', docs: ['project', 'architecture', 'database', 'api', 'auth', 'security', 'testing', 'rules'] },
  { task: 'Bug fix / debugging', docs: ['debugging', 'architecture', 'testing', 'rules'] },
  { task: 'Performance work / caching / background jobs', docs: ['performance', 'architecture', 'database', 'rules'] },
  { task: 'Tests', docs: ['testing', 'project', 'rules'] },
  { task: 'Build / CI / Docker / deployment / infrastructure', docs: ['deployment', 'project', 'security', 'rules'] },
  { task: 'Dependency changes', docs: ['project', 'security', 'rules'] },
  { task: 'Code review', docs: ['code-review', 'rules', 'security', 'testing'] },
  { task: 'Small, local change (typo, rename, copy)', docs: ['rules'] },
];
