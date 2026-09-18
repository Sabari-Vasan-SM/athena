import { readRecentEvents, summarizeSessions } from '../../services/agent-activity.js';
import { listAgents } from '../../services/agents.js';
import { requireProjectRoot, type GlobalOptions } from '../context.js';
import * as ui from '../ui/term.js';

export interface ActivityOptions extends GlobalOptions {
  limit?: string;
  agent?: string;
}

const STATE_COLOR: Record<string, (s: string) => string> = {
  ANALYZING: ui.c.cyan,
  PLANNING: ui.c.magenta,
  CODING: ui.c.blue,
  TESTING: ui.c.yellow,
  REVIEWING: ui.c.cyan,
  SUCCESS: ui.c.green,
  IDLE: ui.c.dim,
};

export async function activityCommand(opts: ActivityOptions): Promise<void> {
  const root = await requireProjectRoot(opts);
  const limit = Math.min(Math.max(Number(opts.limit ?? 30) || 30, 1), 500);
  const all = await readRecentEvents(root, 500);
  const events = (opts.agent ? all.filter((e) => e.agent === opts.agent) : all).slice(-limit);

  if (ui.isJson()) {
    ui.json({ events, sessions: summarizeSessions(all) });
    return;
  }
  ui.heading('AI Agent Activity');
  ui.line();
  if (!events.length) {
    const agents = await listAgents(root);
    const reporting = agents.filter((a) => a.activityObservation === 'hooks');
    ui.line(ui.dim('No agent activity recorded yet.'));
    ui.line(ui.dim(reporting.length ? `Hooks are installed for: ${reporting.map((a) => a.name).join(', ')}. Events appear once an agent runs in this project.` : 'Install hooks with `athena agents add claude-code` (or cursor) to record agent activity.'));
    return;
  }
  for (const e of events) {
    const time = new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const color = STATE_COLOR[e.state] ?? ((s: string) => s);
    ui.line(`${ui.dim(time)}  ${color(ui.sym.dot)} ${ui.c.bold(e.agent)} ${ui.dim('·')} ${e.message}`);
  }
  ui.line();
  for (const s of summarizeSessions(all).slice(0, 5)) {
    ui.line(ui.dim(`${s.agent} ${s.session ? `(${s.session.slice(0, 8)})` : ''}: ${s.events} events, last ${ui.relativeTime(s.lastEventAt)}`));
  }
  ui.line(ui.dim('Only hook-reported tool use is shown. Athena cannot see agent reasoning.'));
}
