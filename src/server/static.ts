import { promises as fs } from 'node:fs';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export interface StaticAsset {
  abs: string;
  type: string;
  immutable: boolean;
}

/**
 * Build an allowlist of servable files at startup. Requests are looked up in this
 * map by exact URL path — request input is never joined into a filesystem path.
 */
export async function buildAssetMap(webDir: string): Promise<Map<string, StaticAsset> | null> {
  try {
    await fs.access(path.join(webDir, 'index.html'));
  } catch {
    return null;
  }
  const map = new Map<string, StaticAsset>();
  async function walk(dir: string): Promise<void> {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(abs);
      else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        const type = TYPES[ext];
        if (!type) continue;
        const urlPath = `/${path.relative(webDir, abs).split(path.sep).join('/')}`;
        map.set(urlPath, { abs, type, immutable: urlPath.startsWith('/assets/') });
      }
    }
  }
  await walk(webDir);
  return map;
}

export const MISSING_UI_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Athena</title></head>
<body style="font-family:system-ui;background:#0b0d10;color:#e6e8eb;padding:48px">
<h1>Athena web UI assets not found</h1>
<p>The API is running, but the UI has not been built. From the Athena repository run <code>npm run build</code>.</p>
</body></html>`;
