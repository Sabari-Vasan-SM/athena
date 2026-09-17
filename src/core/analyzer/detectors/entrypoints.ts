import type { Detector } from '../context.js';
import { inferred } from '../../model/fact.js';

const CONVENTIONAL = /(^|\/)(src\/)?(main|index|server|app|cli)\.(m|c)?(t|j)sx?$|(^|\/)(main|app|wsgi|asgi|manage|__main__)\.py$|(^|\/)(cmd\/[^/]+\/)?main\.go$|(^|\/)src\/(main|lib)\.rs$|(^|\/)Program\.cs$|(^|\/)[A-Za-z]+Application\.(java|kt)$|(^|\/)lib\/main\.dart$|(^|\/)public\/index\.php$|(^|\/)config\.ru$/;

export const entryPointsDetector: Detector = {
  id: 'entrypoints',
  version: 1,
  async run(ctx) {
    const known = new Set(ctx.model.entryPoints.map((e) => e.path));
    const candidates = ctx.find((f) => CONVENTIONAL.test(f.path) && f.path.split('/').length <= 5 && !/(^|\/)(test|tests|__tests__|examples?|fixtures?)\//.test(f.path));
    for (const f of candidates.slice(0, 30)) {
      if (known.has(f.path)) continue;
      ctx.model.entryPoints.push({ path: f.path, provenance: inferred('filesystem', [{ file: f.path, detail: 'conventional entry-point file name' }], 'medium') });
    }
  },
};
