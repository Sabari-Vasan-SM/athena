import path from 'node:path';
import { z } from 'zod';
import { ATHENA_DIR } from '../paths.js';
import { scanText } from '../security/secrets.js';
import { readTextIfExists, writeFileAtomic } from '../util/fs.js';
import { parseCommittedJson, PolicyError } from '../policy/policy.js';

/**
 * `.athena/triage.json` (committed): a human decision about a finding, the equivalent
 * of SonarQube's hotspot review. Every decision needs a reason. Reasons are committed
 * and shown in reports, so a reason that looks like it contains a secret is refused
 * (the value is never echoed).
 *
 * `to-review` keeps the finding open; the other statuses take it out of the gate.
 */
export const TRIAGE_FILE = `${ATHENA_DIR}/triage.json`;

export const TRIAGE_STATUSES = ['safe', 'false-positive', 'accepted-risk', 'fixed', 'to-review'] as const;
export type TriageStatus = (typeof TRIAGE_STATUSES)[number];
/** Statuses that close a finding (it no longer counts as open). */
export const CLOSING_TRIAGE: ReadonlySet<TriageStatus> = new Set(['safe', 'false-positive', 'accepted-risk', 'fixed']);

export const MAX_REASON_CHARS = 500;

export const TriageEntry = z.strictObject({
  status: z.enum(TRIAGE_STATUSES),
  reason: z.string().trim().min(1, 'a reason is required').max(MAX_REASON_CHARS),
  by: z.string().max(200).optional(),
  at: z.string(),
});
export type TriageEntry = z.infer<typeof TriageEntry>;

export const Triage = z.strictObject({
  schemaVersion: z.literal(1),
  entries: z.record(z.string().regex(/^[a-f0-9]{32}$/, 'keys must be finding fingerprints (32 hex)'), TriageEntry),
});
export type Triage = z.infer<typeof Triage>;

export function emptyTriage(): Triage {
  return { schemaVersion: 1, entries: {} };
}

export function parseTriage(text: string, source = TRIAGE_FILE): Triage {
  return parseCommittedJson(Triage, text, source);
}

export async function loadTriage(root: string): Promise<Triage | null> {
  const raw = await readTextIfExists(path.join(root, TRIAGE_FILE));
  return raw === null ? null : parseTriage(raw);
}

export function serializeTriage(t: Triage): string {
  const entries = Object.fromEntries(Object.entries(t.entries).sort(([a], [b]) => a.localeCompare(b)));
  return `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`;
}

export async function saveTriage(root: string, t: Triage): Promise<void> {
  await writeFileAtomic(path.join(root, TRIAGE_FILE), serializeTriage(Triage.parse(t)));
}

/** Refuse free text that looks like it contains a secret. Never echoes the value. */
export function assertNoSecret(text: string, what: string): void {
  const hits = scanText(text);
  if (hits.length) {
    throw new PolicyError(`The ${what} looks like it contains a secret (${hits[0]!.type}); it was not saved.`, `Describe the decision without including credentials.`);
  }
}

export interface TriageInput {
  status: TriageStatus;
  reason: string;
  by?: string;
  now?: Date;
}

/** Record (or replace) the decision for `fingerprint`. Returns a new Triage. */
export function setTriage(t: Triage, fingerprint: string, input: TriageInput): Triage {
  if (!/^[a-f0-9]{32}$/.test(fingerprint)) throw new PolicyError(`Not a finding fingerprint: ${fingerprint.slice(0, 64)}`);
  const reason = input.reason.trim();
  if (!reason) throw new PolicyError('A triage decision needs a reason.', 'Say why, e.g. "input is validated by the router schema".');
  if (reason.length > MAX_REASON_CHARS) throw new PolicyError(`The reason is too long (${reason.length} > ${MAX_REASON_CHARS} characters).`);
  assertNoSecret(reason, 'triage reason');
  if (input.by) assertNoSecret(input.by, 'triage author');
  const entry = TriageEntry.parse({ status: input.status, reason, ...(input.by ? { by: input.by } : {}), at: (input.now ?? new Date()).toISOString() });
  return { ...t, entries: { ...t.entries, [fingerprint]: entry } };
}

export function removeTriage(t: Triage, fingerprint: string): Triage {
  const { [fingerprint]: _removed, ...rest } = t.entries;
  return { ...t, entries: rest };
}
