import type { Detector } from '../context.js';

const EXT_LANG: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', kts: 'Kotlin',
  scala: 'Scala', swift: 'Swift', m: 'Objective-C', mm: 'Objective-C',
  c: 'C', h: 'C/C++ header', cc: 'C++', cpp: 'C++', cxx: 'C++', hpp: 'C++',
  cs: 'C#', fs: 'F#', vb: 'Visual Basic', php: 'PHP', rb: 'Ruby', dart: 'Dart',
  ex: 'Elixir', exs: 'Elixir', erl: 'Erlang', clj: 'Clojure', hs: 'Haskell',
  lua: 'Lua', r: 'R', jl: 'Julia', zig: 'Zig', sol: 'Solidity',
  vue: 'Vue', svelte: 'Svelte', astro: 'Astro',
  html: 'HTML', css: 'CSS', scss: 'SCSS', sass: 'Sass', less: 'Less',
  sql: 'SQL', sh: 'Shell', bash: 'Shell', zsh: 'Shell', ps1: 'PowerShell',
  tf: 'Terraform', hcl: 'HCL', proto: 'Protocol Buffers', graphql: 'GraphQL', gql: 'GraphQL',
  prisma: 'Prisma',
};

export const structureDetector: Detector = {
  id: 'structure',
  version: 1,
  async run(ctx) {
    const langs = new Map<string, { files: number; bytes: number }>();
    const top = new Set<string>();
    for (const f of ctx.files) {
      const slash = f.path.indexOf('/');
      if (slash > 0) top.add(f.path.slice(0, slash));
      if (f.binary) continue;
      const dot = f.path.lastIndexOf('.');
      if (dot === -1 || dot < f.path.lastIndexOf('/')) continue;
      const lang = EXT_LANG[f.path.slice(dot + 1).toLowerCase()];
      if (!lang) continue;
      const cur = langs.get(lang) ?? { files: 0, bytes: 0 };
      cur.files++;
      cur.bytes += f.size;
      langs.set(lang, cur);
    }
    ctx.model.languages = [...langs.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
    ctx.model.topLevelDirs = [...top].sort();
  },
};
