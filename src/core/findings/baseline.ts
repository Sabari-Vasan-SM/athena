import path from 'node:path';
import { z } from 'zod';
import { ATHENA_DIR } from '../paths.js';
import { readTextIfExists, writeFileAtomic } from '../util/fs.js';
import { parseCommittedJson, PolicyError } from '../policy/policy.js';
import { CATEGORIES, type Category, type Finding, type ScanResult } from './finding.js';
import { assertNoSecret } from './triage.js';

/**
 * `.athena/baseline.json` (committed): findings that existed when the baseline was
 * taken. With gate scope `new`, baselined findings don't fail the gate; they stay
 * visible (status `baselined`) and still count in ratings. Entries hold no code or
 * secret values — only the value-free fingerprint, rule id and file.
 */
export const BASELINE_FILE = `${ATHENA_DIR}/baseline.json`;

export const BaselineEntry = z.strictObject({
  fingerprint: z.string().regex(/^[a-f0-9]{32}$/),
  ruleId: z.string().min(1).max(200),
  file: z.string().max(1000).optional(),
  addedAt: z.string(),
  reason: z.string().max(500).optional(),
});
export type BaselineEntry = z.infer<typeof BaselineEntry>;

export const Baseline = z.strictObject({
  schemaVersion: z.literal(1),
  createdAt: z.string(),
  entries: z.array(BaselineEntry),
});
export type Baseline = z.infer<typeof Baseline>;

export function emptyBaseline(now = new Date()): Baseline {
  return { schemaVersion: 1, createdAt: now.toISOString(), entries: [] };
}

export function parseBaseline(text: string, source = BASELINE_FILE): Baseline {
  const b = parseCommittedJson(Baseline, text, source);
  const seen = new Set<string>();
  for (const e of b.entries) {
    if (seen.has(e.fingerprint)) throw new PolicyError(`${source} lists fingerprint ${e.fingerprint} more than once.`, `Remove the duplicate entry from ${source}.`);
    seen.add(e.fingerprint);
  }
  return b;
}

/** Working-tree baseline, or null when there is none. Invalid = PolicyError. */
export async function loadBaseline(root: string): Promise<Baseline | null> {
  const raw = await readTextIfExists(path.join(root, BASELINE_FILE));
  return raw === null ? null : parseBaseline(raw);
}

/** Stable, diff-friendly serialization (entries sorted by rule, file, fingerprint). */
export function serializeBaseline(b: Baseline): string {
  const entries = [...b.entries].sort(
    (x, y) => x.ruleId.localeCompare(y.ruleId) || (x.file ?? '').localeCompare(y.file ?? '') || x.fingerprint.localeCompare(y.fingerprint),
  );
  return `${JSON.stringify({ schemaVersion: 1, createdAt: b.createdAt, entries }, null, 2)}\n`;
}

export async function saveBaseline(root: string, b: Baseline): Promise<void> {
  await writeFileAtomic(path.join(root, BASELINE_FILE), serializeBaseline(Baseline.parse(b)));
}

export function baselineFingerprints(b: Baseline | null): Set<string> {
  return new Set(b?.entries.map((e) => e.fingerprint) ?? []);
}

function entryFor(f: Finding, now: Date, reason?: string): BaselineEntry {
  const file = f.location?.file ?? f.package?.manifest;
  return { fingerprint: f.fingerprint, ruleId: f.ruleId, ...(file ? { file } : {}), addedAt: now.toISOString(), ...(reason ? { reason } : {}) };
}

export interface BaselineOptions {
  now?: Date;
  reason?: string;
}

/** A new baseline holding every given finding. */
export function createBaseline(findings: Finding[], opts: BaselineOptions = {}): Baseline {
  const now = opts.now ?? new Date();
  return updateBaseline(emptyBaseline(now), findings, opts).baseline;
}

/** Add findings not yet in the baseline. Existing entries (and their dates/reasons) are kept. */
export function updateBaseline(b: Baseline, findings: Finding[], opts: BaselineOptions = {}): { baseline: Baseline; added: BaselineEntry[] } {
  const now = opts.now ?? new Date();
  if (opts.reason !== undefined) {
    if (opts.reason.length > 500) throw new PolicyError(`The baseline reason is too long (${opts.reason.length} > 500 characters).`);
    assertNoSecret(opts.reason, 'baseline reason');
  }
  const have = baselineFingerprints(b);
  const added: BaselineEntry[] = [];
  for (const f of findings) {
    if (have.has(f.fingerprint)) continue;
    have.add(f.fingerprint);
    added.push(entryFor(f, now, opts.reason));
  }
  return { baseline: { ...b, entries: [...b.entries, ...added] }, added };
}

const categoryOf = (ruleId: string): Category | undefined => {
  const head = ruleId.split('/')[0];
  return (CATEGORIES as readonly string[]).includes(head ?? '') ? (head as Category) : undefined;
};

export interface PruneResult {
  baseline: Baseline;
  removed: BaselineEntry[];
  /** Entries kept only because their category was not fully scanned (an engine failed, timed out or none ran). */
  keptUnverified: BaselineEntry[];
}

/**
 * Drop entries whose fingerprint no longer appears in a full scan. Refuses a partial
 * scan (staged/changed/base), and keeps entries of any category that was not fully
 * covered: a broken or missing engine reports nothing, which must not read as "fixed".
 */
export function pruneBaseline(b: Baseline, result: ScanResult): PruneResult {
  if (result.scope.mode !== 'all') {
    throw new PolicyError(`Can't prune the baseline from a partial scan (${result.scope.mode}).`, 'Run a full scan first, then prune.');
  }
  const present = new Set(result.findings.map((f) => f.fingerprint));
  const verified = new Set<string>();
  const broken = new Set<string>();
  for (const c of result.coverage) {
    if (c.status === 'ok') verified.add(c.category);
    if (c.status === 'failed' || c.status === 'timeout') broken.add(c.category);
  }
  const kept: BaselineEntry[] = [];
  const removed: BaselineEntry[] = [];
  const keptUnverified: BaselineEntry[] = [];
  for (const e of b.entries) {
    if (present.has(e.fingerprint)) {
      kept.push(e);
      continue;
    }
    const cat = categoryOf(e.ruleId);
    if (!cat || !verified.has(cat) || broken.has(cat)) {
      kept.push(e);
      keptUnverified.push(e);
      continue;
    }
    removed.push(e);
  }
  return { baseline: { ...b, entries: kept }, removed, keptUnverified };
}
