import type { Category } from '../findings/finding.js';
import { SECRET_PATTERNS } from '../security/secrets.js';

/**
 * Metadata for Athena's own rules: what `athena explain <ruleId>` prints, and what
 * SARIF uses for a rule when the finding carries no help of its own. External engines
 * (Semgrep, Gitleaks, …) bring their own help on each finding.
 */
export interface RuleInfo {
  id: string;
  category: Category;
  title: string;
  description: string;
  /** What to do about it. Plain text. */
  help: string;
  cwe: string[];
  helpUrl?: string;
  /** Heuristic rule: its findings are "worth checking", not confirmed problems. */
  potential?: boolean;
}

const SECRET_HELP =
  'Remove the value from the code, load it from an environment variable or a secret manager, and rotate the credential: anyone with access to the repository or its history may already have it. Removing it from the latest commit does not remove it from Git history.';

/** Patterns that match on keywords plus entropy rather than a known token format. */
const HEURISTIC_SECRETS = new Set(['generic-secret-assignment', 'env-secret-assignment']);

const secretRules: RuleInfo[] = SECRET_PATTERNS.map((p) => ({
  id: `secret/${p.id}`,
  category: 'secret',
  title: `${p.description} in source`,
  description: HEURISTIC_SECRETS.has(p.id)
    ? `A value that looks like a credential (${p.description.toLowerCase()}) was found by a keyword and entropy heuristic. It may be a real secret or a false positive; check it.`
    : `A string matching the format of a ${p.description} was found in a tracked file. Athena reports the type and location only, never the value.`,
  help: SECRET_HELP,
  cwe: ['CWE-798'],
  ...(HEURISTIC_SECRETS.has(p.id) ? { potential: true } : {}),
}));

const review = (id: string, title: string, description: string, help: string, cwe: string[] = []): RuleInfo => ({ id: `review/${id}`, category: 'review', title, description, help, cwe });

const OTHER_RULES: RuleInfo[] = [
  {
    id: 'dependency/vulnerable-package',
    category: 'dependency',
    title: 'Dependency with a known vulnerability',
    description: 'A package in the dependency tree matches a published security advisory, as reported by the ecosystem audit tool (npm audit, pip-audit, cargo audit, …).',
    help: 'Upgrade to a fixed version when one is available (see the advisory), or remove the dependency. If the vulnerable code path is not reachable, record that with a triage decision instead of ignoring the finding.',
    cwe: ['CWE-1395'],
  },
  review('env-file', 'Environment file in the change', 'A .env-style file is part of the change. These usually hold credentials and machine-specific settings.', 'Add it to .gitignore and commit a .env.example with variable names only.', ['CWE-538']),
  review('dependencies', 'New dependencies', 'The change adds dependencies to a manifest.', 'Justify each addition; check its licence, maintenance and size.'),
  review('tests', 'Source changed without tests', 'Source files changed but no test files did.', 'Add or update tests for the changed behaviour, or say why none are needed.'),
  review('api', 'API surface changed', 'Route or API handler files changed.', 'Check authentication, authorization and error handling for the changed endpoints.'),
  review('database', 'Database schema or migrations changed', 'Schema or migration files changed.', 'Check indexes, constraints and backward compatibility with running code and existing data.'),
  review('auth', 'Authentication or authorization code changed', 'Files that implement authentication or authorization changed.', 'Review the change against the project security notes; such code deserves a second reviewer.'),
  review('large-files', 'Large files added', 'The change adds unusually large files.', 'Consider whether these belong in Git (Git LFS, an artifact store, or generated at build time).'),
  review('leftovers', 'TODO/FIXME or debug statements added', 'Added lines contain TODO/FIXME markers or debug statements.', 'Remove debug output and resolve or track the TODOs before merging.', ['CWE-489']),
  review('vulnerabilities', 'Known vulnerable dependencies', 'The last dependency scan reported high or critical advisories.', 'Run the dependency scan for details and upgrade the affected packages.', ['CWE-1395']),
  review('knowledge', 'Project knowledge out of date', 'Athena knowledge (.athena/) does not reflect these changes.', 'Run `athena sync` so agents read current context.'),
  review('skipped', 'Changed files not checked', 'Some changed files could not be read (too large, binary or unreadable), so their contents were not checked.', 'Check these files yourself; Athena makes no claim about them.'),
  review('policy-weakened', 'Security policy changed on this branch', 'The branch changes .athena/policy.json, baseline.json or triage.json, or adds an athena-ignore comment, compared with the base branch. High when the change relaxes the quality gate.', 'Have a maintainer review the change. With `--policy-from <base>` the gate keeps using the base branch policy until this merges.'),
  review('suppression-without-reason', 'Inline suppression without a reason', 'An `athena-ignore <ruleId>` comment has no `-- <reason>`, so it was not applied.', 'Add a reason: `athena-ignore <ruleId> -- <why this is safe>`.'),
  review('invalid-suppression', 'Inline suppression with no valid rule id', 'An `athena-ignore` comment does not name a valid rule id, so it was not applied.', 'Name exactly one rule: `athena-ignore secret/stripe-key -- <reason>`. Run `athena scan --list-rules` for ids.'),
];

export const RULES: ReadonlyMap<string, RuleInfo> = new Map([...secretRules, ...OTHER_RULES].map((r) => [r.id, r]));

export const ruleInfo = (id: string): RuleInfo | undefined => RULES.get(id);
export const listRules = (): RuleInfo[] => [...RULES.values()].sort((a, b) => a.id.localeCompare(b.id));
