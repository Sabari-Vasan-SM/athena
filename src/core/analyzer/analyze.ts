import path from 'node:path';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import { ATHENA_DIR, loadConfig, type AthenaConfig } from '../config.js';
import { mapLimit, walkProject, type FileEntry, type ReusableEntry } from '../fs/walker.js';
import { emptyModel, ProjectModel } from '../model/project-model.js';
import { createContext, type AnalysisHints, type Detector, type FactDef } from './context.js';
import { FactEngine, type ReadFileFn } from './engine.js';
import { FactsCache, type FactsCacheStats } from '../cache/facts-cache.js';
import { readFileIndex } from '../state/state.js';
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
import { secretFingerprintKey, secretsDetector } from './detectors/secrets.js';
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

/** Bump when fact extraction changes without a detector version bump. */
const FACTS_REVISION = 1;
/** Identifies the detector code that produced cached facts; any change discards the facts cache. */
export const DETECTORS_VERSION = `${FACTS_REVISION};${DETECTORS.map((d) => `${d.id}@${d.version}`).join(',')}`;

const ALL_FACTS: FactDef<unknown>[] = DETECTORS.flatMap((d) => d.facts ?? []);

export type AnalysisStage = 'scan' | 'detect' | 'git' | 'finalize';

export interface AnalyzeOptions {
  signal?: AbortSignal;
  config?: AthenaConfig;
  onStage?: (stage: AnalysisStage, detail?: string) => void;
  onDetector?: (id: string, ms: number) => void;
  /**
   * Previous file index: unchanged files (same size + mtime) are neither re-read nor
   * re-hashed. Defaults to the index of the last analysis in `.athena/`.
   */
  reuse?: Record<string, ReusableEntry>;
  /** Use and update the per-file facts cache in `.athena/cache/` (default true; only when `.athena/` exists). */
  cache?: boolean;
  /** Salt for secret fingerprints when `.athena/local.json` does not exist yet (fresh init). */
  fingerprintSalt?: string;
  /** Injectable file reader (tests count content reads with it). */
  readFile?: ReadFileFn;
  /** Byte budget for file text kept in memory for aggregate-stage lookups (default 64MB). */
  textCacheBytes?: number;
}

export interface AnalysisPerf {
  filesRead: number;
  rereads: number;
  factsComputed: number;
  cache: FactsCacheStats;
}

export interface AnalysisResult {
  model: ProjectModel;
  files: FileEntry[];
  config: AthenaConfig;
  detectorVersions: Record<string, number>;
  durationMs: number;
  /** I/O and cache counters for this run. */
  perf: AnalysisPerf;
}

/** Facts not yet persisted (fresh init: `.athena/` did not exist during analysis). */
const pendingCaches = new WeakMap<AnalysisResult, { cache: FactsCache; live: Set<string> }>();

/** Hash of the config options facts depend on (what gets indexed and read). */
export function factsConfigHash(config: AthenaConfig): string {
  return crypto.createHash('sha256').update(JSON.stringify({ ignore: config.ignore, include: config.include, maxFileBytes: config.maxFileBytes })).digest('hex').slice(0, 16);
}

async function isDir(p: string): Promise<boolean> {
  return fs.stat(p).then((s) => s.isDirectory(), () => false);
}

/**
 * Analyze a project into a ProjectModel.
 *
 * Stages: (1) walk — stat only, reusing hashes of files whose size and mtime are
 * unchanged; (2) hints — manifests and declared frameworks, which decide whether
 * expensive facts are worth computing eagerly; (3) content pass — every new,
 * changed or uncached file is read exactly once, hashed, and all its per-file
 * facts are computed and cached by content hash; (4) aggregate — the detectors
 * build the model from facts, in their fixed order. Unchanged files are not read.
 */
export async function analyzeProject(rootInput: string, opts: AnalyzeOptions = {}): Promise<AnalysisResult> {
  const started = Date.now();
  const root = await fs.realpath(path.resolve(rootInput));
  const loaded = opts.config ? { config: opts.config } : await loadConfig(root);
  const config = loaded.config;
  const model = emptyModel(path.basename(root), root);
  if ('warning' in loaded && loaded.warning) model.warnings.push(loaded.warning);

  const athena = path.join(root, ATHENA_DIR);
  const useCache = opts.cache !== false && (await isDir(athena));
  const reuse = opts.reuse ?? (useCache ? await readFileIndex(athena) : undefined);

  opts.onStage?.('scan');
  const walk = await walkProject(root, { config, signal: opts.signal, reuse, deferRead: true });
  model.warnings.push(...walk.warnings);

  const runtime = await secretFingerprintKey(root, opts.fingerprintSalt);
  const cache = await FactsCache.open(useCache ? athena : null, { detectors: DETECTORS_VERSION, config: factsConfigHash(config) });
  const engine = new FactEngine({ root, files: walk.files, cache, runtime, defs: ALL_FACTS, signal: opts.signal, readFile: opts.readFile, textCacheBytes: opts.textCacheBytes });
  await cache.preload(walk.files.filter((f) => f.hash && !f.binary && !f.large).map((f) => f.hash));

  // Hints, only when some file may need an expensive (gated) fact computed.
  const gated = ALL_FACTS.filter((d) => d.when);
  const needHints = walk.files.some((f) => !f.large && gated.some((d) => d.applies(f) && (f.hash === '' || (!f.binary && !cache.has(f.hash, engine.keyOf(d, f.path))))));
  engine.hints = needHints ? await projectHints(root, config, walk.files, engine, opts.signal) : { frameworks: new Set() };

  // Content pass: each file that needs it is read once.
  const todo = walk.files.filter((f) => engine.needsProcessing(f));
  await mapLimit(todo, 32, (f) => engine.process(f));
  opts.signal?.throwIfAborted();

  const files = engine.unreadable.size ? walk.files.filter((f) => !engine.unreadable.has(f.path)) : walk.files;
  let skippedBinary = 0;
  let skippedLarge = 0;
  for (const f of files) {
    if (f.binary) skippedBinary++;
    if (f.large) skippedLarge++;
  }
  model.stats = { filesScanned: files.length, skippedBinary, skippedLarge, skippedUnreadable: walk.skippedUnreadable + engine.unreadable.size };

  opts.onStage?.('detect');
  const ctx = createContext(root, config, files, model, engine, opts.signal);
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

  const live = new Set(files.map((f) => f.hash));
  const result: AnalysisResult = {
    model: redacted,
    files,
    config,
    detectorVersions: Object.fromEntries(DETECTORS.map((d) => [d.id, d.version])),
    durationMs: 0,
    perf: { ...engine.stats, cache: cache.stats },
  };
  if (useCache) {
    try {
      await cache.save(athena, live);
    } catch {
      /* the cache is an optimization; a read-only checkout still analyzes */
    }
  } else if (opts.cache !== false) pendingCaches.set(result, { cache, live });
  result.durationMs = Date.now() - started;
  return result;
}

/**
 * Persist the facts of an analysis that ran before `.athena/` existed (fresh init
 * builds into a temporary directory). No-op when the analysis already saved them.
 */
export async function persistAnalysisCache(result: AnalysisResult, athenaDir: string): Promise<void> {
  const pending = pendingCaches.get(result);
  if (!pending) return;
  pendingCaches.delete(result);
  try {
    await pending.cache.save(athenaDir, pending.live);
  } catch {
    /* optional */
  }
}

/** Frameworks declared by the project's manifests (runs the manifest detectors on a scratch model). */
async function projectHints(root: string, config: AthenaConfig, files: FileEntry[], engine: FactEngine, signal?: AbortSignal): Promise<AnalysisHints> {
  const scratch = emptyModel(path.basename(root), root);
  const ctx = createContext(root, config, files, scratch, engine, signal);
  try {
    await manifestsDetector.run(ctx);
    await dependenciesDetector.run(ctx);
  } catch (err) {
    if (signal?.aborted) throw err;
  }
  return { frameworks: new Set(scratch.frameworks.map((f) => f.name)) };
}

/** Apply secret redaction to every string in the model (defense in depth). */
export function redactDeep<T>(value: T, memo: Map<string, string> = new Map()): T {
  if (typeof value === 'string') {
    // Models repeat the same strings (paths, names) many times; redact each once.
    let r = memo.get(value);
    if (r === undefined) {
      r = redact(value);
      memo.set(value, r);
    }
    return r as T;
  }
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, memo)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, memo);
    return out as T;
  }
  return value;
}
