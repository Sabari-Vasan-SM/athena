import path from 'node:path';
import { z } from 'zod';
import { readTextIfExists } from './util/fs.js';

export const ATHENA_DIR = '.athena';

export const DEFAULT_IGNORES = [
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'bower_components',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.dart_tool',
  '.venv',
  'venv',
  '.tox',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'target',
  'coverage',
  '.gradle',
  '.idea',
  'vendor',
  'Pods',
  '.terraform',
  '.serverless',
  ATHENA_DIR,
  `${ATHENA_DIR}.tmp-*`,
];

export const AthenaConfig = z.object({
  /** Additional gitignore-style patterns to exclude. */
  ignore: z.array(z.string()).default([]),
  /** Patterns (gitignore-style) to force-include even if a default ignore matches. */
  include: z.array(z.string()).default([]),
  /** Files larger than this are indexed by metadata only. */
  maxFileBytes: z.number().int().positive().default(1_000_000),
  /** Hard cap on files scanned; beyond this analysis stops and warns. */
  maxFiles: z.number().int().positive().default(200_000),
  /** Agent adapters to configure. Empty = auto. */
  agents: z.array(z.string()).optional(),
});
export type AthenaConfig = z.infer<typeof AthenaConfig>;

export interface LoadedConfig {
  config: AthenaConfig;
  warning?: string;
}

export async function loadConfig(root: string): Promise<LoadedConfig> {
  const file = path.join(root, ATHENA_DIR, 'config.json');
  const raw = await readTextIfExists(file);
  if (raw === null) return { config: AthenaConfig.parse({}) };
  try {
    const parsed = AthenaConfig.safeParse(JSON.parse(raw));
    if (parsed.success) return { config: parsed.data };
    return { config: AthenaConfig.parse({}), warning: `.athena/config.json is invalid (${parsed.error.issues[0]?.message}); using defaults` };
  } catch {
    return { config: AthenaConfig.parse({}), warning: '.athena/config.json is not valid JSON; using defaults' };
  }
}
