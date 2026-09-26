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
import { codexAdapter } from '../../src/agents/codex/adapter.js';
import { windsurfAdapter, WINDSURF_RULE_LIMIT } from '../../src/agents/windsurf/adapter.js';
import { clineAdapter } from '../../src/agents/cline/adapter.js';
import { copilotAdapter } from '../../src/agents/copilot/adapter.js';
import { geminiCliAdapter } from '../../src/agents/gemini-cli/adapter.js';
import { antigravityAdapter } from '../../src/agents/antigravity/adapter.js';
import { resolveAdapters } from '../../src/agents/registry.js';
import { removeAgents, configureAgents } from '../../src/services/agents.js';
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

  it('maps Codex hooks, reporting apply_patch files instead of the patch body', () => {
    const ev = (hook: string, payload: Record<string, unknown>) => normalizeHookEvent('codex', hook, payload);
    const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: src/b.ts\n+z\n*** End Patch';
    const edit = ev('PreToolUse', { tool_name: 'apply_patch', tool_input: { command: patch } })!;
    expect(edit).toMatchObject({ kind: 'edit', state: 'CODING', files: ['src/a.ts', 'src/b.ts'], command: null });
    expect(JSON.stringify(edit)).not.toContain('Begin Patch');
    expect(ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'cargo test' } })).toMatchObject({ kind: 'command', state: 'TESTING' });
    expect(ev('PreToolUse', { tool_name: 'update_plan', tool_input: {} })).toMatchObject({ state: 'PLANNING' });
    expect(ev('SessionStart', { session_id: 'x1' })).toMatchObject({ kind: 'session-start', session: 'x1' });
  });

  it('maps Gemini CLI hooks and built-in tool names', () => {
    const ev = (hook: string, payload: Record<string, unknown>) => normalizeHookEvent('gemini-cli', hook, payload);
    expect(ev('SessionStart', { session_id: 'g1', source: 'startup' })).toMatchObject({ kind: 'session-start', session: 'g1' });
    expect(ev('BeforeAgent', { prompt: 'add billing' })).toMatchObject({ kind: 'prompt', state: 'PLANNING' });
    expect(JSON.stringify(ev('BeforeAgent', { prompt: 'secret plan' }))).not.toContain('secret plan');
    expect(ev('BeforeTool', { tool_name: 'read_file', tool_input: { file_path: 'src/a.ts' } })).toMatchObject({ kind: 'read', state: 'ANALYZING', files: ['src/a.ts'] });
    expect(ev('BeforeTool', { tool_name: 'grep_search', tool_input: {} })).toMatchObject({ kind: 'search' });
    expect(ev('BeforeTool', { tool_name: 'replace', tool_input: { file_path: 'src/a.ts' } })).toMatchObject({ kind: 'edit', state: 'CODING' });
    expect(ev('BeforeTool', { tool_name: 'write_file', tool_input: { file_path: 'src/b.ts' } })).toMatchObject({ kind: 'edit' });
    expect(ev('BeforeTool', { tool_name: 'run_shell_command', tool_input: { command: 'npm test' } })).toMatchObject({ kind: 'command', state: 'TESTING' });
    expect(ev('AfterTool', { tool_name: 'replace' })).toBeNull();
    expect(ev('AfterAgent', {})).toMatchObject({ kind: 'stop', state: 'SUCCESS' });
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

  it('installs Codex MCP and hooks without touching existing config', async () => {
    const dir = await project();
    const codexHome = path.join(dir, '.test-codex-home');
    process.env.CODEX_HOME = codexHome;
    try {
      await fs.mkdir(path.join(dir, '.codex'), { recursive: true });
      const userToml = '# my settings\nmodel = "gpt-5"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n';
      await fs.writeFile(path.join(dir, '.codex/config.toml'), userToml);

      await applyChanges(dir, await codexAdapter.plan({ root: dir, projectName: 'shop' }));
      const toml = await fs.readFile(path.join(dir, '.codex/config.toml'), 'utf8');
      expect(toml.startsWith(userToml.trimEnd())).toBe(true);
      expect(toml).toContain('[mcp_servers.athena]');
      expect(toml).toContain('args = ["mcp"]');
      const hooks = JSON.parse(await fs.readFile(path.join(dir, '.codex/hooks.json'), 'utf8'));
      expect(hooks.hooks.PreToolUse[0].hooks[0]).toMatchObject({ type: 'command', timeout: 10 });
      expect(hooks.hooks.PreToolUse[0].hooks[0].command).toBe('athena event --athena-hook --agent codex --hook PreToolUse');
      expect(await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8')).toContain('<!-- athena:start -->');

      // Idempotent
      const again = await codexAdapter.plan({ root: dir, projectName: 'shop' });
      expect(again.every((c) => c.action === 'unchanged')).toBe(true);

      // Trust is read from the Codex home, never written
      const trustMsg = async () => (await codexAdapter.check(dir)).find((c) => /trust/i.test(c.message))!;
      expect((await trustMsg()).ok).toBe(false);
      await fs.mkdir(codexHome, { recursive: true });
      await fs.writeFile(path.join(codexHome, 'config.toml'), `[projects.${JSON.stringify(dir)}]\ntrust_level = "trusted"\n`);
      expect(await trustMsg()).toMatchObject({ ok: true });
      expect((await codexAdapter.check(dir)).filter((c) => !/trust/i.test(c.message)).every((c) => c.ok)).toBe(true);

      await codexAdapter.remove(dir);
      expect(await fs.readFile(path.join(dir, '.codex/config.toml'), 'utf8')).toBe(userToml);
      await expect(fs.access(path.join(dir, '.codex/hooks.json'))).rejects.toThrow();
    } finally {
      delete process.env.CODEX_HOME;
    }
  });

  it('leaves a developer-defined Codex "athena" MCP server alone, and rejects malformed TOML', async () => {
    const dir = await project();
    await fs.mkdir(path.join(dir, '.codex'), { recursive: true });
    const own = '[mcp_servers.athena]\ncommand = "/opt/athena/bin/athena"\nargs = ["mcp", "--allow-write"]\n';
    await fs.writeFile(path.join(dir, '.codex/config.toml'), own);
    const config = (await codexAdapter.plan({ root: dir, projectName: 'shop' })).find((c) => c.path === '.codex/config.toml')!;
    expect(config).toMatchObject({ action: 'unchanged', content: own });

    await fs.writeFile(path.join(dir, '.codex/config.toml'), 'model = ');
    await expect(codexAdapter.plan({ root: dir, projectName: 'shop' })).rejects.toThrow(/not valid TOML/);
  });

  it('keeps the shared AGENTS.md block when Codex is removed but AGENTS.md stays configured', async () => {
    const dir = await project();
    await configureAgents(dir, ['codex', 'agents-md']);
    await removeAgents(dir, ['codex']);
    expect(await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8')).toContain('<!-- athena:start -->');
    await expect(fs.access(path.join(dir, '.codex/hooks.json'))).rejects.toThrow();
    await removeAgents(dir, ['agents-md']);
    await expect(fs.access(path.join(dir, 'AGENTS.md'))).rejects.toThrow();
  });

  it('installs GitHub Copilot instructions, MCP and hooks without touching existing files', async () => {
    const dir = await project();
    const userInstructions = '# Team\n\nUse pnpm.\n';
    const userMcp = JSON.stringify({ inputs: [{ id: 'tok', type: 'promptString' }], servers: { github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' } } }, null, 2);
    const userHooks = JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: 'command', bash: './audit.sh' }] } }, null, 2);
    await fs.mkdir(path.join(dir, '.github/hooks'), { recursive: true });
    await fs.mkdir(path.join(dir, '.vscode'), { recursive: true });
    await fs.writeFile(path.join(dir, '.github/copilot-instructions.md'), userInstructions);
    await fs.writeFile(path.join(dir, '.vscode/mcp.json'), userMcp);
    await fs.writeFile(path.join(dir, '.github/hooks/team.json'), userHooks);

    await applyChanges(dir, await copilotAdapter.plan({ root: dir, projectName: 'shop' }));
    const instructions = await fs.readFile(path.join(dir, '.github/copilot-instructions.md'), 'utf8');
    expect(instructions.startsWith(userInstructions)).toBe(true);
    expect(instructions).toContain('<!-- athena:start -->');
    const mcp = JSON.parse(await fs.readFile(path.join(dir, '.vscode/mcp.json'), 'utf8'));
    expect(mcp.servers.github).toEqual({ type: 'http', url: 'https://api.githubcopilot.com/mcp/' });
    expect(mcp.servers.athena).toEqual({ type: 'stdio', command: 'athena', args: ['mcp'] });
    expect(mcp.inputs).toHaveLength(1);
    expect(mcp.mcpServers).toBeUndefined();
    const hooks = JSON.parse(await fs.readFile(path.join(dir, '.github/hooks/athena.json'), 'utf8'));
    expect(hooks.version).toBe(1);
    expect(Object.keys(hooks.hooks)).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop']);
    expect(hooks.hooks.PreToolUse[0]).toMatchObject({ type: 'command', timeoutSec: 10 });
    // A missing `athena` must never deny a Copilot tool call: commands always exit 0.
    expect(hooks.hooks.PreToolUse[0].bash).toBe('athena event --athena-hook --agent copilot --hook PreToolUse 2>/dev/null || true');
    expect(hooks.hooks.PreToolUse[0].powershell).toMatch(/--agent copilot --hook PreToolUse .*; exit 0$/);
    expect(await fs.readFile(path.join(dir, '.github/hooks/team.json'), 'utf8')).toBe(userHooks);
    if (process.platform !== 'win32') {
      const r = await new Promise<number>((resolve) => execFile('sh', ['-c', 'PATH=/nonexistent; ' + hooks.hooks.PreToolUse[0].bash], (err) => resolve(err ? 1 : 0)));
      expect(r).toBe(0);
    }

    // Idempotent
    expect((await copilotAdapter.plan({ root: dir, projectName: 'shop' })).every((c) => c.action === 'unchanged')).toBe(true);
    expect((await copilotAdapter.check(dir)).every((c) => c.ok)).toBe(true);
    expect(await copilotAdapter.detectPresence(dir)).toMatchObject({ detectedInProject: true });

    const touched = await copilotAdapter.remove(dir);
    expect(touched.sort()).toEqual(['.github/copilot-instructions.md', '.github/hooks/athena.json', '.vscode/mcp.json']);
    expect(await fs.readFile(path.join(dir, '.github/copilot-instructions.md'), 'utf8')).toBe(userInstructions);
    expect(JSON.parse(await fs.readFile(path.join(dir, '.vscode/mcp.json'), 'utf8'))).toEqual(JSON.parse(userMcp));
    await expect(fs.access(path.join(dir, '.github/hooks/athena.json'))).rejects.toThrow();
    expect(await fs.readFile(path.join(dir, '.github/hooks/team.json'), 'utf8')).toBe(userHooks);
  });

  it('deletes the Copilot files it created and refuses malformed .vscode/mcp.json', async () => {
    const dir = await project();
    await applyChanges(dir, await copilotAdapter.plan({ root: dir, projectName: 'shop' }));
    expect((await copilotAdapter.detectPresence(dir)).evidence).toEqual([]);
    await copilotAdapter.remove(dir);
    for (const f of ['.github/copilot-instructions.md', '.vscode/mcp.json', '.github/hooks/athena.json', '.github/hooks', '.vscode']) await expect(fs.access(path.join(dir, f)), f).rejects.toThrow();

    await fs.mkdir(path.join(dir, '.vscode'), { recursive: true });
    await fs.writeFile(path.join(dir, '.vscode/mcp.json'), '{ "servers": { ');
    await expect(copilotAdapter.plan({ root: dir, projectName: 'shop' })).rejects.toThrow(/not valid JSON/);
    expect(await copilotAdapter.detectPresence(dir)).toMatchObject({ evidence: ['.vscode/mcp.json'] });
  });

  it('detects Copilot from developer files only', async () => {
    const dir = await project();
    expect((await copilotAdapter.detectPresence(dir)).detectedInProject).toBe(false);
    await fs.mkdir(path.join(dir, '.github/instructions'), { recursive: true });
    await fs.writeFile(path.join(dir, '.github/instructions/ts.instructions.md'), '---\napplyTo: "**/*.ts"\n---\nUse strict mode.\n');
    expect((await copilotAdapter.detectPresence(dir)).evidence).toEqual(['.github/instructions']);
  });

  it('installs Gemini CLI context, MCP and hooks without touching existing settings', async () => {
    const dir = await project();
    const userContext = '# Gemini notes\n\nPrefer small diffs.\n';
    const userSettings = { theme: 'GitHub', mcpServers: { docs: { command: 'docs-mcp', args: [] } }, hooks: { BeforeTool: [{ matcher: 'write_file', hooks: [{ name: 'guard', type: 'command', command: './guard.sh' }] }] } };
    await fs.mkdir(path.join(dir, '.gemini'), { recursive: true });
    await fs.writeFile(path.join(dir, 'GEMINI.md'), userContext);
    await fs.writeFile(path.join(dir, '.gemini/settings.json'), JSON.stringify(userSettings, null, 2));

    await applyChanges(dir, await geminiCliAdapter.plan({ root: dir, projectName: 'shop' }));
    const context = await fs.readFile(path.join(dir, 'GEMINI.md'), 'utf8');
    expect(context.startsWith(userContext)).toBe(true);
    expect(context).toContain('<!-- athena:start -->');
    const settings = JSON.parse(await fs.readFile(path.join(dir, '.gemini/settings.json'), 'utf8'));
    expect(settings.theme).toBe('GitHub');
    expect(settings.mcpServers.docs).toEqual({ command: 'docs-mcp', args: [] });
    expect(settings.mcpServers.athena).toEqual({ command: 'athena', args: ['mcp'] });
    expect(Object.keys(settings.hooks)).toEqual(['BeforeTool', 'SessionStart', 'BeforeAgent', 'AfterAgent', 'SessionEnd']);
    expect(settings.hooks.BeforeTool).toHaveLength(2);
    expect(settings.hooks.BeforeTool[0].matcher).toBe('write_file');
    expect(settings.hooks.BeforeTool[1]).toMatchObject({ matcher: '*' });
    expect(settings.hooks.BeforeTool[1].hooks[0]).toEqual({ name: 'athena-activity', type: 'command', command: 'athena event --athena-hook --agent gemini-cli --hook BeforeTool', timeout: 10_000 });

    expect((await geminiCliAdapter.plan({ root: dir, projectName: 'shop' })).every((c) => c.action === 'unchanged')).toBe(true);
    expect((await geminiCliAdapter.check(dir)).every((c) => c.ok)).toBe(true);
    expect((await geminiCliAdapter.detectPresence(dir)).evidence).toEqual(['GEMINI.md', '.gemini']);

    expect((await geminiCliAdapter.remove(dir)).sort()).toEqual(['.gemini/settings.json', 'GEMINI.md']);
    expect(await fs.readFile(path.join(dir, 'GEMINI.md'), 'utf8')).toBe(userContext);
    expect(JSON.parse(await fs.readFile(path.join(dir, '.gemini/settings.json'), 'utf8'))).toEqual(userSettings);
  });

  it('deletes the Gemini CLI files it created and refuses malformed settings', async () => {
    const dir = await project();
    await applyChanges(dir, await geminiCliAdapter.plan({ root: dir, projectName: 'shop' }));
    expect((await geminiCliAdapter.detectPresence(dir)).evidence).toEqual([]);
    await geminiCliAdapter.remove(dir);
    for (const f of ['GEMINI.md', '.gemini']) await expect(fs.access(path.join(dir, f)), f).rejects.toThrow();

    await fs.mkdir(path.join(dir, '.gemini'), { recursive: true });
    await fs.writeFile(path.join(dir, '.gemini/settings.json'), '{ "theme": ');
    await expect(geminiCliAdapter.plan({ root: dir, projectName: 'shop' })).rejects.toThrow(/not valid JSON/);
  });

  it('treats GEMINI.md as Gemini CLI evidence, not Antigravity', async () => {
    const dir = await project();
    await fs.writeFile(path.join(dir, 'GEMINI.md'), '# notes\n');
    expect((await geminiCliAdapter.detectPresence(dir)).evidence).toEqual(['GEMINI.md']);
    expect((await antigravityAdapter.detectPresence(dir)).evidence).toEqual([]);
    expect(resolveAdapters(['gemini', 'github-copilot', 'gh-copilot', 'antigravity']).map((a) => a.id)).toEqual(['gemini-cli', 'copilot', 'antigravity']);
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

describe('rule-file integrations (Windsurf, Cline)', () => {
  const ctx = (root: string) => ({ root, projectName: 'shop' });

  it('writes, re-plans idempotently and removes the Windsurf rule', async () => {
    const dir = await project();
    expect((await windsurfAdapter.detectPresence(dir)).detectedInProject).toBe(false);
    const planned = await windsurfAdapter.plan(ctx(dir));
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({ path: '.windsurf/rules/athena.md', ownership: 'owned', action: 'create' });
    await applyChanges(dir, planned);
    const text = await fs.readFile(path.join(dir, '.windsurf/rules/athena.md'), 'utf8');
    expect(text.startsWith('---\ntrigger: always_on\n---\n')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(WINDSURF_RULE_LIMIT);
    expect((await windsurfAdapter.plan(ctx(dir))).every((c) => c.action === 'unchanged')).toBe(true);
    expect((await windsurfAdapter.check(dir)).every((c) => c.ok)).toBe(true);
    // Athena's own rule is not evidence; the developer's files are.
    expect((await windsurfAdapter.detectPresence(dir)).evidence).toEqual([]);
    await fs.writeFile(path.join(dir, '.windsurf/rules/team.md'), '---\ntrigger: always_on\n---\nUse pnpm.\n');
    await fs.writeFile(path.join(dir, '.windsurfrules'), 'Be terse.\n');
    expect((await windsurfAdapter.detectPresence(dir)).evidence).toEqual(['.windsurfrules', '.windsurf']);

    expect(await windsurfAdapter.remove(dir)).toEqual(['.windsurf/rules/athena.md']);
    await expect(fs.access(path.join(dir, '.windsurf/rules/athena.md'))).rejects.toThrow();
    expect(await fs.readFile(path.join(dir, '.windsurf/rules/team.md'), 'utf8')).toContain('Use pnpm.');
    expect(await windsurfAdapter.remove(dir)).toEqual([]);
  });

  it('never overwrites or removes a developer file at the Windsurf rule path', async () => {
    const dir = await project();
    await fs.mkdir(path.join(dir, '.windsurf/rules'), { recursive: true });
    await fs.writeFile(path.join(dir, '.windsurf/rules/athena.md'), 'my own rule');
    const planned = await windsurfAdapter.plan(ctx(dir));
    expect(planned[0]).toMatchObject({ action: 'unchanged', content: 'my own rule' });
    await applyChanges(dir, planned);
    expect(await windsurfAdapter.remove(dir)).toEqual([]);
    expect(await fs.readFile(path.join(dir, '.windsurf/rules/athena.md'), 'utf8')).toBe('my own rule');
    expect((await windsurfAdapter.check(dir))[0]).toMatchObject({ ok: false, level: 'warn' });
    expect((await windsurfAdapter.detectPresence(dir)).evidence).toEqual(['.windsurf']);
  });

  it('writes, re-plans idempotently and removes the Cline rule', async () => {
    const dir = await project();
    expect((await clineAdapter.detectPresence(dir)).detectedInProject).toBe(false);
    const planned = await clineAdapter.plan(ctx(dir));
    expect(planned).toEqual([expect.objectContaining({ path: '.clinerules/athena.md', ownership: 'owned', action: 'create' })]);
    await applyChanges(dir, planned);
    const text = await fs.readFile(path.join(dir, '.clinerules/athena.md'), 'utf8');
    expect(text).toContain('Generated by Athena');
    expect(text.startsWith('---')).toBe(false); // no frontmatter: Cline applies the rule to every task
    expect((await clineAdapter.plan(ctx(dir))).every((c) => c.action === 'unchanged')).toBe(true);
    expect(await clineAdapter.check(dir)).toEqual([{ ok: true, level: 'ok', message: 'Cline: .clinerules/athena.md' }]);
    expect((await clineAdapter.detectPresence(dir)).evidence).toEqual([]);
    await fs.writeFile(path.join(dir, '.clinerules/coding.md'), '# Coding\n- Use pnpm\n');
    expect((await clineAdapter.detectPresence(dir)).evidence).toEqual(['.clinerules']);

    expect(await clineAdapter.remove(dir)).toEqual(['.clinerules/athena.md']);
    await expect(fs.access(path.join(dir, '.clinerules/athena.md'))).rejects.toThrow();
    expect(await fs.readFile(path.join(dir, '.clinerules/coding.md'), 'utf8')).toContain('Use pnpm');
  });

  it('never overwrites a developer file at the Cline rule path', async () => {
    const dir = await project();
    await fs.mkdir(path.join(dir, '.clinerules'), { recursive: true });
    await fs.writeFile(path.join(dir, '.clinerules/athena.md'), 'my own rule');
    const planned = await clineAdapter.plan(ctx(dir));
    expect(planned[0]).toMatchObject({ path: '.clinerules/athena.md', action: 'unchanged', content: 'my own rule' });
    await applyChanges(dir, planned);
    expect(await clineAdapter.remove(dir)).toEqual([]);
    expect(await fs.readFile(path.join(dir, '.clinerules/athena.md'), 'utf8')).toBe('my own rule');
    expect((await clineAdapter.detectPresence(dir)).evidence).toEqual(['.clinerules']);
  });

  it('leaves a single-file .clinerules untouched and uses .cline/rules/ instead', async () => {
    const dir = await project();
    await fs.writeFile(path.join(dir, '.clinerules'), 'Always write tests.\n');
    expect((await clineAdapter.detectPresence(dir)).evidence).toEqual(['.clinerules']);

    const planned = await clineAdapter.plan(ctx(dir));
    expect(planned).toEqual([expect.objectContaining({ path: '.cline/rules/athena.md', action: 'create' })]);
    await applyChanges(dir, planned);
    expect(await fs.readFile(path.join(dir, '.clinerules'), 'utf8')).toBe('Always write tests.\n');
    expect(await fs.readFile(path.join(dir, '.cline/rules/athena.md'), 'utf8')).toContain('Generated by Athena');
    expect((await clineAdapter.plan(ctx(dir))).every((c) => c.action === 'unchanged')).toBe(true);
    const checks = await clineAdapter.check(dir);
    expect(checks[0]).toMatchObject({ ok: true, message: 'Cline: .cline/rules/athena.md' });
    expect(checks.some((c) => c.level === 'warn' && /single file/.test(c.message))).toBe(true);
    // .cline/ holding only Athena's rule is not evidence; the .clinerules file still is.
    expect((await clineAdapter.detectPresence(dir)).evidence).toEqual(['.clinerules']);

    expect(await clineAdapter.remove(dir)).toEqual(['.cline/rules/athena.md']);
    expect(await fs.readFile(path.join(dir, '.clinerules'), 'utf8')).toBe('Always write tests.\n');
    await expect(fs.access(path.join(dir, '.cline/rules/athena.md'))).rejects.toThrow();
  });

  it('configures both through the service and reports activity as unsupported', async () => {
    const dir = await project();
    await configureAgents(dir, ['windsurf', 'cline']);
    const agents = await listAgents(dir);
    for (const id of ['windsurf', 'cline']) {
      const a = agents.find((x) => x.id === id)!;
      expect(a.configured).toBe(true);
      expect(a.capabilities).toMatchObject({ hooks: false, mcp: false });
      expect(a.activityObservation).toBe('unsupported');
      expect(a.detectedInProject).toBe(false);
    }
    expect(await removeAgents(dir, ['windsurf', 'cline'])).toEqual(['.windsurf/rules/athena.md', '.clinerules/athena.md']);
    expect(resolveAdapters(['codeium']).map((a) => a.id)).toEqual(['windsurf']);
    expect(() => resolveAdapters(['roo'])).toThrow(/Unknown agent/);
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
