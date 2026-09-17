import { describe, expect, it } from 'vitest';
import { isBlockModified, mergeDocument, parseBlocks, removeIntegrationBlock, renderBlock, upsertIntegrationBlock } from '../../src/core/knowledge/managed-blocks.js';

const doc = (a: string, b: string) => `# Doc\n\nIntro by developer.\n\n${renderBlock({ id: 'a', content: a })}\n\nMiddle notes.\n\n${renderBlock({ id: 'b', content: b })}\n\n## Developer Notes\n\nMine.\n`;

describe('managed blocks', () => {
  it('parses blocks and detects unmodified content', () => {
    const blocks = parseBlocks(doc('alpha', 'beta'));
    expect(blocks.map((b) => b.id)).toEqual(['a', 'b']);
    expect(blocks.some(isBlockModified)).toBe(false);
  });

  it('replaces generated blocks and preserves developer content', () => {
    const r = mergeDocument(doc('alpha', 'beta'), [{ id: 'a', content: 'ALPHA2' }, { id: 'b', content: 'beta' }]);
    expect(r.updated).toEqual(['a']);
    expect(r.text).toContain('ALPHA2');
    expect(r.text).toContain('Intro by developer.');
    expect(r.text).toContain('Middle notes.');
    expect(r.text).toContain('Mine.');
  });

  it('is idempotent', () => {
    const original = doc('alpha', 'beta');
    const r = mergeDocument(original, [{ id: 'a', content: 'alpha' }, { id: 'b', content: 'beta' }]);
    expect(r.changed).toBe(false);
    expect(r.text).toBe(original);
  });

  it('keeps developer edits inside a block unless forced', () => {
    const edited = doc('alpha', 'beta').replace('alpha', 'alpha — edited by developer');
    const r = mergeDocument(edited, [{ id: 'a', content: 'new alpha' }]);
    expect(r.preservedModified).toEqual(['a']);
    expect(r.text).toContain('edited by developer');
    const forced = mergeDocument(edited, [{ id: 'a', content: 'new alpha' }], { force: true });
    expect(forced.text).toContain('new alpha');
    expect(forced.text).not.toContain('edited by developer');
  });

  it('inserts new sections before the developer notes, but not ones the developer deleted', () => {
    const r = mergeDocument(doc('alpha', 'beta'), [{ id: 'c', content: 'gamma' }, { id: 'd', content: 'delta' }], { insertBefore: '## Developer Notes', previouslyKnown: ['a', 'b', 'd'] });
    expect(r.added).toEqual(['c']);
    expect(r.text.indexOf('gamma')).toBeLessThan(r.text.indexOf('## Developer Notes'));
    expect(r.text).not.toContain('delta');
  });

  it('treats unterminated markers as developer content', () => {
    const broken = '<!-- athena:generated:start id=x hash=abc -->\nno end marker';
    expect(parseBlocks(broken)).toEqual([]);
    expect(mergeDocument(broken, [{ id: 'x', content: 'y' }], { previouslyKnown: ['x'] }).text).toBe(broken);
  });

  it('upserts and removes integration blocks in user-owned files', () => {
    const user = '# My CLAUDE.md\n\nExisting instructions.\n';
    const withBlock = upsertIntegrationBlock(user, 'Athena v1');
    expect(withBlock).toContain('Existing instructions.');
    const updated = upsertIntegrationBlock(withBlock, 'Athena v2');
    expect(updated).toContain('Athena v2');
    expect(updated).not.toContain('Athena v1');
    expect(updated.match(/athena:start/g)).toHaveLength(1);
    expect(removeIntegrationBlock(updated)).toBe(user);
    expect(removeIntegrationBlock(upsertIntegrationBlock(null, 'only'))).toBe('');
  });
});
