import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { check } from 'recheck';

// Use recheck's pure-JS backend on every OS (its Java fallback fails on Windows CI).
process.env.RECHECK_BACKEND ??= 'pure';
import { MAX_GENERIC_LINE, SECRET_PATTERNS, scanText, type ScanStats } from '../../src/core/security/secrets.js';
import { FAKE } from '../helpers.js';

const SIZE = 64 * 1024;
const fill = (unit: string, size = SIZE) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

/**
 * Inputs that make backtracking regexes super-linear: long runs of each
 * character class the patterns use, repeated keywords and prefixes, BEGIN
 * headers without END, and long dotted identifier chains.
 */
const ADVERSARIAL: Record<string, string> = {
  'a-': fill('a-'),
  'a.b.': fill('a.b.'),
  'alnum run': fill('aZ09'),
  'underscore run': fill('_'),
  'dash run': fill('-'),
  'spaces': fill(' '),
  'tabs and newlines': fill('\t\n'),
  'equals run': fill('='),
  'colon-quote': fill(':"'),
  'equals-quote-value': fill('="aaaaaaaaaaaaaaaaaaaaaaa'),
  'keyword repeated': fill('password'),
  'keyword-dash repeated': fill('secret-'),
  'keyword assignment no quote': fill('api_key='),
  'env keyword no value': fill('PASSWORD_'),
  'env line repeated': fill('TOKEN=\n'),
  'BEGIN without END': fill('-----BEGIN RSA PRIVATE KEY-----\n'),
  'BEGIN inline without END': fill('-----BEGIN PRIVATE KEY-----'),
  'sk- repeated': fill('sk-'),
  'sk-ant- repeated': fill('sk-ant-'),
  'eyJ repeated': fill('eyJ'),
  'eyJ dotted': fill('eyJaaaaaaaaaaaa.'),
  'xoxb- repeated': fill('xoxb-'),
  'glpat- repeated': fill('glpat-'),
  'ghp_ repeated': fill('ghp_'),
  'AKIA repeated': fill('AKIA'),
  'AIza repeated': fill('AIza'),
  'SG. repeated': fill('SG.'),
  'AccountKey repeated': fill('AccountKey='),
  'postgres:// user no @': `postgres://${fill('a:')}`,
  'postgres:// repeated': fill('postgres://a:b'),
  'private_key json no close': fill('"private_key": "-----BEGIN PRIVATE KEY-----'),
  'aws secret repeated': fill('aws_secret_access_key='),
  'slack webhook no tail': fill('https://hooks.slack.com/services/'),
  'long dotted identifier': `${fill('a.b.c.', 60_000)} = "Zq8#mK2$vL9pW4xT7nB1"`,
};

// Generous for slow or busy machines, yet orders of magnitude below what the old patterns
// took on these inputs (seconds at 16 KB, more than 12 minutes at 64 KB).
const BUDGET_MS = 200 * (process.env.CI ? 4 : 1);

/** Fastest of three runs: a backtracking regex is slow every time, a busy CPU only sometimes. */
function bestOf3(fn: () => void): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

describe('secret scanner is linear-time on adversarial input', () => {
  // Warm up the regex engine so the first case doesn't pay JIT costs.
  scanText(fill('warm up ', 4096));

  it.each(Object.entries(ADVERSARIAL))('%s', (_name, input) => {
    expect(bestOf3(() => scanText(input))).toBeLessThan(BUDGET_MS);
  });

  it('each pattern individually stays within budget on every input', () => {
    for (const p of SECRET_PATTERNS) {
      for (const [name, input] of Object.entries(ADVERSARIAL)) {
        const ms = bestOf3(() => {
          for (const _ of input.matchAll(new RegExp(p.regex.source, p.regex.flags))) void _;
        });
        expect(ms, `${p.id} on "${name}"`).toBeLessThan(BUDGET_MS);
      }
    }
  });

  it('still finds a private key block', () => {
    expect(scanText(FAKE.pem).map((m) => m.type)).toEqual(['private-key']);
    // END too far away (beyond the bounded window) is not paired.
    const far = FAKE.pem.replace('\nabcDEF123\n', `\n${'A'.repeat(20_000)}\n`);
    expect(scanText(far).filter((m) => m.type === 'private-key')).toEqual([]);
    // BEGIN repeated, then one key: flagged once, at the BEGIN line of the real block.
    const text = `${'-----BEGIN RSA PRIVATE KEY-----\n'.repeat(3)}x\n${FAKE.pem}\n`;
    const keys = scanText(text).filter((m) => m.type === 'private-key');
    expect(keys).toHaveLength(1);
    expect(keys[0]!.line).toBe(1);
  });

  it('skips generic patterns on overlong lines and counts them', () => {
    const minified = `var a=1;${'x'.repeat(MAX_GENERIC_LINE)};const clientSecret = "Zq8#mK2$vL9pW4xT7nB1";`;
    const stats: ScanStats = { skippedLongLines: 0 };
    expect(scanText(minified, { stats })).toEqual([]);
    expect(stats.skippedLongLines).toBe(1);
    // Specific token formats are still found on long lines.
    expect(scanText(`${'x'.repeat(MAX_GENERIC_LINE)} ${FAKE.github}`).map((m) => m.type)).toEqual(['github-token']);
  });
});

describe('recheck static ReDoS analysis', () => {
  it.each(SECRET_PATTERNS.map((p) => [p.id, p] as const))('%s is not vulnerable', async (_id, p) => {
    const result = await check(p.regex.source, p.regex.flags, { timeout: 20_000 });
    expect(result.status, `${p.id}: ${result.status === 'vulnerable' ? result.complexity.summary : ''}`).not.toBe('vulnerable');
  }, 60_000);
});
