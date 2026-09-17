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
| `athena doctor` | Check the installation, project, knowledge files and agent integrations |
| `athena rules` | `list`, `add "<rule>" --section <name>`, `edit`, `enable`, `disable`, `remove` |
| `athena agents` | `list`, `add <claude-code\|cursor\|antigravity\|agents-md\|all>`, `remove` |
| `athena clean` | Remove `.athena/` and Athena integration blocks |

Global flags: `--json`, `--quiet`, `--cwd <dir>`, `--no-color`.

`open`, `watch`, `sync`, `security`, `review` and `architecture` are reserved for upcoming phases. They print *Not available yet* and exit with code 2. See [docs/ROADMAP.md](docs/ROADMAP.md).

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
