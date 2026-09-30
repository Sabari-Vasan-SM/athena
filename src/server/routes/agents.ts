import { configureAgents, listAgents, removeAgents } from '../../services/agents.js';
import type { ServerContext } from '../context.js';

const agentsBody = { schema: { body: { type: 'object', required: ['agents'], additionalProperties: false, properties: { agents: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 40 } } } } } };

/** AI agent integrations: list, configure, remove. */
export function registerAgentRoutes({ app, root, events }: ServerContext): void {
  app.get('/api/agents', async () => listAgents(root));
  app.post<{ Body: { agents: string[] } }>('/api/agents/configure', agentsBody, async (req) => {
    const r = await configureAgents(root, req.body.agents);
    events.emit({ source: 'web-ui', type: 'agents.configured', level: 'success', message: `Configured ${r.map((x) => x.id).join(', ')}`, data: { files: r.flatMap((x) => x.files.map((f) => f.path)) } });
    return listAgents(root);
  });
  app.post<{ Body: { agents: string[] } }>('/api/agents/remove', agentsBody, async (req) => {
    const removed = await removeAgents(root, req.body.agents);
    events.emit({ source: 'web-ui', type: 'agents.removed', level: 'info', message: `Removed ${req.body.agents.join(', ')} integration${removed.length ? ` (${removed.join(', ')})` : ''}` });
    return listAgents(root);
  });
}
