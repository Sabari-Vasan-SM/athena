import type { AgentAdapter } from '../../core/agents/adapter.js';
import { athenaInstructions } from '../common/instructions.js';
import { checkBlock, planBlock, removeBlockFrom, userEvidence } from '../common/files.js';

/**
 * AGENTS.md is an open, cross-tool instruction file convention read by many
 * coding agents. Athena manages a marked block so agents without a dedicated
 * adapter still discover the knowledge layer.
 */
export const agentsMdAdapter: AgentAdapter = {
  id: 'agents-md',
  displayName: 'AGENTS.md (cross-agent)',
  capabilities: { instructionsFile: true, scopedRules: false, hooks: false, mcp: false },
  supportNote: 'Manages a marked block in AGENTS.md for agents that read the AGENTS.md convention.',
  async detectPresence(root) {
    const evidence = await userEvidence(root, { files: ['AGENTS.md'] });
    return { detectedInProject: evidence.length > 0, evidence };
  },
  async plan(ctx) {
    return [await planBlock(ctx.root, 'AGENTS.md', athenaInstructions({ heading: '##' }))];
  },
  async remove(root) {
    return (await removeBlockFrom(root, 'AGENTS.md')) ? ['AGENTS.md'] : [];
  },
  async check(root) {
    return [await checkBlock(root, 'AGENTS.md', 'AGENTS.md')];
  },
};
