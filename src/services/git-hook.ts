import { promises as fs } from 'node:fs';
import path from 'node:path';
import { git } from '../core/git/git.js';
import { readTextIfExists } from '../core/util/fs.js';
import { hookCommand } from '../agents/common/hooks.js';
import { AthenaError, conflict } from './errors.js';

/**
 * Git pre-commit hook management.
 *
 * Athena only ever owns the lines between HOOK_START and HOOK_END. A hook file
 * that Athena did not create keeps every other line; Athena's block is placed
 * right after the shebang so it runs before any `exit` in the developer's script.
 */
export const HOOK_START = '# athena:start';
export const HOOK_END = '# athena:end';

/** The line to put in husky / lefthook / pre-commit configs instead of installing a hook file. */
export const HOOK_MANAGER_COMMAND = 'npx --no-install athena sync --check';

const SHELL_SHEBANG = /^#!\s*(?:\/usr\/bin\/env\s+)?(?:\/usr\/local\/bin\/|\/usr\/bin\/|\/bin\/)?(?:sh|bash|dash|zsh|ksh)(?:\s|$)/;
const HOOK_MANAGERS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'husky', pattern: /husky/i },
  { name: 'lefthook', pattern: /lefthook/i },
  { name: 'pre-commit', pattern: /pre-commit\.com|INSTALL_PYTHON|pre_commit/ },
  { name: 'simple-git-hooks', pattern: /simple-git-hooks/i },
  { name: 'overcommit', pattern: /overcommit/i },
];

export interface GitHookLocation {
  /** Absolute path of the working tree top level. */
  topLevel: string;
  /** Absolute hooks directory (honours core.hooksPath and linked worktrees). */
  hooksDir: string;
  hookFile: string;
  /** Project root relative to the top level ('' when they are the same). */
  projectPrefix: string;
}

export interface GitHookStatus extends GitHookLocation {
  installed: boolean;
  review: boolean;
  /** True when the whole file is Athena's (created by `athena git-hook install`). */
  ownsFile: boolean;
  /** A hook manager that appears to own the hooks directory or file, if any. */
  manager: string | null;
}

export type GitHookAction = 'created' | 'updated' | 'unchanged' | 'added-to-existing';

export async function locateHook(projectRoot: string): Promise<GitHookLocation> {
  const top = await git(projectRoot, ['rev-parse', '--show-toplevel']);
  if (!top.ok || !top.stdout.trim()) throw new AthenaError('`athena git-hook` needs a Git repository.', 'Run `git init` first, or use `athena sync --check` in your own tooling.');
  const topLevel = await fs.realpath(top.stdout.trim());
  const hooks = await git(topLevel, ['rev-parse', '--git-path', 'hooks']);
  if (!hooks.ok || !hooks.stdout.trim()) throw new AthenaError('Could not find the Git hooks directory.');
  const hooksDir = path.resolve(topLevel, hooks.stdout.trim());
  const projectPrefix = path.relative(topLevel, await fs.realpath(projectRoot)).split(path.sep).join('/');
  return { topLevel, hooksDir, hookFile: path.join(hooksDir, 'pre-commit'), projectPrefix };
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The shell block Athena owns inside the pre-commit hook. */
export function renderHookBlock(opts: { projectPrefix: string; review: boolean; command?: string }): string {
  const cmd = opts.command ?? hookCommand();
  const probe = cmd.split(/\s+/)[0]!;
  const cwdArg = opts.projectPrefix ? ` -C ${shQuote(opts.projectPrefix)}` : '';
  const athena = `${cmd} --no-color${cwdArg}`;
  const lines = [
    `${HOOK_START} (added by \`athena git-hook install\`; remove with \`athena git-hook uninstall\`)`,
    `if command -v ${probe} >/dev/null 2>&1; then`,
    '  athena_rc=0',
    `  athena_out=$(${athena} sync --check --quiet 2>&1) || athena_rc=$?`,
    '  if [ "$athena_rc" -eq 3 ]; then',
    "    echo 'athena: Athena is not initialized in this project; skipping the knowledge check.' >&2",
    '  elif [ "$athena_rc" -ne 0 ]; then',
    `    printf '%s\\n' "$athena_out" >&2`,
    "    echo 'athena: commit blocked: .athena/ knowledge is out of date. Run `athena sync`, stage .athena/ and commit again (or skip once with `git commit --no-verify`).' >&2",
    '    exit 1',
    '  fi',
  ];
  if (opts.review) {
    lines.push(
      '  athena_rc=0',
      `  athena_out=$(${athena} review --no-sync 2>&1) || athena_rc=$?`,
      '  if [ "$athena_rc" -ne 0 ] && [ "$athena_rc" -ne 3 ]; then',
      `    printf '%s\\n' "$athena_out" >&2`,
      "    echo 'athena: commit blocked: `athena review` found blockers (possible secrets or env files). Fix them, or skip once with `git commit --no-verify`.' >&2",
      '    exit 1',
      '  fi',
    );
  }
  lines.push('else', `  echo 'athena: \`${probe}\` not found on PATH; skipping Athena pre-commit checks.' >&2`, 'fi', HOOK_END);
  return `${lines.join('\n')}\n`;
}

interface ParsedHook {
  before: string;
  block: string;
  after: string;
}

function parseHook(text: string): ParsedHook | null {
  const start = text.indexOf(`${HOOK_START}`);
  if (start < 0) return null;
  const lineStart = text.lastIndexOf('\n', start) + 1;
  const endIdx = text.indexOf(HOOK_END, start);
  if (endIdx < 0) return null;
  let blockEnd = endIdx + HOOK_END.length;
  if (text[blockEnd] === '\n') blockEnd++;
  return { before: text.slice(0, lineStart), block: text.slice(lineStart, blockEnd), after: text.slice(blockEnd) };
}

function detectManager(loc: GitHookLocation, text: string | null): string | null {
  const rel = path.relative(loc.topLevel, loc.hooksDir).split(path.sep);
  if (rel.includes('.husky')) return 'husky';
  if (text) for (const m of HOOK_MANAGERS) if (m.pattern.test(text)) return m.name;
  return null;
}

const NEW_FILE_HEADER = '#!/bin/sh\n';

export async function hookStatus(projectRoot: string): Promise<GitHookStatus> {
  const loc = await locateHook(projectRoot);
  const text = await readTextIfExists(loc.hookFile);
  const parsed = text ? parseHook(text) : null;
  return {
    ...loc,
    installed: Boolean(parsed),
    review: Boolean(parsed?.block.includes(' review ')),
    ownsFile: Boolean(parsed && `${parsed.before}${parsed.after}`.trim() === NEW_FILE_HEADER.trim()),
    manager: detectManager(loc, text && parsed ? `${parsed.before}${parsed.after}` : text),
  };
}

export async function installHook(projectRoot: string, opts: { review?: boolean } = {}): Promise<{ action: GitHookAction; status: GitHookStatus }> {
  const loc = await locateHook(projectRoot);
  const block = renderHookBlock({ projectPrefix: loc.projectPrefix, review: Boolean(opts.review) });
  const text = await readTextIfExists(loc.hookFile);
  let next: string;
  let action: GitHookAction;
  const parsed = text ? parseHook(text) : null;
  if (text === null) {
    const manager = detectManager(loc, null);
    if (manager) throw managedError(manager);
    next = `${NEW_FILE_HEADER}\n${block}`;
    action = 'created';
  } else if (parsed) {
    next = `${parsed.before}${block}${parsed.after}`;
    action = next === text ? 'unchanged' : 'updated';
  } else {
    const manager = detectManager(loc, text);
    if (manager) throw managedError(manager);
    const firstLine = text.split('\n', 1)[0]!;
    if (!SHELL_SHEBANG.test(firstLine)) {
      throw conflict(
        `${path.relative(loc.topLevel, loc.hookFile) || loc.hookFile} already exists and is not a shell script, so Athena will not modify it.`,
        `Add this command to your pre-commit hook yourself: ${HOOK_MANAGER_COMMAND}`,
      );
    }
    // Insert right after the shebang so Athena runs before any `exit` in the existing script.
    const rest = text.slice(firstLine.length + 1);
    next = `${firstLine}\n${block}\n${rest}`;
    action = 'added-to-existing';
  }
  if (action !== 'unchanged') {
    await fs.mkdir(loc.hooksDir, { recursive: true });
    await fs.writeFile(loc.hookFile, next, 'utf8');
  }
  await fs.chmod(loc.hookFile, 0o755);
  return { action, status: await hookStatus(projectRoot) };
}

export async function uninstallHook(projectRoot: string): Promise<{ removed: boolean; deletedFile: boolean; status: GitHookStatus }> {
  const loc = await locateHook(projectRoot);
  const text = await readTextIfExists(loc.hookFile);
  const parsed = text ? parseHook(text) : null;
  if (!parsed) return { removed: false, deletedFile: false, status: await hookStatus(projectRoot) };
  let rest = parsed.after;
  // Drop the blank line Athena added after its block, restoring the original bytes.
  if (rest.startsWith('\n')) rest = rest.slice(1);
  const remaining = `${parsed.before}${rest}`;
  let deletedFile = false;
  if (!remaining.trim() || remaining.trim() === NEW_FILE_HEADER.trim()) {
    await fs.rm(loc.hookFile, { force: true });
    deletedFile = true;
  } else {
    await fs.writeFile(loc.hookFile, remaining, 'utf8');
  }
  return { removed: true, deletedFile, status: await hookStatus(projectRoot) };
}

function managedError(manager: string): AthenaError {
  return conflict(
    `Git hooks in this repository are managed by ${manager}, so Athena will not write a hook file.`,
    `Add this line to your ${manager} pre-commit configuration instead: ${HOOK_MANAGER_COMMAND}`,
  );
}
