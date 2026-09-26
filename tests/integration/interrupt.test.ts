import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { CLI, cleanupProjects, makeProject, runCli } from '../helpers.js';

afterAll(cleanupProjects);

async function largeProject(fileCount: number): Promise<string> {
  const dir = await makeProject({ 'package.json': JSON.stringify({ name: 'big', dependencies: { express: '5' } }) });
  const batch: Promise<void>[] = [];
  for (let i = 0; i < fileCount; i++) {
    const sub = path.join(dir, 'src', `m${i % 100}`);
    batch.push(fs.mkdir(sub, { recursive: true }).then(() => fs.writeFile(path.join(sub, `f${i}.ts`), `export const v${i} = ${i};\napp.get('/r${i}', h);\n`)));
    if (batch.length >= 500) await Promise.all(batch.splice(0));
  }
  await Promise.all(batch);
  return dir;
}

describe.skipIf(process.platform === 'win32')('interruption and scale', () => {
  it('Ctrl+C during init leaves no partial .athena', async () => {
    const dir = await largeProject(20_000);
    const child = spawn(process.execPath, [CLI, 'init', '--no-agents'], { cwd: dir, env: { ...process.env, NO_COLOR: '1', CI: '1' } });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    // Wait until the CLI has loaded (its first output) so the SIGINT handler is
    // installed; a fixed delay raced process startup on slower CI runners.
    await new Promise<void>((resolve) => {
      child.stdout.once('data', () => resolve());
      child.once('exit', () => resolve());
    });
    child.kill('SIGINT');
    const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
    const entries = await fs.readdir(dir);
    // Either it was interrupted cleanly, or it finished before the signal — never partial.
    if (code === 130) {
      expect(entries.filter((e) => e.startsWith('.athena'))).toEqual([]);
      expect(stderr).toContain('Interrupted');
    } else {
      expect(code).toBe(0);
      expect(entries).toContain('.athena');
      expect(entries.filter((e) => e.startsWith('.athena.tmp'))).toEqual([]);
    }
  }, 120_000);

  it('analyzes 20k files and reports status in reasonable time', async () => {
    const dir = await largeProject(20_000);
    let t = Date.now();
    const init = await runCli(['init', '--no-agents', '--json'], dir);
    const initMs = Date.now() - t;
    expect(init.code, init.stderr).toBe(0);
    expect(JSON.parse(init.stdout).filesScanned).toBe(20_001);
    t = Date.now();
    const status = await runCli(['status', '--json'], dir);
    const statusMs = Date.now() - t;
    expect(JSON.parse(status.stdout).sync).toBe('up-to-date');
    // Generous bounds for slow CI machines; status reuses hashes so it must be faster than init.
    expect(initMs).toBeLessThan(60_000);
    expect(statusMs).toBeLessThan(initMs);
  }, 180_000);
});
