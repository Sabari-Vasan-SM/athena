import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Build the CLI once, before any test file runs. Integration tests execute dist/cli.js,
 * and the build is code-split: rebuilding dist/ from several test files in parallel
 * (as they used to) rewrote chunks while other tests were loading them, which crashed
 * those CLI runs with half-written modules.
 */
export default async function setup(): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  await new Promise<void>((resolve, reject) =>
    execFile('npx', ['tsup'], { cwd: root, shell: process.platform === 'win32' }, (err, _out, stderr) => (err ? reject(new Error(`CLI build failed:\n${stderr}`)) : resolve())),
  );
}
