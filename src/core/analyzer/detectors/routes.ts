import { parse as babelParse } from '@babel/parser';
import type { AnalysisContext, Detector } from '../context.js';
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

function regexRoutes(file: string, text: string, framework: string, re: RegExp, pick: (m: RegExpMatchArray) => { method: string; path: string } | null): Route[] {
  const out: Route[] = [];
  for (const m of text.matchAll(re)) {
    const r = pick(m);
    if (!r) continue;
    const line = text.slice(0, m.index).split('\n').length;
    out.push({ ...r, framework, file, line, provenance: detected('code', [{ file, line }], 'medium') });
  }
  return out;
}

async function nextRoutes(ctx: AnalysisContext): Promise<Route[]> {
  const out: Route[] = [];
  for (const f of ctx.find(/(^|\/)(src\/)?app\/(.+\/)?route\.(t|j)sx?$/)) {
    const text = await ctx.read(f.path);
    if (!text) continue;
    const seg = /(?:^|\/)(?:src\/)?app\/(.*)route\.(?:t|j)sx?$/.exec(f.path)?.[1] ?? '';
    const urlPath = `/${seg.replace(/\/$/, '')}`.split('/').filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@')).join('/') || '/';
    for (const m of text.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)) {
      const line = text.slice(0, m.index).split('\n').length;
      out.push({ method: m[1]!, path: urlPath, framework: 'Next.js (app router)', file: f.path, line, provenance: detected('code', [{ file: f.path, line }]) });
    }
  }
  for (const f of ctx.find(/(^|\/)(src\/)?pages\/api\/.+\.(t|j)sx?$/)) {
    const seg = /(?:^|\/)(?:src\/)?pages(\/api\/.+)\.(?:t|j)sx?$/.exec(f.path)?.[1] ?? '';
    out.push({ method: 'ANY', path: seg.replace(/\/index$/, ''), framework: 'Next.js (pages API)', file: f.path, provenance: detected('filesystem', [{ file: f.path }]) });
  }
  return out;
}

export const routesDetector: Detector = {
  id: 'routes',
  version: 1,
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

    const jsFrameworks = ['Express', 'Fastify', 'Koa', 'Hono', 'NestJS'].filter((n) => fw.has(n));
    if (jsFrameworks.length) {
      for (const f of ctx.find(/\.(m|c)?(t|j)sx?$/)) {
        if (f.large || /\.(test|spec|d)\.[cm]?[jt]sx?$/.test(f.path)) continue;
        const text = await ctx.read(f.path);
        if (!text || !/\b(express|fastify|hono|koa|@nestjs\/common|Router)\b/.test(text)) continue;
        const guess = /@nestjs\/common/.test(text) ? 'NestJS' : /\bfastify\b/i.test(text) ? 'Fastify' : /\bhono\b/.test(text) ? 'Hono' : /\bkoa\b/.test(text) ? 'Koa' : 'Express';
        push(jsRoutes(f.path, text, guess));
      }
    }

    const pyFw = ['FastAPI', 'Flask', 'Starlette', 'Litestar'].some((n) => fw.has(n));
    if (pyFw) {
      for (const f of ctx.find(/\.py$/)) {
        const text = await ctx.read(f.path);
        if (!text || !/@\w+\.(get|post|put|patch|delete|route|api_route)\(/.test(text)) continue;
        push(regexRoutes(f.path, text, fw.has('FastAPI') ? 'FastAPI' : 'Flask', /@(\w+)\.(get|post|put|patch|delete|options|head|route|api_route)\(\s*["']([^"']*)["']([^\n]*)/g, (m) => {
          const verb = m[2]!;
          if (verb === 'route' || verb === 'api_route') {
            const methods = /methods\s*=\s*\[([^\]]+)\]/.exec(m[4]!)?.[1]?.replace(/["'\s]/g, '').toUpperCase();
            return { method: methods || 'GET', path: m[3]! };
          }
          return { method: verb.toUpperCase(), path: m[3]! };
        }));
      }
    }
    if (fw.has('Django')) {
      for (const f of ctx.find(/(^|\/)urls\.py$/)) {
        const text = await ctx.read(f.path);
        if (text) push(regexRoutes(f.path, text, 'Django', /\b(re_)?path\(\s*r?["']([^"']*)["']\s*,\s*([\w.]+)/g, (m) => ({ method: 'ANY', path: `/${m[2]!}` })));
      }
    }

    const java = ctx.find(/\.(java|kt)$/);
    for (const f of java) {
      const text = await ctx.read(f.path);
      if (!text || !/@(Get|Post|Put|Patch|Delete|Request)Mapping/.test(text)) continue;
      const prefix = /@RequestMapping\(\s*(?:value\s*=\s*|path\s*=\s*)?["']([^"']*)["']\s*\)\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public\s+)?(?:abstract\s+)?(?:class|interface)/.exec(text)?.[1] ?? '';
      push(regexRoutes(f.path, text, 'Spring', /@(Get|Post|Put|Patch|Delete)Mapping(?:\(\s*(?:value\s*=\s*|path\s*=\s*)?\{?\s*["']([^"']*)["'])?/g, (m) => ({ method: m[1]!.toUpperCase(), path: `${prefix}${m[2] ?? ''}` || '/' })));
    }

    for (const f of ctx.find(/\.go$/)) {
      if (f.path.endsWith('_test.go')) continue;
      const text = await ctx.read(f.path);
      if (!text) continue;
      push(regexRoutes(f.path, text, 'Go', /\.(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete|HandleFunc|Handle)\(\s*"([^"]+)"/g, (m) => {
        const verb = m[1]!;
        if (verb.startsWith('Handle')) {
          const sp = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/.*)$/.exec(m[2]!);
          if (sp) return { method: sp[1]!, path: sp[2]! };
          return m[2]!.startsWith('/') ? { method: 'ANY', path: m[2]! } : null;
        }
        return m[2]!.startsWith('/') ? { method: verb.toUpperCase(), path: m[2]! } : null;
      }));
    }

    for (const f of ctx.find(/\.rs$/)) {
      const text = await ctx.read(f.path);
      if (!text) continue;
      push(regexRoutes(f.path, text, 'Axum', /\.route\(\s*"([^"]+)"\s*,\s*(get|post|put|patch|delete)/g, (m) => ({ method: m[2]!.toUpperCase(), path: m[1]! })));
      push(regexRoutes(f.path, text, 'Actix/Rocket', /#\[(get|post|put|patch|delete)\(\s*"([^"]+)"/g, (m) => ({ method: m[1]!.toUpperCase(), path: m[2]! })));
    }

    if (ctx.has('config/routes.rb')) {
      const text = await ctx.read('config/routes.rb');
      if (text) {
        push(regexRoutes('config/routes.rb', text, 'Rails', /^\s*(get|post|put|patch|delete)\s+["']([^"']+)["']/gm, (m) => ({ method: m[1]!.toUpperCase(), path: m[2]!.startsWith('/') ? m[2]! : `/${m[2]}` })));
        push(regexRoutes('config/routes.rb', text, 'Rails', /^\s*resources?\s+:(\w+)/gm, (m) => ({ method: 'RESOURCE', path: `/${m[1]}` })));
      }
    }
    for (const f of ctx.find(/(^|\/)routes\/[^/]+\.php$/)) {
      const text = await ctx.read(f.path);
      if (text) push(regexRoutes(f.path, text, 'Laravel', /Route::(get|post|put|patch|delete|any|resource|apiResource)\(\s*["']([^"']+)["']/g, (m) => ({ method: m[1]!.toUpperCase(), path: m[2]!.startsWith('/') ? m[2]! : `/${m[2]}` })));
    }
    for (const f of ctx.find(/\.cs$/)) {
      const text = await ctx.read(f.path);
      if (!text) continue;
      push(regexRoutes(f.path, text, 'ASP.NET Core', /\.Map(Get|Post|Put|Patch|Delete)\(\s*"([^"]+)"/g, (m) => ({ method: m[1]!.toUpperCase(), path: m[2]! })));
      if (/\[Http(Get|Post|Put|Patch|Delete)/.test(text)) {
        const prefix = /\[Route\(\s*"([^"]+)"\s*\)\]\s*(?:\[[^\]]+\]\s*)*public\s+(?:sealed\s+|partial\s+)*class/.exec(text)?.[1] ?? '';
        push(regexRoutes(f.path, text, 'ASP.NET Core', /\[Http(Get|Post|Put|Patch|Delete)(?:\(\s*"([^"]*)"\s*\))?\]/g, (m) => ({ method: m[1]!.toUpperCase(), path: `/${[prefix, m[2] ?? ''].filter(Boolean).join('/')}` })));
      }
    }

    model.routes = routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
    if (routes.length >= MAX_ROUTES) ctx.warn(`Route listing truncated at ${MAX_ROUTES} entries.`);

    for (const f of ctx.find(/(^|\/)(openapi|swagger)[^/]*\.(json|ya?ml)$/i)) model.apiSpecs.push({ path: f.path, kind: 'openapi' });
    for (const f of ctx.find(/\.(graphql|gql)$/)) model.apiSpecs.push({ path: f.path, kind: 'graphql' });
    for (const f of ctx.find(/\.proto$/)) model.apiSpecs.push({ path: f.path, kind: 'grpc' });
  },
};
