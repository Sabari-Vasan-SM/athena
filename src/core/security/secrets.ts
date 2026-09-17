import { sha256 } from '../util/fs.js';

export interface SecretPattern {
  id: string;
  description: string;
  regex: RegExp;
  /** Capture group holding the secret value (0 = whole match). */
  group?: number;
  /** Minimum Shannon entropy (bits/char) for the captured value. */
  minEntropy?: number;
}

export interface SecretMatch {
  type: string;
  line: number;
  /** Start/end offsets of the secret value within the scanned text. */
  start: number;
  end: number;
  fingerprint: string;
}

/**
 * Conservative, well-known credential formats. Generic patterns require entropy
 * so ordinary identifiers ("password = form.password") are not flagged.
 */
export const SECRET_PATTERNS: SecretPattern[] = [
  { id: 'private-key', description: 'Private key block', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g },
  { id: 'aws-access-key-id', description: 'AWS access key ID', regex: /\b((?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})\b/g, group: 1 },
  { id: 'aws-secret-access-key', description: 'AWS secret access key', regex: /aws_?secret_?access_?key["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})\b/gi, group: 1 },
  { id: 'gcp-service-account', description: 'GCP service account private key', regex: /"private_key"\s*:\s*"(-----BEGIN PRIVATE KEY-----[^"]+)"/g, group: 1 },
  { id: 'azure-storage-key', description: 'Azure storage connection string', regex: /AccountKey=([A-Za-z0-9+/=]{60,})/g, group: 1 },
  { id: 'github-token', description: 'GitHub token', regex: /\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g, group: 1 },
  { id: 'gitlab-token', description: 'GitLab token', regex: /\b(glpat-[A-Za-z0-9_-]{20,})\b/g, group: 1 },
  { id: 'slack-token', description: 'Slack token', regex: /\b(xox[abprs]-[A-Za-z0-9-]{10,})\b/g, group: 1 },
  { id: 'slack-webhook', description: 'Slack webhook URL', regex: /(https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,})/g, group: 1 },
  { id: 'stripe-key', description: 'Stripe secret key', regex: /\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,})\b/g, group: 1 },
  { id: 'anthropic-key', description: 'Anthropic API key', regex: /\b(sk-ant-[A-Za-z0-9_-]{20,})\b/g, group: 1 },
  { id: 'openai-key', description: 'OpenAI API key', regex: /\b(sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,})\b/g, group: 1 },
  { id: 'google-api-key', description: 'Google API key', regex: /\b(AIza[0-9A-Za-z_-]{35})\b/g, group: 1 },
  { id: 'sendgrid-key', description: 'SendGrid API key', regex: /\b(SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})\b/g, group: 1 },
  { id: 'npm-token', description: 'npm token', regex: /\b(npm_[A-Za-z0-9]{36})\b/g, group: 1 },
  { id: 'jwt', description: 'JSON Web Token', regex: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, group: 1 },
  {
    id: 'connection-string-credentials',
    description: 'Connection string with embedded password',
    regex: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql|sqlserver):\/\/[^\s:@/"'`]+:([^\s@/"'`]{3,})@/gi,
    group: 1,
  },
  {
    id: 'generic-secret-assignment',
    description: 'Hardcoded secret-like assignment',
    regex: /\b[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|auth[_-]?key|client[_-]?secret|private[_-]?key)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["'`]([^"'`\s]{12,})["'`]/gi,
    group: 1,
    minEntropy: 3.5,
  },
  {
    id: 'env-secret-assignment',
    description: 'Secret-like environment value',
    regex: /^\s*(?:export\s+)?[A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|CLIENT_SECRET)[A-Z0-9_]*\s*=\s*["']?([^\s"'#$]{8,})["']?\s*$/gm,
    group: 1,
    minEntropy: 3.0,
  },
];

const PLACEHOLDER_VALUE = /^(?:<.*>|\$\{.*\}|\{\{.*\}\}|x{4,}|\*{4,}|changeme|change[-_]?me|your[-_].*|example.*|placeholder.*|dummy.*|test.*|fake.*|replace[-_]?me|todo|null|none|undefined|password|secret|redacted)$/i;

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

export function scanText(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  const taken: Array<[number, number]> = [];
  const lineStarts = computeLineStarts(text);

  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    for (const m of text.matchAll(pattern.regex)) {
      const group = pattern.group ?? 0;
      const value = m[group];
      if (!value || m.index === undefined) continue;
      if (PLACEHOLDER_VALUE.test(value)) continue;
      if (pattern.minEntropy !== undefined && shannonEntropy(value) < pattern.minEntropy) continue;
      const offsetInMatch = group === 0 ? 0 : m[0].indexOf(value);
      const start = m.index + Math.max(offsetInMatch, 0);
      const end = start + value.length;
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      taken.push([start, end]);
      matches.push({
        type: pattern.id,
        line: lineAt(lineStarts, start),
        start,
        end,
        fingerprint: sha256(value).slice(0, 12),
      });
    }
  }
  return matches.sort((a, b) => a.start - b.start);
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
