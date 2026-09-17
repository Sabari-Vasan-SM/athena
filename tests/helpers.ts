import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = path.join(REPO_ROOT, 'dist', 'cli.js');

const created: string[] = [];

export async function makeProject(files: Record<string, string | Buffer>): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'athena-test-')));
  created.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return dir;
}

export async function cleanupProjects(): Promise<void> {
  await Promise.all(created.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runCli(args: string[], cwd: string, env: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, NO_COLOR: '1', CI: '1', ...env }, timeout: 60_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

export function gitInit(dir: string): Promise<void> {
  const run = (args: string[]) =>
    new Promise<void>((resolve, reject) =>
      execFile('git', args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }, (err) => (err ? reject(err) : resolve())),
    );
  return run(['init', '-q']).then(() => run(['add', '-A'])).then(() => run(['commit', '-q', '-m', 'init', '--no-gpg-sign']));
}

/** Test credentials assembled at runtime so no literal secret is committed. */
export const FAKE = {
  aws: 'AKIA' + 'Q3EXAMPLEK7X2M4Z',
  github: 'ghp' + '_' + 'r8Kx2LmP9qW4zT7vN1bY6cH3jF5dS0aE8uGi',
  stripe: 'sk' + '_live_' + '4eC39HqLyjWDarjtT1zdp7dc9Xz',
  anthropic: 'sk-ant' + '-api03-' + 'Zx8Kq2Lm9Wp4Tv7Nb1Yc6Hj3Fd5Sa0Eu',
  pem: '-----BEGIN RSA ' + 'PRIVATE KEY-----\nMIIEowIBAAKCAQEA7Zq3\nabcDEF123\n-----END RSA ' + 'PRIVATE KEY-----',
  dbPassword: 'Tr0ub4dor&3xK9pQ',
};
