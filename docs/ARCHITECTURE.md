# Athena Architecture

Athena is a local-first **project intelligence layer** for AI coding agents. It analyzes a repository, keeps a structured model of what it found (with provenance), renders that model as human-readable Markdown in `.athena/`, and configures coding agents to use it.

Athena does not replace coding agents. It does not claim that code is secure, correct or complete.

## Principles

1. **Structured model first, Markdown second.** Detectors produce a typed `ProjectModel`. Markdown is a *rendering* of that model. The project graph, context engine and MCP server (later phases) build on the model, not on parsed Markdown.
2. **No hallucinated facts.** Every fact carries `status` (`FACT` · `DETECTED` · `INFERRED` · `UNKNOWN`), `confidence`, `source` and `evidence` (file/line). Renderers print `UNKNOWN` explicitly rather than omitting it. AI output (Phase 6) is capped at `INFERRED`.
3. **The developer owns the knowledge.** Generated content lives inside `athena:generated` markers. Everything outside them is never modified. Edits inside a marker are detected by hash and preserved unless `--force` is passed. `rules.md` is created once and never regenerated.
4. **Local and safe by default.** No network access, no AI required for analysis. Secrets are redacted before anything is written.
5. **Agent-agnostic core.** `src/core` knows nothing about specific agents. A test enforces this.

## Layout

```text
src/
├── core/                      # agent- and provider-agnostic
│   ├── model/                 # zod schemas: Provenance, ProjectModel
│   ├── fs/walker.ts           # ignore-aware, symlink-safe, binary/size-aware walker + hashing
│   ├── analyzer/
│   │   ├── analyze.ts         # orchestrates walk → detectors → git → redaction → validation
│   │   ├── context.ts         # Detector interface, cached file access
│   │   ├── catalog.ts         # dependency → capability table (10 ecosystems)
│   │   └── detectors/         # structure, manifests, dependencies, env, infra, tests,
│   │                          # database, routes, auth, entrypoints, secrets
│   ├── security/secrets.ts    # secret scanner + redactor
│   ├── git/git.ts             # execFile-only git access (never a shell)
│   ├── knowledge/             # document registry, relevance map, renderers,
│   │                          # managed-block merge, rules.md round-trip parser
│   ├── state/state.ts         # state.json schema, atomic writes, file index diff
│   ├── impact/                # changed path → affected documents; model-level diff
│   ├── graph/graph.ts         # project graph: nodes, edges, queries
│   ├── context/               # deterministic context selection for a task
│   └── agents/adapter.ts      # AgentAdapter interface only
├── ai/                        # AIProvider interface + anthropic/openai/google/ollama
├── mcp/                       # MCP server (stdio) exposing context to agents
├── agents/                    # adapters: claude-code, cursor, antigravity, agents-md
├── services/                  # use cases shared by CLI and server: pipeline, status, doctor,
│                              # knowledge (read/save/search/history), rules, agents, overview
├── server/                    # Fastify app, security guard, event bus, static allowlist, instance lifecycle
└── cli/                       # commander CLI, terminal UI
web/                           # React + Vite UI, built to dist/web and served by the server
```

Dependency direction (enforced by tests): `core` ← `agents` ← `services` ← `server` ← `cli`. The web UI talks to the server only over HTTP.

## Data flow

```mermaid
graph LR
  repo["Repository"] --> walker["Walker (ignore, hash)"]
  walker --> detectors["Detectors"]
  detectors --> model["ProjectModel (provenance)"]
  git["git (execFile)"] --> model
  model --> redact["Redaction + zod validation"]
  redact --> renderers["Renderers"]
  renderers --> merge["Managed-block merge"]
  merge --> docs[".athena/*.md"]
  redact --> modeljson[".athena/model.json"]
  walker --> state[".athena/state.json (file index)"]
  docs --> adapters["Agent adapters"]
  adapters --> agentfiles["CLAUDE.md · .cursor/rules · .agents/rules · AGENTS.md"]
```

## `.athena/` contents

| File | Owner | Committed? |
|---|---|---|
| `project.md` … `deployment.md` | Generated sections + developer notes | Yes (recommended) |
| `rules.md` | Developer | Yes |
| `config.json` (optional) | Developer: `ignore`, `include`, `maxFileBytes`, `maxFiles` | Yes |
| `model.json` | Athena (structured model) | No (`.athena/.gitignore`) |
| `state.json` | Athena (file index, doc hashes, agent config) | No |
| `.backup/` | Corrupted state backups | No |

Generated Markdown contains no timestamps, so re-running `athena analyze` on an unchanged project produces byte-identical files. The Git history of `.athena/*.md` is the knowledge history.

## Detectors

Detectors run in a fixed order because later detectors read earlier results. For example, `routes` uses the frameworks from `dependencies`. A failing detector becomes a warning; it never aborts the analysis. Each detector has a `version`, recorded in `state.json`, so incremental sync (Phase 3) can invalidate stale output.

Parsing strategy:
- Manifests: real parsers (JSON, `smol-toml`, `yaml`), plus narrow scans for XML and Gradle.
- JS/TS routes: Babel AST with error recovery (Express, Fastify, Koa, Hono, NestJS decorators).
- Other languages: conservative regexes, always `DETECTED · medium` with file:line evidence.
- Schema: Prisma models/relations/indexes, SQL DDL (tables, columns, FKs, indexes), Django, SQLAlchemy/SQLModel, Mongoose.

`web-tree-sitter` (WASM, no native builds) is the planned route to deeper multi-language parsing for the project graph.

## Agent integrations

Each adapter uses the agent's own documented mechanism:

| Agent | Mechanism | Ownership |
|---|---|---|
| Claude Code | `CLAUDE.md` block with `@.athena/rules.md` import | Marked block in a user file |
| Cursor | `.cursor/rules/athena.mdc` (`alwaysApply: true`) | Athena-owned file |
| Codex | `AGENTS.md` block; `[mcp_servers.athena]` between `# athena:start`/`# athena:end` in `.codex/config.toml`; entries in `.codex/hooks.json` | Marked blocks/entries in user files |
| Antigravity | `.agents/rules/athena.md` (12,000-character limit) | Athena-owned file |
| AGENTS.md | Marked block (cross-tool convention) | Marked block in a user file |

Instruction text is shared (`src/agents/common/instructions.ts`) and contains a **relevance map** (`core/knowledge/documents.ts`). Agents load only the documents relevant to the task instead of all twelve. Adapters never overwrite a user file that sits at an Athena-owned path, and never write through symlinks.

`init` configures agents detected in the project plus `AGENTS.md`; others are opt-in (`--agents`, `athena agents add`).

## Safety properties (tested)

- No secret value appears in `.athena/` or `model.json`. Env files are never read; only variable names are recorded.
- Paths are resolved inside the project root. Symlinks leaving the root are not followed, and symlink loops terminate.
- Fresh `init` writes to `.athena.tmp-*` and renames on success, so Ctrl+C leaves nothing behind (exit 130).
- Corrupted `state.json` is moved to `.athena/.backup/` and rebuilt.
- Developer edits (inside and outside generated sections) survive `analyze`.

## Local server (Phase 2)

```mermaid
graph LR
  browser["Browser (React UI)"] -- "Bearer token, JSON" --> guard["Guard: Host allowlist, token, Origin, content type"]
  guard --> api["Fastify routes"]
  api --> services["services/*"]
  services --> athena[".athena/*.md, rules.md"]
  watcher["fs.watch .athena/"] --> bus["EventBus"]
  api --> bus
  bus -- "SSE over fetch" --> browser
```

- **Token flow:** `athena open` prints `http://127.0.0.1:<port>/#token=…`. The UI moves the token from the fragment into sessionStorage and strips it from the address bar. EventSource can't send headers, so events are streamed with `fetch`.
- **Writes:** document saves carry the hash of the version the client loaded, and a mismatch returns 409. Rule mutations are index-based and carry the file hash. Saves that contain likely secrets are refused (422).
- **Events:** only observed facts. `web-ui` covers edits and analyses started in the UI, `athena` covers analysis progress and results, and `filesystem` covers `.athena/*.md` changes made elsewhere. The server compares content hashes to ignore its own writes. There is no `agent` source until a real integration exists.

## Synchronization (Phase 3)

```mermaid
graph LR
  fs["File changes"] --> watch["watchProject: chokidar and IgnoreMatcher, debounce"]
  head[".git/HEAD, refs"] --> watch
  watch --> plan["planSync"]
  cli["athena sync"] --> plan
  plan --> analyze["analyzeProject: hash reuse"]
  analyze --> diff["diffModels: previous vs next model"]
  analyze --> render["planKnowledge: in-memory render and merge"]
  render --> proposal["Proposal: docs that change, reasons, diffs"]
  diff --> proposal
  proposal -->|review| apply["applySync: conflict check, write docs, model, state"]
```

- **Pure planning:** `planSync` never writes. Each proposal carries a stable id (a hash of the file and content pairs), which the server uses to reject stale apply and ignore requests.
- **Reason sources:** `MODEL_SECTIONS` maps model keys to the documents that render them. Adding a detector field means adding its section there, so proposals can explain themselves.
- **Stable rendering:** rendered documents must not churn on incidental changes. Avoid exact counts or byte sizes in generated sections; keep them in `model.json` or the UI.
- **Watcher ownership:** the watcher ignores `.athena/`, so knowledge edits don't trigger plans. The server re-plans explicitly after UI edits that could invalidate a proposal.

## Agent activity (Phase 4)

```mermaid
graph LR
  agent["Coding agent"] -->|hook fires| cli["athena event (stdin JSON)"]
  cli --> norm["normalizeHookEvent: tool to state"]
  norm --> log[".athena/.agent-events.jsonl"]
  log -->|tailed| server["Local server"]
  server -->|SSE| ui["Activity timeline and robot"]
```

- **File, not HTTP:** hooks never need a token, a running server or the network, and events recorded while the UI was closed still appear later. The server tracks a byte offset and re-reads only new lines.
- **Fast and safe by construction:** `athena event` writes nothing to stdout (agents may parse it), always exits 0, and is installed with `async: true` so a slow disk cannot stall an agent.
- **Only facts:** the tool name, files and command, mapped to a display state. Prompts and reasoning are never stored; commands are redacted and paths made project-relative.

## Security and review (Phase 5)

- **No bundled vulnerability data.** `services/security.ts` defines one runner per ecosystem (command, argv, applicability, parser). Runners execute with `execFile` and fixed arguments. Availability is checked first, so "not installed" is never reported as "clean".
- **Scan results are a sidecar** (`.athena/security-scan.json`) rendered into `security.md` by `KnowledgeExtras`, which keeps the analyzer free of network/tool dependencies while letting scan results flow through the normal sync review.
- **Review is deterministic** (`services/review.ts`): every finding is a fact about the diff (added lines, changed paths, manifest deltas). Rules and the checklist are surfaced, never judged.

## Intelligence layer (Phase 6)

```mermaid
graph LR
  model["ProjectModel"] --> graph["Project graph"]
  docs[".athena/*.md sections"] --> engine["Context engine"]
  graph --> engine
  rules["rules.md"] --> engine
  engine --> cli["athena context"]
  engine --> mcp["MCP: get_relevant_context"]
  mcp --> agents["Any MCP agent"]
  docs -. redacted, consent .-> ai["AIProvider (optional)"]
  ai --> suggestions[".athena/ai-suggestions.md (INFERRED)"]
```

- **The graph is derived, never asserted.** Every node comes from something the analysis detected; import edges are resolved against indexed files only. It is a cache (`graph.json`, gitignored), rebuilt with `athena graph --build`.
- **Context selection is deterministic** so it can be tested, explained and trusted: areas from keywords, expansion from the graph, section ranking, and a character budget. The reason for each document is part of the output.
- **MCP is a thin adapter** over the same services the CLI uses, which is why it cannot drift from what `athena` itself reports. Writes are refused unless `--allow-write` is passed.
- **AI stays at the edge.** No core path depends on a provider; enrichment sends redacted knowledge (never source), requires consent, and writes only to a separate, clearly-labelled INFERRED file.

## Decisions

See `docs/adr/`.
