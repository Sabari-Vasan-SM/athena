import type { Detector } from '../context.js';
import { scanText } from '../../security/secrets.js';

const SKIP = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock|poetry\.lock|uv\.lock|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock|pubspec\.lock)$|\.(min\.js|map|svg|snap)$/;
const MAX_FINDINGS = 500;

/**
 * Scans indexed text files for likely credentials. Only type, location and a short
 * fingerprint are recorded — never the value.
 */
export const secretsDetector: Detector = {
  id: 'secrets',
  version: 1,
  async run(ctx) {
    const findings = ctx.model.security.secrets;
    for (const f of ctx.files) {
      if (f.binary || f.large || SKIP.test(f.path)) continue;
      if (findings.length >= MAX_FINDINGS) {
        ctx.warn(`Secret scan stopped after ${MAX_FINDINGS} findings.`);
        break;
      }
      ctx.signal?.throwIfAborted();
      const text = await ctx.read(f.path);
      if (!text) continue;
      for (const m of scanText(text)) findings.push({ type: m.type, file: f.path, line: m.line, fingerprint: m.fingerprint });
    }
  },
};
