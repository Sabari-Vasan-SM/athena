import type { Detector } from '../context.js';
import { detected, inferred } from '../../model/fact.js';

/**
 * Auth libraries come from the dependency catalog. This detector adds structural
 * hints: auth-related files, middleware, and role/permission definitions.
 * Everything here is INFERRED unless the code pattern is unambiguous.
 */
export const authDetector: Detector = {
  id: 'auth',
  version: 1,
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

    for (const f of ctx.find(/(^|\/)(src\/)?middleware\.(t|j)s$/)) {
      const text = await ctx.read(f.path);
      if (text && /(auth|session|token|redirect\(.*login)/i.test(text)) {
        model.auth.push({ name: 'Next.js middleware referencing auth/session', kind: 'middleware', provenance: detected('code', [{ file: f.path }], 'medium') });
      }
    }

    // Role / permission definitions
    const roleEvidence: Array<{ file: string; line: number; detail: string }> = [];
    for (const f of ctx.find(/\.(prisma|ts|tsx|py|java|kt|cs|go|rb|php)$/)) {
      if (f.large || roleEvidence.length >= 10) continue;
      const text = await ctx.read(f.path);
      if (!text || !/role|permission/i.test(text)) continue;
      for (const m of text.matchAll(/\b(?:enum|class|type|interface)\s+(\w*(?:Role|Permission)s?)\b/g)) {
        roleEvidence.push({ file: f.path, line: text.slice(0, m.index).split('\n').length, detail: `definition "${m[1]}"` });
        if (roleEvidence.length >= 10) break;
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
