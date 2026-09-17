import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FileEntry } from '../fs/walker.js';
import type { ProjectModel } from '../model/project-model.js';
import type { AthenaConfig } from '../config.js';

export interface AnalysisContext {
  root: string;
  config: AthenaConfig;
  files: FileEntry[];
  model: ProjectModel;
  signal?: AbortSignal;
  /** Read a text file (repo-relative POSIX). Returns null for binary/oversized/missing files. */
  read(rel: string): Promise<string | null>;
  has(rel: string): boolean;
  /** Files whose path matches the predicate/regex. */
  find(match: RegExp | ((f: FileEntry) => boolean)): FileEntry[];
  warn(message: string): void;
}

export interface Detector {
  id: string;
  /** Bump when detector output semantics change (recorded in state.json). */
  version: number;
  run(ctx: AnalysisContext): Promise<void>;
}

export function createContext(root: string, config: AthenaConfig, files: FileEntry[], model: ProjectModel, signal?: AbortSignal): AnalysisContext {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const cache = new Map<string, string | null>();
  return {
    root,
    config,
    files,
    model,
    signal,
    has: (rel) => byPath.has(rel),
    async read(rel) {
      if (cache.has(rel)) return cache.get(rel)!;
      const entry = byPath.get(rel);
      if (!entry || entry.binary || entry.large) return null;
      signal?.throwIfAborted();
      let text: string | null = null;
      try {
        text = await fs.readFile(path.join(root, rel), 'utf8');
      } catch {
        text = null;
      }
      // Only cache small files to bound memory on huge repos.
      if (!text || text.length < 256_000) cache.set(rel, text);
      return text;
    },
    find(match) {
      if (match instanceof RegExp) return files.filter((f) => match.test(f.path));
      return files.filter(match);
    },
    warn(message) {
      model.warnings.push(message);
    },
  };
}
