# Changelog

## Unreleased

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
