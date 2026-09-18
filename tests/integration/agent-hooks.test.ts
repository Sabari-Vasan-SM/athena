import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { createServer } from '../../src/server/app.js';
import { runPipeline } from '../../src/services/pipeline.js';
import { listAgents } from '../../src/services/agents.js';
import { readRecentEvents, summarizeSessions } from '../../src/services/agent-activity.js';
import { normalizeHookEvent } from '../../src/agents/common/hook-events.js';
import { claudeCodeAdapter } from '../../src/agents/claude-code/adapter.js';
import { cursorAdapter } from '../../src/agents/cursor/adapter.js';
import { applyChanges } from '../../src/agents/registry.js';
import { CLI, cleanupProjects, FAKE, makeProject } from '../helpers.js';

afterAll(cleanupProjects);

const TOKEN = 'test-token-0123456789abcdefghijklmnop';
const PORT = 7998;
const auth = { authorization: `Bearer ${TOKEN}`, host: `127.0.0.1:${PORT}` };

async function project(): Promise<string> {
  const dir = await makeProject({ 'package.json': JSON.stringify({ name: 'shop' }), 'src/app.ts': 'export {}' });
  await runPipeline({ root: dir, mode: 'init', agents: [] });
  return dir;
}

/** Feed a hook payload to the built CLI exactly as an agent would. */
function fireHook(dir: string, agent: string, hook: string, payload: Record<string, unknown>): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, 'event', '--agent', agent, '--hook', hook], { cwd: dir, env: { ...process.env, NO_COLOR: '1' } }, (err, stdout, stderr) =>
      resolve({ stdout, stderr, code: err ? ((err as { code?: number }).code ?? 1) : 0 }),
    );
    child.stdin!.end(JSON.stringify({ cwd: dir, ...payload }));
  });
}

describe('hook payload normalization', () => {
  it('maps Claude Code hooks to observable states', () => {
    const ev = (hook: string, payload: Record<string, unknown>) => normalizeHookEvent('claude-code', hook, payload);
    expect(ev('SessionStart', { session_id: 's1' })).toMatchObject({ kind: 'session-start', state: 'IDLE', session: 's1' });
    expect(ev('UserPromptSubmit', { user_input: 'add billing' })).toMatchObject({ kind: 'prompt', state: 'PLANNING' });
    expect(ev('PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'src/a.ts' } })).toMatchObject({ kind: 'read', state: 'ANALYZING', files: ['src/a.ts'] });
    expect(ev('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } })).toMatchObject({ kind: 'edit', state: 'CODING' });
    expect(ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } })).toMatchObject({ kind: 'command', state: 'TESTING' });
    expect(ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm run lint' } })).toMatchObject({ state: 'REVIEWING' });
    expect(ev('Stop', { stop_reason: 'end_turn' })).toMatchObject({ kind: 'stop', state: 'SUCCESS' });
    // PostToolUse would duplicate PreToolUse
    expect(ev('PostToolUse', { tool_name: 'Edit' })).toBeNull();
  });

  it('maps Cursor hooks, including its own field names', () => {
    const ev = (hook: string, payload: Record<string, unknown>) => normalizeHookEvent('cursor', hook, payload);
    expect(ev('beforeSubmitPrompt', { conversation_id: 'c1' })).toMatchObject({ kind: 'prompt', state: 'PLANNING', session: 'c1' });
    expect(ev('afterFileEdit', { file_path: 'src/x.ts', edits: [{ file_path: 'src/y.ts' }] })).toMatchObject({ kind: 'edit', files: ['src/x.ts', 'src/y.ts'] });
    expect(ev('beforeShellExecution', { command: 'pytest -q' })).toMatchObject({ state: 'TESTING' });
    expect(ev('afterShellExecution', { command: 'pytest -q' })).toBeNull();
  });

  it('never records agent reasoning, only tool facts', () => {
    const e = normalizeHookEvent('claude-code', 'UserPromptSubmit', { user_input: 'my secret business plan' })!;
    expect(JSON.stringify(e)).not.toContain('secret business plan');
  });
});

describe('athena event (called by agents)', () => {
  it('records events, stays silent on stdout, and always exits 0', async () => {
    const dir = await project();
    const r = await fireHook(dir, 'claude-code', 'PreToolUse', { session_id: 's1', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/app.ts') } });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');

    const events = await readRecentEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ agent: 'claude-code', kind: 'edit', files: ['src/app.ts'] });
    expect(events[0]!.message).not.toContain(dir); // project-relative only
  });

  it('is harmless outside an Athena project, with malformed input, and with secrets', async () => {
    const plain = await makeProject({ 'a.txt': 'x' });
    expect((await fireHook(plain, 'claude-code', 'Stop', {})).code).toBe(0);
    await expect(fs.access(path.join(plain, '.athena'))).rejects.toThrow();

    const dir = await project();
    const broken = await new Promise<number>((resolve) => {
      const child = execFile(process.execPath, [CLI, 'event', '--agent', 'x', '--hook', 'Stop'], { cwd: dir }, (err) => resolve(err ? 1 : 0));
      child.stdin!.end('not json at all');
    });
    expect(broken).toBe(0);

    await fireHook(dir, 'claude-code', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: `curl -H "token: ${FAKE.github}" https://api.example.com` } });
    const log = await fs.readFile(path.join(dir, '.athena/.agent-events.jsonl'), 'utf8');
    expect(log).not.toContain(FAKE.github);
    expect(log).toContain('<redacted>');
  });

  it('summarizes sessions per agent', async () => {
    const dir = await project();
    await fireHook(dir, 'claude-code', 'SessionStart', { session_id: 'aaa' });
    await fireHook(dir, 'claude-code', 'PreToolUse', { session_id: 'aaa', tool_name: 'Read', tool_input: { file_path: 'src/app.ts' } });
    await fireHook(dir, 'cursor', 'afterFileEdit', { conversation_id: 'bbb', file_path: 'src/app.ts' });
    const sessions = summarizeSessions(await readRecentEvents(dir));
    expect(sessions.map((s) => s.agent).sort()).toEqual(['claude-code', 'cursor']);
    expect(sessions.find((s) => s.agent === 'claude-code')!.events).toBe(2);
  });
});

describe('hook installation', () => {
  it('installs Claude Code hooks without touching existing settings', async () => {
    const dir = await project();
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
    await fs.writeFile(path.join(dir, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-own-script.sh' }] }] } }, null, 2));

    await applyChanges(dir, await claudeCodeAdapter.plan({ root: dir, projectName: 'shop' }));
    const settings = JSON.parse(await fs.readFile(path.join(dir, '.claude/settings.json'), 'utf8'));
    expect(settings.permissions.allow).toEqual(['Bash(ls)']);
    expect(settings.hooks.Stop).toHaveLength(2); // user's hook kept, Athena's added
    expect(settings.hooks.PreToolUse[0].hooks[0]).toMatchObject({ type: 'command', command: 'athena', async: true });
    expect(settings.hooks.PreToolUse[0].hooks[0].args).toContain('--athena-hook');

    // Re-running is idempotent
    await applyChanges(dir, await claudeCodeAdapter.plan({ root: dir, projectName: 'shop' }));
    const again = JSON.parse(await fs.readFile(path.join(dir, '.claude/settings.json'), 'utf8'));
    expect(again.hooks.Stop).toHaveLength(2);
    expect((await claudeCodeAdapter.check(dir)).some((c) => c.ok && /hooks installed/.test(c.message))).toBe(true);

    await claudeCodeAdapter.remove(dir);
    const after = JSON.parse(await fs.readFile(path.join(dir, '.claude/settings.json'), 'utf8'));
    expect(after.permissions.allow).toEqual(['Bash(ls)']);
    expect(after.hooks.Stop).toHaveLength(1);
    expect(JSON.stringify(after)).not.toContain('--athena-hook');
  });

  it('installs Cursor hooks with an executable forwarding script', async () => {
    const dir = await project();
    await applyChanges(dir, await cursorAdapter.plan({ root: dir, projectName: 'shop' }));
    const hooks = JSON.parse(await fs.readFile(path.join(dir, '.cursor/hooks.json'), 'utf8'));
    expect(hooks.version).toBe(1);
    expect(hooks.hooks.afterFileEdit[0].command).toContain('.cursor/hooks/athena-hook');
    const script = path.join(dir, '.cursor/hooks/athena-hook.sh');
    if (process.platform !== 'win32') expect((await fs.stat(script)).mode & 0o111).toBeGreaterThan(0);

    await cursorAdapter.remove(dir);
    await expect(fs.access(path.join(dir, '.cursor/hooks.json'))).rejects.toThrow();
    await expect(fs.access(script)).rejects.toThrow();
  });

  it('refuses to touch malformed agent config', async () => {
    const dir = await project();
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
    await fs.writeFile(path.join(dir, '.claude/settings.json'), '{ broken json');
    await expect(claudeCodeAdapter.plan({ root: dir, projectName: 'shop' })).rejects.toThrow(/not valid JSON/);
  });

  it('reports observation status per agent', async () => {
    const dir = await project();
    let agents = await listAgents(dir);
    expect(agents.find((a) => a.id === 'antigravity')!.activityObservation).toBe('unsupported');
    expect(agents.find((a) => a.id === 'claude-code')!.activityObservation).toBe('not-configured');

    await runPipeline({ root: dir, mode: 'analyze', agents: [claudeCodeAdapter] });
    await fireHook(dir, 'claude-code', 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'src/app.ts' } });
    agents = await listAgents(dir);
    const claude = agents.find((a) => a.id === 'claude-code')!;
    expect(claude.activityObservation).toBe('hooks');
    expect(claude.observedEvents).toBe(1);
    expect(claude.lastActivityAt).not.toBeNull();
  });
});

describe('server agent activity', () => {
  it('streams hook events into the timeline and drives the robot state', async () => {
    const dir = await project();
    await fireHook(dir, 'claude-code', 'SessionStart', { session_id: 'old' }); // recorded before the server starts
    const webDir = await makeProject({ 'index.html': '<!doctype html><title>Athena</title>' });
    const s = await createServer({ root: dir, token: TOKEN, host: '127.0.0.1', port: PORT, webDir });
    try {
      expect(s.events.recent().some((e) => e.source === 'agent')).toBe(true); // history seeded

      await fireHook(dir, 'claude-code', 'PreToolUse', { session_id: 'live', tool_name: 'Edit', tool_input: { file_path: 'src/app.ts' } });
      for (let i = 0; i < 100 && s.events.activity().actor !== 'agent'; i++) await new Promise((r) => setTimeout(r, 50));
      expect(s.events.activity()).toMatchObject({ actor: 'agent', state: 'CODING' });

      const activity = (await s.app.inject({ url: '/api/activity', headers: auth })).json();
      expect(activity.agentObservation.available).toBe(false); // hooks not installed in this project
      expect(activity.events.filter((e: { source: string }) => e.source === 'agent').length).toBeGreaterThanOrEqual(2);
      expect(activity.sessions.map((x: { session: string }) => x.session)).toContain('live');
    } finally {
      await s.close();
    }
  }, 30_000);
});
