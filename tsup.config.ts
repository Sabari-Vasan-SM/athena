import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Options } from 'tsup';

type Plugin = NonNullable<Options['esbuildPlugins']>[number];

/**
 * Chunk names are content-hashed, so each build can leave the previous build's
 * chunks behind in dist/ (and they would ship in the npm package). After a
 * successful build, delete top-level dist/*.js(.map) files that this build did
 * not produce. Subdirectories — the Vite-built UI in dist/web — are never touched.
 */
const removeStaleChunks: Plugin = {
  name: 'remove-stale-chunks',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length || !result.outputFiles) return;
      const outDir = path.resolve(build.initialOptions.outdir ?? 'dist');
      const fresh = new Set(result.outputFiles.map((f) => path.resolve(f.path)));
      for (const entry of readdirSync(outDir, { withFileTypes: true })) {
        const file = path.join(outDir, entry.name);
        if (entry.isFile() && /\.js(\.map)?$/.test(entry.name) && !fresh.has(file)) rmSync(file, { force: true });
      }
    });
  },
};

export default defineConfig({
  entry: { cli: 'src/cli/index.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  // Code splitting: dist/cli.js stays a small entry (the bin, with the shebang), and
  // each command's code — and its dependencies — lives in chunks loaded on demand,
  // so `athena event` (run on every agent tool call) loads almost nothing.
  // Chunks are written next to cli.js in dist/, so paths resolved from
  // import.meta.url (package.json, dist/web) are unchanged.
  splitting: true,
  // No clean: cleaning would delete the Vite-built UI in dist/web. Stale chunks are
  // removed by the plugin above instead.
  clean: false,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  esbuildPlugins: [removeStaleChunks],
});
