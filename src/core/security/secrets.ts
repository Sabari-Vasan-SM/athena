import crypto from 'node:crypto';

export interface SecretPattern {
  id: string;
  description: string;
  /**
   * Every pattern must run in linear time on untrusted input (see
   * tests/unit/secrets-redos.test.ts). Open-ended token classes are preceded by a
   * lookbehind on the same class so a match can only start at the beginning of a run.
   */
  regex: RegExp;
  /** Capture group holding the secret value (0 = whole match). */
  group?: number;
  /** Minimum Shannon entropy (bits/char) for the captured value. */
  minEntropy?: number;
  /**
   * Keyword heuristic: the identifier preceding the value must match this. Such
   * patterns are "generic" and are not applied to overlong (minified) lines.
   */
  identifier?: RegExp;
}

export interface SecretMatch {
  type: string;
  line: number;
  /** Start/end offsets of the secret value within the scanned text. */
  start: number;
  end: number;
  /**
   * Keyed fingerprint of the value (never an unsalted hash). With the default
   * options it is keyed with a random per-process key, so it is only useful for
   * comparisons within one process.
   */
  fingerprint: string;
}

export interface ScanOptions {
  /** Fingerprint function for matched values. Default: HMAC with a random per-process key. */
  fingerprint?: (value: string) => string;
  /** Receives counters about the scan (e.g. lines skipped by generic patterns). */
  stats?: ScanStats;
}

export interface ScanStats {
  /** Lines longer than MAX_GENERIC_LINE on which generic (keyword) patterns were not applied. */
  skippedLongLines: number;
}

/** Generic keyword patterns are skipped on lines longer than this (minified code, data blobs). */
export const MAX_GENERIC_LINE = 4096;
/** How far past a PEM BEGIN header the matching END line is looked for. */
export const PRIVATE_KEY_WINDOW = 16 * 1024;
/** Longest identifier inspected before a generic assignment. */
const IDENTIFIER_LOOKBACK = 64;

const PEM_LABEL = '(?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----';
const PEM_BEGIN = new RegExp(`-----BEGIN ${PEM_LABEL}`, 'g');
const PEM_END = new RegExp(`-----END ${PEM_LABEL}`, 'g');

const GENERIC_KEYWORD = /password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|auth[_-]?key|client[_-]?secret|private[_-]?key/i;
const ENV_KEYWORD = /PASSWORD|SECRET|TOKEN|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|CLIENT_SECRET/;

/**
 * Conservative, well-known credential formats. Generic patterns require entropy
 * so ordinary identifiers ("password = form.password") are not flagged.
 */
export const SECRET_PATTERNS: SecretPattern[] = [
  // Matched in two steps (see matchPrivateKeys): this regex only finds the BEGIN header.
  { id: 'private-key', description: 'Private key block', regex: PEM_BEGIN },
  { id: 'aws-access-key-id', description: 'AWS access key ID', regex: /\b((?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})\b/g, group: 1 },
  { id: 'aws-secret-access-key', description: 'AWS secret access key', regex: /aws_?secret_?access_?key["']?[ \t]*[:=][ \t]*["']?([A-Za-z0-9/+=]{40})\b/gi, group: 1 },
  { id: 'gcp-service-account', description: 'GCP service account private key', regex: /"private_key"[ \t]*:[ \t]*"(-----BEGIN PRIVATE KEY-----[^"]{1,16384})"/g, group: 1 },
  { id: 'azure-storage-key', description: 'Azure storage connection string', regex: /(?<![A-Za-z0-9+/=])AccountKey=([A-Za-z0-9+/=]{60,1024})/g, group: 1 },
  { id: 'github-token', description: 'GitHub token', regex: /(?<![A-Za-z0-9_])((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/g, group: 1 },
  { id: 'gitlab-token', description: 'GitLab token', regex: /(?<![A-Za-z0-9_-])(glpat-[A-Za-z0-9_-]{20,255})(?![A-Za-z0-9_-])/g, group: 1 },
  { id: 'slack-token', description: 'Slack token', regex: /(?<![A-Za-z0-9_-])(xox[abprs]-[A-Za-z0-9-]{10,255})(?![A-Za-z0-9_-])/g, group: 1 },
  { id: 'slack-webhook', description: 'Slack webhook URL', regex: /(https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,255})/g, group: 1 },
  { id: 'stripe-key', description: 'Stripe secret key', regex: /(?<![A-Za-z0-9_])((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,255})\b/g, group: 1 },
  { id: 'anthropic-key', description: 'Anthropic API key', regex: /(?<![A-Za-z0-9_-])(sk-ant-[A-Za-z0-9_-]{20,255})(?![A-Za-z0-9_-])/g, group: 1 },
  { id: 'openai-key', description: 'OpenAI API key', regex: /(?<![A-Za-z0-9_-])(sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,255})(?![A-Za-z0-9_-])/g, group: 1 },
  { id: 'google-api-key', description: 'Google API key', regex: /(?<![A-Za-z0-9_-])(AIza[0-9A-Za-z_-]{35})(?![A-Za-z0-9_-])/g, group: 1 },
  { id: 'sendgrid-key', description: 'SendGrid API key', regex: /(?<![A-Za-z0-9_-])(SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/g, group: 1 },
  { id: 'npm-token', description: 'npm token', regex: /(?<![A-Za-z0-9_])(npm_[A-Za-z0-9]{36})\b/g, group: 1 },
  { id: 'jwt', description: 'JSON Web Token', regex: /(?<![A-Za-z0-9_-])(eyJ[A-Za-z0-9_-]{10,4096}\.eyJ[A-Za-z0-9_-]{10,8192}\.[A-Za-z0-9_-]{10,4096})(?![A-Za-z0-9_-])/g, group: 1 },
  {
    id: 'connection-string-credentials',
    description: 'Connection string with embedded password',
    regex: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql|sqlserver):\/\/[^\s:@/"'`]{1,256}:([^\s@/"'`]{3,256})@/gi,
    group: 1,
  },
  {
    // Two-step, linear: find a bounded quoted value after ":" or "=", then check the
    // identifier just before the operator for a keyword (see identifierBefore).
    id: 'generic-secret-assignment',
    description: 'Hardcoded secret-like assignment',
    regex: /[:=][ \t]*["'`]([^"'`\s]{12,200})["'`]/g,
    group: 1,
    minEntropy: 3.5,
    identifier: GENERIC_KEYWORD,
  },
  {
    id: 'env-secret-assignment',
    description: 'Secret-like environment value',
    regex: /^[ \t]*(?:export[ \t]+)?[A-Z0-9_]{1,128}[ \t]*=[ \t]*["']?([^\s"'#$]{8,512})["']?[ \t\r]*$/gm,
    group: 1,
    minEntropy: 3.0,
    identifier: ENV_KEYWORD,
  },
];

const PLACEHOLDER_VALUE = /^(?:<.*>|\$\{.*\}|\{\{.*\}\}|x{4,}|\*{4,}|changeme|change[-_]?me|your[-_].*|example.*|placeholder.*|dummy.*|test.*|fake.*|replace[-_]?me|todo|null|none|undefined|password|secret|redacted)$/i;

const PROCESS_KEY = crypto.randomBytes(32);
/** Default fingerprint: keyed with a random per-process key, never a plain hash of the value. */
export const ephemeralFingerprint = (value: string): string => crypto.createHmac('sha256', PROCESS_KEY).update(value).digest('hex').slice(0, 16);

export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

interface RawMatch {
  start: number;
  end: number;
  value: string;
}

/** PEM blocks: BEGIN header, then the first END header within PRIVATE_KEY_WINDOW. Linear time. */
function matchPrivateKeys(text: string): RawMatch[] {
  if (!text.includes('PRIVATE KEY')) return [];
  const ends: Array<[number, number]> = [];
  PEM_END.lastIndex = 0;
  for (const m of text.matchAll(PEM_END)) ends.push([m.index, m.index + m[0].length]);
  if (!ends.length) return [];
  const out: RawMatch[] = [];
  let e = 0;
  PEM_BEGIN.lastIndex = 0;
  for (const m of text.matchAll(PEM_BEGIN)) {
    const bodyStart = m.index + m[0].length;
    while (e < ends.length && ends[e]![0] < bodyStart) e++;
    if (e >= ends.length) break;
    const [endStart, endEnd] = ends[e]!;
    if (endStart - bodyStart > PRIVATE_KEY_WINDOW) continue;
    out.push({ start: m.index, end: endEnd, value: text.slice(m.index, endEnd) });
  }
  return out;
}

const IDENT_CHAR = /[A-Za-z0-9_.-]/;

/** The identifier immediately before `opIndex` (skipping spaces and one closing quote), at most IDENTIFIER_LOOKBACK chars. */
function identifierBefore(text: string, opIndex: number): string {
  let i = opIndex - 1;
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) i--;
  if (i >= 0 && (text[i] === '"' || text[i] === "'")) i--;
  const end = i + 1;
  const floor = Math.max(0, end - IDENTIFIER_LOOKBACK);
  while (i >= floor && IDENT_CHAR.test(text[i]!)) i--;
  return text.slice(i + 1, end);
}

function lineLength(starts: number[], line: number, textLength: number): number {
  const start = starts[line - 1]!;
  const next = line < starts.length ? starts[line]! : textLength + 1;
  return next - 1 - start;
}

export function scanText(text: string, opts: ScanOptions = {}): SecretMatch[] {
  const fingerprint = opts.fingerprint ?? ephemeralFingerprint;
  const matches: SecretMatch[] = [];
  const taken: Array<[number, number]> = [];
  const lineStarts = computeLineStarts(text);

  if (opts.stats) {
    for (let l = 1; l <= lineStarts.length; l++) if (lineLength(lineStarts, l, text.length) > MAX_GENERIC_LINE) opts.stats.skippedLongLines++;
  }

  const accept = (type: string, raw: RawMatch, line = lineAt(lineStarts, raw.start)) => {
    if (taken.some(([s, e]) => raw.start < e && raw.end > s)) return;
    taken.push([raw.start, raw.end]);
    matches.push({ type, line, start: raw.start, end: raw.end, fingerprint: fingerprint(raw.value) });
  };

  for (const pattern of SECRET_PATTERNS) {
    if (pattern.id === 'private-key') {
      for (const raw of matchPrivateKeys(text)) accept(pattern.id, raw);
      continue;
    }
    pattern.regex.lastIndex = 0;
    for (const m of text.matchAll(pattern.regex)) {
      const group = pattern.group ?? 0;
      const value = m[group];
      if (!value || m.index === undefined) continue;
      if (PLACEHOLDER_VALUE.test(value)) continue;
      if (pattern.minEntropy !== undefined && shannonEntropy(value) < pattern.minEntropy) continue;
      const offsetInMatch = group === 0 ? 0 : m[0].lastIndexOf(value);
      const start = m.index + Math.max(offsetInMatch, 0);
      const line = lineAt(lineStarts, start);
      if (pattern.identifier) {
        if (lineLength(lineStarts, line, text.length) > MAX_GENERIC_LINE) continue;
        const name = pattern.id === 'env-secret-assignment' ? envName(m[0]) : identifierBefore(text, m.index);
        if (!pattern.identifier.test(name)) continue;
      }
      accept(pattern.id, { start, end: start + value.length, value }, line);
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}

/** Variable name of an env-style assignment match (text before "="). */
function envName(match: string): string {
  const eq = match.indexOf('=');
  return match.slice(0, eq).replace(/^[ \t]*(?:export[ \t]+)?/, '').trim();
}

/** Replace any detected secret values in `text` with a placeholder. */
export function redact(text: string, placeholder = '<redacted>'): string {
  const matches = scanText(text);
  if (!matches.length) return text;
  let out = '';
  let cursor = 0;
  for (const m of matches) {
    out += text.slice(cursor, m.start) + placeholder;
    cursor = m.end;
  }
  return out + text.slice(cursor);
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Heuristic: does an env var *name* look like it holds a secret? */
export function isSecretLikeName(name: string): boolean {
  return /(PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|DATABASE_URL|DB_URL|CONNECTION_STRING|DSN|WEBHOOK)/i.test(name);
}
