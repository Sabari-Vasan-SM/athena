import type { FileEntry } from '../fs/walker.js';
import type { ProjectModel } from '../model/project-model.js';
import type { AthenaConfig } from '../config.js';

/**
 * A per-file fact: a pure, JSON-serializable function of a file's text (and, when
 * `pathKeyed`, its path). Facts are computed in the single content pass while the
 * file's bytes are in memory, cached by content hash, and read back by detectors
 * in the aggregate stage — so an unchanged file is never read again.
 */
export interface FactDef<T = unknown> {
  /** Stable id; part of the cache key. Change it (or DETECTORS_VERSION) when `compute` changes. */
  id: string;
  /** Files this fact is computed for during the content pass. Must cover every file a detector asks about. */
  applies(f: FileEntry): boolean;
  /** Must not return null/undefined: null is reserved for "file not readable as text". */
  compute(text: string, rel: string, rt: FactRuntime): T;
  /** The value depends on the path too: the path becomes part of the cache key. */
  pathKeyed?: boolean;
  /** Expensive facts: only computed eagerly when the project hints ask for them (lazily otherwise). */
  when?(hints: AnalysisHints): boolean;
  /** The value depends on the secret-fingerprint key: keyed by it, never persisted when the key is ephemeral. */
  keyed?: boolean;
}

export interface FactRuntime {
  fingerprint(value: string): string;
  /** Id of the fingerprint key (a hash of the salt); null for an ephemeral per-process key. */
  fingerprintKeyId: string | null;
}

/** Project-level hints known before the content pass (from manifests and declared dependencies). */
export interface AnalysisHints {
  frameworks: Set<string>;
}

export interface AnalysisContext {
  root: string;
  config: AthenaConfig;
  files: FileEntry[];
  model: ProjectModel;
  signal?: AbortSignal;
  /** Read a text file (repo-relative POSIX). Returns null for binary/oversized/missing files. */
  read(rel: string): Promise<string | null>;
  /**
   * The fact `def` for file `rel`: from the cache when the content is unchanged,
   * otherwise computed from the file's text. Null when the file is not an indexed,
   * readable text file (the same cases in which `read` returns null).
   */
  fact<T>(rel: string, def: FactDef<T>): Promise<T | null>;
  has(rel: string): boolean;
  /** Files whose path matches the predicate/regex. */
  find(match: RegExp | ((f: FileEntry) => boolean)): FileEntry[];
  warn(message: string): void;
  /** Keyed fingerprint for secret values (see secretFingerprintKey). */
  runtime: FactRuntime;
}

export interface Detector {
  id: string;
  /** Bump when detector output semantics change (recorded in state.json; invalidates cached facts). */
  version: number;
  /** Per-file facts this detector reads (computed in the single content pass). */
  facts?: FactDef<any>[];
  run(ctx: AnalysisContext): Promise<void>;
}

export interface FactSource {
  read(rel: string): Promise<string | null>;
  fact<T>(rel: string, def: FactDef<T>): Promise<T | null>;
  runtime: FactRuntime;
}

export function createContext(root: string, config: AthenaConfig, files: FileEntry[], model: ProjectModel, source: FactSource, signal?: AbortSignal): AnalysisContext {
  const byPath = new Map(files.map((f) => [f.path, f]));
  return {
    root,
    config,
    files,
    model,
    signal,
    runtime: source.runtime,
    has: (rel) => byPath.has(rel),
    read: (rel) => source.read(rel),
    fact: (rel, def) => source.fact(rel, def),
    find(match) {
      if (match instanceof RegExp) return files.filter((f) => match.test(f.path));
      return files.filter(match);
    },
    warn(message) {
      model.warnings.push(message);
    },
  };
}
