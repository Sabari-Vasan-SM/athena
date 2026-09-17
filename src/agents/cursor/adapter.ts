import path from 'node:path';
import type { AgentAdapter } from '../../core/agents/adapter.js';
import { readTextIfExists } from '../../core/util/fs.js';
import { athenaInstructions } from '../common/instructions.js';
import { OWNED_HEADER, planOwned, removeOwned, userEvidence } from '../common/files.js';

const RULE_FILE = '.cursor/rules/athena.mdc';

/**
 * Cursor project rules live in `.cursor/rules/*.mdc` with frontmatter
 * (`description`, `globs`, `alwaysApply`). Athena owns a single always-applied rule.
 */
export const cursorAdapter: AgentAdapter = {
  id: 'cursor',
  displayName: 'Cursor',
  capabilities: { instructionsFile: true, scopedRules: true, hooks: true, mcp: true },
  supportNote: 'Uses an Athena-owned project rule at .cursor/rules/athena.mdc (alwaysApply).',
  async detectPresence(root) {
    const evidence = await userEvidence(root, { files: ['.cursorrules'], dirs: ['.cursor'], athenaOwned: [RULE_FILE] });
    return { detectedInProject: evidence.length > 0, evidence };
  },
  async plan(ctx) {
    const content = [
      '---',
      'description: Athena project intelligence — how to use .athena/ knowledge and project rules',
      'globs:',
      'alwaysApply: true',
      '---',
      OWNED_HEADER,
      '',
      athenaInstructions({ heading: '#' }),
      '',
    ].join('\n');
    return [await planOwned(ctx.root, RULE_FILE, content)];
  },
  async remove(root) {
    return (await removeOwned(root, RULE_FILE)) ? [RULE_FILE] : [];
  },
  async check(root) {
    const text = await readTextIfExists(path.join(root, RULE_FILE));
    if (text === null) return [{ ok: false, level: 'warn', message: `Cursor: ${RULE_FILE} not found` }];
    if (!/^---[\s\S]*?alwaysApply:\s*true[\s\S]*?---/.test(text)) return [{ ok: false, level: 'warn', message: `Cursor: ${RULE_FILE} frontmatter was modified (alwaysApply is not true)` }];
    return [{ ok: true, level: 'ok', message: `Cursor: ${RULE_FILE}` }];
  },
};
