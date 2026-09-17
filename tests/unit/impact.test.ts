import { describe, expect, it } from 'vitest';
import { impactOf } from '../../src/core/impact/impact.js';
import { diffFileIndex } from '../../src/core/state/state.js';

describe('impact analysis', () => {
  it('maps an API change to api/security/testing but not deployment', () => {
    const r = impactOf(['src/api/payment.ts']);
    expect(r.docs).toEqual(expect.arrayContaining(['api', 'security', 'testing']));
    expect(r.docs).not.toContain('deployment');
  });

  it('maps schema changes to database', () => {
    expect(impactOf(['prisma/schema.prisma']).docs).toContain('database');
    expect(impactOf(['db/migrations/0003_add_orders.sql']).docs).toContain('database');
  });

  it('maps infrastructure changes to deployment', () => {
    expect(impactOf(['Dockerfile']).docs).toContain('deployment');
    expect(impactOf(['.github/workflows/ci.yml']).docs).toContain('deployment');
  });

  it('ignores .athena changes and flags structural changes', () => {
    expect(impactOf(['.athena/project.md']).docs).toEqual([]);
    expect(impactOf(['README.md'], { structural: ['README.md'] }).docs).toEqual(['project']);
  });

  it('diffs file indexes', () => {
    const prev = { 'a.ts': { h: '1', s: 1, m: 1 }, 'b.ts': { h: '2', s: 1, m: 1 } };
    const next = { 'a.ts': { h: '1', s: 1, m: 2 }, 'b.ts': { h: '3', s: 1, m: 1 }, 'c.ts': { h: '4', s: 1, m: 1 } };
    expect(diffFileIndex(prev, next)).toEqual({ added: ['c.ts'], modified: ['b.ts'], deleted: [] });
  });
});
