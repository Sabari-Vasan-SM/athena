import { parse as babelParse } from '@babel/parser';
import type { AnalysisContext, Detector, FactDef } from '../context.js';
import type { Route } from '../../model/project-model.js';
import { detected } from '../../model/fact.js';

const HTTP = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all'];
const MAX_ROUTES = 5000;

type Node = { type: string; [k: string]: unknown };
const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && typeof (v as Node).type === 'string';

function walk(node: unknown, visit: (n: Node, parent: Node | null) => void, parent: Node | null = null): void {
  if (Array.isArray(node)) {
    for (const c of node) walk(c, visit, parent);
    return;
  }
  if (!isNode(node)) return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key === 'comments' || key === 'leadingComments' || key === 'trailingComments') continue;
    const v = node[key];
    if (typeof v === 'object' && v !== null) walk(v, visit, node);
  }
}

function strValue(n: unknown): string | null {
  if (!isNode(n)) return null;
  if (n.type === 'StringLiteral') return n.value as string;
  if (n.type === 'TemplateLiteral' && Array.isArray(n.quasis) && n.quasis.length === 1) return ((n.quasis[0] as Node).value as { cooked: string }).cooked;
  return null;
}

const lineOf = (n: Node): number | undefined => (n.loc as { start?: { line: number } } | undefined)?.start?.line;

function jsRoutes(file: string, text: string, framework: string): Route[] {
  let ast: unknown;
  try {
    ast = babelParse(text, { sourceType: 'unambiguous', errorRecovery: true, plugins: ['typescript', 'jsx', 'decorators'] as never });
  } catch {
    return [];
  }
  const routes: Route[] = [];
  const prov = (line?: number) => detected('code', [{ file, line }], 'high');

  walk(ast, (n) => {
    // app.get('/path', ...) / router.post(...) / fastify.get(...) / hono.get(...)
    if (n.type === 'CallExpression' && isNode(n.callee) && n.callee.type === 'MemberExpression' && isNode(n.callee.property) && n.callee.property.type === 'Identifier') {
      const method = (n.callee.property.name as string).toLowerCase();
      const args = n.arguments as unknown[];
      if (HTTP.includes(method) && args.length >= 2) {
        const p = strValue(args[0]);
        if (p !== null && (p.startsWith('/') || p === '*')) routes.push({ method: method.toUpperCase(), path: p, framework, file, line: lineOf(n), provenance: prov(lineOf(n)) });
      }
      // fastify.route({ method: 'GET', url: '/x' })
      if (method === 'route' && isNode(args[0]) && args[0].type === 'ObjectExpression') {
        let m: string | null = null;
        let u: string | null = null;
        for (const prop of args[0].properties as Node[]) {
          const k = isNode(prop.key) ? ((prop.key.name as string) ?? (prop.key.value as string)) : null;
          if (k === 'method') m = strValue(prop.value);
          if (k === 'url' || k === 'path') u = strValue(prop.value);
        }
        if (m && u) routes.push({ method: m.toUpperCase(), path: u, framework, file, line: lineOf(n), provenance: prov(lineOf(n)) });
      }
    }
    // NestJS: @Controller('prefix') class { @Get('x') method() {} }
    if ((n.type === 'ClassDeclaration' || n.type === 'ClassExpression') && Array.isArray(n.decorators)) {
      let prefix: string | null = null;
      for (const d of n.decorators as Node[]) {
        const expr = d.expression as Node;
        if (expr?.type === 'CallExpression' && isNode(expr.callee) && expr.callee.name === 'Controller') {
          const a = (expr.arguments as unknown[])[0];
          prefix = strValue(a) ?? (isNode(a) && a.type === 'ObjectExpression' ? null : '');
        }
      }
      if (prefix === null) return;
      const body = (n.body as Node).body as Node[];
      for (const member of body) {
        for (const d of (member.decorators as Node[] | undefined) ?? []) {
          const expr = d.expression as Node;
          if (expr?.type !== 'CallExpression' || !isNode(expr.callee)) continue;
          const name = expr.callee.name as string;
          if (!['Get', 'Post', 'Put', 'Patch', 'Delete', 'Options', 'Head', 'All'].includes(name)) continue;
          const sub = strValue((expr.arguments as unknown[])[0]) ?? '';
          const full = `/${[prefix, sub].filter(Boolean).join('/')}`.replace(/\/+/g, '/');
          routes.push({ method: name.toUpperCase(), path: full, framework: 'NestJS', file, line: lineOf(d), provenance: prov(lineOf(d)) });
        }
      }
    }
  });
  return routes;
}

/** A route found in one file, without the file: [method, path, line]. */
type RouteRow = [string, string, number | null];
/** Like RouteRow, with the framework the route was attributed to. */
type JsRouteRow = [string, string, string, number | null];

function regexRoutes(text: string, re: RegExp, pick: (m: RegExpMatchArray) => { method: string; path: string } | null): RouteRow[] {
  const out: RouteRow[] = [];
  for (const m of text.matchAll(re)) {
    const r = pick(m);
    if (!r) continue;
    const line = text.slice(0, m.index).split('\n').length;
    out.push([r.method, r.path, line]);
  }
  return out;
}

const toRoutes = (file: string, framework: string, rows: RouteRow[] | null): Route[] =>
  (rows ?? []).map(([method, path, line]) => ({ method, path, framework, file, line: line ?? undefined, provenance: detected('code', [{ file, line: line ?? undefined }], 'medium') }));

const JS_RE = /\.(m|c)?(t|j)sx?$/;
const JS_FRAMEWORKS = ['Express', 'Fastify', 'Koa', 'Hono', 'NestJS'];

/** JS/TS routes from the AST. Babel parsing is expensive, so this is only computed eagerly when a JS server framework is declared. */
const jsRoutesFact: FactDef<JsRouteRow[] | false> = {
  id: 'routes-js',
  applies: (f) => JS_RE.test(f.path) && !f.large && !/\.(test|spec|d)\.[cm]?[jt]sx?$/.test(f.path),
  when: (hints) => JS_FRAMEWORKS.some((n) => hints.frameworks.has(n)),
  compute(text, rel) {
    if (!text || !/\b(express|fastify|hono|koa|@nestjs\/common|Router)\b/.test(text)) return false;
    const guess = /@nestjs\/common/.test(text) ? 'NestJS' : /\bfastify\b/i.test(text) ? 'Fastify' : /\bhono\b/.test(text) ? 'Hono' : /\bkoa\b/.test(text) ? 'Koa' : 'Express';
    return jsRoutes(rel, text, guess).map((r): JsRouteRow => [r.method, r.path, r.framework, r.line ?? null]);
  },
};

const NEXT_APP_RE = /(^|\/)(src\/)?app\/(.+\/)?route\.(t|j)sx?$/;
const nextRouteFact: FactDef<Array<[string, number]>> = {
  id: 'routes-next-app',
  applies: (f) => NEXT_APP_RE.test(f.path),
  compute(text) {
    const out: Array<[string, number]> = [];
    if (!text) return out;
    for (const m of text.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)) out.push([m[1]!, text.slice(0, m.index).split('\n').length]);
    return out;
  },
};

async function nextRoutes(ctx: AnalysisContext): Promise<Route[]> {
  const out: Route[] = [];
  for (const f of ctx.find(NEXT_APP_RE)) {
    const rows = await ctx.fact(f.path, nextRouteFact);
    if (!rows) continue;
    const seg = /(?:^|\/)(?:src\/)?app\/(.*)route\.(?:t|j)sx?$/.exec(f.path)?.[1] ?? '';
    const urlPath = `/${seg.replace(/\/$/, '')}`.split('/').filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@')).join('/') || '/';
    for (const [method, line] of rows) out.push({ method, path: urlPath, framework: 'Next.js (app router)', file: f.path, line, provenance: detected('code', [{ file: f.path, line }]) });
  }
  for (const f of ctx.find(/(^|\/)(src\/)?pages\/api\/.+\.(t|j)sx?$/)) {
    const seg = /(?:^|\/)(?:src\/)?pages(\/api\/.+)\.(?:t|j)sx?$/.exec(f.path)?.[1] ?? '';
    out.push({ method: 'ANY', path: seg.replace(/\/index$/, ''), framework: 'Next.js (pages API)', file: f.path, provenance: detected('filesystem', [{ file: f.path }]) });
  }
  return out;
}

const pyRoutesFact: FactDef<RouteRow[]> = {
  id: 'routes-python',
  applies: (f) => /\.py$/.test(f.path),
  compute(text) {
    if (!text || !/@\w+\.(get|post|put|patch|delete|route|api_route)\(/.test(text)) return [];
    return regexRoutes(text, /@(\w+)\.(get|post|put|patch|delete|options|head|route|api_route)\(\s*["']([^"']*)["']([^\n]*)/g, (m) => {
      const verb = m[2]!;
      if (verb === 'route' || verb === 'api_route') {
        const methods = /methods\s*=\s*\[([^\]]+)\]/.exec(m[4]!)?.[1]?.replace(/["'\s]/g, '').toUpperCase();
        return { method: methods || 'GET', path: m[3]! };
      }
      return { method: verb.toUpperCase(), path: m[3]! };
    });
  },
};

const DJANGO_URLS_RE = /(^|\/)urls\.py$/;
const djangoRoutesFact: FactDef<RouteRow[]> = {
  id: 'routes-django',
  applies: (f) => DJANGO_URLS_RE.test(f.path),
  compute: (text) => (text ? regexRoutes(text, /\b(re_)?path\(\s*r?["']([^"']*)["']\s*,\s*([\w.]+)/g, (m) => ({ method: 'ANY', path: `/${m[2]!}` })) : []),
};

const JAVA_RE = /\.(java|kt)$/;
const springRoutesFact: FactDef<RouteRow[]> = {
  id: 'routes-spring',
  applies: (f) => JAVA_RE.test(f.path),
  compute(text) {
    if (!text || !/@(Get|Post|Put|Patch|Delete|Request)Mapping/.test(text)) return [];
    const prefix = /@RequestMapping\(\s*(?:value\s*=\s*|path\s*=\s*)?["']([^"']*)["']\s*\)\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public\s+)?(?:abstract\s+)?(?:class|interface)/.exec(text)?.[1] ?? '';
    return regexRoutes(text, /@(Get|Post|Put|Patch|Delete)Mapping(?:\(\s*(?:value\s*=\s*|path\s*=\s*)?\{?\s*["']([^"']*)["'])?/g, (m) => ({ method: m[1]!.toUpperCase(), path: `${prefix}${m[2] ?? ''}` || '/' }));
  },
};

const goRoutesFact: FactDef<RouteRow[]> = {
  id: 'routes-go',
  applies: (f) => /\.go$/.test(f.path) && !f.path.endsWith('_test.go'),
  compute(text) {
    if (!text) return [];
    return regexRoutes(text, /\.(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete|HandleFunc|Handle)\(\s*"([^"]+)"/g, (m) => {
      const verb = m[1]!;
      if (verb.startsWith('Handle')) {
        const sp = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/.*)$/.exec(m[2]!);
        if (sp) return { method: sp[1]!, path: sp[2]! };
        return m[2]!.startsWith('/') ? { method: 'ANY', path: m[2]! } : null;
      }
      return m[2]!.startsWith('/') ? { method: verb.toUpperCase(), path: m[2]! } : null;
    });
  },
};

/** Rust routes: Axum rows first, then Actix/Rocket rows (the order the detector pushes them). */
const rustRoutesFact: FactDef<{ axum: RouteRow[]; actix: RouteRow[] }> = {
  id: 'routes-rust',
  applies: (f) => /\.rs$/.test(f.path),
  compute(text) {
    if (!text) return { axum: [], actix: [] };
    return {
      axum: regexRoutes(text, /\.route\(\s*"([^"]+)"\s*,\s*(get|post|put|patch|delete)/g, (m) => ({ method: m[2]!.toUpperCase(), path: m[1]! })),
      actix: regexRoutes(text, /#\[(get|post|put|patch|delete)\(\s*"([^"]+)"/g, (m) => ({ method: m[1]!.toUpperCase(), path: m[2]! })),
    };
  },
};

const railsRoutesFact: FactDef<RouteRow[] | false> = {
  id: 'routes-rails',
  applies: (f) => f.path === 'config/routes.rb',
  compute(text) {
    if (!text) return false;
    return [
      ...regexRoutes(text, /^\s*(get|post|put|patch|delete)\s+["']([^"']+)["']/gm, (m) => ({ method: m[1]!.toUpperCase(), path: m[2]!.startsWith('/') ? m[2]! : `/${m[2]}` })),
      ...regexRoutes(text, /^\s*resources?\s+:(\w+)/gm, (m) => ({ method: 'RESOURCE', path: `/${m[1]}` })),
    ];
  },
};

const LARAVEL_RE = /(^|\/)routes\/[^/]+\.php$/;
const laravelRoutesFact: FactDef<RouteRow[]> = {
  id: 'routes-laravel',
  applies: (f) => LARAVEL_RE.test(f.path),
  compute: (text) => (text ? regexRoutes(text, /Route::(get|post|put|patch|delete|any|resource|apiResource)\(\s*["']([^"']+)["']/g, (m) => ({ method: m[1]!.toUpperCase(), path: m[2]!.startsWith('/') ? m[2]! : `/${m[2]}` })) : []),
};

const aspnetRoutesFact: FactDef<RouteRow[]> = {
  id: 'routes-aspnet',
  applies: (f) => /\.cs$/.test(f.path),
  compute(text) {
    if (!text) return [];
    const rows = regexRoutes(text, /\.Map(Get|Post|Put|Patch|Delete)\(\s*"([^"]+)"/g, (m) => ({ method: m[1]!.toUpperCase(), path: m[2]! }));
    if (/\[Http(Get|Post|Put|Patch|Delete)/.test(text)) {
      const prefix = /\[Route\(\s*"([^"]+)"\s*\)\]\s*(?:\[[^\]]+\]\s*)*public\s+(?:sealed\s+|partial\s+)*class/.exec(text)?.[1] ?? '';
      rows.push(...regexRoutes(text, /\[Http(Get|Post|Put|Patch|Delete)(?:\(\s*"([^"]*)"\s*\))?\]/g, (m) => ({ method: m[1]!.toUpperCase(), path: `/${[prefix, m[2] ?? ''].filter(Boolean).join('/')}` })));
    }
    return rows;
  },
};

export const routesDetector: Detector = {
  id: 'routes',
  version: 1,
  facts: [jsRoutesFact, nextRouteFact, pyRoutesFact, djangoRoutesFact, springRoutesFact, goRoutesFact, rustRoutesFact, railsRoutesFact, laravelRoutesFact, aspnetRoutesFact],
  async run(ctx) {
    const { model } = ctx;
    const routes: Route[] = [];
    const fw = new Set(model.frameworks.map((f) => f.name));
    const push = (rs: Route[]) => {
      for (const r of rs) if (routes.length < MAX_ROUTES) routes.push(r);
    };

    if (fw.has('Next.js')) push(await nextRoutes(ctx));
    if (!fw.has('Next.js') && (ctx.has('vercel.json') || fw.has('Vercel Functions (Node)'))) {
      // Vercel maps files in the root api/ directory to /api/<path> serverless functions.
      for (const f of ctx.find(/^api\/.+\.(m|c)?(t|j)s$/)) {
        if (/(^|\/)_|\.(test|spec|d)\./.test(f.path)) continue;
        const urlPath = `/${f.path.replace(/\.(m|c)?(t|j)s$/, '').replace(/\/index$/, '')}`;
        routes.push({ method: 'ANY', path: urlPath, framework: 'Vercel Functions', file: f.path, provenance: detected('filesystem', [{ file: f.path, detail: 'Vercel api/ directory convention' }], 'medium') });
      }
    }

    const jsFrameworks = JS_FRAMEWORKS.filter((n) => fw.has(n));
    if (jsFrameworks.length) {
      for (const f of ctx.find(JS_RE)) {
        if (f.large || /\.(test|spec|d)\.[cm]?[jt]sx?$/.test(f.path)) continue;
        const rows = await ctx.fact(f.path, jsRoutesFact);
        if (!rows) continue;
        push(rows.map(([method, path, framework, line]) => ({ method, path, framework, file: f.path, line: line ?? undefined, provenance: detected('code', [{ file: f.path, line: line ?? undefined }], 'high') })));
      }
    }

    const pyFw = ['FastAPI', 'Flask', 'Starlette', 'Litestar'].some((n) => fw.has(n));
    if (pyFw) {
      for (const f of ctx.find(/\.py$/)) push(toRoutes(f.path, fw.has('FastAPI') ? 'FastAPI' : 'Flask', await ctx.fact(f.path, pyRoutesFact)));
    }
    if (fw.has('Django')) {
      for (const f of ctx.find(DJANGO_URLS_RE)) push(toRoutes(f.path, 'Django', await ctx.fact(f.path, djangoRoutesFact)));
    }

    for (const f of ctx.find(JAVA_RE)) push(toRoutes(f.path, 'Spring', await ctx.fact(f.path, springRoutesFact)));

    for (const f of ctx.find(/\.go$/)) {
      if (f.path.endsWith('_test.go')) continue;
      push(toRoutes(f.path, 'Go', await ctx.fact(f.path, goRoutesFact)));
    }

    for (const f of ctx.find(/\.rs$/)) {
      const v = await ctx.fact(f.path, rustRoutesFact);
      if (!v) continue;
      push(toRoutes(f.path, 'Axum', v.axum));
      push(toRoutes(f.path, 'Actix/Rocket', v.actix));
    }

    if (ctx.has('config/routes.rb')) {
      const rows = await ctx.fact('config/routes.rb', railsRoutesFact);
      if (rows) push(toRoutes('config/routes.rb', 'Rails', rows));
    }
    for (const f of ctx.find(LARAVEL_RE)) push(toRoutes(f.path, 'Laravel', await ctx.fact(f.path, laravelRoutesFact)));
    for (const f of ctx.find(/\.cs$/)) push(toRoutes(f.path, 'ASP.NET Core', await ctx.fact(f.path, aspnetRoutesFact)));

    model.routes = routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
    if (routes.length >= MAX_ROUTES) ctx.warn(`Route listing truncated at ${MAX_ROUTES} entries.`);

    for (const f of ctx.find(/(^|\/)(openapi|swagger)[^/]*\.(json|ya?ml)$/i)) model.apiSpecs.push({ path: f.path, kind: 'openapi' });
    for (const f of ctx.find(/\.(graphql|gql)$/)) model.apiSpecs.push({ path: f.path, kind: 'graphql' });
    for (const f of ctx.find(/\.proto$/)) model.apiSpecs.push({ path: f.path, kind: 'grpc' });
  },
};
