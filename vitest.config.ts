import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    testTimeout: 30_000,
    // Builds dist/ once; tests must not rebuild it (see tests/global-setup.ts).
    globalSetup: ['tests/global-setup.ts'],
  },
});
