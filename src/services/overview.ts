import path from 'node:path';
import { ProjectModel } from '../core/model/project-model.js';
import { athenaDir, readState } from '../core/state/state.js';
import { readTextIfExists } from '../core/util/fs.js';
import { AthenaError } from './errors.js';
import { ATHENA_VERSION } from './version.js';

export interface Overview {
  athenaVersion: string;
  project: { name: string; description: string | null; root: string };
  analyzedAt: string;
  analysisDurationMs: number;
  git: { isRepo: boolean; branch: string | null; head: string | null };
  /** null when model.json is unavailable (e.g. fresh clone) — never guessed. */
  summary: null | {
    filesAnalyzed: number;
    languages: Array<{ name: string; files: number }>;
    frameworks: Array<{ name: string; category: string; root: string; status: string; confidence: string }>;
    monorepo: { isMonorepo: boolean; tool: string | null; packages: number };
    databases: string[];
    entities: number;
    migrations: number;
    routes: number;
    apiSpecs: number;
    auth: string[];
    testFrameworks: string[];
    testFiles: number;
    ci: string[];
    containers: number;
    hosting: string[];
    envVars: number;
    potentialSecrets: number;
    securityControls: number;
    warnings: string[];
  };
}

export async function getOverview(root: string): Promise<Overview> {
  const st = await readState(athenaDir(root));
  if (st.kind === 'missing') throw new AthenaError('Athena is not initialized in this project.', 'Run `athena init`.', 3);
  if (st.kind === 'corrupted') throw new AthenaError(`.athena/state.json is corrupted (${st.reason}).`, 'Run `athena analyze` to rebuild it.');
  const state = st.state;

  let model: ProjectModel | null = null;
  const raw = await readTextIfExists(path.join(athenaDir(root), 'model.json'));
  if (raw) {
    try {
      const parsed = ProjectModel.safeParse(JSON.parse(raw));
      if (parsed.success) model = parsed.data;
    } catch {
      model = null;
    }
  }
  const uniq = (xs: string[]) => [...new Set(xs)];
  return {
    athenaVersion: ATHENA_VERSION,
    project: { name: state.projectName, description: model?.description ?? null, root },
    analyzedAt: state.analyzedAt,
    analysisDurationMs: state.analysisDurationMs,
    git: { isRepo: state.git.isRepo, branch: state.git.branch ?? null, head: state.git.head ?? null },
    summary: model && {
      filesAnalyzed: model.stats.filesScanned,
      languages: model.languages.slice(0, 6).map((l) => ({ name: l.name, files: l.files })),
      frameworks: model.frameworks.map((f) => ({ name: f.name, category: f.category, root: f.root, status: f.provenance.status, confidence: f.provenance.confidence })),
      monorepo: { isMonorepo: model.workspace.isMonorepo, tool: model.workspace.tool ?? null, packages: model.workspace.packages.length },
      databases: uniq(model.databases.map((d) => d.name)),
      entities: model.dbEntities.length,
      migrations: model.migrations.reduce((n, m) => n + m.count, 0),
      routes: model.routes.length,
      apiSpecs: model.apiSpecs.length,
      auth: uniq(model.auth.map((a) => a.name)),
      testFrameworks: uniq(model.tests.frameworks.map((t) => t.name)),
      testFiles: model.tests.testFileCount,
      ci: uniq(model.ci.map((c) => c.system)),
      containers: model.containers.dockerfiles.length + model.containers.services.length,
      hosting: uniq(model.infrastructure.filter((i) => i.kind === 'hosting').map((i) => i.name)),
      envVars: model.env.vars.length,
      potentialSecrets: model.security.secrets.length,
      securityControls: model.security.controls.length,
      warnings: model.warnings,
    },
  };
}
