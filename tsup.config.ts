import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli/index.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  // No clean: tsup overwrites cli.js itself, and cleaning would delete the Vite-built UI in dist/web.
  clean: false,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
});
