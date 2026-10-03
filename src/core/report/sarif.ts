import { CONFIDENCE_RANK, type Category, type Confidence, type Coverage, type Finding, type Severity } from '../findings/finding.js';
import { FINGERPRINT_VERSION } from '../findings/fingerprint.js';
import { mdText } from './markdown.js';
import { ruleInfo } from './rules.js';
import { displayTitle, fileOf, INFORMATION_URI, sortForDisplay, statusKind, statusOf, type ReportInput } from './shared.js';

/**
 * SARIF 2.1.0 for GitHub code scanning and other SARIF consumers.
 *
 * Mapping decisions (documented, stable within this format version):
 * - `level`: critical/high → error, medium/unrated → warning, low/info → note.
 * - `security-severity` (rule property, read by GitHub): critical 9.5, high 8.0,
 *   medium 5.5, low 3.0, info 0.0, unrated 7.0. Unrated means the source gave no
 *   severity; it lands in GitHub's "high" band (7.0–8.9) so it is never hidden as low.
 *   A rule takes the highest severity among its findings in this run.
 * - `precision`: from confidence (high/medium/low); a rule takes the highest confidence
 *   among its findings. Potential (heuristic) findings stay visible via `properties.potential`.
 * - Tags: the category, `security` for security categories or when CWEs are known,
 *   and CWEs as `external/cwe/cwe-<n>` (GitHub's convention).
 * - `partialFingerprints["athena/v<FINGERPRINT_VERSION>"]` is the value-free Athena fingerprint.
 * - Status: baselined → `baselineState: unchanged` + external suppression; suppressed
 *   (inline comment) → `inSource` suppression; triaged → external suppression with the
 *   triage state as justification; excluded (out of policy scope) findings are omitted.
 *   `baselineState` is emitted when a baseline was applied or the scope is not `all`.
 * - Coverage: every non-ok coverage record becomes a `toolExecutionNotification`
 *   (failed/timeout = error, unavailable = warning, skipped = note); any failed or timed
 *   out engine makes `executionSuccessful` false.
 */

export const SECURITY_SEVERITY: Record<Severity, string> = { critical: '9.5', high: '8.0', medium: '5.5', low: '3.0', info: '0.0', unrated: '7.0' };
export const SARIF_LEVEL: Record<Severity, 'error' | 'warning' | 'note'> = { critical: 'error', high: 'error', medium: 'warning', unrated: 'warning', low: 'note', info: 'note' };
const SECURITY_CATEGORIES = new Set<Category>(['secret', 'dependency', 'sast', 'iac']);
const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/* eslint-disable @typescript-eslint/no-explicit-any -- SARIF is a large external schema; we build plain JSON. */
type Json = Record<string, any>;

/** RFC 3986 relative reference for a project-relative POSIX path. */
const uriOf = (p: string): string => p.split('/').map(encodeURIComponent).join('/');
const isAbsolute = (p: string) => p.startsWith('/') || /^[A-Za-z]:\//.test(p);

function artifactLocation(file: string): Json {
  if (isAbsolute(file)) return { uri: `file://${file.startsWith('/') ? '' : '/'}${uriOf(file)}` };
  return { uri: uriOf(file), uriBaseId: '%SRCROOT%' };
}

function buildRule(id: string, findings: Finding[]): Json {
  const info = ruleInfo(id);
  // Highest severity by security-severity score (unrated = 7.0, between high and medium).
  const score = (f: Finding) => Number(SECURITY_SEVERITY[f.severity]);
  const top = findings.reduce((a, b) => (score(b) > score(a) ? b : a));
  const severity = top.severity;
  const confidence = findings.map((f) => f.confidence).reduce<Confidence>((a, b) => (CONFIDENCE_RANK[b] > CONFIDENCE_RANK[a] ? b : a), 'low');
  const cwe = [...new Set([...(info?.cwe ?? []), ...findings.flatMap((f) => f.cwe)])].sort();
  const categories = [...new Set(findings.map((f) => f.category))];
  const security = categories.some((c) => SECURITY_CATEGORIES.has(c)) || cwe.length > 0;
  const withHelp = findings.find((f) => f.help);
  const helpText = withHelp?.help?.text ?? info?.help ?? top.message ?? top.title;
  const helpUrl = withHelp?.help?.url ?? info?.helpUrl;
  return {
    id,
    shortDescription: { text: info?.title ?? top.title },
    ...(info?.description ? { fullDescription: { text: info.description } } : {}),
    help: { text: helpText, markdown: `${mdText(helpText, 4000)}${helpUrl && /^https?:\/\//.test(helpUrl) ? `\n\n[More information](${encodeURI(helpUrl)})` : ''}` },
    ...(helpUrl && /^https?:\/\//.test(helpUrl) ? { helpUri: encodeURI(helpUrl) } : {}),
    defaultConfiguration: { level: SARIF_LEVEL[severity] },
    properties: {
      tags: [...categories, ...(security ? ['security'] : []), ...cwe.map((c) => `external/cwe/${c.toLowerCase()}`)],
      'security-severity': SECURITY_SEVERITY[severity],
      precision: confidence,
    },
  };
}

function notification(c: Coverage): Json {
  const level = c.status === 'failed' || c.status === 'timeout' ? 'error' : c.status === 'unavailable' ? 'warning' : 'note';
  return {
    level,
    message: { text: `${c.engine} (${c.category}${c.target ? `, ${c.target}` : ''}): ${c.status}${c.reason ? ` — ${c.reason}` : ''}. Not covered by this run.` },
    descriptor: { id: `athena/coverage/${c.status}` },
    properties: { engine: c.engine, category: c.category, status: c.status, network: c.network, ...(c.target ? { target: c.target } : {}) },
  };
}

export function toSarif(input: ReportInput): Json {
  const r = input.result;
  const findings = sortForDisplay(r.findings).filter((f) => statusKind(statusOf(input, f)) !== 'excluded');
  const baselineApplied = Object.values(input.statuses ?? {}).includes('baselined') || r.scope.mode !== 'all';

  const ruleIds = [...new Set(findings.map((f) => f.ruleId))].sort();
  const rules = ruleIds.map((id) => buildRule(id, findings.filter((f) => f.ruleId === id)));
  const ruleIndex = new Map(ruleIds.map((id, i) => [id, i]));

  const results = findings.map((f) => {
    const status = statusOf(input, f);
    const kind = statusKind(status);
    const file = fileOf(f, input.root);
    const loc = f.location;
    const region: Json | undefined = loc?.startLine
      ? {
          startLine: loc.startLine,
          ...(loc.startColumn ? { startColumn: loc.startColumn } : {}),
          ...(loc.endLine && loc.endLine >= loc.startLine ? { endLine: loc.endLine } : {}),
          ...(loc.endColumn && (loc.endLine ?? loc.startLine) >= loc.startLine ? { endColumn: loc.endColumn } : {}),
        }
      : undefined;
    const note = input.notes?.[f.fingerprint];
    const suppression =
      kind === 'suppressed'
        ? { kind: 'inSource', status: 'accepted', justification: note ?? 'Suppressed by an inline Athena comment.' }
        : kind === 'triaged'
          ? { kind: 'external', status: 'accepted', justification: note ?? `Triaged as ${status.slice('triaged:'.length) || 'unspecified'} in Athena triage.` }
          : kind === 'baselined'
            ? { kind: 'external', status: 'accepted', justification: note ?? 'Accepted in the Athena baseline (existing finding).' }
            : undefined;
    const title = displayTitle(f);
    return {
      ruleId: f.ruleId,
      ruleIndex: ruleIndex.get(f.ruleId)!,
      level: SARIF_LEVEL[f.severity],
      message: { text: f.message && f.message !== f.title ? `${title}: ${f.message}` : title },
      ...(file ? { locations: [{ physicalLocation: { artifactLocation: artifactLocation(file), ...(region ? { region } : {}) } }] } : {}),
      partialFingerprints: { [`athena/v${FINGERPRINT_VERSION}`]: f.fingerprint },
      ...(baselineApplied ? { baselineState: kind === 'baselined' ? 'unchanged' : 'new' } : {}),
      ...(suppression ? { suppressions: [suppression] } : {}),
      properties: {
        severity: f.severity,
        confidence: f.confidence,
        category: f.category,
        label: f.label,
        potential: f.potential,
        engine: f.engine.id,
        ...(f.engine.version ? { engineVersion: f.engine.version } : {}),
        alsoReportedBy: f.alsoReportedBy,
        status,
        ...(f.owasp.length ? { owasp: f.owasp } : {}),
        ...(f.package ? { package: f.package } : {}),
      },
    };
  });

  const gaps = r.coverage.filter((c) => c.status !== 'ok');
  const endTime = Number.isNaN(Date.parse(r.scannedAt)) ? undefined : new Date(Date.parse(r.scannedAt)).toISOString();
  return {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'Athena',
            version: input.toolVersion,
            ...(SEMVER.test(input.toolVersion) ? { semanticVersion: input.toolVersion } : {}),
            informationUri: INFORMATION_URI,
            rules,
          },
        },
        invocations: [
          {
            executionSuccessful: !r.coverage.some((c) => c.status === 'failed' || c.status === 'timeout'),
            ...(endTime ? { endTimeUtc: endTime } : {}),
            toolExecutionNotifications: gaps.map(notification),
          },
        ],
        columnKind: 'utf16CodeUnits',
        results,
        properties: {
          scope: r.scope,
          coverage: r.coverage.map((c) => ({ engine: c.engine, category: c.category, status: c.status, network: c.network, ...(c.reason ? { reason: c.reason } : {}), ...(c.target ? { target: c.target } : {}) })),
          ...(input.gate ? { gate: input.gate } : {}),
          ...(input.ratings ? { ratings: input.ratings } : {}),
        },
      },
    ],
  };
}

export const renderSarif = (input: ReportInput): string => `${JSON.stringify(toSarif(input), null, 2)}\n`;
