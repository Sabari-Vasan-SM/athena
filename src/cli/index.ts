// Entry point. Agent hooks run `athena event …` on every tool call, so that path
// skips commander and every other command's dependencies; everything else loads
// the full program, whose commands import their modules only when they run.

async function runEvent(args: string[]): Promise<boolean> {
  const { parseEventArgs, eventCommand } = await import('./commands/event.js');
  const opts = parseEventArgs(args);
  if (!opts) return false; // unusual arguments: let the full CLI handle (and report) them
  // Hooks must not be broken by Ctrl+C in the agent's terminal: the first signal
  // lets the event finish (reading stdin is bounded by a timeout); a second one
  // exits, as the full CLI does.
  let signalled = false;
  const onSignal = () => {
    if (signalled) process.exit(130);
    signalled = true;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  await eventCommand(opts);
  return true;
}

/** An event that cannot even load must still exit 0 and stay off stdout. */
function eventFailed(err: unknown): true {
  if (process.argv.includes('--verbose-errors')) process.stderr.write(`athena event: ${(err as Error)?.message ?? err}\n`);
  return true;
}

if (process.argv[2] !== 'event' || !(await runEvent(process.argv.slice(3)).catch(eventFailed))) {
  const { main } = await import('./program.js');
  await main();
}
