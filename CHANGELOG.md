# Changelog

## Unreleased

- **Codex support**: `athena agents add codex` (also picked up by `athena init` when a `.codex/` folder exists). Athena writes its block in `AGENTS.md`, registers the MCP server in `.codex/config.toml` and installs activity hooks in `.codex/hooks.json`, keeping everything else in those files. `athena doctor` warns when Codex hasn't trusted the project yet, since Codex ignores `.codex/` until then. Athena only reads Codex's trust setting and never changes it.
- Removing one integration no longer removes the `AGENTS.md` block that another configured integration still uses.

## 0.1.3

- **Terminal UI**: `athena init`, `analyze` and `open` show a branded header (logo, links) sized to the terminal, a live checklist of the real pipeline stages with measured timings and results, and summary panels for project overview, generated files and next steps. It falls back to narrower layouts, plain text without Unicode, and no animation when output is not a TTY. `--json` and `--quiet` are unchanged.
- `package.json` now links the GitHub repository, homepage and issue tracker.

## 0.1.0 — unreleased

First public release.

- **Analysis**: detects languages, frameworks, monorepos, commands, env var names, database schema, HTTP routes, auth signals, containers, CI and tests across 10 ecosystems. Every statement is labeled `FACT`, `DETECTED`, `INFERRED` or `UNKNOWN` with file/line evidence.
- **Knowledge**: 12 Markdown documents in `.athena/`, plus developer-owned `rules.md`. Generated sections are refreshed; your edits are preserved.
- **Sync**: `athena sync` and `athena watch` propose updates only for documents that would actually change, with reasons and diffs. Nothing is written without review.
- **Web UI**: `athena open` — knowledge viewer/editor, rules editor, sync review with diffs, security scan, context explorer and activity timeline, on `127.0.0.1` with a per-session token.
- **Agents**: Claude Code, Cursor, Antigravity and AGENTS.md integrations, including activity hooks and MCP registration.
- **Security & review**: `athena security` runs the audit tools your ecosystems provide; `athena review` checks the current diff for secrets, missing tests, new dependencies and more.
- **Intelligence**: project graph, deterministic context engine (`athena context`), MCP server (`athena mcp`), and optional consent-gated AI suggestions (`athena ai`).
