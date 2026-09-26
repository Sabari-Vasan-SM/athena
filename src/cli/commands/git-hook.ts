import path from 'node:path';
import { HOOK_MANAGER_COMMAND, hookStatus, installHook, uninstallHook, type GitHookStatus } from '../../services/git-hook.js';
import { EXIT } from '../../services/errors.js';
import { requireProjectRoot, type GlobalOptions } from '../context.js';
import * as ui from '../ui/term.js';

const rel = (s: GitHookStatus) => path.relative(s.topLevel, s.hookFile).split(path.sep).join('/') || s.hookFile;

function managerTip(): void {
  ui.line(ui.dim(`Using husky, lefthook or pre-commit? Add \`${HOOK_MANAGER_COMMAND}\` to its pre-commit config instead.`));
}

export async function gitHookInstallCommand(opts: GlobalOptions & { review?: boolean }): Promise<number> {
  const root = await requireProjectRoot(opts);
  const { action, status } = await installHook(root, { review: opts.review });
  if (ui.isJson()) {
    ui.json({ action, ...status });
    return EXIT.OK;
  }
  const what = status.review ? 'knowledge check + review' : 'knowledge check';
  const message: Record<typeof action, string> = {
    created: `Installed the pre-commit hook (${what}) at ${rel(status)}`,
    updated: `Updated Athena's block in ${rel(status)} (${what})`,
    unchanged: `Pre-commit hook already installed at ${rel(status)} (${what})`,
    'added-to-existing': `Added Athena's block to your existing ${rel(status)} (${what}); the rest of the hook is unchanged`,
  };
  ui.ok(message[action]);
  ui.info(ui.dim('Commits are blocked when .athena/ knowledge is out of date. Teammates without Athena installed are not blocked.'));
  if (!ui.isQuiet()) managerTip();
  return EXIT.OK;
}

export async function gitHookUninstallCommand(opts: GlobalOptions): Promise<number> {
  const root = await requireProjectRoot(opts);
  const r = await uninstallHook(root);
  if (ui.isJson()) {
    ui.json({ removed: r.removed, deletedFile: r.deletedFile, ...r.status });
    return EXIT.OK;
  }
  if (!r.removed) ui.line(`No Athena pre-commit hook found in ${rel(r.status)}.`);
  else if (r.deletedFile) ui.ok(`Removed ${rel(r.status)}`);
  else ui.ok(`Removed Athena's block from ${rel(r.status)}; the rest of the hook is unchanged`);
  return EXIT.OK;
}

export async function gitHookStatusCommand(opts: GlobalOptions): Promise<number> {
  const root = await requireProjectRoot(opts);
  const s = await hookStatus(root);
  if (ui.isJson()) {
    ui.json(s);
    return EXIT.OK;
  }
  if (s.installed) {
    ui.ok(`Installed in ${rel(s)} (${s.review ? 'knowledge check + review' : 'knowledge check'}${s.ownsFile ? '' : '; shared with your own hook'})`);
  } else {
    ui.line(`Not installed ${ui.dim(`(${rel(s)})`)}`);
    if (s.manager) ui.line(ui.dim(`Hooks here are managed by ${s.manager}: add \`${HOOK_MANAGER_COMMAND}\` to its pre-commit config.`));
    else ui.line(ui.dim('Run `athena git-hook install` (add `--review` to also block commits with secrets or env files).'));
  }
  return EXIT.OK;
}
