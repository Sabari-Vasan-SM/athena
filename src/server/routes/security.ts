import { SCAN_FILE } from '../../core/model/security-scan.js';
import { AthenaError } from '../../services/errors.js';
import { runSecurityScan, saveScan, type SecurityScan } from '../../services/security.js';
import type { ServerContext } from '../context.js';

/** Last security scan, and starting a new one in the background. */
export function registerSecurityRoutes(ctx: ServerContext): void {
  const { app, root, events, state, session } = ctx;

  app.get('/api/security', async () => ({ scan: await session.scan(), running: state.scanRunning }));

  app.post<{ Body: { skipAudit?: boolean } }>(
    '/api/security/scan',
    { schema: { body: { type: 'object', additionalProperties: false, properties: { skipAudit: { type: 'boolean' } } } } },
    async (req, reply) => {
      if (state.scanRunning) throw new AthenaError('A security scan is already running.', undefined, 1, 'busy');
      state.scanRunning = true;
      // Until the background scan owns the flag, any throw (e.g. model.json missing) must release it.
      let handedOff = false;
      try {
        const model = await session.requireModel();
        events.emit({ source: 'web-ui', type: 'security.started', level: 'info', message: 'Security scan started' });
        events.setActivity({ state: 'REVIEWING', actor: 'athena', task: 'Scanning dependencies', reading: [] });
        handedOff = true;
        void runSecurityScan(root, model, { skipAudit: req.body?.skipAudit, onTool: (tool) => events.setActivity({ state: 'REVIEWING', actor: 'athena', task: `Running ${tool}`, reading: [] }) })
          .then(async (scan: SecurityScan) => {
            await saveScan(root, scan);
            await session.remember(SCAN_FILE, scan);
            const findings = scan.tools.reduce((n, t) => n + t.findings.length, 0);
            events.emit({
              source: 'athena',
              type: 'security.completed',
              level: findings || scan.secrets.count ? 'warn' : 'success',
              message: `Security scan finished — ${findings} dependency finding(s), ${scan.secrets.count} potential secret(s)`,
              data: { findings, secrets: scan.secrets.count },
            });
            events.setActivity({ state: 'SUCCESS', actor: 'athena', task: 'Security scan complete', reading: [] }, 4000);
            ctx.replanSoon();
          })
          .catch((err: Error) => {
            events.emit({ source: 'athena', type: 'security.failed', level: 'error', message: `Security scan failed: ${err.message}` });
            events.setActivity({ state: 'ERROR', actor: 'athena', task: 'Security scan failed', reading: [] }, 8000);
          })
          .finally(() => {
            state.scanRunning = false;
          });
      } finally {
        if (!handedOff) state.scanRunning = false;
      }
      return reply.code(202).send({ accepted: true });
    },
  );
}
