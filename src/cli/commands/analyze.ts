import { requireProjectRoot, type GlobalOptions } from '../context.js';
import { parseAgentsOption, printSummary, runWithProgress, summarize } from './init.js';
import * as ui from '../ui/term.js';

export interface AnalyzeOptions extends GlobalOptions {
  force?: boolean;
  agents?: string;
  signal?: AbortSignal;
}

export async function analyzeCommand(opts: AnalyzeOptions): Promise<void> {
  const root = await requireProjectRoot(opts);
  const agents = parseAgentsOption(opts.agents, false);
  const result = await runWithProgress(root, { mode: 'analyze', force: opts.force, agents, signal: opts.signal });
  if (ui.isJson()) ui.json(summarize(result, root, false));
  else printSummary(result, false, 'analyze');
}
