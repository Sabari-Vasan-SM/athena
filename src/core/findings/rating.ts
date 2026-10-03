import type { Policy } from '../policy/policy.js';
import { SEVERITY_RANK, type Category, type Finding, type ScanResult, type Severity } from './finding.js';
import type { StatusInfo } from './status.js';

/**
 * A–E rating per category from the worst active finding — no numeric score, and never
 * a grade for something nothing scanned:
 *   A none · B low/info · C medium · D high · E critical
 *   unrated → D, or C when the policy only warns on unrated findings.
 * A category with no active findings is not rated (null) when no engine ran for it or one of
 * its engines failed — "nothing found" from a broken engine is not an A.
 */
export type Grade = 'A' | 'B' | 'C' | 'D' | 'E';

export interface CategoryRating {
  category: Category;
  rating: Grade | null;
  /** Worst active severity, if any. */
  worst?: Severity;
  active: number;
  /** e.g. "2 engines (athena-secrets, gitleaks) across typescript, python; 3 files not covered". */
  basis: string;
}

export interface RatingContext {
  policy: Policy;
  statuses: Map<string, StatusInfo>;
  /** Rule counts per engine id, when known; the basis then says "N rules" instead of counting engines. */
  rulesByEngine?: Record<string, number>;
}

const GRADE: Record<Severity, Grade> = { critical: 'E', high: 'D', medium: 'C', low: 'B', info: 'B', unrated: 'D' };
const ORDER: Grade[] = ['A', 'B', 'C', 'D', 'E'];

export function gradeFor(severity: Severity, policy: Policy): Grade {
  if (severity === 'unrated' && policy.gate.unrated === 'warn') return 'C';
  return GRADE[severity];
}

export function rateCategories(result: Pick<ScanResult, 'findings' | 'coverage'>, ctx: RatingContext): CategoryRating[] {
  const cats = new Set<Category>();
  for (const c of result.coverage) cats.add(c.category);
  for (const f of result.findings) cats.add(f.category);
  const out: CategoryRating[] = [];
  for (const category of [...cats].sort()) {
    const cov = result.coverage.filter((c) => c.category === category);
    const ran = cov.filter((c) => c.status === 'ok');
    const active: Finding[] = result.findings.filter((f) => f.category === category && (ctx.statuses.get(f.fingerprint)?.active ?? true));
    let worstIdx = -1;
    let worst: Severity | undefined;
    for (const f of active) {
      const idx = ORDER.indexOf(gradeFor(f.severity, ctx.policy));
      if (idx > worstIdx || (idx === worstIdx && worst && SEVERITY_RANK[f.severity] > SEVERITY_RANK[worst])) {
        worstIdx = idx;
        worst = f.severity;
      }
    }
    const grade: Grade = worstIdx >= 0 ? ORDER[worstIdx]! : 'A';
    // Findings prove problems even when coverage is partial; an A needs engines that all actually ran.
    const broken = cov.some((c) => c.status === 'failed' || c.status === 'timeout');
    const rating: Grade | null = active.length ? grade : ran.length && !broken ? 'A' : null;
    out.push({ category, rating, ...(worst ? { worst } : {}), active: active.length, basis: basisText(cov, ran, ctx) });
  }
  return out;
}

function basisText(cov: ScanResult['coverage'], ran: ScanResult['coverage'], ctx: RatingContext): string {
  if (!ran.length) {
    const why = cov.map((c) => `${c.engine} ${c.status}`).join(', ');
    return `not scanned${why ? ` (${why})` : ''}`;
  }
  const engines = [...new Set(ran.map((c) => c.engine))].sort();
  const known = engines.every((e) => ctx.rulesByEngine?.[e] !== undefined);
  const what = known
    ? `${engines.reduce((n, e) => n + ctx.rulesByEngine![e]!, 0)} rules`
    : `${engines.length} engine${engines.length === 1 ? '' : 's'} (${engines.join(', ')})`;
  const langs = [...new Set(ran.flatMap((c) => c.languages))].sort();
  let notCovered = 0;
  for (const c of ran) {
    const s = c.filesSkipped;
    if (s) notCovered += s.tooLarge + s.binary + s.minified + s.unreadable + s.unsupported;
  }
  const broken = cov.filter((c) => c.status === 'failed' || c.status === 'timeout').map((c) => c.engine);
  return `${what} across ${langs.length ? langs.join(', ') : 'all files'}; ${notCovered} file${notCovered === 1 ? '' : 's'} not covered${broken.length ? `; ${broken.join(', ')} failed` : ''}`;
}
