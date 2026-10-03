import type { Scanner } from './types.js';
import { dependencyScanner, type DependencyAuditOptions } from './dependencies.js';
import { secretsScanner } from './secrets.js';

export { secretsScanner, scanSecrets, secretFinding, secretFindings, secretSeverity, SECRETS_ENGINE } from './secrets.js';
export { dependencyScanner, auditDependencies, auditFindings, auditCoverage, DEPENDENCY_RULE } from './dependencies.js';
export { reviewScanner, reviewFindings, reviewCoverage, REVIEW_ENGINE } from './review.js';

export interface BuiltinScannerOptions extends DependencyAuditOptions {
  /**
   * The review scanner (services/review.ts `createReviewScanner()`): it needs Git,
   * which core does not run, so callers inject it. Omitted = no review checks.
   */
  review?: Scanner;
  /** Leave out the dependency audits. */
  skipAudit?: boolean;
}

/** Built-in scanners in run order: secrets, dependency audits, review checks. */
export function builtinScanners(opts: BuiltinScannerOptions = {}): Scanner[] {
  const { review, skipAudit, ...deps } = opts;
  return [secretsScanner, ...(skipAudit ? [] : [dependencyScanner(deps)]), ...(review ? [review] : [])];
}
