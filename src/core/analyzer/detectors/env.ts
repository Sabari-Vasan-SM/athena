import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Detector } from '../context.js';
import { isSecretLikeName } from '../../security/secrets.js';

const TEMPLATE_ENV = /(^|\/)\.env\.(example|sample|template|dist|defaults)$|(^|\/)(example|sample)\.env$/;
const REAL_ENV_NAMES = ['.env', '.env.local', '.env.development', '.env.production', '.env.test', '.env.development.local', '.env.production.local'];

const CODE_REFS: Array<[RegExp, RegExp]> = [
  [/\.(m|c)?(t|j)sx?$/, /\b(?:process\.env|import\.meta\.env)\.([A-Z][A-Z0-9_]{1,})|process\.env\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]/g],
  [/\.py$/, /os\.(?:environ(?:\.get)?\s*[[(]\s*|getenv\s*\(\s*)["']([A-Z][A-Z0-9_]+)["']/g],
  [/\.go$/, /os\.(?:Getenv|LookupEnv)\(\s*"([A-Z][A-Z0-9_]+)"/g],
  [/\.rs$/, /env::var\(\s*"([A-Z][A-Z0-9_]+)"/g],
  [/\.rb$/, /ENV\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]|ENV\.fetch\(\s*["']([A-Z][A-Z0-9_]+)["']/g],
  [/\.php$/, /(?:getenv|env)\(\s*["']([A-Z][A-Z0-9_]+)["']/g],
  [/\.(java|kt)$/, /System\.getenv\(\s*"([A-Z][A-Z0-9_]+)"/g],
  [/\.cs$/, /GetEnvironmentVariable\(\s*"([A-Z][A-Z0-9_]+)"/g],
  [/\.dart$/, /fromEnvironment\(\s*'([A-Z][A-Z0-9_]+)'/g],
];

/**
 * Collects environment variable NAMES only. Values are never read into the model:
 * template files are parsed for keys; real .env files are only noted as present.
 */
export const envDetector: Detector = {
  id: 'env',
  version: 1,
  async run(ctx) {
    const vars = new Map<string, Set<string>>();
    const add = (name: string, ref: string) => {
      if (!vars.has(name)) vars.set(name, new Set());
      vars.get(name)!.add(ref);
    };

    for (const f of ctx.find(TEMPLATE_ENV)) {
      const text = await ctx.read(f.path);
      if (!text) continue;
      for (const m of text.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) add(m[1]!, f.path);
    }

    let scanned = 0;
    for (const [fileRe, refRe] of CODE_REFS) {
      for (const f of ctx.find(fileRe)) {
        if (f.large || f.binary || /(^|\/)(test|tests|__tests__|spec)\//.test(f.path)) continue;
        if (++scanned > 20_000) break;
        const text = await ctx.read(f.path);
        if (!text) continue;
        refRe.lastIndex = 0;
        for (const m of text.matchAll(refRe)) {
          const name = m[1] ?? m[2];
          if (name && name !== 'NODE_ENV') add(name, f.path);
        }
      }
    }

    // Real env files are frequently gitignored and therefore not walked; check for presence directly.
    const present = new Set<string>();
    for (const f of ctx.find(/(^|\/)\.env(\.[a-z.]+)?$/)) if (!TEMPLATE_ENV.test(f.path)) present.add(f.path);
    for (const name of REAL_ENV_NAMES) {
      try {
        const st = await fs.stat(path.join(ctx.root, name));
        if (st.isFile()) present.add(name);
      } catch {
        /* absent */
      }
    }

    ctx.model.env.vars = [...vars.entries()]
      .map(([name, refs]) => ({ name, references: [...refs].sort().slice(0, 10), secretLike: isSecretLikeName(name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    ctx.model.env.envFilesPresent = [...present].sort();
  },
};
