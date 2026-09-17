import { describe, expect, it } from 'vitest';
import { addRule, listRules, parseRules, removeRule, serializeRules, updateRule } from '../../src/core/knowledge/rules.js';

const SAMPLE = `# Athena Project Rules

Some intro prose that must survive.

## Architecture

- Do not bypass the service layer.
- [disabled] Keep business logic outside controllers.
  - nested detail stays attached

## Security

* Never expose secrets.

\`\`\`
- not a rule (inside code fence)
\`\`\`

- [x] checkbox items are not rules
`;

describe('rules.md round-trip', () => {
  it('parses rules with sections and enabled state', () => {
    const rules = listRules(parseRules(SAMPLE));
    expect(rules).toEqual([
      { index: 1, section: 'Architecture', text: 'Do not bypass the service layer.', enabled: true },
      { index: 2, section: 'Architecture', text: 'Keep business logic outside controllers.', enabled: false },
      { index: 3, section: 'Security', text: 'Never expose secrets.', enabled: true },
    ]);
  });

  it('serializes unchanged documents byte-for-byte', () => {
    expect(serializeRules(parseRules(SAMPLE))).toBe(SAMPLE);
  });

  it('preserves CRLF line endings', () => {
    const crlf = SAMPLE.replace(/\n/g, '\r\n');
    expect(serializeRules(parseRules(crlf))).toBe(crlf);
  });

  it('adds a rule to an existing section after its last rule', () => {
    const doc = addRule(parseRules(SAMPLE), 'architecture', 'Services must not import controllers.');
    const out = serializeRules(doc);
    expect(out).toContain('- [disabled] Keep business logic outside controllers.\n- Services must not import controllers.');
    expect(listRules(doc).find((r) => r.text.startsWith('Services'))!.section).toBe('Architecture');
  });

  it('creates a new section when needed', () => {
    const out = serializeRules(addRule(parseRules(SAMPLE), 'Database', 'Use migrations.'));
    expect(out).toMatch(/## Database\n\n- Use migrations\.\n$/);
  });

  it('enables, disables, edits and removes by index', () => {
    let doc = parseRules(SAMPLE);
    doc = updateRule(doc, 2, { enabled: true });
    doc = updateRule(doc, 1, { enabled: false, text: 'Always use the service layer.' });
    doc = removeRule(doc, 3);
    const out = serializeRules(doc);
    expect(out).toContain('- [disabled] Always use the service layer.');
    expect(out).toContain('- Keep business logic outside controllers.\n  - nested detail stays attached');
    expect(out).not.toContain('Never expose secrets.');
    expect(out).toContain('Some intro prose that must survive.');
  });

  it('rejects invalid input', () => {
    expect(() => updateRule(parseRules(SAMPLE), 99, { enabled: true })).toThrow(/No rule #99/);
    expect(() => addRule(parseRules(SAMPLE), 'X', '   ')).toThrow(/empty/);
    // Newlines cannot inject extra rules or headings
    const out = serializeRules(addRule(parseRules(SAMPLE), 'X', 'one\n## Injected\n- two'));
    expect(listRules(parseRules(out)).filter((r) => r.section === 'Injected')).toHaveLength(0);
  });
});
