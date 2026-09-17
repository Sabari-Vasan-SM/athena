import type { AnalysisContext, Detector } from '../context.js';
import type { DbEntity } from '../../model/project-model.js';
import { detected } from '../../model/fact.js';
import { dirOf } from '../../util/paths.js';

async function prisma(ctx: AnalysisContext): Promise<DbEntity[]> {
  const out: DbEntity[] = [];
  for (const f of ctx.find(/\.prisma$/)) {
    const text = await ctx.read(f.path);
    if (!text) continue;
    const provider = /datasource\s+\w+\s*\{[^}]*provider\s*=\s*"([^"]+)"/.exec(text)?.[1];
    if (provider) ctx.model.databases.push({ name: `${provider} (Prisma datasource)`, kind: 'engine', provenance: detected('config', [{ file: f.path, detail: 'datasource provider' }]) });
    for (const m of text.matchAll(/^(model|view)\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
      const body = m[3]!;
      const fields: DbEntity['fields'] = [];
      const indexes: string[] = [];
      const relations: string[] = [];
      for (const raw of body.split('\n')) {
        const line = raw.replace(/\/\/.*$/, '').trim();
        if (!line) continue;
        if (line.startsWith('@@')) {
          indexes.push(line);
          continue;
        }
        const fm = /^(\w+)\s+([\w[\]?.()"]+)\s*(.*)$/.exec(line);
        if (!fm) continue;
        const attributes = [...fm[3]!.matchAll(/@[\w.]+(\([^)]*\))?/g)].map((a) => a[0]);
        fields.push({ name: fm[1]!, type: fm[2]!, attributes });
        const rel = attributes.find((a) => a.startsWith('@relation'));
        if (rel) relations.push(`${fm[1]} → ${fm[2]!.replace(/[[\]?]/g, '')}`);
      }
      const lineNo = text.slice(0, m.index).split('\n').length;
      out.push({ name: m[2]!, kind: 'model', fields, indexes, relations, file: f.path, provenance: detected('code', [{ file: f.path, line: lineNo }]) });
    }
  }
  return out;
}

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

async function sqlFiles(ctx: AnalysisContext): Promise<DbEntity[]> {
  const tables = new Map<string, DbEntity>();
  const files = ctx.find((f) => /\.sql$/i.test(f.path) && !f.large).slice(0, 2000);
  for (const f of files) {
    const raw = await ctx.read(f.path);
    if (!raw) continue;
    const text = stripSqlComments(raw);
    for (const m of text.matchAll(/CREATE\s+(?:UNLOGGED\s+|TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"[\]\w.]+)\s*\(([\s\S]*?)\)\s*;/gi)) {
      const name = m[1]!.replace(/[`"[\]]/g, '');
      const fields: DbEntity['fields'] = [];
      const relations: string[] = [];
      for (const col of splitTopLevel(m[2]!)) {
        const c = col.trim();
        const fk = /FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+([`"\w.]+)/i.exec(c);
        if (fk) {
          relations.push(`${fk[1]!.trim()} → ${fk[2]!.replace(/[`"]/g, '')}`);
          continue;
        }
        if (/^(CONSTRAINT|PRIMARY\s+KEY|UNIQUE|CHECK|INDEX|KEY)\b/i.test(c)) continue;
        const cm = /^([`"\w]+)\s+([\w]+(?:\s*\([^)]*\))?)(.*)$/s.exec(c);
        if (!cm) continue;
        const attrs: string[] = [];
        if (/PRIMARY\s+KEY/i.test(cm[3]!)) attrs.push('PRIMARY KEY');
        if (/NOT\s+NULL/i.test(cm[3]!)) attrs.push('NOT NULL');
        if (/\bUNIQUE\b/i.test(cm[3]!)) attrs.push('UNIQUE');
        const ref = /REFERENCES\s+([`"\w.]+)/i.exec(cm[3]!);
        if (ref) relations.push(`${cm[1]!.replace(/[`"]/g, '')} → ${ref[1]!.replace(/[`"]/g, '')}`);
        fields.push({ name: cm[1]!.replace(/[`"]/g, ''), type: cm[2]!, attributes: attrs });
      }
      const line = raw.slice(0, raw.indexOf(m[0].slice(0, 20))).split('\n').length;
      // Later migrations may redefine a table; keep the latest definition by path order.
      tables.set(name.toLowerCase(), { name, kind: 'table', fields, indexes: tables.get(name.toLowerCase())?.indexes ?? [], relations, file: f.path, provenance: detected('code', [{ file: f.path, line: line > 0 ? line : undefined }]) });
    }
    for (const m of text.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([`"\w.]+)\s+ON\s+([`"\w.]+)\s*(?:USING\s+\w+\s*)?\(([^)]*)\)/gi)) {
      const t = tables.get(m[3]!.replace(/[`"]/g, '').toLowerCase());
      if (t) t.indexes.push(`${m[1] ? 'UNIQUE ' : ''}${m[2]!.replace(/[`"]/g, '')} (${m[4]!.trim()})`);
    }
  }
  return [...tables.values()];
}

function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

async function djangoModels(ctx: AnalysisContext): Promise<DbEntity[]> {
  const out: DbEntity[] = [];
  for (const f of ctx.find(/(^|\/)models(\.py|\/[^/]+\.py)$/)) {
    const text = await ctx.read(f.path);
    if (!text || !/from django\.db import models|models\.Model/.test(text)) continue;
    const classRe = /^class\s+(\w+)\(([^)]*models\.Model[^)]*)\):\s*\n((?:[ \t]+.*\n|\s*\n)*)/gm;
    for (const m of text.matchAll(classRe)) {
      const fields: DbEntity['fields'] = [];
      const relations: string[] = [];
      for (const fm of m[3]!.matchAll(/^\s+(\w+)\s*=\s*models\.(\w+)\(([^)\n]*)/gm)) {
        fields.push({ name: fm[1]!, type: fm[2]!, attributes: [] });
        if (/ForeignKey|OneToOneField|ManyToManyField/.test(fm[2]!)) relations.push(`${fm[1]} → ${fm[3]!.split(',')[0]!.trim().replace(/["']/g, '')}`);
      }
      out.push({ name: m[1]!, kind: 'model', fields, indexes: [], relations, file: f.path, provenance: detected('code', [{ file: f.path, line: text.slice(0, m.index).split('\n').length }], 'medium') });
    }
  }
  return out;
}

async function sqlalchemyModels(ctx: AnalysisContext): Promise<DbEntity[]> {
  const out: DbEntity[] = [];
  if (!ctx.model.databases.some((d) => /SQLAlchemy|SQLModel/.test(d.name))) return out;
  for (const f of ctx.find(/\.py$/).slice(0, 5000)) {
    const text = await ctx.read(f.path);
    if (!text || !/__tablename__|table=True/.test(text)) continue;
    for (const m of text.matchAll(/^class\s+(\w+)\(([^)]*)\):\s*\n((?:[ \t]+.*\n|\s*\n)*)/gm)) {
      const body = m[3]!;
      const tn = /__tablename__\s*=\s*["'](\w+)["']/.exec(body)?.[1];
      if (!tn && !/table\s*=\s*True/.test(m[2]!)) continue;
      const fields = [...body.matchAll(/^\s+(\w+)\s*(?::\s*[^=\n]+)?=\s*(?:Column|mapped_column|Field)\(/gm)].map((fm) => ({ name: fm[1]!, attributes: [] as string[] }));
      out.push({ name: tn ?? m[1]!, kind: 'table', fields, indexes: [], relations: [], file: f.path, provenance: detected('code', [{ file: f.path, line: text.slice(0, m.index).split('\n').length }], 'medium') });
    }
  }
  return out;
}

async function mongooseModels(ctx: AnalysisContext): Promise<DbEntity[]> {
  if (!ctx.model.databases.some((d) => d.name === 'Mongoose')) return [];
  const out: DbEntity[] = [];
  for (const f of ctx.find(/\.(m|c)?(t|j)s$/).slice(0, 5000)) {
    const text = await ctx.read(f.path);
    if (!text || !text.includes('model(')) continue;
    for (const m of text.matchAll(/mongoose\.model\s*(?:<[^>]*>)?\(\s*["'](\w+)["']|\bmodel\s*(?:<[^>]*>)?\(\s*["'](\w+)["']\s*,/g)) {
      out.push({ name: (m[1] ?? m[2])!, kind: 'collection', fields: [], indexes: [], relations: [], file: f.path, provenance: detected('code', [{ file: f.path, line: text.slice(0, m.index).split('\n').length }], 'medium') });
    }
  }
  return out;
}

const MIGRATION_DIRS: Array<[RegExp, string]> = [
  [/(^|\/)prisma\/migrations\/[^/]+\/migration\.sql$/, 'Prisma Migrate'],
  [/(^|\/)drizzle\/[^/]*\.sql$/, 'Drizzle Kit'],
  [/(^|\/)alembic\/versions\/[^/]+\.py$|(^|\/)migrations\/versions\/[^/]+\.py$/, 'Alembic'],
  [/(^|\/)migrations\/\d{4}_[^/]+\.py$/, 'Django migrations'],
  [/(^|\/)db\/migrate\/[^/]+\.rb$/, 'Rails migrations'],
  [/(^|\/)db\/migration\/V\d+[^/]*\.sql$|(^|\/)resources\/db\/migration\/[^/]+\.sql$/, 'Flyway'],
  [/(^|\/)(db\/)?changelog\/[^/]+\.(xml|ya?ml|sql)$/, 'Liquibase'],
  [/(^|\/)database\/migrations\/[^/]+\.php$/, 'Laravel migrations'],
  [/(^|\/)Migrations\/\d+_[^/]+\.cs$/, 'EF Core migrations'],
  [/(^|\/)migrations\/[^/]+\.(up|down)\.sql$|(^|\/)migrations\/\d+[^/]*\.sql$/, 'SQL migrations'],
  [/(^|\/)priv\/repo\/migrations\/[^/]+\.exs$/, 'Ecto migrations'],
  [/(^|\/)supabase\/migrations\/[^/]+\.sql$/, 'Supabase migrations'],
];

export const databaseDetector: Detector = {
  id: 'database',
  version: 1,
  async run(ctx) {
    const { model } = ctx;
    const entities = [...(await prisma(ctx)), ...(await sqlFiles(ctx)), ...(await djangoModels(ctx)), ...(await sqlalchemyModels(ctx)), ...(await mongooseModels(ctx))];
    model.dbEntities = entities.sort((a, b) => a.name.localeCompare(b.name));

    const seen = new Set<string>();
    for (const [re, tool] of MIGRATION_DIRS) {
      const files = ctx.find(re).filter((f) => !seen.has(f.path));
      if (!files.length) continue;
      files.forEach((f) => seen.add(f.path));
      const byDir = new Map<string, number>();
      for (const f of files) {
        const d = tool === 'Prisma Migrate' ? dirOf(dirOf(f.path)) : dirOf(f.path);
        byDir.set(d, (byDir.get(d) ?? 0) + 1);
      }
      for (const [dir, count] of byDir) model.migrations.push({ path: dir, tool, count });
    }

    // Dedupe databases by name, merging evidence.
    const merged = new Map<string, (typeof model.databases)[number]>();
    for (const d of model.databases) {
      const cur = merged.get(d.name);
      if (cur) cur.provenance.evidence.push(...d.provenance.evidence);
      else merged.set(d.name, d);
    }
    model.databases = [...merged.values()];
  },
};
