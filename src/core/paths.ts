import path from 'node:path';

/**
 * Where Athena keeps its files. Dependency-free on purpose: `athena event` (run by
 * agent hooks on every tool call) imports it, and must not load zod or the config
 * and state schemas. `config.ts` and `state/state.ts` re-export or mirror these.
 */
export const ATHENA_DIR = '.athena';

export function athenaDir(root: string): string {
  return path.join(root, ATHENA_DIR);
}
