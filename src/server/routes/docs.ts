import { docAtRevision, docHistory, listDocs, readDoc, saveDoc, searchDocs } from '../../services/knowledge.js';
import type { ServerContext } from '../context.js';

/** Knowledge documents: list, read, save (with conflict detection), history and search. */
export function registerDocsRoutes(ctx: ServerContext): void {
  const { app, root, events } = ctx;

  app.get('/api/docs', async () => {
    const [docs, status] = await Promise.all([listDocs(root), ctx.getStatus().catch(() => null)]);
    const affected = new Map(status?.affectedDocuments.map((a) => [a.file, a.reasons]) ?? []);
    return docs.map((d) => ({ ...d, sync: syncState(d.id, d.present, affected.get(d.file)), affectedBy: affected.get(d.file) ?? [] }));
  });

  const withSync = async <T extends { id: string; file: string }>(doc: T) => {
    const status = await ctx.getStatus().catch(() => null);
    const reasons = status?.affectedDocuments.find((a) => a.file === doc.file)?.reasons;
    return { ...doc, sync: syncState(doc.id, true, reasons), affectedBy: reasons ?? [] };
  };

  app.get<{ Params: { id: string } }>('/api/docs/:id', async (req) => withSync(await readDoc(root, req.params.id)));

  app.put<{ Params: { id: string }; Body: { content: string; baseHash: string | null } }>(
    '/api/docs/:id',
    { schema: { body: { type: 'object', required: ['content', 'baseHash'], additionalProperties: false, properties: { content: { type: 'string' }, baseHash: { type: ['string', 'null'] } } } } },
    async (req) => {
      const doc = await saveDoc(root, req.params.id, req.body.content, req.body.baseHash);
      ctx.recentWrites.set(doc.file, doc.hash!);
      ctx.invalidateStatus();
      events.emit({ source: 'web-ui', type: 'knowledge.saved', level: 'success', message: `Saved ${doc.file}`, data: { file: doc.file } });
      ctx.replanSoon();
      return withSync(doc);
    },
  );

  app.get<{ Params: { id: string } }>('/api/docs/:id/history', async (req) => docHistory(root, req.params.id));
  app.get<{ Params: { id: string; sha: string } }>('/api/docs/:id/history/:sha', async (req) => ({ content: await docAtRevision(root, req.params.id, req.params.sha) }));

  app.get<{ Querystring: { q?: string } }>('/api/search', async (req) => searchDocs(root, String(req.query.q ?? '').slice(0, 200)));
}

export function syncState(id: string, present: boolean, affectedReasons: string[] | undefined): 'missing' | 'developer-owned' | 'synchronized' | 'may-be-outdated' {
  if (!present) return 'missing';
  if (id === 'rules') return 'developer-owned';
  return affectedReasons?.length ? 'may-be-outdated' : 'synchronized';
}
