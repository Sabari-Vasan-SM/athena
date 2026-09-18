# Athena

**Project intelligence for AI coding agents.**

Athena analyzes your repository and maintains a structured, human-readable understanding of it in `.athena/`: architecture, database, API, auth, security, testing, deployment, and your own project rules. It then points Claude Code, Cursor, Antigravity and other agents at that knowledge, so they plan and change code with real project context.

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
| `athena rules` | `list`, `add "<rule>" --section <name>`, `edit`, `enable`, `disable`, `remove` |
| `athena agents` | `list`, `add <claude-code\|cursor\|antigravity\|agents-md\|all>`, `remove` |
| `athena activity` | Show AI agent activity observed through hooks (`-n`, `--agent`) |
| `athena security` | Audit dependencies with the tools installed for this project, and report secret findings (`--fail-on`, `--last`, `--no-audit`) |
| `athena review` | Check the current diff for facts worth reviewing, and list your rules and checklist (`--base`, `--no-fail`) |
| `athena context <task>` | Show which knowledge an agent should read for a task (`--full`, `--json`) |
| `athena graph` | Inspect the project graph (`--build`, `--search`, `--node`, `--kind`) |
| `athena mcp` | Serve project intelligence to agents over MCP (stdio; `--allow-write`) |
| `athena ai` | `status`, `enrich` — optional AI suggestions (`--consent`, `--dry-run`) |
| `athena open` | Start (or reuse) the local web UI on `127.0.0.1`, watch for changes, and open it (`--port`, `--no-open`, `--no-watch`) |
| `athena clean` | Remove `.athena/` and Athena integration blocks |

Global flags: `--json`, `--quiet`, `--cwd <dir>`, `--no-color`.

 They print *Not available yet* and exit with code 2. See [docs/ROADMAP.md](docs/ROADMAP.md).

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
- `athena sync --check` exits with 1 when knowledge is out of date, which is useful in CI or a pre-commit hook.
- Ignore rules: defaults, root and nested `.gitignore` files, `.git/info/exclude`, and `.athena/config.json`.

## Watching what agents do

Athena configures hooks for agents that support them, so it can show what they actually did:

| Agent | Mechanism |
|---|---|
| Claude Code | Hooks in `.claude/settings.json` running `athena event` (async, so the agent is never blocked) |
| Cursor | Hooks in `.cursor/hooks.json` plus a small forwarding script |
| Antigravity | No documented hook mechanism — activity is reported as unavailable |

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
athena security          # audit dependencies + report secret findings
athena security --fail-on high   # exit 1 in CI
athena review                     # check the current diff before you commit
```

**`athena security`** runs the audit tools your project's ecosystems provide (`npm audit`, `pnpm audit`, `pip-audit`, `govulncheck`, `cargo audit`, `composer audit`) and reports what they find, attributed to the tool. Athena has no vulnerability database of its own: a tool that isn't installed is reported as **unknown**, never as "no problems". Results are stored in `.athena/security-scan.json` and recorded in `security.md` on the next `athena sync`.

**`athena review`** checks facts about your current diff: secrets in added lines (a blocker, exit 1), committed env files, new dependencies, source changed without tests, API/schema/auth touchpoints, large files, debug leftovers, and whether Athena knowledge is stale. It then lists your enabled rules and the project's review checklist for you or your agent to apply — Athena does not claim to judge whether they are met, and it runs no AI.

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
- **Project graph.** `athena graph --build` writes `.athena/graph.json`: packages, files, routes, entities, frameworks and commands, connected by `contains`, `imports`, `handles`, `defines` and `depends_on`. It comes from the analysis, so it never asserts more than DETECTED evidence.

**MCP.** `athena mcp` serves this to any MCP-capable agent over stdio, and `athena agents add` registers it (`.mcp.json` for Claude Code, `.cursor/mcp.json` for Cursor). Tools: `get_relevant_context`, `get_project_context`, `get_architecture`, `get_database_schema`, `get_api_context`, `get_security_context`, `get_project_rules`, `get_knowledge_document`, `get_project_changes`, `get_project_graph`, `get_athena_status`, `update_knowledge`.

The server is **read-only by default**: `update_knowledge` reports what would change and refuses to write unless you start it with `--allow-write`.

## Optional AI

Athena needs no AI: analysis, sync, context and MCP are all deterministic. AI is opt-in for suggestions only.

```bash
athena ai status                  # which providers are configured and reachable
athena ai enrich --dry-run        # show exactly what would be sent
athena ai enrich --consent        # ask for suggestions
```

- **Providers:** Anthropic, OpenAI, Google, and Ollama for a fully local setup. Configure in `.athena/config.json` under `"ai"`; API keys come from environment variables only and are never written to disk by Athena.
- **Consent first.** Nothing leaves your machine without `--consent` (or `"consent": true`). `--dry-run` prints the provider, endpoint, documents and exact size first.
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
| Antigravity | `.agents/rules/athena.md` (set to *Always On* in Antigravity if needed) |
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
