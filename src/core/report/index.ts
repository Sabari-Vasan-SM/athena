import { renderGithub } from './github.js';
import { renderJson } from './json.js';
import { renderMarkdown } from './markdown.js';
import { renderSarif } from './sarif.js';
import type { ReportInput } from './shared.js';
import { renderText, type TextOptions } from './text.js';

/**
 * Report renderers for unified scan results. Pure: they take a ScanResult plus the
 * policy outcome (statuses, gate, ratings) and return a string; nothing is read from or
 * written to disk. Every format shows coverage gaps, renders heuristic findings as
 * "Potential …", and prints only what the findings carry (never a secret value).
 */

export const REPORT_FORMATS = ['text', 'json', 'markdown', 'github', 'sarif'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export function render(format: ReportFormat, input: ReportInput, opts: TextOptions = {}): string {
  switch (format) {
    case 'text':
      return renderText(input, opts);
    case 'json':
      return renderJson(input);
    case 'markdown':
      return renderMarkdown(input);
    case 'github':
      return renderGithub(input);
    case 'sarif':
      return renderSarif(input);
  }
}

export type { CategoryRating, FindingStatus, GateVerdict, Grade, ReportInput, Summary } from './shared.js';
export { summarize } from './shared.js';
export type { TextOptions } from './text.js';
export type { JsonReport } from './json.js';
export { renderText } from './text.js';
export { renderJson, toJsonReport } from './json.js';
export { renderMarkdown, SCAN_MARKER, MAX_MARKDOWN_FINDINGS } from './markdown.js';
export { renderGithub, MAX_ANNOTATIONS } from './github.js';
export { renderSarif, toSarif, SECURITY_SEVERITY, SARIF_LEVEL } from './sarif.js';
export { ruleInfo, listRules, RULES, type RuleInfo } from './rules.js';
