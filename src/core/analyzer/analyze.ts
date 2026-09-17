import path from 'node:path';
import { promises as fs } from 'node:fs';
import { loadConfig, type AthenaConfig } from '../config.js';
import { walkProject, type FileEntry } from '../fs/walker.js';
import { emptyModel, ProjectModel } from '../model/project-model.js';
import { createContext, type Detector } from './context.js';
import { structureDetector } from './detectors/structure.js';
import { manifestsDetector } from './detectors/manifests.js';
import { dependenciesDetector } from './detectors/dependencies.js';
import { envDetector } from './detectors/env.js';
import { infraDetector } from './detectors/infra.js';
import { testsDetector } from './detectors/tests.js';
import { databaseDetector } from './detectors/database.js';
import { routesDetector } from './detectors/routes.js';
import { authDetector } from './detectors/auth.js';
import { entryPointsDetector } from './detectors/entrypoints.js';
import { secretsDetector } from './detectors/secrets.js';
import { gitInfo } from '../git/git.js';
import { redact } from '../security/secrets.js';

/** Ordered: later detectors may read earlier detectors' output. */
export const DETECTORS: Detector[] = [
  structureDetector,
  manifestsDetector,
  dependenciesDetector,
  envDetector,
  infraDetector,
  testsDetector,
  databaseDetector,
  routesDetector,
  authDetector,
  entryPointsDetector,
  secretsDetector,
];

export type AnalysisStage = 'scan' | 'detect' | 'git' | 'finalize';

export interface AnalyzeOptions {
  signal?: AbortSignal;
  config?: AthenaConfig;
  onStage?: (stage: AnalysisStage, detail?: string) => void;
  onDetector?: (id: string, ms: number) => void;
}

export interface AnalysisResult {
  model: ProjectModel;
  files: FileEntry[];
  config: AthenaConfig;
  detectorVersions: Record<string, number>;
  durationMs: number;
}

export async function analyzeProject(rootInput: string, opts: AnalyzeOptions = {}): Promise<AnalysisResult> {
  const started = Date.now();
  const root = await fs.realpath(path.resolve(rootInput));
  const loaded = opts.config ? { config: opts.config } : await loadConfig(root);
  const config = loaded.config;
  const model = emptyModel(path.basename(root), root);
  if ('warning' in loaded && loaded.warning) model.warnings.push(loaded.warning);

  opts.onStage?.('scan');
  const walk = await walkProject(root, { config, signal: opts.signal });
  model.stats = {
    filesScanned: walk.files.length,
    skippedBinary: walk.skippedBinary,
    skippedLarge: walk.skippedLarge,
    skippedUnreadable: walk.skippedUnreadable,
  };
  model.warnings.push(...walk.warnings);

  opts.onStage?.('detect');
  const ctx = createContext(root, config, walk.files, model, opts.signal);
  for (const d of DETECTORS) {
    opts.signal?.throwIfAborted();
    const t = Date.now();
    try {
      await d.run(ctx);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      model.warnings.push(`Detector "${d.id}" failed: ${(err as Error).message}`);
    }
    opts.onDetector?.(d.id, Date.now() - t);
  }

  opts.onStage?.('git');
  model.git = await gitInfo(root);

  opts.onStage?.('finalize');
  const redacted = redactDeep(model) as ProjectModel;
  // Validate our own output — a failure here is a bug, surfaced as a warning rather than a crash.
  const check = ProjectModel.safeParse(redacted);
  if (!check.success) redacted.warnings.push(`Internal model validation issue: ${check.error.issues[0]?.path.join('.')} ${check.error.issues[0]?.message}`);

  return {
    model: redacted,
    files: walk.files,
    config,
    detectorVersions: Object.fromEntries(DETECTORS.map((d) => [d.id, d.version])),
    durationMs: Date.now() - started,
  };
}

/** Apply secret redaction to every string in the model (defense in depth). */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}
