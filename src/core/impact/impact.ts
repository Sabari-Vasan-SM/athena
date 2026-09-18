import type { DocId } from '../knowledge/documents.js';

/**
 * Path-based impact rules: which knowledge documents a changed file may affect.
 * Used by `athena status` and combined with the model-level diff in sync planning.
 */
const RULES: Array<{ match: RegExp; docs: DocId[]; reason: string }> = [
  { match: /(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|Pipfile|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|composer\.json|Gemfile|pubspec\.yaml|mix\.exs|[^/]+\.csproj)$/, docs: ['project', 'architecture', 'security', 'testing'], reason: 'dependency manifest' },
  { match: /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|uv\.lock|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock)$/, docs: ['project', 'security'], reason: 'lockfile' },
  { match: /(^|\/)(pnpm-workspace\.yaml|turbo\.json|nx\.json|lerna\.json|go\.work|settings\.gradle(\.kts)?)$/, docs: ['project', 'architecture'], reason: 'workspace configuration' },
  { match: /\.prisma$|\.sql$|(^|\/)(migrations?|migrate|alembic|changelog)\/|(^|\/)models(\.py|\/)|(^|\/)(schema|entities|entity)\b/i, docs: ['database', 'performance', 'code-review'], reason: 'schema / migration' },
  { match: /(^|\/)(routes?|controllers?|handlers?|api|endpoints?|views|resolvers?)\/|(^|\/)(urls\.py|routes\.rb)$|(^|\/)app\/(.+\/)?route\.(t|j)sx?$|\.(graphql|gql|proto)$|(openapi|swagger)[^/]*\.(json|ya?ml)$/i, docs: ['api', 'security', 'testing'], reason: 'API surface' },
  { match: /(auth|session|login|oauth|jwt|guard|permission|rbac|acl|polic(y|ies)|middleware)/i, docs: ['auth', 'security'], reason: 'auth-related' },
  { match: /(^|\/)(Dockerfile|Containerfile)[^/]*$|(^|\/)(docker-)?compose[^/]*\.ya?ml$/i, docs: ['deployment', 'architecture', 'security'], reason: 'container configuration' },
  { match: /^\.github\/workflows\/|(^|\/)(\.gitlab-ci\.yml|Jenkinsfile|azure-pipelines\.ya?ml|bitbucket-pipelines\.yml)$|^\.circleci\//, docs: ['deployment', 'testing'], reason: 'CI/CD' },
  { match: /\.tf$|(^|\/)(vercel\.json|netlify\.toml|fly\.toml|render\.ya?ml|railway\.(json|toml)|Procfile|wrangler\.(toml|jsonc?)|serverless\.ya?ml|Chart\.yaml|kustomization\.ya?ml)$|(^|\/)(k8s|kubernetes|helm|deploy|infra)\//, docs: ['deployment', 'architecture'], reason: 'infrastructure' },
  { match: /(^|\/)\.env\.(example|sample|template)$/, docs: ['deployment', 'project'], reason: 'environment template' },
  { match: /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$|(^|\/)(jest|vitest|playwright|cypress)\.config\./, docs: ['testing'], reason: 'tests' },
  { match: /(cache|redis|queue|worker|jobs?)\b/i, docs: ['performance'], reason: 'caching / background work' },
  { match: /(^|\/)(Makefile|justfile|Taskfile\.ya?ml)$/, docs: ['project', 'debugging'], reason: 'task runner' },
];

export interface ImpactResult {
  docs: DocId[];
  reasons: Record<string, string[]>;
}

export function impactOf(paths: string[], opts: { structural?: string[] } = {}): ImpactResult {
  const docs = new Set<DocId>();
  const reasons: Record<string, string[]> = {};
  const note = (doc: DocId, why: string) => {
    docs.add(doc);
    reasons[doc] ??= [];
    if (!reasons[doc]!.includes(why)) reasons[doc]!.push(why);
  };
  for (const p of paths) {
    if (p.startsWith('.athena/')) continue;
    for (const r of RULES) if (r.match.test(p)) for (const d of r.docs) note(d, r.reason);
  }
  // Added/deleted files change project structure even when no rule matches.
  if (opts.structural?.some((p) => !p.startsWith('.athena/'))) note('project', 'files added or removed');
  const order = ['project', 'architecture', 'database', 'api', 'auth', 'security', 'testing', 'debugging', 'performance', 'code-review', 'deployment', 'rules'];
  return { docs: [...docs].sort((a, b) => order.indexOf(a) - order.indexOf(b)), reasons };
}
