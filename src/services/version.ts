import { createRequire } from 'node:module';

function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    // dist/cli.js → ../package.json ; src/cli/version.ts (tests) → ../../package.json
    for (const p of ['../package.json', '../../package.json']) {
      try {
        const pkg = require(p) as { name?: string; version?: string };
        if (pkg.name === 'athena-cli' && pkg.version) return pkg.version;
      } catch {
        /* try next */
      }
    }
  } catch {
    /* fall through */
  }
  return '0.0.0-unknown';
}

export const ATHENA_VERSION = readVersion();
