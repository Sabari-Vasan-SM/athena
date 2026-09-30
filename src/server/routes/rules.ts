import { AthenaError } from '../../services/errors.js';
import { getRules, rulesAdd, rulesRemove, rulesUpdate } from '../../services/rules.js';
import type { ServerContext } from '../context.js';

/** rules.md: list, add, edit/enable/disable, delete (all with optimistic concurrency). */
export function registerRulesRoutes({ app, root, events, recentWrites }: ServerContext): void {
  const ruleAfter = (message: string) => {
    events.emit({ source: 'web-ui', type: 'rules.changed', level: 'success', message });
  };
  app.get('/api/rules', async () => getRules(root));
  app.post<{ Body: { section: string; text: string; baseHash?: string } }>(
    '/api/rules',
    { schema: { body: { type: 'object', required: ['section', 'text'], additionalProperties: false, properties: { section: { type: 'string', maxLength: 200 }, text: { type: 'string', maxLength: 1000 }, baseHash: { type: 'string' } } } } },
    async (req) => {
      const v = await rulesAdd(root, req.body.baseHash, req.body.section, req.body.text);
      recentWrites.set('rules.md', v.hash);
      ruleAfter(`Added rule to "${req.body.section}"`);
      return v;
    },
  );
  app.patch<{ Params: { index: string }; Body: { text?: string; enabled?: boolean; baseHash: string } }>(
    '/api/rules/:index',
    { schema: { body: { type: 'object', required: ['baseHash'], additionalProperties: false, properties: { text: { type: 'string', maxLength: 1000 }, enabled: { type: 'boolean' }, baseHash: { type: 'string' } } } } },
    async (req) => {
      const index = parseIndex(req.params.index);
      const v = await rulesUpdate(root, req.body.baseHash, index, { text: req.body.text, enabled: req.body.enabled });
      recentWrites.set('rules.md', v.hash);
      ruleAfter(req.body.enabled === undefined ? `Edited rule #${index}` : `${req.body.enabled ? 'Enabled' : 'Disabled'} rule #${index}`);
      return v;
    },
  );
  app.delete<{ Params: { index: string }; Querystring: { baseHash?: string } }>('/api/rules/:index', async (req) => {
    const index = parseIndex(req.params.index);
    if (!req.query.baseHash) throw new AthenaError('baseHash is required');
    const v = await rulesRemove(root, req.query.baseHash, index);
    recentWrites.set('rules.md', v.hash);
    ruleAfter(`Deleted rule #${index}`);
    return v;
  });
}

function parseIndex(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new AthenaError(`Invalid rule index: ${raw.slice(0, 20)}`);
  return n;
}
