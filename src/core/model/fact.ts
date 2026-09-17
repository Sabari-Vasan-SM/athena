import { z } from 'zod';

/**
 * Epistemic status of a piece of knowledge. This is the core anti-hallucination
 * mechanism: nothing is ever promoted to a higher status than its evidence supports.
 *
 * - FACT      developer-asserted, or unambiguous declaration (e.g. a manifest dependency)
 * - DETECTED  found by a detector, with evidence
 * - INFERRED  heuristic conclusion (AI output is always at most INFERRED)
 * - UNKNOWN   Athena looked and could not determine it
 */
export const FactStatus = z.enum(['FACT', 'DETECTED', 'INFERRED', 'UNKNOWN']);
export type FactStatus = z.infer<typeof FactStatus>;

export const Confidence = z.enum(['high', 'medium', 'low']);
export type Confidence = z.infer<typeof Confidence>;

export const FactSource = z.enum(['code', 'config', 'filesystem', 'git', 'developer', 'ai']);
export type FactSource = z.infer<typeof FactSource>;

export const Evidence = z.object({
  /** Repo-relative POSIX path. */
  file: z.string(),
  line: z.number().int().positive().optional(),
  detail: z.string().optional(),
});
export type Evidence = z.infer<typeof Evidence>;

export const Provenance = z.object({
  status: FactStatus,
  confidence: Confidence,
  source: FactSource,
  evidence: z.array(Evidence),
});
export type Provenance = z.infer<typeof Provenance>;

export function detected(
  source: FactSource,
  evidence: Evidence[],
  confidence: Confidence = 'high',
): Provenance {
  return { status: 'DETECTED', confidence, source, evidence };
}

export function inferred(
  source: FactSource,
  evidence: Evidence[],
  confidence: Confidence = 'medium',
): Provenance {
  return { status: 'INFERRED', confidence, source, evidence };
}

export function fact(source: FactSource, evidence: Evidence[]): Provenance {
  return { status: 'FACT', confidence: 'high', source, evidence };
}
