import { parseAllDocuments, parse as parseYaml } from 'yaml';
import type { AnalysisContext, Detector } from '../context.js';
import type { CiJob, ContainerService } from '../../model/project-model.js';
import { detected } from '../../model/fact.js';
import { redact } from '../../security/secrets.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const IMAGE_CAPS: Array<[RegExp, string, 'database' | 'cache' | 'queue']> = [
  [/^(?:.*\/)?(postgres|postgis\/postgis|pgvector\/pgvector|timescale\/timescaledb)(:|$)/, 'PostgreSQL', 'database'],
  [/^(?:.*\/)?(mysql|mariadb)(:|$)/, 'MySQL/MariaDB', 'database'],
  [/^(?:.*\/)?mongo(:|$)/, 'MongoDB', 'database'],
  [/^(?:.*\/)?(mcr\.microsoft\.com\/mssql\/server|mssql)/, 'SQL Server', 'database'],
  [/^(?:.*\/)?(elasticsearch|opensearch)/, 'Elasticsearch/OpenSearch', 'database'],
  [/^(?:.*\/)?clickhouse/, 'ClickHouse', 'database'],
  [/^(?:.*\/)?(redis|valkey|redis\/redis-stack)(:|$)/, 'Redis', 'cache'],
  [/^(?:.*\/)?memcached(:|$)/, 'Memcached', 'cache'],
  [/^(?:.*\/)?rabbitmq(:|$)/, 'RabbitMQ', 'queue'],
  [/^(?:.*\/)?(confluentinc\/cp-kafka|bitnami\/kafka|apache\/kafka)/, 'Kafka', 'queue'],
  [/^(?:.*\/)?nats(:|$)/, 'NATS', 'queue'],
];

const HOSTING: Array<[RegExp, string, string]> = [
  [/(^|\/)vercel\.json$/, 'Vercel', 'hosting'],
  [/(^|\/)netlify\.toml$/, 'Netlify', 'hosting'],
  [/(^|\/)fly\.toml$/, 'Fly.io', 'hosting'],
  [/(^|\/)render\.ya?ml$/, 'Render', 'hosting'],
  [/(^|\/)railway\.(json|toml)$/, 'Railway', 'hosting'],
  [/(^|\/)Procfile$/, 'Procfile (Heroku-style)', 'hosting'],
  [/(^|\/)app\.ya?ml$/, 'Google App Engine (app.yaml)', 'hosting'],
  [/(^|\/)firebase\.json$/, 'Firebase Hosting/config', 'hosting'],
  [/(^|\/)wrangler\.(toml|jsonc?)$/, 'Cloudflare Workers', 'hosting'],
  [/(^|\/)serverless\.ya?ml$/, 'Serverless Framework', 'hosting'],
  [/(^|\/)template\.ya?ml$|(^|\/)samconfig\.toml$/, 'AWS SAM (possible)', 'hosting'],
  [/(^|\/)cdk\.json$/, 'AWS CDK', 'iac'],
  [/(^|\/)Pulumi\.ya?ml$/, 'Pulumi', 'iac'],
  [/(^|\/)Chart\.yaml$/, 'Helm chart', 'kubernetes'],
  [/(^|\/)kustomization\.ya?ml$/, 'Kustomize', 'kubernetes'],
  [/(^|\/)skaffold\.ya?ml$/, 'Skaffold', 'kubernetes'],
  [/(^|\/)nginx[^/]*\.conf$|(^|\/)nginx\/.*\.conf$/, 'nginx config', 'reverse-proxy'],
  [/(^|\/)Caddyfile$/, 'Caddy', 'reverse-proxy'],
  [/(^|\/)traefik\.ya?ml$/, 'Traefik', 'reverse-proxy'],
];

function strList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x) : isObj(x) && x.target ? `${x.published ?? ''}:${x.target}` : '')).filter(Boolean);
  if (isObj(v)) return Object.keys(v);
  return [];
}

function trimCmd(s: string): string {
  const one = s.split('\n').map((l) => l.trim()).filter(Boolean).join(' && ');
  return redact(one.length > 160 ? `${one.slice(0, 157)}...` : one);
}

async function composeServices(ctx: AnalysisContext): Promise<ContainerService[]> {
  const out: ContainerService[] = [];
  for (const f of ctx.find(/(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/)) {
    const text = await ctx.read(f.path);
    if (!text) continue;
    let y: unknown;
    try {
      y = parseYaml(text);
    } catch {
      ctx.warn(`Could not parse ${f.path} (invalid YAML)`);
      continue;
    }
    if (!isObj(y) || !isObj(y.services)) continue;
    for (const [name, svc] of Object.entries(y.services)) {
      if (!isObj(svc)) continue;
      out.push({
        name,
        image: typeof svc.image === 'string' ? svc.image : isObj(svc.build) || typeof svc.build === 'string' ? '(built locally)' : undefined,
        ports: strList(svc.ports),
        dependsOn: strList(svc.depends_on),
        file: f.path,
      });
    }
  }
  return out;
}

async function ciJobs(ctx: AnalysisContext): Promise<CiJob[]> {
  const jobs: CiJob[] = [];
  const loadYaml = async (p: string): Promise<Obj | null> => {
    const text = await ctx.read(p);
    if (!text) return null;
    try {
      const y = parseYaml(text);
      return isObj(y) ? y : null;
    } catch {
      ctx.warn(`Could not parse ${p} (invalid YAML)`);
      return null;
    }
  };

  for (const f of ctx.find(/^\.github\/workflows\/[^/]+\.ya?ml$/)) {
    const y = await loadYaml(f.path);
    if (!y || !isObj(y.jobs)) continue;
    for (const [id, job] of Object.entries(y.jobs)) {
      if (!isObj(job)) continue;
      const steps = Array.isArray(job.steps) ? job.steps : [];
      const commands = steps.flatMap((s) => (isObj(s) && typeof s.run === 'string' ? [trimCmd(s.run)] : isObj(s) && typeof s.uses === 'string' ? [`uses: ${s.uses}`] : []));
      jobs.push({ system: 'GitHub Actions', file: f.path, name: typeof job.name === 'string' ? job.name : id, commands: commands.slice(0, 12) });
    }
  }
  if (ctx.has('.gitlab-ci.yml')) {
    const y = await loadYaml('.gitlab-ci.yml');
    if (y) for (const [id, job] of Object.entries(y)) {
      if (id.startsWith('.') || !isObj(job) || !('script' in job)) continue;
      const script = Array.isArray(job.script) ? job.script.map(String) : [String(job.script)];
      jobs.push({ system: 'GitLab CI', file: '.gitlab-ci.yml', name: id, commands: script.map(trimCmd).slice(0, 12) });
    }
  }
  if (ctx.has('.circleci/config.yml')) {
    const y = await loadYaml('.circleci/config.yml');
    if (y && isObj(y.jobs)) for (const [id, job] of Object.entries(y.jobs)) {
      const steps = isObj(job) && Array.isArray(job.steps) ? job.steps : [];
      const commands = steps.flatMap((s) => (isObj(s) && isObj(s.run) && typeof s.run.command === 'string' ? [trimCmd(s.run.command)] : isObj(s) && typeof s.run === 'string' ? [trimCmd(s.run)] : []));
      jobs.push({ system: 'CircleCI', file: '.circleci/config.yml', name: id, commands: commands.slice(0, 12) });
    }
  }
  for (const f of ctx.find(/(^|\/)azure-pipelines\.ya?ml$/)) jobs.push({ system: 'Azure Pipelines', file: f.path, name: 'pipeline', commands: [] });
  for (const f of ctx.find(/(^|\/)bitbucket-pipelines\.yml$/)) jobs.push({ system: 'Bitbucket Pipelines', file: f.path, name: 'pipeline', commands: [] });
  for (const f of ctx.find(/(^|\/)Jenkinsfile$/)) {
    const text = (await ctx.read(f.path)) ?? '';
    const stages = [...text.matchAll(/stage\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    if (stages.length) for (const s of stages) jobs.push({ system: 'Jenkins', file: f.path, name: s, commands: [] });
    else jobs.push({ system: 'Jenkins', file: f.path, name: 'pipeline', commands: [] });
  }
  return jobs;
}

export const infraDetector: Detector = {
  id: 'infra',
  version: 1,
  async run(ctx) {
    const { model } = ctx;

    for (const f of ctx.find(/(^|\/)(Dockerfile|Containerfile)(\.[\w.-]+)?$|\.dockerfile$/i)) {
      const text = await ctx.read(f.path);
      if (!text) continue;
      const baseImages = [...text.matchAll(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/gim)].map((m) => m[1]!);
      const exposedPorts = [...text.matchAll(/^\s*EXPOSE\s+(.+)$/gim)].flatMap((m) => m[1]!.trim().split(/\s+/));
      model.containers.dockerfiles.push({ path: f.path, baseImages: [...new Set(baseImages)], exposedPorts: [...new Set(exposedPorts)] });
    }

    model.containers.services = await composeServices(ctx);
    for (const svc of model.containers.services) {
      if (!svc.image) continue;
      for (const [re, name, cap] of IMAGE_CAPS) {
        if (!re.test(svc.image)) continue;
        const prov = detected('config', [{ file: svc.file, detail: `compose service "${svc.name}" image ${svc.image}` }]);
        if (cap === 'database') model.databases.push({ name, kind: 'service', provenance: prov });
        else if (cap === 'cache') model.caching.push({ name: `${name} (container)`, provenance: prov });
        else model.queues.push({ name: `${name} (container)`, provenance: prov });
      }
    }

    for (const [re, name, kind] of HOSTING) {
      for (const f of ctx.find(re)) model.infrastructure.push({ name, kind, file: f.path, provenance: detected('filesystem', [{ file: f.path }], name.includes('possible') ? 'low' : 'high') });
    }

    const tfProviders = new Map<string, string>();
    for (const f of ctx.find(/\.tf$/)) {
      const text = await ctx.read(f.path);
      if (!text) continue;
      for (const m of text.matchAll(/(?:provider|required_providers)\s*"?([a-z0-9_-]+)"?\s*\{|source\s*=\s*"(?:[\w.-]+\/)?([\w-]+)\/([\w-]+)"/g)) {
        const p = m[1] ?? m[3];
        if (p && p !== 'required_providers' && !tfProviders.has(p)) tfProviders.set(p, f.path);
      }
    }
    for (const [p, file] of tfProviders) model.infrastructure.push({ name: `Terraform provider: ${p}`, kind: 'iac', file, provenance: detected('config', [{ file }]) });

    const k8sKinds = new Map<string, string>();
    for (const f of ctx.find(/\.ya?ml$/)) {
      if (f.large || /(^|\/)(\.github|\.gitlab|\.circleci)\//.test(f.path) || /compose/.test(f.path)) continue;
      const text = await ctx.read(f.path);
      if (!text || !/^apiVersion:/m.test(text) || !/^kind:/m.test(text)) continue;
      try {
        for (const doc of parseAllDocuments(text)) {
          const j = doc.toJSON() as unknown;
          if (isObj(j) && typeof j.kind === 'string' && typeof j.apiVersion === 'string' && !k8sKinds.has(j.kind)) k8sKinds.set(j.kind, f.path);
        }
      } catch {
        /* templated YAML (Helm) is expected to fail */
      }
    }
    for (const [kind, file] of k8sKinds) model.infrastructure.push({ name: `Kubernetes ${kind}`, kind: 'kubernetes', file, provenance: detected('config', [{ file }]) });

    model.ci = await ciJobs(ctx);

    for (const f of ctx.find(/(^|\/)(\.github\/dependabot\.ya?ml|renovate\.json5?|\.renovaterc(\.json)?|\.snyk|\.semgrep\.ya?ml|\.gitleaks\.toml|\.trivyignore|codeql[^/]*\.ya?ml|\.pre-commit-config\.yaml|SECURITY\.md)$/)) {
      const name = /dependabot/.test(f.path) ? 'Dependabot' : /renovate/.test(f.path) ? 'Renovate' : /snyk/.test(f.path) ? 'Snyk' : /semgrep/.test(f.path) ? 'Semgrep' : /gitleaks/.test(f.path) ? 'Gitleaks' : /trivy/.test(f.path) ? 'Trivy' : /codeql/.test(f.path) ? 'CodeQL' : /pre-commit/.test(f.path) ? 'pre-commit hooks' : 'Security policy (SECURITY.md)';
      model.security.tooling.push({ name, provenance: detected('filesystem', [{ file: f.path }]) });
    }
    for (const job of model.ci) {
      for (const c of job.commands) {
        const m = /(codeql|trivy|snyk|semgrep|gitleaks|npm audit|pip-audit|govulncheck|cargo audit|bandit|brakeman|zap)/i.exec(c);
        if (m) model.security.tooling.push({ name: `${m[1]} (in CI)`, provenance: detected('config', [{ file: job.file, detail: `job "${job.name}"` }]) });
      }
    }
  },
};
