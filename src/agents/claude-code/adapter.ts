import type { AgentAdapter } from '../../core/agents/adapter.js';
import { athenaInstructions } from '../common/instructions.js';
import { checkBlock, planBlock, removeBlockFrom, userEvidence } from '../common/files.js';

/**
 * Claude Code reads project memory from CLAUDE.md and supports `@path` imports.
 * Athena manages a marked block in CLAUDE.md and imports only rules.md eagerly;
 * other documents are loaded on demand via the relevance map, keeping context small.
 */
export const claudeCodeAdapter: AgentAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  capabilities: { instructionsFile: true, scopedRules: false, hooks: true, mcp: true },
  supportNote: 'Uses CLAUDE.md with an @-import of .athena/rules.md. Hooks-based activity observation is planned (Phase 4).',
  async detectPresence(root) {
    const evidence = await userEvidence(root, { files: ['CLAUDE.md', 'CLAUDE.local.md', '.mcp.json'], dirs: ['.claude'] });
    return { detectedInProject: evidence.length > 0, evidence };
  },
  async plan(ctx) {
    return [await planBlock(ctx.root, 'CLAUDE.md', athenaInstructions({ heading: '##', rulesImport: '@.athena/rules.md' }))];
  },
  async remove(root) {
    return (await removeBlockFrom(root, 'CLAUDE.md')) ? ['CLAUDE.md'] : [];
  },
  async check(root) {
    return [await checkBlock(root, 'CLAUDE.md', 'Claude Code')];
  },
};
