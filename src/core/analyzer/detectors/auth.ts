import type { Detector, FactDef } from '../context.js';
import { detected, inferred } from '../../model/fact.js';

/**
 * Auth libraries come from the dependency catalog. This detector adds structural
 * hints: auth-related files, middleware, and role/permission definitions.
 * Everything here is INFERRED unless the code pattern is unambiguous.
 */
const MIDDLEWARE_RE = /(^|\/)(src\/)?middleware\.(t|j)s$/;
const ROLE_FILE_RE = /\.(prisma|ts|tsx|py|java|kt|cs|go|rb|php)$/;
/** At most this many role definitions are reported in total, so no file needs more. */
const MAX_ROLE_EVIDENCE = 10;

const middlewareFact: FactDef<boolean> = {
  id: 'auth-middleware',
  applies: (f) => MIDDLEWARE_RE.test(f.path),
  compute: (text) => !!text && /(auth|session|token|redirect\(.*login)/i.test(text),
};

/** Role/permission type definitions in a file: [name, line]. */
const roleDefsFact: FactDef<Array<[string, number]>> = {
  id: 'auth-role-defs',
  applies: (f) => ROLE_FILE_RE.test(f.path) && !f.large,
  compute(text) {
    const out: Array<[string, number]> = [];
    if (!text || !/role|permission/i.test(text)) return out;
    for (const m of text.matchAll(/\b(?:enum|class|type|interface)\s+(\w*(?:Role|Permission)s?)\b/g)) {
      out.push([m[1]!, text.slice(0, m.index).split('\n').length]);
      if (out.length >= MAX_ROLE_EVIDENCE) break;
    }
    return out;
  },
};

export const authDetector: Detector = {
  id: 'auth',
  version: 1,
  facts: [middlewareFact, roleDefsFact],
  async run(ctx) {
    const { model } = ctx;
    const authFiles = ctx.find((f) => !f.binary && /\.(m|c)?(t|j)sx?$|\.(py|go|rs|java|kt|cs|php|rb|ex)$/.test(f.path) && /(^|\/)[^/]*(auth|session|login|oauth|jwt|guard|permission|rbac|acl|polic(y|ies))[^/]*$/i.test(f.path) && !/\.(test|spec)\./.test(f.path));
    if (authFiles.length) {
      model.auth.push({
        name: `Auth-related source files (${authFiles.length})`,
        kind: 'middleware',
        provenance: inferred('filesystem', authFiles.slice(0, 8).map((f) => ({ file: f.path, detail: 'file name suggests auth concern' })), 'low'),
      });
    }

    for (const f of ctx.find(MIDDLEWARE_RE)) {
      if (await ctx.fact(f.path, middlewareFact)) {
        model.auth.push({ name: 'Next.js middleware referencing auth/session', kind: 'middleware', provenance: detected('code', [{ file: f.path }], 'medium') });
      }
    }

    // Role / permission definitions
    const roleEvidence: Array<{ file: string; line: number; detail: string }> = [];
    for (const f of ctx.find(ROLE_FILE_RE)) {
      if (f.large || roleEvidence.length >= MAX_ROLE_EVIDENCE) continue;
      const defs = await ctx.fact(f.path, roleDefsFact);
      if (!defs) continue;
      for (const [name, line] of defs) {
        roleEvidence.push({ file: f.path, line, detail: `definition "${name}"` });
        if (roleEvidence.length >= MAX_ROLE_EVIDENCE) break;
      }
    }
    for (const e of model.dbEntities) {
      if (/^(roles?|permissions?|user_roles?|role_permissions?)$/i.test(e.name)) roleEvidence.push({ file: e.file, line: e.provenance.evidence[0]?.line ?? 1, detail: `database entity "${e.name}"` });
    }
    if (roleEvidence.length) {
      model.auth.push({ name: 'Role/permission definitions', kind: 'middleware', provenance: detected('code', roleEvidence, 'medium') });
    }
  },
};
