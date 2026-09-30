import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Detector, FactDef } from '../context.js';
import { isSecretLikeName } from '../../security/secrets.js';

const TEMPLATE_ENV = /(^|\/)\.env\.(example|sample|template|dist|defaults)$|(^|\/)(example|sample)\.env$/;
/** Local env files whose presence is recorded even when they are gitignored. */
export const REAL_ENV_NAMES = ['.env', '.env.local', '.env.development', '.env.production', '.env.test', '.env.development.local', '.env.production.local'];

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

const TEST_DIR = /(^|\/)(test|tests|__tests__|spec)\//;

/** Keys declared in a template env file (names only). */
const templateKeysFact: FactDef<string[]> = {
  id: 'env-template-keys',
  applies: (f) => TEMPLATE_ENV.test(f.path),
  compute(text) {
    if (!text) return [];
    return [...text.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map((m) => m[1]!);
  },
};

/** Env var names referenced from code, one fact per language pattern. */
const CODE_REF_FACTS: FactDef<string[]>[] = CODE_REFS.map(([fileRe, refRe], i) => ({
  id: `env-code-refs${i}`,
  applies: (f) => fileRe.test(f.path) && !f.large && !f.binary && !TEST_DIR.test(f.path),
  compute(text) {
    const out: string[] = [];
    if (!text) return out;
    refRe.lastIndex = 0;
    for (const m of text.matchAll(refRe)) {
      const name = m[1] ?? m[2];
      if (name && name !== 'NODE_ENV') out.push(name);
    }
    return out;
  },
}));

/**
 * Collects environment variable NAMES only. Values are never read into the model:
 * template files are parsed for keys; real .env files are only noted as present.
 */
export const envDetector: Detector = {
  id: 'env',
  version: 1,
  facts: [templateKeysFact, ...CODE_REF_FACTS],
  async run(ctx) {
    const vars = new Map<string, Set<string>>();
    const add = (name: string, ref: string) => {
      if (!vars.has(name)) vars.set(name, new Set());
      vars.get(name)!.add(ref);
    };

    for (const f of ctx.find(TEMPLATE_ENV)) {
      const keys = await ctx.fact(f.path, templateKeysFact);
      if (!keys) continue;
      for (const k of keys) add(k, f.path);
    }

    let scanned = 0;
    for (const [i, [fileRe]] of CODE_REFS.entries()) {
      for (const f of ctx.find(fileRe)) {
        if (f.large || f.binary || TEST_DIR.test(f.path)) continue;
        if (++scanned > 20_000) break;
        const names = await ctx.fact(f.path, CODE_REF_FACTS[i]!);
        if (!names) continue;
        for (const name of names) add(name, f.path);
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
