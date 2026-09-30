import { KNOWLEDGE_DOCS, RELEVANCE_MAP } from '../../core/knowledge/documents.js';
import { aiStatus } from '../../services/ai.js';
import { runDoctor } from '../../services/doctor.js';
import { getOverview } from '../../services/overview.js';
import { ATHENA_VERSION } from '../../services/version.js';
import type { ServerContext } from '../context.js';

/** Health, session info, overview, status, doctor and AI status. */
export function registerSessionRoutes({ app, root, instanceId, getStatus }: ServerContext): void {
  app.get('/api/health', async () => ({ ok: true, instanceId, version: ATHENA_VERSION }));
  app.get('/api/session', async () => ({ ok: true, instanceId, version: ATHENA_VERSION, root, docs: KNOWLEDGE_DOCS, relevanceMap: RELEVANCE_MAP }));

  app.get('/api/overview', async () => getOverview(root));
  app.get('/api/status', async () => getStatus());
  app.get('/api/doctor', async () => runDoctor(root));
  app.get('/api/ai', async () => aiStatus(root));
}
