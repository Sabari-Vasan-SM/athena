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
  await backdate(dir, Object.keys(files));
  return dir;
}

/**
 * Give files an mtime an hour in the past, as existing code usually has. Athena re-reads
 * files modified within the last couple of seconds ("racily clean", see RACY_WINDOW_MS),
 * so tests that assert zero reads after an analysis need files that aren't brand new.
 */
export async function backdate(dir: string, rels: string[]): Promise<void> {
  const past = new Date(Date.now() - 3_600_000);
  await Promise.all(rels.map((rel) => fs.utimes(path.join(dir, rel), past, past)));
}

/** Backdate every file under `dir` (for projects copied or generated rather than made with makeProject). */
export async function backdateTree(dir: string): Promise<void> {
  const rels: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const ent of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) await walk(child);
      else if (ent.isFile()) rels.push(child);
    }
  };
  await walk('');
  await backdate(dir, rels);
}

export async function cleanupProjects(): Promise<void> {
  // Windows refuses to delete a directory while a watcher or child process still holds a
  // handle (EBUSY/EPERM); fs.rm's retries cover the moment it takes to be released.
  await Promise.all(created.splice(0).map((d) => fs.rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })));
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runCli(args: string[], cwd: string, env: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, NO_COLOR: '1', CI: '1', ...env }, timeout: 60_000 }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: unknown; signal?: string | null; killed?: boolean }) | null;
      const code = e ? (typeof e.code === 'number' ? e.code : 1) : 0;
      // Make a killed or crashed process visible instead of a bare exit code 1.
      const note = e && typeof e.code !== 'number' ? `\n[runCli] ${e.killed ? 'killed (timeout)' : 'failed'}: signal=${e.signal ?? 'none'} ${e.message}` : '';
      resolve({ code, stdout, stderr: stderr + note });
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
