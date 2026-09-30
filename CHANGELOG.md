# Changelog

## Unreleased

### Performance

- `athena open` reuses parsed `.athena` artifacts: a new `ProjectSession` loads `model.json`, `graph.json`, `security-scan.json` and `state.json` once and re-reads them only when the file changes (inode, size or mtime). The overview, graph, context, security and `athena security` paths share it, and the graph summary checks for `model.json` with a stat instead of parsing and validating the whole model.
- The event stream (`/api/events`) coalesces bursts into one write per 250 ms (intermediate activity states collapse to the latest), serializes each event once for all clients, and applies backpressure: a client that stops reading gets nothing more until its socket drains, keeps at most 100 queued events (oldest dropped) plus the latest activity, and then receives a `resync` frame with the number of events it missed. At most 16 event streams are open at once (503 beyond that).
- `GET /api/sync` no longer includes each proposed document's full diff; the Sync page fetches a diff from the new `GET /api/sync/:doc` only when the document is expanded.

### Changed

- The local server is split into route modules (`src/server/routes/*`) sharing one server context; routes, authentication, Host/Origin checks, security headers, CSP and rate limiting are unchanged.
- `GET /api/sync` returns the proposal without `documents[].diff` (reasons, changed and preserved sections, additions/deletions and `diffTruncated` are still included). New `GET /api/sync/:doc[?planId=…]` returns one proposed document's diff; the id must be a knowledge document in the current proposal (404 otherwise, 409 when `planId` is stale). `POST /api/sync/check` still returns the full plan.
- A corrupted `model.json` now gives a clear error with a hint (`model.json is corrupted (…)`, run `athena analyze`) instead of an internal error when starting a security scan from the web UI.
- Test, source, auth, API and schema path patterns now come from one module (`src/core/patterns.ts`). `athena review` recognizes more test layouts (`integration_tests/`, `androidTest/`, `test_driver/`, `*_test.dart`), and change impact recognizes the same test files as review plus test runner configs.

## 0.2.1 — 2026-09-30

Security release. Upgrading is recommended for everyone. After upgrading, run `athena sync` once (the `security.md` format changed) and, if you use the pre-commit hook with `--review`, run `athena git-hook install --review` again so it reviews staged changes.

### Breaking

- `athena review --base <ref>` exits with code 2 when the base can't be resolved or has no merge base with HEAD. Shallow CI clones need full history, e.g. `actions/checkout` with `fetch-depth: 0`.
- `ai.baseUrl` and `ai.consent` in the committed `.athena/config.json` are now ignored (with a warning in `athena ai status`, `athena ai enrich` and `athena doctor`). Move them to the environment (`ATHENA_AI_BASE_URL`, `ATHENA_AI_CONSENT=1`), `.athena/local.json` (gitignored), or your user config (`~/.config/athena/config.json`, `$XDG_CONFIG_HOME/athena/config.json`, or `%APPDATA%\athena\config.json` on Windows). `provider`, `model`, `mode` and `maxChars` still work from `.athena/config.json`.
- `--fail-on` now fails on unrated findings by default (`--unrated warn` to relax).
- `security-scan.json` and `athena security --json`: severity `unknown` has been renamed to `unrated`, in both findings and `counts`. Old scan files are still read. Tools that run once per input have a new optional `target` field (for example `pip-audit` per requirements file).
- The `security.md` format changed: the Fingerprint column was removed from Secret Management. Run `athena sync` to update it.

### Security

- `athena security --fail-on` now also fails when an audit tool ran but failed or timed out, since nothing was checked. A tool that isn't installed is still only reported. The web UI shows `unrated` findings.
- **AI credential exfiltration**: a repository could set its own `ai.baseUrl` and `ai.consent` in `.athena/config.json` and receive your API key and knowledge. Both are now read only from machine-local sources (env > `.athena/local.json` > user config), providers refuse a base URL without a trusted source, and an Ollama endpoint that isn't loopback counts as remote and needs consent.
- **Local server**: per-client rate limiting on `/api/*` (token bucket, 30 req/s, burst 120, 429 when exceeded); `--allow-remote` keeps the Host/Origin allowlist (bind address plus loopback) instead of disabling it, and warns that the connection is plain HTTP; `/api/context` clamps `maxChars` to 200,000; a failed security-scan start (e.g. missing `model.json`) no longer leaves every later scan stuck at 423; shutdown no longer hangs on open event streams.
- **MCP**: every tool that returns repository content redacts secret-looking values and wraps the text in `<athena-document path="…" trust="untrusted-data">` delimiters with a note that it is project data, not instructions (embedded delimiters are neutralized).
- **Agent hooks**: generated hook scripts quote `ATHENA_HOOK_COMMAND`, the agent name and the hook argument (POSIX single quotes; cmd.exe double quotes with `%` doubled), so paths with spaces, quotes, `$` or `&` can't break or inject into the script.
- **Agent activity log**: commands and messages are additionally masked for `Authorization: Bearer|Basic …`, `--password …`, `mysql -p…` and `scheme://user:password@` credentials; rotation renames the log to `.agent-events.1.jsonl` (one generation kept) instead of rewriting it, so concurrent appends are never lost, and recent-event reads include the previous generation.
- **GitHub Action**: the PR comment is only updated when it was written by `github-actions[bot]` and carries the versioned `<!-- athena-review:v1 -->` marker (the old marker is still recognized from the same bot), so another user's comment can't be hijacked. Review findings now also produce `::error`/`::warning` file annotations (with line numbers where available, escaped, never secret values).
- **Web UI**: the Security and graph views refresh after `security.*` and `graph.*` events.
- `athena review` scans each run of consecutive added lines as one block, so multi-line secrets such as PEM private keys are now flagged (at the line where they start, never with the value).
- `athena review` fails closed on Git errors: a failing `git` command, an unknown `--base`, or a missing merge base (shallow clone) is now an error (exit 2) instead of an empty, "clean" review. Ctrl+C stops running `git` processes.
- The diff is streamed with a 64 MB budget; a larger diff fails the review instead of being silently truncated.
- `--base` now compares `merge-base(base, HEAD)..HEAD` for both the file list and the patch, so commits that exist only on the base branch no longer appear in the review.
- The dependency check uses the analyzer's manifest parsers (`name =` / `version =` are no longer reported as dependencies), and a new manifest reports all of its dependencies.
- New `athena review --staged` reviews the index (contents read from Git, untracked files ignored). The `--review` pre-commit hook now runs `athena review --staged --no-sync`, so unstaged or untracked files (such as a local `.env`) no longer block commits while staged secrets still do, and a review that can't run blocks the commit with its own message. Re-run `athena git-hook install --review` to update an installed hook.
- Untracked files are read once, never through a symlink that points outside the project, and only up to 512 KB. Files that could not be checked are listed in a `skipped` warning (JSON: `incomplete`, `skipped`), and the review no longer says it found nothing to flag.
- `athena security --fail-on` now counts findings the tool did not rate. pip-audit and govulncheck never report severity, so these findings were stored as `unknown` and never failed the build. They are now `unrated` and fail by default; `--unrated warn` reports them without failing.
- pnpm audit output is parsed in pnpm's own advisories format. Before this, every pnpm project was reported as having no vulnerable dependencies.
- An npm audit that reports an error (for example when offline) is now marked `failed` with npm's message. Before, it was reported as a clean audit. The same applies to empty or unrecognised output from any audit tool. npm exiting 1 because it found vulnerabilities still counts as a successful run.
- govulncheck's multi-line JSON output is now parsed, and a vulnerability is reported only when govulncheck returns a finding for it. The title says whether the vulnerable code is called, only imported, or only required.
- pip-audit now audits each `requirements*.txt` (`-r <file>`, at most 10), or a PEP 621 `pyproject.toml` as a project path. It no longer audits whichever Python environment is active. With nothing to audit, pip-audit is reported as `unavailable` with the reason "no requirements file to audit".
- `athena security` scans the project files for secrets on every run. Before, it took the secret count from the cached `model.json`, so the count could be out of date.
- Rewrote the secret patterns to remove catastrophic backtracking (ReDoS). `generic-secret-assignment` took over 1 s on 40 KB of crafted input. It now finds a bounded quoted value first, then checks the identifier before it (at most 64 chars) for a keyword. Private keys are matched by finding the BEGIN header and then the END within 16 KB. Open-ended token patterns now use bounded or lookbehind-anchored matches. Generic keyword patterns skip lines longer than 4096 characters. CI checks every pattern for time on crafted input and with the `recheck` ReDoS analyzer.
- `security.md`, which is committed, no longer lists a fingerprint for each secret. The old value was an unsalted, truncated SHA-256 of the secret, so anyone could test guessed values against it offline. Secret fingerprints in `model.json` are now an HMAC keyed with the per-machine salt in `.athena/local.json` (gitignored), or with a random per-process key.

## 0.2.0 — 2026-09-26

- **Website link**: the terminal header, footer and next steps now link to https://athena.sabari.me, which is also the package homepage.
- **Releases**: the release workflow uses npm trusted publishing (no stored token), adds provenance automatically, and creates a GitHub release from the changelog.
- Source maps are no longer included in the npm package, and `CHANGELOG.md` is.
- Fixed a CI race in the Ctrl+C test that failed on slower runners.
- **Codex support**: `athena agents add codex` (also picked up by `athena init` when a `.codex/` folder exists). Athena writes its block in `AGENTS.md`, registers the MCP server in `.codex/config.toml` and installs activity hooks in `.codex/hooks.json`, keeping everything else in those files. `athena doctor` warns when Codex hasn't trusted the project yet, since Codex ignores `.codex/` until then. Athena only reads Codex's trust setting and never changes it.
- **GitHub Copilot support**: `athena agents add copilot` (aliases `github-copilot`, `gh-copilot`). Athena writes a marked block in `.github/copilot-instructions.md`, registers the MCP server under `servers` in `.vscode/mcp.json`, and installs activity hooks in its own `.github/hooks/athena.json` (read by Copilot CLI and VS Code). Hook commands always exit 0, because Copilot denies a tool call when a pre-tool hook fails. `athena init` detects Copilot from `.github/copilot-instructions.md`, `.github/instructions/`, `.github/hooks/` or a `.vscode/mcp.json` Athena didn't create.
- **Gemini CLI support**: `athena agents add gemini-cli`. Athena writes a marked block in `GEMINI.md`, and adds the `athena` MCP server and activity hooks (`SessionStart`, `BeforeAgent`, `BeforeTool`, `AfterAgent`, `SessionEnd`) to `.gemini/settings.json`, keeping everything else in those files.
- `gemini` now selects Gemini CLI rather than Antigravity, and a `GEMINI.md` file no longer counts as evidence of Antigravity. `GEMINI.md` is Gemini CLI's context file; Antigravity also reads it, but so do other tools, so only `.agents/` or `.agent/` mean Antigravity is in use.
- **Windsurf support**: `athena agents add windsurf` (alias `codeium`; picked up by `athena init` when `.windsurf/` or `.windsurfrules` exists). Athena writes an owned rule at `.windsurf/rules/athena.md` with `trigger: always_on`, kept under the documented 12,000-character limit; Windsurf and Devin Desktop (its new name) read it. MCP and activity hooks are not configured: Windsurf's MCP config is per user, and Cascade hooks only apply to the legacy Cascade agent (available through July 2026).
- **Cline support**: `athena agents add cline` (picked up by `athena init` when `.clinerules` or `.cline/` exists). Athena writes an owned rule at `.clinerules/athena.md`; if `.clinerules` is a single file, Athena leaves it alone and uses `.cline/rules/athena.md`, which Cline also reads. MCP and activity hooks are not configured: Cline's MCP settings are per user, and its hooks are SDK plugins.
- Removing one integration no longer removes the `AGENTS.md` block that another configured integration still uses.
- **GitHub Action** (`uses: Sabari-Vasan-SM/athena@v0`): a composite action that runs `athena sync --check` and, on pull requests, `athena review --base <PR base>`, failing on stale knowledge or review blockers. With `comment: true` it keeps one pull request comment up to date with the findings (type and location only, never values). Outputs `in-sync` and `blockers`. Linux and macOS runners; see `examples/github-workflow.yml`.
- **`athena git-hook install|uninstall|status`**: a `#!/bin/sh` pre-commit hook that blocks commits when `.athena/` is out of date (`--review` also blocks possible secrets and env files). It honours `core.hooksPath` and worktrees, adds a marked block to an existing shell hook instead of replacing it, refuses non-shell hooks and hooks managed by husky, lefthook or pre-commit (printing the `npx --no-install athena sync --check` line to use instead), and lets commits through when `athena` isn't installed.
- `athena sync --check` no longer fails when only the Git change hotspots in `debugging.md` differ. They come from commit history and moved with every commit, so the check failed right after committing up-to-date knowledge. `--check --json` now includes `inSync` and `stale`.
- Change hotspots no longer count commits to `.athena/` itself, and ties are ordered by path instead of commit recency.
- `examples/demo-shop`: a small Express + Prisma project with its generated `.athena/` knowledge committed.

## 0.1.3 — 2026-09-22

- **Terminal UI**: `athena init`, `analyze` and `open` show a branded header (logo, links) sized to the terminal, a live checklist of the real pipeline stages with measured timings and results, and summary panels for project overview, generated files and next steps. It falls back to narrower layouts, plain text without Unicode, and no animation when output is not a TTY. `--json` and `--quiet` are unchanged.
- `package.json` now links the GitHub repository, homepage and issue tracker.

## 0.1.2 — 2026-09-18

Republished with no functional changes.

## 0.1.1 — 2026-09-18

Packaging fix: the `bin` path in `package.json` is now `dist/cli.js`, and the description encoding was corrected. No functional changes.

## 0.1.0 — 2026-09-18

First public release.

- **Analysis**: detects languages, frameworks, monorepos, commands, env var names, database schema, HTTP routes, auth signals, containers, CI and tests across 10 ecosystems. Every statement is labeled `FACT`, `DETECTED`, `INFERRED` or `UNKNOWN` with file/line evidence.
- **Knowledge**: 11 generated Markdown documents in `.athena/`, plus the developer-owned `rules.md`. Generated sections are refreshed; your edits are preserved.
- **Sync**: `athena sync` and `athena watch` propose updates only for documents that would actually change, with reasons and diffs. Nothing is written without review.
- **Web UI**: `athena open` — knowledge viewer/editor, rules editor, sync review with diffs, security scan, context explorer and activity timeline, on `127.0.0.1` with a per-session token.
- **Agents**: Claude Code, Cursor, Antigravity and AGENTS.md integrations, including activity hooks and MCP registration.
- **Security & review**: `athena security` runs the audit tools your ecosystems provide; `athena review` checks the current diff for secrets, missing tests, new dependencies and more.
- **Intelligence**: project graph, deterministic context engine (`athena context`), MCP server (`athena mcp`), and optional consent-gated AI suggestions (`athena ai`).
