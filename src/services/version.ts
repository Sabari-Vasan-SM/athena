import { createRequire } from 'node:module';

/** Must match package.json "name" — the version lookup checks it to avoid reading the wrong manifest. */
export const PACKAGE_NAME = 'project-athena';

function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    // dist/cli.js → ../package.json ; src/cli/version.ts (tests) → ../../package.json
    for (const p of ['../package.json', '../../package.json']) {
      try {
        const pkg = require(p) as { name?: string; version?: string };
        if (pkg.name === PACKAGE_NAME && pkg.version) return pkg.version;
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
