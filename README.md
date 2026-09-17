# Athena

**Project intelligence for AI coding agents.**

Athena analyzes your repository and maintains a structured, human-readable understanding of it in `.athena/`: architecture, database, API, auth, security, testing, deployment, and your own project rules. It then points Claude Code, Cursor, Antigravity and other agents at that knowledge, so they plan and change code with real project context.

Athena doesn't replace your coding agent, and it doesn't claim to make code bug-free or secure. It makes agents more **project-aware**, and it is honest about what it knows.

```bash
npm install -g athena-cli   # requires Node.js >= 22.12
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
| `athena open` | Start (or reuse) the local web UI on `127.0.0.1`, watch for changes, and open it (`--port`, `--no-open`, `--no-watch`) |
| `athena clean` | Remove `.athena/` and Athena integration blocks |

Global flags: `--json`, `--quiet`, `--cwd <dir>`, `--no-color`.

`security`, `review` and `architecture` are reserved for upcoming phases. They print *Not available yet* and exit with code 2. See [docs/ROADMAP.md](docs/ROADMAP.md).

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
- follow an activity timeline of what Athena actually observed: analyses, UI edits, and knowledge files changed on disk

The robot indicator reflects Athena's own work (analyzing, finished, error). **AI agent activity is not shown yet.** Observing agents needs hook integrations (Phase 4), and the UI says so instead of simulating it.

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
