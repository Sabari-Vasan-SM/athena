import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseEventArgs } from '../../src/cli/commands/event.js';
import { runPipeline } from '../../src/services/pipeline.js';
import { readRecentEvents } from '../../src/services/agent-activity.js';
import { CLI, cleanupProjects, makeProject, runCli } from '../helpers.js';

afterAll(cleanupProjects);

describe('event argument fast path', () => {
  it('accepts exactly the event and global options', () => {
    expect(parseEventArgs(['--athena-hook', '--agent', 'claude-code', '--hook', 'PreToolUse'])).toEqual({ agent: 'claude-code', hook: 'PreToolUse' });
    expect(parseEventArgs(['--agent=cur sor', '--hook=after edit', '--verbose-errors'])).toEqual({ agent: 'cur sor', hook: 'after edit', verbose: true });
    expect(parseEventArgs(['-C', '/p', '--json', '-q', '--quiet', '--no-color'])).toEqual({ cwd: '/p' });
    expect(parseEventArgs(['-C/p', '--cwd=/q'])).toEqual({ cwd: '/q' });
    expect(parseEventArgs(['--agent', 'a', '--agent', 'b'])).toEqual({ agent: 'b' }); // last wins, like commander
    expect(parseEventArgs(['--agent', '--hook'])).toEqual({ agent: '--hook' }); // required values are taken verbatim
    expect(parseEventArgs([])).toEqual({});
  });

  it('defers anything else to the full CLI', () => {
    for (const args of [['--help'], ['-h'], ['--bogus'], ['extra'], ['--agent'], ['--'], ['-qC', 'x']]) expect(parseEventArgs(args), args.join(' ')).toBeNull();
  });
});

/** Every module reachable from a dist chunk through static imports. */
async function staticGraph(entry: string): Promise<{ files: Set<string>; packages: Set<string> }> {
  const dist = path.dirname(CLI);
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = async (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    const src = await fs.readFile(path.join(dist, file), 'utf8');
    // Static imports only: `import … from "x"` / `import "x"` at statement start.
    for (const m of src.matchAll(/^import\s+(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/gm)) {
      const spec = m[1]!;
      if (spec.startsWith('./')) await visit(spec.slice(2));
      else if (!isBuiltin(spec)) packages.add(spec);
    }
  };
  await visit(entry);
  return { files, packages };
}

describe('built CLI startup', () => {
  it('keeps the bin entry tiny, with the shebang, and loads commands lazily', async () => {
    const entry = await fs.readFile(CLI, 'utf8');
    expect(entry.startsWith('#!/usr/bin/env node\n')).toBe(true);
    const { packages } = await staticGraph('cli.js');
    expect([...packages]).toEqual([]); // no dependency is loaded before argv is inspected
  });

  it('loads no heavy dependency on the `athena event` path', async () => {
    const entry = await fs.readFile(CLI, 'utf8');
    const eventChunk = entry.match(/import\(["']\.\/(event-[\w-]+\.js)["']\)/)?.[1];
    expect(eventChunk).toBeTruthy();
    const { packages } = await staticGraph(eventChunk!);
    for (const heavy of ['commander', 'fastify', '@babel/parser', '@modelcontextprotocol/sdk', 'chokidar', 'yaml', 'smol-toml', 'diff', 'ignore', 'picocolors']) {
      expect([...packages].some((p) => p === heavy || p.startsWith(`${heavy}/`)), heavy).toBe(false);
    }
  });

  it('records an event through the fast path with global options, and falls back for help', async () => {
    const dir = await makeProject({ 'package.json': JSON.stringify({ name: 'shop' }), 'src/app.ts': 'export {}' });
    await runPipeline({ root: dir, mode: 'init', agents: [] });
    const elsewhere = await makeProject({ 'x.txt': 'x' });
    const r = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = execFile(process.execPath, [CLI, 'event', '--athena-hook', '--agent=claude-code', '--hook', 'PreToolUse', '-C', dir, '--quiet'], { cwd: elsewhere }, (err, stdout, stderr) =>
        resolve({ code: err ? 1 : 0, stdout, stderr }),
      );
      child.stdin!.end(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: path.join(dir, 'src/app.ts') } }));
    });
    expect(r).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(await readRecentEvents(dir)).toMatchObject([{ agent: 'claude-code', kind: 'read', files: ['src/app.ts'] }]);

    const help = await runCli(['event', '--help'], dir);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage: athena event');
    const version = await runCli(['--version'], dir);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
