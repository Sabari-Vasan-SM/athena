import { Command, Option } from 'commander';
import { ATHENA_VERSION } from '../services/version.js';
import { AthenaError, EXIT } from '../services/errors.js';
import * as ui from './ui/term.js';
import type { GlobalOptions } from './context.js';
import { initCommand } from './commands/init.js';
import { analyzeCommand } from './commands/analyze.js';
import { statusCommand } from './commands/status.js';
import { doctorCommand } from './commands/doctor.js';
import { rulesAddCommand, rulesDisableCommand, rulesEditCommand, rulesEnableCommand, rulesListCommand, rulesRemoveCommand } from './commands/rules.js';
import { cleanCommand } from './commands/clean.js';
import { openCommand } from './commands/open.js';
import { syncCommand } from './commands/sync.js';
import { eventCommand } from './commands/event.js';
import { activityCommand } from './commands/activity.js';
import { securityCommand } from './commands/security.js';
import { reviewCommand } from './commands/review.js';
import { watchCommand } from './commands/watch.js';
import { agentsAddCommand, agentsListCommand, agentsRemoveCommand } from './commands/agents.js';

const controller = new AbortController();
let interrupted = false;

function onSignal(): void {
  if (interrupted) process.exit(EXIT.INTERRUPTED); // second Ctrl+C: exit immediately
  interrupted = true;
  controller.abort(new Error('Interrupted'));
  if (process.stdout.isTTY) process.stdout.write('\x1b[?25h');
  if (!ui.isJson()) process.stderr.write(`\n${ui.c.yellow('Interrupted.')} ${ui.dim(ui.getInterruptMessage())}\n`);
}
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

const PLANNED: Array<{ name: string; description: string; phase: number }> = [
  { name: 'architecture', description: 'Explore the project graph and architecture', phase: 6 },
];

function globals(cmd: Command): GlobalOptions {
  return cmd.optsWithGlobals() as GlobalOptions;
}

function run<A extends unknown[]>(fn: (...args: A) => Promise<void | number>) {
  return async (...args: A) => {
    const cmd = args[args.length - 1] as Command;
    const g = globals(cmd);
    ui.setOutputMode({ json: g.json, quiet: g.quiet });
    const code = await fn(...args);
    if (typeof code === 'number') process.exitCode = code;
  };
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('athena')
    .description('Athena — local-first project intelligence for AI coding agents')
    .version(ATHENA_VERSION, '-v, --version', 'Print the Athena version')
    .addOption(new Option('-C, --cwd <dir>', 'Run as if started in <dir>'))
    .option('--json', 'Machine-readable JSON output')
    .option('-q, --quiet', 'Only print warnings, errors and results')
    .option('--no-color', 'Disable colors (also respects NO_COLOR)')
    .showHelpAfterError('(run `athena --help` for usage)')
    .configureHelp({ sortSubcommands: false });

  program
    .command('init')
    .description('Analyze the project and create .athena/ knowledge')
    .option('--agents <list>', 'Agents to configure: comma-separated ids (claude-code, cursor, antigravity, agents-md), "all" or "none". Default: detected agents + AGENTS.md')
    .option('--no-agents', 'Do not configure any agent integration')
    .option('--dry-run', 'Analyze and show what would be written, without writing')
    .action(
      run(async (cmdOpts: { agents?: string | boolean; dryRun?: boolean }, cmd: Command) => {
        const g = globals(cmd);
        await initCommand({ ...g, agents: typeof cmdOpts.agents === 'string' ? cmdOpts.agents : undefined, noAgents: cmdOpts.agents === false, dryRun: cmdOpts.dryRun, signal: controller.signal });
      }),
    );

  program
    .command('analyze')
    .description('Re-analyze the project and refresh generated knowledge (developer edits are preserved)')
    .option('--force', 'Regenerate sections even if they were edited by hand')
    .option('--agents <list>', 'Reconfigure these agent integrations')
    .action(run(async (o: { force?: boolean; agents?: string }, cmd: Command) => analyzeCommand({ ...globals(cmd), ...o, signal: controller.signal })));

  program
    .command('sync')
    .description('Review and apply knowledge updates for changes since the last analysis')
    .option('-y, --yes', 'Apply without asking')
    .option('--dry-run', 'Show the plan without writing')
    .option('--check', 'Exit with code 1 if knowledge is out of date (for CI/hooks)')
    .option('--diff', 'Print full diffs of proposed document changes')
    .option('--force', 'Also regenerate sections that were edited by hand')
    .action(run(async (o: { yes?: boolean; dryRun?: boolean; check?: boolean; diff?: boolean; force?: boolean }, cmd: Command) => syncCommand({ ...globals(cmd), ...o, signal: controller.signal })));

  program
    .command('watch')
    .description('Watch the project and propose knowledge updates as files change')
    .option('--auto-apply', 'Apply updates automatically instead of proposing them')
    .option('--debounce <ms>', 'Quiet period before checking changes (default 1500)')
    .action(run(async (o: { autoApply?: boolean; debounce?: string }, cmd: Command) => watchCommand({ ...globals(cmd), ...o, signal: controller.signal })));

  program
    .command('security')
    .description('Scan dependencies with the audit tools installed for this project, and report secret findings')
    .option('--no-audit', 'Skip dependency audits (report secrets only)')
    .option('--fail-on <severity>', 'Exit 1 when a finding at or above this severity exists (critical, high, moderate, low)')
    .option('--last', 'Show the last scan instead of running a new one')
    .action(run(async (o: { audit?: boolean; failOn?: string; last?: boolean }, cmd: Command) => securityCommand({ ...globals(cmd), noAudit: o.audit === false, failOn: o.failOn, last: o.last, signal: controller.signal })));

  program
    .command('review')
    .description('Check the current diff for facts worth reviewing, and list the project rules and checklist')
    .option('--base <ref>', 'Compare against this Git ref instead of the working tree')
    .option('--no-sync', 'Skip the knowledge freshness check')
    .option('--no-fail', 'Always exit 0, even when blockers are found')
    .action(run(async (o: { base?: string; sync?: boolean; fail?: boolean }, cmd: Command) => reviewCommand({ ...globals(cmd), base: o.base, noSync: o.sync === false, noFail: o.fail === false, signal: controller.signal })));

  program
    .command('status')
    .description('Show knowledge health and changes since the last analysis')
    .action(run(async (_o: unknown, cmd: Command) => statusCommand({ ...globals(cmd), signal: controller.signal })));

  program
    .command('doctor')
    .description('Check the Athena installation, project and integrations')
    .action(run(async (_o: unknown, cmd: Command) => doctorCommand(globals(cmd))));

  const rules = program.command('rules').description('List and edit project rules (.athena/rules.md)');
  rules.command('list', { isDefault: true }).description('List rules with their numbers').action(run(async (_o: unknown, cmd: Command) => rulesListCommand(globals(cmd))));
  rules.command('add <text>').description('Add a rule').option('-s, --section <name>', 'Section heading', 'General').action(run(async (text: string, o: { section?: string }, cmd: Command) => rulesAddCommand(text, { ...globals(cmd), ...o })));
  rules.command('edit <number> <text>').description('Replace the text of a rule').action(run(async (n: string, text: string, _o: unknown, cmd: Command) => rulesEditCommand(n, text, globals(cmd))));
  rules.command('enable <number>').description('Enable a rule').action(run(async (n: string, _o: unknown, cmd: Command) => rulesEnableCommand(n, globals(cmd))));
  rules.command('disable <number>').description('Disable a rule without deleting it').action(run(async (n: string, _o: unknown, cmd: Command) => rulesDisableCommand(n, globals(cmd))));
  rules.command('remove <number>').description('Delete a rule').action(run(async (n: string, _o: unknown, cmd: Command) => rulesRemoveCommand(n, globals(cmd))));

  const agents = program.command('agents').description('Manage AI agent integrations');
  agents.command('list', { isDefault: true }).description('Show supported agents and integration status').action(run(async (_o: unknown, cmd: Command) => agentsListCommand(globals(cmd))));
  agents.command('add <agents...>').description('Configure integrations (claude-code, cursor, antigravity, agents-md, or "all")').action(run(async (names: string[], _o: unknown, cmd: Command) => agentsAddCommand(names, globals(cmd))));
  agents.command('remove <agents...>').description('Remove Athena-managed integration files/blocks').action(run(async (names: string[], _o: unknown, cmd: Command) => agentsRemoveCommand(names, globals(cmd))));

  program
    .command('open')
    .description('Start (or reuse) the local web UI and open it in your browser')
    .option('-p, --port <port>', 'Port to bind (default: first free port from 7432)')
    .option('--host <host>', 'Interface to bind (default: 127.0.0.1)')
    .option('--allow-remote', 'Allow binding to a non-loopback interface')
    .option('--no-open', 'Do not launch a browser')
    .option('--no-watch', 'Do not watch the project for changes')
    .action(run(async (o: { port?: string; host?: string; open?: boolean; allowRemote?: boolean; watch?: boolean }, cmd: Command) => openCommand({ ...globals(cmd), ...o, signal: controller.signal })));

  program
    .command('activity')
    .description('Show AI agent activity observed through hooks')
    .option('-n, --limit <count>', 'Number of events to show (default 30)')
    .option('--agent <id>', 'Only show events from this agent')
    .action(run(async (o: { limit?: string; agent?: string }, cmd: Command) => activityCommand({ ...globals(cmd), ...o })));

  program
    .command('event')
    .description('Record an agent hook event (called by AI coding agents, reads JSON on stdin)')
    .option('--agent <id>', 'Agent that fired the hook')
    .option('--hook <name>', 'Hook event name')
    .option('--athena-hook', 'Marker used to identify Athena-managed hook entries')
    .option('--verbose-errors', 'Print errors to stderr (hooks stay silent by default)')
    .action(
      run(async (o: { agent?: string; hook?: string; verboseErrors?: boolean }, cmd: Command) => {
        const g = globals(cmd);
        await eventCommand({ agent: o.agent, hook: o.hook, cwd: g.cwd, verbose: o.verboseErrors });
      }),
    );

  program
    .command('clean')
    .description('Remove .athena/ and Athena agent integrations')
    .option('-y, --yes', 'Skip confirmation')
    .option('--keep-agents', 'Keep agent integration files/blocks')
    .action(run(async (o: { yes?: boolean; keepAgents?: boolean }, cmd: Command) => cleanCommand({ ...globals(cmd), ...o })));

  program
    .command('version')
    .description('Print the Athena version')
    .action(run(async (_o: unknown, cmd: Command) => {
      if (globals(cmd).json) ui.json({ version: ATHENA_VERSION, node: process.versions.node, platform: process.platform });
      else ui.line(ATHENA_VERSION);
    }));

  for (const p of PLANNED) {
    program
      .command(p.name)
      .description(`${p.description} ${ui.dim(`(planned — Phase ${p.phase})`)}`)
      .allowUnknownOption()
      .allowExcessArguments()
      .action(
        run(async (_o: unknown, cmd: Command) => {
          if (globals(cmd).json) ui.json({ available: false, command: p.name, plannedPhase: p.phase });
          else ui.line(`${ui.c.yellow('Not available yet')} — \`athena ${p.name}\` is planned for Phase ${p.phase}.`);
          return EXIT.NOT_AVAILABLE;
        }),
      );
  }
  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (process.stdout.isTTY) process.stdout.write('\x1b[?25h');
    if (controller.signal.aborted) {
      process.exitCode = EXIT.INTERRUPTED;
      return;
    }
    if (err instanceof AthenaError) {
      if (ui.isJson()) ui.json({ error: err.message, hint: err.hint });
      else {
        process.stderr.write(`${ui.c.red(`${ui.sym.err} ${err.message}`)}\n`);
        if (err.hint) process.stderr.write(`  ${ui.dim(err.hint)}\n`);
      }
      process.exitCode = err.exitCode;
      return;
    }
    process.stderr.write(`${ui.c.red(`${ui.sym.err} Unexpected error: ${(err as Error).message}`)}\n`);
    if (process.env.ATHENA_DEBUG) process.stderr.write(`${(err as Error).stack}\n`);
    else process.stderr.write(`  ${ui.dim('Set ATHENA_DEBUG=1 for a stack trace. Please report this issue.')}\n`);
    process.exitCode = EXIT.ERROR;
  }
}

await main();
