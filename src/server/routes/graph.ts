import { AthenaError } from '../../services/errors.js';
import { graphSummary, refreshGraph } from '../../services/context.js';
import type { ServerContext } from '../context.js';

/** Project graph summary and rebuilding it. */
export function registerGraphRoutes({ app, root, events, state }: ServerContext): void {
  app.get('/api/graph', async () => ({ ...(await graphSummary(root)), building: state.graphBuilding }));

  app.post('/api/graph/build', async () => {
    if (state.graphBuilding) throw new AthenaError('The graph is already being built.', undefined, 1, 'busy');
    state.graphBuilding = true;
    try {
      const graph = await refreshGraph(root);
      events.emit({ source: 'web-ui', type: 'graph.built', level: 'success', message: `Project graph built: ${graph.stats.nodes} nodes, ${graph.stats.edges} relationships` });
      return { built: true, builtAt: graph.builtAt, stats: graph.stats };
    } finally {
      state.graphBuilding = false;
    }
  });
}
