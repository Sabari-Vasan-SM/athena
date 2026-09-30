#!/usr/bin/env node
// Benchmark the built CLI (dist/cli.js) on a generated repository.
//   node bench/run.mjs [--files 20000] [--dir <path>] [--label name] [--baseline bench/baseline.json] [--check]
// Scenarios: cold init, warm sync --check, one-file-change sync --check, status,
// review of a 500-file diff, and `athena event` cold start (p50 of 10 runs).
// Writes bench/results/<label>.json; with --check, exits 1 if any scenario is
// more than 20% slower (or uses 20% more memory) than the baseline.
import { spawn, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const CLI = path.join(repoRoot, 'dist', 'cli.js');
const RSS = path.join(here, 'rss.cjs');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const files = Number(opt('files', '20000'));
const label = opt('label', `files-${files}`);
const baselinePath = opt('baseline', path.join(here, 'baseline.json'));
const check = args.includes('--check');
const dir = path.resolve(opt('dir', path.join(os.tmpdir(), `athena-bench-${files}`)));
const TOLERANCE = 0.2;

async function exists(p) {
  return fs.access(p).then(() => true, () => false);
}

/** Run the CLI once; returns wall ms and peak RSS (MB). */
function runCli(cliArgs, { input } = {}) {
  return new Promise((resolve, reject) => {
    const rssFile = path.join(os.tmpdir(), `athena-bench-rss-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    const started = process.hrtime.bigint();
    const child = spawn(process.execPath, ['--require', RSS, CLI, ...cliArgs], {
      cwd: dir,
      env: { ...process.env, BENCH_RSS_OUT: rssFile, NO_COLOR: '1', CI: '1' },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    if (input !== undefined) child.stdin.end(input);
    child.on('error', reject);
    child.on('close', async (code) => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      let rssMb = null;
      try {
        rssMb = JSON.parse(await fs.readFile(rssFile, 'utf8')).maxRssKb / 1024;
        await fs.rm(rssFile, { force: true });
      } catch {
        // No measurement (e.g. crashed before exit handler) — reported as null.
      }
      resolve({ code, ms, rssMb, stderr: stderr.slice(0, 500) });
    });
  });
}

const git = (a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'b', GIT_AUTHOR_EMAIL: 'b@e.com', GIT_COMMITTER_NAME: 'b', GIT_COMMITTER_EMAIL: 'b@e.com' } });

async function main() {
  if (!(await exists(CLI))) throw new Error('dist/cli.js not found — run `npm run build:cli` first');
  if (!(await exists(path.join(dir, '.git')))) {
    console.log(`Generating ${files} files in ${dir} …`);
    execFileSync(process.execPath, [path.join(here, 'generate.mjs'), dir, String(files)], { stdio: 'inherit' });
  }
  // Start from a clean, committed state every time.
  git(['reset', '-q', '--hard']);
  git(['clean', '-qfdx']);

  const results = {};
  const record = (name, r, expectCodes = [0]) => {
    if (!expectCodes.includes(r.code)) throw new Error(`${name}: exited ${r.code}\n${r.stderr}`);
    results[name] = { ms: Math.round(r.ms), rssMb: r.rssMb === null ? null : Math.round(r.rssMb) };
    console.log(`  ${name.padEnd(22)} ${String(Math.round(r.ms)).padStart(7)} ms  ${r.rssMb === null ? '     ?' : String(Math.round(r.rssMb)).padStart(6)} MB`);
  };

  console.log(`\nAthena benchmark — ${files} files (${label})`);
  record('init (cold)', await runCli(['init', '--no-agents', '--quiet']));
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'athena']);
  record('sync --check (warm)', await runCli(['sync', '--check', '--quiet']));

  const one = (await fs.readdir(path.join(dir, 'src', 'm0'))).find((f) => f.endsWith('.ts'));
  await fs.appendFile(path.join(dir, 'src', 'm0', one), '\nexport const touched = 1;\n');
  record('sync --check (1 file)', await runCli(['sync', '--check', '--quiet']), [0, 1]);
  record('status', await runCli(['status', '--json']));

  // A 500-file working-tree diff for review.
  const tsDirs = (await fs.readdir(path.join(dir, 'src'))).slice(0, 50);
  let touched = 0;
  for (const d of tsDirs) {
    for (const f of (await fs.readdir(path.join(dir, 'src', d))).slice(0, 10)) {
      await fs.appendFile(path.join(dir, 'src', d, f), `\n// TODO: bench change ${touched}\nexport const b${touched} = ${touched};\n`);
      if (++touched >= 500) break;
    }
    if (touched >= 500) break;
  }
  record('review (500 files)', await runCli(['review', '--json', '--no-sync']), [0, 1]);

  // Agent hooks start the CLI on every tool call: measure cold start (p50 of 10).
  const payload = JSON.stringify({ session_id: 'bench', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'src/m0/f0.ts' } });
  const runs = [];
  for (let i = 0; i < 10; i++) runs.push(await runCli(['event', '--agent', 'claude-code', '--hook', 'PreToolUse'], { input: payload }));
  runs.sort((a, b) => a.ms - b.ms);
  record('event (p50 of 10)', runs[5]);

  const report = { label, files, node: process.version, platform: `${process.platform}-${process.arch}`, cpus: os.cpus().length, date: new Date().toISOString(), results };
  await fs.mkdir(path.join(here, 'results'), { recursive: true });
  const outFile = path.join(here, 'results', `${label}.json`);
  await fs.writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nSaved ${path.relative(repoRoot, outFile)}`);

  if (await exists(baselinePath)) {
    const base = JSON.parse(await fs.readFile(baselinePath, 'utf8'));
    const baseResults = base.results ?? {};
    let regressed = false;
    console.log(`\nCompared with ${path.relative(repoRoot, baselinePath)} (${base.label}, ${base.platform}):`);
    for (const [name, r] of Object.entries(results)) {
      const b = baseResults[name];
      if (!b) continue;
      const t = r.ms / b.ms;
      const m = r.rssMb && b.rssMb ? r.rssMb / b.rssMb : 1;
      const flag = t > 1 + TOLERANCE || m > 1 + TOLERANCE;
      regressed ||= flag;
      console.log(`  ${name.padEnd(22)} time ×${t.toFixed(2)}  memory ×${m.toFixed(2)}${flag ? '  ← regression' : ''}`);
    }
    if (check && regressed) {
      console.error('\nBenchmark regression beyond 20% of the baseline.');
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
