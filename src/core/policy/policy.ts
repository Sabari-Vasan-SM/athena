import path from 'node:path';
import ignoreFactory, { type Ignore } from 'ignore';
import { z } from 'zod';
import { ATHENA_DIR } from '../paths.js';
import { readTextIfExists } from '../util/fs.js';
import { CATEGORIES, CONFIDENCES, SEVERITIES, type Finding } from '../findings/finding.js';

/**
 * `.athena/policy.json` — the committed, optional project policy: what fails the
 * quality gate, per-rule overrides, path exclusions, licence lists and which external
 * engines may run. A missing file means defaults; an invalid file is an error (never
 * silently ignored — a typo must not quietly turn the gate off).
 */
export const POLICY_FILE = `${ATHENA_DIR}/policy.json`;

/** Gate thresholds. `unrated` is not a threshold: it is handled by `gate.unrated`. */
export const GATE_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export const DEFAULT_GATE_CATEGORIES = ['secret', 'dependency', 'sast', 'iac', 'review'] as const;
export const EXTERNAL_ENGINES = ['semgrep', 'gitleaks', 'trivy', 'osv-scanner'] as const;
export type ExternalEngine = (typeof EXTERNAL_ENGINES)[number];

/** Rule ids, or a family prefix ending in `/*` (e.g. `sast/js/*`). */
const RuleKey = z.string().regex(/^[a-z0-9][a-z0-9._/-]{1,120}(\/\*)?$/, 'expected a rule id such as "secret/stripe-key" or a prefix such as "sast/js/*"');
const Glob = z.string().min(1).max(500);

export const RuleSetting = z.union([
  z.literal('off'),
  z.strictObject({
    severity: z.enum(SEVERITIES).optional(),
    confidence: z.enum(CONFIDENCES).optional(),
  }),
]);
export type RuleSetting = z.infer<typeof RuleSetting>;

export const Policy = z.strictObject({
  schemaVersion: z.literal(1).default(1),
  gate: z
    .strictObject({
      failOn: z.enum(GATE_SEVERITIES).default('high'),
      minConfidence: z.enum(CONFIDENCES).default('medium'),
      unrated: z.enum(['fail', 'warn']).default('fail'),
      scope: z.enum(['new', 'all']).default('new'),
      categories: z.array(z.enum(CATEGORIES)).default([...DEFAULT_GATE_CATEGORIES]),
    })
    .prefault({}),
  rules: z.record(RuleKey, RuleSetting).default({}),
  paths: z
    .strictObject({
      exclude: z.array(Glob).default([]),
      tests: z.array(Glob).default([]),
    })
    .prefault({}),
  licenses: z
    .strictObject({
      deny: z.array(z.string().min(1)).default([]),
      warn: z.array(z.string().min(1)).default([]),
    })
    .prefault({}),
  external: z
    .strictObject({
      semgrep: z.enum(['auto', 'off']).default('auto'),
      gitleaks: z.enum(['auto', 'off']).default('auto'),
      trivy: z.enum(['auto', 'off']).default('auto'),
      'osv-scanner': z.enum(['auto', 'off']).default('auto'),
      network: z.enum(['allow', 'deny']).default('allow'),
    })
    .prefault({}),
});
export type Policy = z.infer<typeof Policy>;
export type PolicyInput = z.input<typeof Policy>;

export const DEFAULT_POLICY: Policy = Policy.parse({});

/** A committed Athena file (policy, baseline, triage) is invalid. Services turn it into an AthenaError. */
export class PolicyError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'PolicyError';
  }
}

/** Format the first zod issue as `<source>: <path>: <message>`. */
export function zodProblem(source: string, error: z.ZodError): string {
  const issue = error.issues[0];
  const where = issue && issue.path.length ? issue.path.map(String).join('.') : '(root)';
  return `${source} is invalid at ${where}: ${issue?.message ?? 'invalid'}`;
}

/** Parse JSON text with a schema, throwing a PolicyError that names the file and the offending path. */
export function parseCommittedJson<T extends z.ZodType>(schema: T, text: string, source: string): z.infer<T> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new PolicyError(`${source} is not valid JSON (${(err as Error).message}).`, `Fix or delete ${source}.`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new PolicyError(zodProblem(source, parsed.error), `Fix ${source}; see the policy documentation for the format.`);
  return parsed.data;
}

export function parsePolicy(text: string, source = POLICY_FILE): Policy {
  return parseCommittedJson(Policy, text, source);
}

/** Read `.athena/policy.json` from the working tree. Missing = defaults; invalid = PolicyError. */
export async function loadPolicy(root: string): Promise<Policy> {
  const raw = await readTextIfExists(path.join(root, POLICY_FILE));
  return raw === null ? DEFAULT_POLICY : parsePolicy(raw);
}

/** The setting for `ruleId`: an exact key wins over the longest matching `prefix/*` key. */
export function ruleSetting(policy: Policy, ruleId: string): RuleSetting | undefined {
  const exact = policy.rules[ruleId];
  if (exact !== undefined) return exact;
  let best: { len: number; setting: RuleSetting } | undefined;
  for (const [key, setting] of Object.entries(policy.rules)) {
    if (!key.endsWith('/*')) continue;
    const prefix = key.slice(0, -1); // keep the trailing slash
    if (ruleId.startsWith(prefix) && (!best || prefix.length > best.len)) best = { len: prefix.length, setting };
  }
  return best?.setting;
}

/** Compiled path matchers for a policy. Paths are project-relative, POSIX separators. */
export class PolicyPaths {
  private readonly exclude: Ignore | null;
  private readonly tests: Ignore | null;
  constructor(policy: Policy) {
    this.exclude = policy.paths.exclude.length ? ignoreFactory().add(policy.paths.exclude) : null;
    this.tests = policy.paths.tests.length ? ignoreFactory().add(policy.paths.tests) : null;
  }
  private static test(m: Ignore | null, file: string): boolean {
    if (!m) return false;
    const rel = file.replace(/\\/g, '/').replace(/^\.\//, '');
    // `ignore` rejects absolute and parent-relative paths; such paths can't match a project glob.
    if (!rel || !ignoreFactory.isPathValid(rel)) return false;
    return m.ignores(rel);
  }
  isExcluded(file: string): boolean {
    return PolicyPaths.test(this.exclude, file);
  }
  isTest(file: string): boolean {
    return PolicyPaths.test(this.tests, file);
  }
}

/** The file a finding is about, for path rules (a package finding uses its manifest). */
export function findingPath(f: Finding): string | undefined {
  return f.location?.file ?? f.package?.manifest;
}

/** Apply per-rule severity/confidence overrides. `off` is not applied here (it yields status `excluded`). */
export function applyRuleOverrides(policy: Policy, findings: Finding[]): Finding[] {
  return findings.map((f) => {
    const s = ruleSetting(policy, f.ruleId);
    if (!s || s === 'off' || (!s.severity && !s.confidence)) return f;
    return { ...f, ...(s.severity ? { severity: s.severity } : {}), ...(s.confidence ? { confidence: s.confidence } : {}) };
  });
}
