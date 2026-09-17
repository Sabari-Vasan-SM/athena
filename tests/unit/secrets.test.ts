import { describe, expect, it } from 'vitest';
import { isSecretLikeName, redact, scanText, shannonEntropy } from '../../src/core/security/secrets.js';
import { FAKE } from '../helpers.js';

describe('secret scanner', () => {
  it.each([
    ['aws-access-key-id', `const key = "${FAKE.aws}";`],
    ['github-token', `token: ${FAKE.github}`],
    ['stripe-key', `STRIPE=${FAKE.stripe}`],
    ['anthropic-key', `client = Anthropic(api_key="${FAKE.anthropic}")`],
    ['private-key', FAKE.pem],
    ['connection-string-credentials', `DATABASE_URL=postgres://app:${FAKE.dbPassword}@db.internal:5432/app`],
    ['generic-secret-assignment', `const clientSecret = "Zq8#mK2$vL9pW4xT7nB1";`],
  ])('detects %s', (type, text) => {
    const found = scanText(text);
    expect(found.map((f) => f.type)).toContain(type);
    expect(found[0]!.fingerprint).toMatch(/^[a-f0-9]{12}$/);
  });

  it.each([
    'password = form.password',
    'const token = getToken()',
    'API_KEY=<your-api-key>',
    'SECRET_KEY=changeme',
    'DATABASE_URL=postgres://localhost:5432/app',
    'api_key = "${API_KEY}"',
    'const passwordField = "password"',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ])('does not flag benign text: %s', (text) => {
    expect(scanText(text)).toEqual([]);
  });

  it('reports correct line numbers', () => {
    const text = `line1\nline2\nconst k = "${FAKE.aws}";\n`;
    expect(scanText(text)[0]!.line).toBe(3);
  });

  it('redacts values but keeps surrounding text', () => {
    const out = redact(`DATABASE_URL=postgres://app:${FAKE.dbPassword}@db:5432/app and ${FAKE.github}`);
    expect(out).not.toContain(FAKE.dbPassword);
    expect(out).not.toContain(FAKE.github);
    expect(out).toContain('postgres://app:<redacted>@db:5432/app');
  });

  it('computes entropy', () => {
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('abcd')).toBe(2);
  });

  it('classifies secret-like env names', () => {
    expect(isSecretLikeName('STRIPE_SECRET_KEY')).toBe(true);
    expect(isSecretLikeName('DATABASE_URL')).toBe(true);
    expect(isSecretLikeName('PORT')).toBe(false);
  });
});
