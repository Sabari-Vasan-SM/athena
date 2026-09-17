import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  plugins: [react()],
  base: '/',
  build: {
    outDir: path.resolve(import.meta.dirname, '../dist/web'),
    emptyOutDir: true,
    sourcemap: false,
    // Keep everything as separate files so the strict CSP (script-src 'self') holds.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    chunkSizeWarningLimit: 3000,
  },
  server: {
    // `npm run dev:web` proxies API calls to a running `athena open --port 7432 --no-open`.
    proxy: { '/api': 'http://127.0.0.1:7432' },
  },
});
