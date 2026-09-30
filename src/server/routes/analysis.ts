import { AthenaError } from '../../services/errors.js';
import { runPipeline } from '../../services/pipeline.js';
import type { ServerContext } from '../context.js';

const STAGE_LABELS: Record<string, string> = { scan: 'Scanning files', detect: 'Detecting technologies, schema and routes', git: 'Reading Git metadata', write: 'Writing knowledge', agents: 'Updating agent integrations' };

/** POST /api/analyze: full re-analysis in the background (202), progress over events. */
export function registerAnalysisRoutes(ctx: ServerContext): void {
  const { app, root, events, state } = ctx;
  app.post<{ Body: { force?: boolean } }>(
    '/api/analyze',
    { schema: { body: { type: 'object', additionalProperties: false, properties: { force: { type: 'boolean' } } } } },
    async (req, reply) => {
      if (state.analysisRunning) throw new AthenaError('An analysis is already running.', undefined, 1, 'busy');
      state.analysisRunning = true;
      const started = Date.now();
      events.setActivity({ state: 'ANALYZING', actor: 'athena', task: 'Analyzing project', reading: [] });
      events.emit({ source: 'athena', type: 'analysis.started', level: 'info', message: 'Analysis started (requested from web UI)' });
      // Exclusive: no sync plan runs while the analysis rewrites state and the index.
      void ctx.scheduler
        .exclusive(() =>
          runPipeline({
            root,
            mode: 'analyze',
            force: req.body?.force,
            onStage: (stage) => {
              if (STAGE_LABELS[stage]) events.setActivity({ state: 'ANALYZING', actor: 'athena', task: STAGE_LABELS[stage]!, reading: [] });
            },
          }),
        )
        .then((result) => {
          for (const d of result.docs) ctx.recentWrites.set(d.file, d.contentHash);
          const changed = result.docs.filter((d) => d.status !== 'unchanged').map((d) => d.file);
          const preserved = result.docs.filter((d) => d.preservedModified.length).map((d) => d.file);
          ctx.invalidateStatus();
          state.currentPlan = null;
          events.emit({
            source: 'athena',
            type: 'analysis.completed',
            level: 'success',
            message: `Analysis completed in ${((Date.now() - started) / 1000).toFixed(1)}s — ${changed.length ? `updated ${changed.join(', ')}` : 'knowledge already up to date'}`,
            data: { changed, preserved, filesScanned: result.analysis.model.stats.filesScanned, warnings: result.analysis.model.warnings.length },
          });
          events.setActivity({ state: 'SUCCESS', actor: 'athena', task: 'Analysis complete', reading: [] }, 4000);
        })
        .catch((err: Error) => {
          events.emit({ source: 'athena', type: 'analysis.failed', level: 'error', message: `Analysis failed: ${err.message}` });
          events.setActivity({ state: 'ERROR', actor: 'athena', task: 'Analysis failed', reading: [] }, 8000);
        })
        .finally(() => {
          state.analysisRunning = false;
        });
      return reply.code(202).send({ accepted: true });
    },
  );
}
