# Athena

**Project intelligence for AI coding agents.**

🌐 **Website & docs:** [athena.sabari.me](https://athena.sabari.me) · 📦 [npm](https://www.npmjs.com/package/project-athena) · [Changelog](CHANGELOG.md)

Athena analyzes your repository and maintains a structured, human-readable understanding of it in `.athena/`: architecture, database, API, auth, security, testing, deployment, and your own project rules. It then points Claude Code, Cursor, Codex, GitHub Copilot, Gemini CLI, Antigravity, Windsurf, Cline and other agents at that knowledge, so they plan and change code with real project context.

Athena doesn't replace your coding agent, and it doesn't claim to make code bug-free or secure. It makes agents more **project-aware**, and it is honest about what it knows.

```bash
npm install -g project-athena   # requires Node.js >= 22.12
cd my-project
athena init
```

## What you get

```text
.athena/
├── project.md        technologies, structure, entry points, commands
├── architecture.md   layers, workspace modules, service topology (Mermaid)
├── database.md       engines, entities, relations, indexes, migrations
├── api.md            detected endpoints and API specs
├── auth.md           auth libraries/providers, tokens, roles
├── security.md       attack surface, controls, potential secrets (no values)
├── testing.md        frameworks, commands, structural gaps
├── debugging.md      commands, logging, change hotspots
├── performance.md    caching, queues, database notes
├── code-review.md    project-specific review checklist
├── deployment.md     containers, CI/CD, hosting, env var names
├── rules.md          your rules — agents are told to follow them
└── state.json        local analysis cache
```

Every statement is labeled:

| Label | Meaning |
|---|---|
| `FACT` | Declared (e.g. manifest) or asserted by a developer |
| `DETECTED` | Found by analysis, with file/line evidence |
| `INFERRED` | Heuristic. Verify before relying on it |
| `UNKNOWN` | Athena looked and could not tell |

Example: *"Redis — DETECTED (package.json)"* followed by *"Cache strategy and invalidation rules: UNKNOWN"*. It never says *"sessions are stored in Redis"* unless the code shows it.

## Your edits are safe

Generated content sits between `athena:generated` markers. Anything outside the markers, including each document's **Developer Notes**, is never touched. If you edit inside a marker, Athena keeps your version and tells you. `athena analyze --force` regenerates it. `rules.md` is yours alone after creation.

## Commands

| Command | |
|---|---|
| `athena init` | Analyze and create `.athena/`. Configures detected agents plus `AGENTS.md` (`--agents all`, `--no-agents`, `--dry-run`) |
| `athena analyze` | Refresh knowledge; preserves your edits (`--force` to regenerate) |
| `athena status` | Knowledge health, file changes since the last analysis, potentially affected documents |
| `athena sync` | Show which documents would change and why (with diffs), then apply after confirmation (`--yes`, `--dry-run`, `--diff`, `--check` for CI) |
| `athena watch` | Watch the project and propose updates as files change (`--auto-apply` to write automatically) |
| `athena doctor` | Check the installation, project, knowledge files and agent integrations |
| `athena memory` | `list`, `show`, `add`, `search`, `recall`, `confirm`, `supersede`, `forget`, `edit`, `stale`, `review` — project memory in `.athena/memory/` (see [Project memory](#project-memory)) |
| `athena rules` | `list`, `add "<rule>" --section <name>`, `edit`, `enable`, `disable`, `remove` |
| `athena agents` | `list`, `add <claude-code\|cursor\|codex\|copilot\|gemini-cli\|antigravity\|windsurf\|cline\|agents-md\|all>`, `remove` |
| `athena activity` | Show AI agent activity observed through hooks (`-n`, `--agent`) |
| `athena scan` | Unified scan: secrets, dependency audits and (on a change) review checks, with policy, baseline, triage and a quality gate (`--base`, `--staged`, `--changed`, `--only`, `-f text\|json\|markdown\|github\|sarif`, `-o`, `--fail-on`, `--policy-from`, `--offline`, `--list-rules`) |
| `athena baseline` | `show`, `create`, `update`, `prune` — record existing findings so only new ones fail the gate |
| `athena findings` | `list`, `show <fingerprint>`, `triage <fingerprint> <safe\|false-positive\|accepted-risk\|fixed\|to-review\|clear> --reason …` |
| `athena explain <ruleId>` | What a rule detects and what to do about it |
| `athena security` | Audit dependencies with the tools installed for this project, and report secret findings (`--fail-on`, `--last`, `--no-audit`) |
| `athena review` | Check the current diff for facts worth reviewing, and list your rules and checklist (`--base`, `--no-fail`) |
| `athena git-hook` | `install` (`--review`), `uninstall`, `status` — a Git pre-commit hook that blocks commits when knowledge is out of date |
| `athena context <task>` | Show which knowledge an agent should read for a task (`--full`, `--json`) |
| `athena graph` | Inspect the project graph (`--build`, `--search`, `--node`, `--kind`) |
| `athena mcp` | Serve project intelligence to agents over MCP (stdio; `--allow-write`, `--no-memory-write`) |
| `athena ai` | `status`, `enrich` — optional AI suggestions (`--consent`, `--dry-run`) |
| `athena open` | Start (or reuse) the local web UI on `127.0.0.1`, watch for changes, and open it (`--port`, `--no-open`, `--no-watch`) |
| `athena clean` | Remove `.athena/` (including project memory) and Athena integration blocks |

Global flags: `--json`, `--quiet`, `--cwd <dir>`, `--no-color`.

 They print *Not available yet* and exit with code 2. See [docs/ROADMAP.md](docs/ROADMAP.md).

## Project memory

Agents rediscover the same things every session: why the queue uses advisory locks, that tests need `TZ=UTC`, which bug the retry guard fixes. Athena keeps these as **project memory** in `.athena/memory/` — one Markdown file per kind (`decisions.md`, `gotchas.md`, `bugs.md`, `conventions.md`, `todos.md`, `facts.md`). Commit it: the team shares it and reviews changes in pull requests. Text you write outside the `athena:memory` markers is kept as written.

- **Evidence labels.** An entry you record is `confirmed` (**FACT**). An entry an agent records is `unreviewed` (**INFERRED**) until you confirm it.
- **Staleness.** Entries can link files. When a linked file changes, the entry is reported **stale** until you confirm it again (which re-anchors it), edit it or forget it.
- **Safety.** Entries that look like a secret are refused (the value is never stored or printed). Entries that address the agent instead of describing the project (possible prompt injection) are flagged and never recalled automatically.

```bash
athena memory add --kind decision --title "Queue uses advisory locks" \
  --file src/jobs/queue.ts --tag jobs --evidence "PR #412"
git log -1 --format=%B | athena memory add --kind bug --title "Double refund on webhook retry" --details -
athena memory list                 # --kind, --status unreviewed|confirmed|superseded, --stale
athena memory review               # walk agent-written entries: [c]onfirm [e]dit later [f]orget [s]kip [q]uit
athena memory recall "change the refund flow" --file src/api/refunds.ts
athena memory stale                # entries whose linked files changed
athena memory confirm m-1a2b3c m-4d5e6f
athena memory supersede m-1a2b3c --by m-7a8b9c   # keep as history
athena memory forget m-1a2b3c      # asks first; --yes in scripts
```

```text
$ athena memory list
ID        KIND       LABEL    STATUS             TITLE · SOURCE
m-b74d24  gotcha     INFERRED unreviewed         Refund webhook retries twice · agent:claude-code
m-815cd7  decision   FACT     confirmed  stale   Queue uses advisory locks · developer

2 entries · 1 confirmed · 1 unreviewed · 1 stale · source: .athena/memory/
1 entry written by agents is INFERRED until reviewed: run `athena memory review`.
```

Every command supports `--json`. `athena memory review` is interactive only in a terminal; elsewhere it lists the unreviewed entries and exits 0. `athena status` and `athena doctor` show how many entries are unreviewed or stale, and `athena clean` warns before deleting project memory.

## Keeping knowledge in sync

```text
$ athena sync

Changes since last analysis
  2 files (1 modified · 1 added)
  Git: 1 new commit

Detected project changes
• API routes: 1 route added (POST /refunds)
• Database schema: 2 entities added (Book, Chapter)

Knowledge to update
  ~ api.md       +4 −3   endpoints
      → API routes: 1 route added (POST /refunds)
  ~ database.md  +25 −4  technology, schema
      → Database schema: 2 entities added (Book, Chapter)
  Checked and unchanged: deployment.md

Apply updates to 2 documents? [y/N]
```

- **Only documents whose content would actually change are proposed.** Athena re-analyzes (reusing hashes of unchanged files), compares the structured project model with the previous one, renders documents in memory, and diffs them against disk.
- **Reasons come from evidence:** which parts of the model changed (routes, schema, dependencies, env vars, CI…), plus which kinds of files changed. Renames are detected by content, and Git commits and branch switches since the last analysis are shown.
- **Nothing is written without review.** `athena watch` and the web UI only propose updates. You can apply or ignore a proposal (an ignored proposal stays quiet until the files change again), or opt in to `--auto-apply`.
- **Your edits are still safe.** Developer-edited sections are preserved and listed. Applying is refused if a document changed after the proposal was made.
- When files change but no knowledge is affected, only the local index is refreshed.
- `athena sync --check` exits with 1 when knowledge is out of date, which is useful in CI or a pre-commit hook (see [Use in CI and git hooks](#use-in-ci-and-git-hooks)). Change hotspots come from Git history and move with every commit, so the check ignores them; `athena sync` still refreshes them.
- `athena sync --check --staged` checks what a commit would contain instead of the working tree: the `.athena/` knowledge as staged against the code as staged. Untracked files and unstaged edits don't count. This is what the pre-commit hook runs.
- Ignore rules: defaults, root and nested `.gitignore` files, `.git/info/exclude`, and `.athena/config.json`.

## Watching what agents do

Athena configures hooks for agents that support them, so it can show what they actually did:

| Agent | Mechanism |
|---|---|
| Claude Code | Hooks in `.claude/settings.json` running `athena event` (async, so the agent is never blocked) |
| Cursor | Hooks in `.cursor/hooks.json` plus a small forwarding script |
| Codex | Hooks in `.codex/hooks.json` running `athena event` (Codex loads them only for trusted projects) |
| GitHub Copilot | Hooks in `.github/hooks/athena.json` running `athena event` (read by Copilot CLI and VS Code, where hooks are in Preview). Each command always exits 0, so a machine without Athena — such as Copilot cloud agent — is never blocked |
| Gemini CLI | Hooks in `.gemini/settings.json` running `athena event` (Gemini CLI warns once when it sees new project hooks) |
| Antigravity | No documented hook mechanism — activity is reported as unavailable |
| Windsurf | Not installed: Cascade hooks applied only to the legacy Cascade agent, which Devin Desktop (Windsurf's new name) kept available only through July 2026 — activity is reported as unavailable |
| Cline | Not installed: Cline's hooks are SDK plugins (TypeScript) that don't run in the IDE extensions — activity is reported as unavailable |

Hooks append events to `.athena/.agent-events.jsonl` (gitignored, rotated, no network). The UI tails that file, so activity shows up live and history survives with the UI closed.

```text
$ athena activity
20:03:58  ● claude-code · Editing src/components/Pricing.tsx
20:04:07  ● claude-code · Running tests: npm test -- billing
20:04:31  ● claude-code · Finished responding
```

**What Athena can and cannot see.** It records which tool ran, on which files, and when. It never records the agent's reasoning, and prompt text is not stored. Secrets in commands are redacted, and paths are stored project-relative. When no hook has fired, Athena says nothing about whether an agent is running.

## Security and review

```bash
athena scan                       # secrets + dependency audits, policy and quality gate
athena scan --base origin/main -f sarif -o athena.sarif --policy-from origin/main   # in CI
athena baseline create            # accept today's findings; only new ones fail the gate
athena findings triage 5f65caf9 false-positive --reason "test fixture"
athena security          # audit dependencies + report secret findings
athena security --fail-on high   # exit 1 in CI
athena review                     # check the current diff before you commit
```

**`athena security`** runs the audit tools your project's ecosystems provide (`npm audit`, `pnpm audit`, `pip-audit`, `govulncheck`, `cargo audit`, `composer audit`) and reports what they find, attributed to the tool. Athena has no vulnerability database of its own: a tool that isn't installed is reported as **unknown**, never as "no problems". Results are stored in `.athena/security-scan.json` and recorded in `security.md` on the next `athena sync`.

**`athena scan`** puts every check into one findings model. Each finding has a rule id, severity (`unrated` when the tool gave none — never treated as low), confidence, a FACT/DETECTED/INFERRED label, CWE, a location or package, and a fingerprint that never depends on a secret's value. Every report lists what was *not* covered (tools not installed, engines that failed, categories nothing scanned), and a failed engine fails the gate — it checked nothing. Optional committed files tune it: `.athena/policy.json` (gate thresholds, rule overrides, path excludes), `.athena/baseline.json`, `.athena/triage.json`, and inline `athena-ignore <ruleId> -- <reason>` comments (a reason is required). In CI, `--policy-from <base>` evaluates with the base branch's policy and reports any change to it on the branch as `review/policy-weakened`. Output formats: text, JSON, Markdown, GitHub annotations and SARIF 2.1.0 (for code scanning). Ratings A–E per category come with their basis; there is no numeric score.

**`athena review`** checks facts about your current diff: secrets in added lines (a blocker, exit 1), committed env files, new dependencies, source changed without tests, API/schema/auth touchpoints, large files, debug leftovers, and whether Athena knowledge is stale. It then lists your enabled rules and the project's review checklist for you or your agent to apply — Athena does not claim to judge whether they are met, and it runs no AI.

## Use in CI and git hooks

Commit `.athena/` so your team and CI share it. Athena can then keep it honest in two places.

### GitHub Action

```yaml
# .github/workflows/athena.yml
on: pull_request
permissions:
  contents: read
  pull-requests: write # only for `comment: true`
jobs:
  athena:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # the review diffs the pull request against its base commit
      - uses: Sabari-Vasan-SM/athena@v0
        with:
          comment: true
```

| Input | Default | |
|---|---|---|
| `check-sync` | `true` | Run `athena sync --check`; fail when `.athena/` is out of date |
| `review` | `true` | On `pull_request` events, run `athena review --base <PR base>`; fail on blockers (possible secrets, committed env files). Skipped on other events |
| `review-base` | PR base SHA | Ref to review against, for example on `push` events |
| `comment` | `false` | Post the findings as one pull request comment and update it on later pushes (marked with `<!-- athena-review -->`) |
| `version` | `latest` | `project-athena` version to install with `npm install -g` |
| `working-directory` | `.` | Folder that contains `.athena/` |
| `github-token` | `github.token` | Token for the comment |

Outputs: `in-sync` (`true`/`false`) and `blockers` (a count). The comment and logs show each finding's type and file location, never the matched value.

- The action uses Node.js if it is already 22.12 or newer, and otherwise installs Node.js 22 with `actions/setup-node`.
- It is a composite action written in bash, so it runs on Linux and macOS runners. Windows runners are not supported.
- Without `fetch-depth: 0` the base commit is missing and the review step fails with a message saying so.
- Pull requests from forks get a read-only token, so the comment is skipped with a warning; the checks still run.

A complete workflow is in [examples/github-workflow.yml](examples/github-workflow.yml).

### Git pre-commit hook

```text
$ athena git-hook install
✓ Installed the pre-commit hook (knowledge check) at .git/hooks/pre-commit
Commits are blocked when the staged .athena/ knowledge is out of date for the staged code (untracked and unstaged files are ignored). Teammates without Athena installed are not blocked.
Using husky, lefthook or pre-commit? Add `npx --no-install athena sync --check --staged` to its pre-commit config instead.

$ git commit -m "Add refunds"
  ~ api.md       endpoints
  ~ security.md  attack-surface
Staged knowledge is out of date for the staged code. Run `athena sync`, then stage .athena/.
athena: commit blocked: staged .athena/ knowledge is out of date. Run `athena sync`, stage .athena/ and commit again (or skip once with `git commit --no-verify`).
```

- The hook checks the commit, not the working tree: an untracked scratch file, a local `.env` or an unstaged edit never blocks a commit, and a change you staged and then reverted in the working tree still counts. If `athena sync` already updated a document but it isn't staged, the output says which files to `git add`.
- The check mirrors the index into `.athena/cache/staged/` (gitignored). Files that match the working tree are stand-ins that reuse the last analysis and the facts cache, so only staged changes are read; the directory is updated incrementally and is safe to delete. Submodules are checked as they are in the working tree. Local env files that aren't committed (such as `.env`) are machine-local: the check accepts staged knowledge written with or without them.
- Knowledge generated by `athena sync` describes the working tree. If untracked files that are not gitignored change it (a new route in a file you don't commit), the staged check reports the difference; commit, ignore or stash those files before syncing.
- Hooks installed by earlier versions check the working tree; `athena git-hook status` points them out and `athena git-hook install` updates them.

- `athena git-hook install --review` also runs `athena review --staged` and blocks commits that add possible secrets or env files. Like the knowledge check, it only looks at what is staged.
- The hook is a `#!/bin/sh` script in the directory Git actually uses (`git rev-parse --git-path hooks`), so `core.hooksPath` and linked worktrees work. For a project in a subfolder of the repository, the hook runs Athena there.
- If `athena` is not on `PATH`, the hook prints a note and lets the commit through, so it never blocks teammates who don't use Athena.
- **An existing pre-commit hook is kept.** If it is a shell script, Athena adds its block between `# athena:start` and `# athena:end` right after the shebang, so it runs before your own commands. Athena refuses to touch hooks written in other languages and hooks it recognizes as managed by husky, lefthook or pre-commit (from `core.hooksPath` or the hook's contents), and prints the line to add instead.
- `athena git-hook uninstall` removes only Athena's block (or the file, if Athena created it). `athena git-hook status` shows what is installed.

**husky, lefthook and other hook managers:** add one line to your pre-commit config instead of installing the hook. It needs `project-athena` as a devDependency or installed globally.

```bash
# .husky/pre-commit
npx --no-install athena sync --check --staged
```

```yaml
# lefthook.yml
pre-commit:
  commands:
    athena:
      run: npx --no-install athena sync --check --staged
```

### Example project

[examples/demo-shop](examples/demo-shop) is a small Express + Prisma API with its generated `.athena/` knowledge committed, so you can see what Athena writes before running it on your own code. See [examples/README.md](examples/README.md).

## Context engine, graph and MCP

Reading twelve documents for every task wastes an agent's context. Athena picks what matters:

```text
$ athena context "add refunds to the payments API"

Documents to read
• api — task mentions "API"
• database — task mentions "payments" via entity Payment
• security — security implications of data/API changes
• testing — tests for changed behavior
```

- **Deterministic.** The same task and project state always produce the same selection, with a stated reason for each document. No AI is involved.
- **Sections, not whole files.** Only the relevant sections are returned, under a character budget, with your rules always included.
- **Project memory.** Up to five recalled memories from `.athena/memory/` (confirmed ones first, possible prompt injections excluded) are included with their label (`FACT` once a developer confirmed them, `INFERRED` while unreviewed), whether they are stale, and why they matched. They share the character budget (at most 30% of it) and appear in `--full` output and as `memories` in `--json`.
- **Project graph.** `athena graph --build` writes `.athena/graph.json`: packages, files, routes, entities, frameworks and commands, connected by `contains`, `imports`, `handles`, `defines` and `depends_on`. It comes from the analysis, so it never asserts more than DETECTED evidence.

**MCP.** `athena mcp` serves this to any MCP-capable agent over stdio, and `athena agents add` registers it (`.mcp.json` for Claude Code, `.cursor/mcp.json` for Cursor, `[mcp_servers.athena]` in `.codex/config.toml` for Codex, `servers.athena` in `.vscode/mcp.json` for GitHub Copilot in VS Code, `mcpServers.athena` in `.gemini/settings.json` for Gemini CLI). Tools: `get_relevant_context`, `get_project_context`, `get_architecture`, `get_database_schema`, `get_api_context`, `get_security_context`, `get_project_rules`, `get_knowledge_document`, `get_project_changes`, `get_project_graph`, `get_athena_status`, `update_knowledge`, and the memory tools `recall`, `list_memory` and `remember`.

The server is **read-only by default**: `update_knowledge` reports what would change and refuses to write unless you start it with `--allow-write`. The one exception is `remember`: an agent may append a memory to `.athena/memory/`, but it is always stored **unreviewed** (`INFERRED`, attributed to the agent, e.g. `agent:claude-code`, or `agent:mcp` when the client is not recognized) and counts as a `FACT` only after a developer confirms it. It never touches knowledge documents and refuses anything that looks like a secret. Start the server with `--no-memory-write` to turn it off.

| Memory tool | Input | Returns |
| --- | --- | --- |
| `recall` | `task?`, `files?`, `tags?`, `limit?` | Ranked memories with why each matched, label, status and staleness, each in `<athena-memory … trust="untrusted-data">` delimiters. Entries that look like instructions to an agent are excluded (the reply says how many). |
| `list_memory` | `kind?`, `status?`, `stale?` | One-line summaries: id, kind, status, label, stale, title |
| `remember` | `kind`, `title`, `details?`, `files?`, `tags?`, `evidence?`, `supersedes?` | The new id and label (`INFERRED`); a developer must confirm it |
 Repository content it returns is passed through the secret redactor and wrapped in `<athena-document … trust="untrusted-data">` (or `<athena-memory …>`) delimiters, so agents can tell project data from instructions. The generated agent instructions tell agents to `recall` at the start of a task, `remember` durable learnings at the end, and treat unreviewed memories as hints to verify — `rules.md` and the developer always win.

## Optional AI

Athena needs no AI: analysis, sync, context and MCP are all deterministic. AI is opt-in for suggestions only.

```bash
athena ai status                  # which providers are configured and reachable
athena ai enrich --dry-run        # show exactly what would be sent
athena ai enrich --consent        # ask for suggestions
```

- **Providers:** Anthropic, OpenAI, Google, and Ollama for a fully local setup. Choose `provider`, `model` and `maxChars` in `.athena/config.json` under `"ai"`; API keys come from environment variables only and are never written to disk by Athena.
- **Trusted settings stay on your machine.** `.athena/config.json` is committed, so anyone who can push to the repository controls it. The two settings that decide where your API key and knowledge go — `baseUrl` (a custom endpoint or remote Ollama) and `consent` — are therefore only read from machine-local sources, in this order: environment variables `ATHENA_AI_BASE_URL` and `ATHENA_AI_CONSENT=1`; `.athena/local.json` (gitignored), e.g. `{ "ai": { "baseUrl": "https://proxy.internal", "consent": true } }`; your user config at `~/.config/athena/config.json` (`$XDG_CONFIG_HOME/athena/config.json`, or `%APPDATA%\athena\config.json` on Windows) with the same `"ai"` shape. If `.athena/config.json` sets them, Athena ignores them and says so in `athena ai status`, `athena ai enrich` and `athena doctor`.
- **Consent first.** Nothing leaves your machine without consent: `athena ai enrich --consent`, `ATHENA_AI_CONSENT=1`, or `"consent": true` in `.athena/local.json` or your user config. An Ollama endpoint that isn't `localhost`/`127.0.0.1`/`::1` counts as remote and needs consent too. `--dry-run` prints the provider, endpoint, documents and exact size first.
- **Knowledge only, redacted.** Athena sends your `.athena` documents — never source code — after the secret redactor, and refuses to send anything that still looks like a secret.
- **Output is INFERRED.** Suggestions land in `.athena/ai-suggestions.md` (gitignored), clearly labeled and attributed to the model. Nothing is added to your knowledge base automatically.

## Web UI

```bash
athena open
```

```text
Athena is running

Local: http://127.0.0.1:7432/#token=…
```

The local web UI lets you:

- browse every knowledge document, with Mermaid diagrams and labels showing which sections are generated, developer-edited or developer-owned
- edit documents in a Markdown editor. Saves go straight to `.athena/*.md`. Saving is refused if the file changed on disk meanwhile, or if the content looks like it contains a secret.
- review proposed knowledge updates on the **Sync** page (reasons, file changes, Git commits, line-by-line diffs), then **Update** or **Ignore**
- see sync status per document, and re-analyze with one click
- browse history (from Git commits touching each file)
- search all knowledge (⌘K)
- manage rules: add, edit, enable/disable, delete. `rules.md` stays the source of truth.
- configure or remove agent integrations
- follow an activity timeline of what Athena actually observed: agent tool use (via hooks), analyses, UI edits, and knowledge files changed on disk
- run dependency audits from the **Security** page and review findings by severity
- explore the **Context** page: type a task and see which knowledge an agent would read, and why

The robot indicator reflects real work: Athena's own analyses, and — for agents with hooks installed — the agent's current tool use (reading, coding, testing). With no hook events it stays idle and says so, rather than simulating activity.

Security: the server binds to `127.0.0.1` only, on the first free port from 7432. Every API call needs the random per-session token from the link, which travels in the URL fragment and is never sent in requests or referrers. Host and Origin headers are checked, a strict Content-Security-Policy applies, and only the fixed set of `.athena` documents can be read or written.

## Agent integrations

| Agent | What Athena writes |
|---|---|
| Claude Code | A marked block in `CLAUDE.md` that imports `.athena/rules.md` |
| Cursor | `.cursor/rules/athena.mdc` (always applied) |
| Codex | The marked block in `AGENTS.md` (which Codex reads), plus `.codex/config.toml` and `.codex/hooks.json`. Codex ignores `.codex/` until you trust the project; `athena doctor` tells you if it isn't trusted yet |
| GitHub Copilot | A marked block in `.github/copilot-instructions.md`, the `athena` server in `.vscode/mcp.json`, and `.github/hooks/athena.json` |
| Gemini CLI | A marked block in `GEMINI.md`, plus the `athena` MCP server and hooks in `.gemini/settings.json`. If you enabled Gemini CLI's folder trust, trust the project, or it ignores `.gemini/settings.json` |
| Antigravity | `.agents/rules/athena.md` (set to *Always On* in Antigravity if needed) |
| Windsurf | `.windsurf/rules/athena.md` (`trigger: always_on`, under the 12,000-character limit), read by Windsurf and Devin Desktop. MCP is per-user in Windsurf, so add `athena mcp` to your `mcp_config.json` yourself |
| Cline | `.clinerules/athena.md`, or `.cline/rules/athena.md` if `.clinerules` is a single file (Athena never touches that file). MCP is per-user in Cline, so add `athena mcp` in Cline's MCP settings yourself |
| Others | A marked block in `AGENTS.md` |

The instructions include a **relevance map**. A database task reads `database.md`, `architecture.md`, `api.md`, `security.md`, `testing.md` and `rules.md`, while a styling tweak reads only `project.md`, `architecture.md` and `rules.md`. Agents don't load everything for every task.

## Privacy and security

- Runs entirely locally, with no network calls and no AI required.
- Records env var **names** only. `.env` contents are never read.
- Potential secrets are reported by type and location only, and all output is redacted.
- See [SECURITY.md](SECURITY.md).

## Configuration

Optional `.athena/config.json`:

```json
{ "ignore": ["generated/"], "include": [], "maxFileBytes": 1000000, "maxFiles": 200000 }
```

Defaults already ignore `node_modules`, `dist`, `build`, `.venv`, `target`, `coverage` and similar directories, plus your `.gitignore`.

## Development

```bash
npm install
npm run build
npm test
node dist/cli.js --help
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
