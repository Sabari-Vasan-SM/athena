import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { gitAvailable, isGitRepo } from '../core/git/git.js';
import { KNOWLEDGE_DOCS } from '../core/knowledge/documents.js';
import { parseBlocks } from '../core/knowledge/managed-blocks.js';
import { listRules, parseRules } from '../core/knowledge/rules.js';
import { athenaDir, readState } from '../core/state/state.js';
import { loadConfig } from '../core/config.js';
import { readTextIfExists } from '../core/util/fs.js';
import { findProjectRoot } from './project.js';
import { relativeTime } from './time.js';
import { ADAPTERS } from '../agents/registry.js';
import { ATHENA_VERSION } from './version.js';
import { findRunningInstance } from './instance.js';
import { whichExecutable } from './which.js';
import { hookCommand } from '../agents/common/hooks.js';
import { readRecentEvents } from './agent-activity.js';

export interface Check {
  area: string;
  level: 'ok' | 'warn' | 'error' | 'info';
  message: string;
  hint?: string;
}

export async function runDoctor(cwd: string): Promise<{ checks: Check[]; root: string | null }> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
  const nodeOk = major > 22 || (major === 22 && minor >= 12);
  add({ area: 'CLI', level: nodeOk ? 'ok' : 'error', message: `Athena ${ATHENA_VERSION} on Node.js ${process.versions.node} (${process.platform}/${process.arch})`, hint: nodeOk ? undefined : 'Athena requires Node.js >= 22.12' });

  const root = await findProjectRoot(cwd);
  const projectRoot = root ?? cwd;

  if (await gitAvailable()) {
    add({ area: 'Git', level: (await isGitRepo(projectRoot)) ? 'ok' : 'warn', message: (await isGitRepo(projectRoot)) ? 'Git repository detected' : 'Not a Git repository', hint: (await isGitRepo(projectRoot)) ? undefined : 'Change detection and knowledge history work best in a Git repository.' });
  } else {
    add({ area: 'Git', level: 'warn', message: 'git executable not found', hint: 'Install Git to enable change detection and knowledge history.' });
  }

  if (!root) {
    add({ area: 'Project', level: 'error', message: 'Athena is not initialized here', hint: 'Run `athena init` in the project root.' });
    return { checks, root };
  }
  add({ area: 'Project', level: 'ok', message: root });

  const dir = athenaDir(root);
  try {
    await fs.access(dir, constants.R_OK | constants.W_OK);
    add({ area: 'Knowledge directory', level: 'ok', message: '.athena/ is readable and writable' });
  } catch {
    add({ area: 'Knowledge directory', level: 'error', message: '.athena/ is not writable', hint: 'Check file permissions.' });
  }

  const cfg = await loadConfig(root);
  if (cfg.warning) add({ area: 'Configuration', level: 'warn', message: cfg.warning });

  const st = await readState(dir);
  if (st.kind === 'ok') add({ area: 'State', level: 'ok', message: `state.json valid (analyzed ${relativeTime(st.state.analyzedAt)})` });
  else if (st.kind === 'missing') add({ area: 'State', level: 'error', message: 'state.json missing', hint: 'Run `athena analyze`.' });
  else add({ area: 'State', level: 'error', message: `state.json corrupted: ${st.reason}`, hint: 'Run `athena analyze` (the file is backed up and rebuilt).' });

  const missing: string[] = [];
  const malformed: string[] = [];
  for (const d of KNOWLEDGE_DOCS) {
    const text = await readTextIfExists(path.join(dir, d.file));
    if (text === null) missing.push(d.file);
    else if (d.id !== 'rules' && (text.match(/athena:generated:start/g)?.length ?? 0) !== parseBlocks(text).length) malformed.push(d.file);
  }
  add({ area: 'Knowledge files', level: missing.length ? 'error' : 'ok', message: missing.length ? `Missing: ${missing.join(', ')}` : `${KNOWLEDGE_DOCS.length} knowledge files present`, hint: missing.length ? 'Run `athena analyze` to regenerate missing files.' : undefined });
  if (malformed.length) add({ area: 'Knowledge files', level: 'warn', message: `Unmatched generated-section markers in: ${malformed.join(', ')}`, hint: 'Those sections are treated as developer content and will not be refreshed.' });

  const rulesText = await readTextIfExists(path.join(dir, 'rules.md'));
  if (rulesText !== null) {
    const rules = listRules(parseRules(rulesText));
    const enabled = rules.filter((r) => r.enabled).length;
    add({ area: 'Rules', level: rules.length ? 'ok' : 'warn', message: `${enabled} enabled, ${rules.length - enabled} disabled`, hint: rules.length ? undefined : 'rules.md has no rules. Add some with `athena rules add`.' });
  }

  const stateAgents = st.kind === 'ok' ? st.state.agents : {};
  for (const a of ADAPTERS) {
    const configured = stateAgents[a.id]?.configured;
    if (!configured) {
      add({ area: a.displayName, level: 'info', message: 'Integration not configured', hint: `Enable with \`athena agents add ${a.id}\`.` });
      continue;
    }
    for (const c of await a.check(root)) add({ area: a.displayName, level: c.level, message: c.message.replace(/^[^:]+:\s*/, '') });
  }

  // Hooks invoke the `athena` executable, so it must be resolvable from the agent's environment.
  const hooksConfigured = ADAPTERS.some((a) => a.capabilities.hooks && stateAgents[a.id]?.configured);
  if (hooksConfigured) {
    const cmd = hookCommand();
    const resolved = await whichExecutable(cmd);
    add(
      resolved
        ? { area: 'Agent hooks', level: 'ok', message: `\`${cmd}\` resolves to ${resolved}` }
        : { area: 'Agent hooks', level: 'warn', message: `\`${cmd}\` is not on PATH — agent hooks cannot report activity`, hint: 'Install globally (`npm i -g athena-cli`) or set ATHENA_HOOK_COMMAND to an absolute path and re-run `athena agents add`.' },
    );
    const events = await readRecentEvents(root, 1);
    add({ area: 'Agent hooks', level: 'info', message: events.length ? `Last agent event: ${relativeTime(events[0]!.ts)}` : 'No agent activity recorded yet (hooks fire when an agent runs)' });
  }

  const running = await findRunningInstance(root);
  add(
    running
      ? { area: 'Local server', level: 'ok', message: `Running on ${running.host}:${running.port} (pid ${running.pid})`, hint: 'Run `athena open` to get the access link.' }
      : { area: 'Local server', level: 'info', message: 'Not running', hint: 'Start the web UI with `athena open`.' },
  );
  if (running && !['127.0.0.1', '::1', 'localhost'].includes(running.host)) {
    add({ area: 'Local server', level: 'warn', message: `Bound to ${running.host} — reachable beyond this machine` });
  }
  return { checks, root };
}

