import path from 'node:path';
import type { AgentAdapter } from '../../core/agents/adapter.js';
import { readTextIfExists } from '../../core/util/fs.js';
import { athenaInstructions } from '../common/instructions.js';
import { OWNED_HEADER, planOwned, removeOwned, userEvidence } from '../common/files.js';

const RULE_FILE = '.agents/rules/athena.md';
/** Antigravity documents a 12,000 character limit per rule file. */
export const ANTIGRAVITY_RULE_LIMIT = 12_000;

/**
 * Google Antigravity reads workspace rules from `.agents/rules/` (legacy: `.agent/rules/`),
 * one Markdown file per rule, max 12,000 characters.
 * Source: https://antigravity.google/docs/rules-workflows/ (checked 2026-09).
 * Activation mode (Always On / Model Decision / Glob / Manual) is configured in
 * Antigravity; its frontmatter format is not documented, so Athena does not write one.
 * Antigravity also reads AGENTS.md and GEMINI.md (https://antigravity.google/docs/rules, checked 2026-09),
 * but those are shared instruction files — GEMINI.md is Gemini CLI's default context file — so they are
 * not evidence that Antigravity specifically is used. Only .agents/ and .agent/ count.
 */
export const antigravityAdapter: AgentAdapter = {
  id: 'antigravity',
  displayName: 'Antigravity',
  capabilities: { instructionsFile: true, scopedRules: true, hooks: false, mcp: true },
  supportNote: 'Uses an Athena-owned workspace rule at .agents/rules/athena.md. Set its activation to "Always On" in Antigravity if it is not applied automatically.',
  async detectPresence(root) {
    const evidence = await userEvidence(root, { dirs: ['.agents', '.agent'], athenaOwned: [RULE_FILE] });
    return { detectedInProject: evidence.length > 0, evidence };
  },
  async plan(ctx) {
    const content = [OWNED_HEADER, '', athenaInstructions({ heading: '#' }), ''].join('\n');
    if (content.length > ANTIGRAVITY_RULE_LIMIT) throw new Error(`Antigravity rule exceeds ${ANTIGRAVITY_RULE_LIMIT} characters`);
    return [await planOwned(ctx.root, RULE_FILE, content)];
  },
  async remove(root) {
    return (await removeOwned(root, RULE_FILE)) ? [RULE_FILE] : [];
  },
  async check(root) {
    const text = await readTextIfExists(path.join(root, RULE_FILE));
    if (text === null) return [{ ok: false, level: 'warn', message: `Antigravity: ${RULE_FILE} not found` }];
    if (text.length > ANTIGRAVITY_RULE_LIMIT) return [{ ok: false, level: 'error', message: `Antigravity: ${RULE_FILE} exceeds the 12,000 character rule limit` }];
    return [
      { ok: true, level: 'ok', message: `Antigravity: ${RULE_FILE}` },
      { ok: true, level: 'warn', message: 'Antigravity: activation mode cannot be verified from files — confirm the rule is "Always On" in Antigravity' },
    ];
  },
};
