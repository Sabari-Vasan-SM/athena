# Roadmap

Status legend: ✅ done · 🔜 next · 📋 planned

## Phase 1: Foundation ✅

- ✅ CLI: `init`, `analyze`, `status`, `doctor`, `rules`, `agents`, `clean`, `version`, `--json`, `--quiet`, `--cwd`
- ✅ Safe walker: ignores, `.gitignore`, symlink safety, binary/large-file handling, hashing, abort support
- ✅ Detectors for 10 ecosystems: manifests, frameworks, workspaces/monorepos, commands, env var names, Docker/compose/k8s/Terraform/hosting, CI, tests, database schema and migrations, HTTP routes, auth signals, entry points, secrets, git
- ✅ Provenance model (`FACT`/`DETECTED`/`INFERRED`/`UNKNOWN`)
- ✅ 12 knowledge documents with managed blocks and developer notes; `rules.md` round-trip
- ✅ `state.json` with a file index and change detection; impact mapping for `status`
- ✅ Agent adapters: Claude Code, Cursor, Codex, Antigravity, AGENTS.md
- ✅ Tests: unit, analyzer integration, CLI end-to-end, interruption, a 20k-file scale test, module boundaries

**Known Phase 1 limitations**
- Only the root `.gitignore` is applied (nested `.gitignore` files are not).
- Route paths don't include router mount prefixes (Express `app.use('/api', router)`, FastAPI `include_router`).
- No request/response schema extraction, and per-route auth is `UNKNOWN`.
- Dependency vulnerability data is not collected.

## Phase 2: Local server and web UI ✅

- ✅ `athena open`: Fastify on `127.0.0.1`, first free port from 7432, reuses an already-running instance (`.athena/.server.json`, mode 0600, gitignored), graceful Ctrl+C
- ✅ Security: per-session bearer token in the URL fragment; Host allowlist (DNS rebinding); Origin check and JSON-only bodies on writes; strict validation (no coercion, unknown fields rejected); strict CSP and security headers; document API restricted to the fixed allowlist; static files served from a startup allowlist; `--allow-remote` required for non-loopback binding
- ✅ Shared `services/` layer used by both the CLI and the server
- ✅ React UI (Vite): overview with real counts only, sync panel with one-click re-analysis, detected stack, per-document sync dots
- ✅ Document viewer: sanitized Markdown (rehype-sanitize), Mermaid (`securityLevel: 'strict'` plus DOMPurify), section ownership labels, lazily loaded CodeMirror editor with ⌘S, conflict detection (409), secret refusal (422), live reload on external changes, Git-backed history
- ✅ Rules editor (add, inline edit, toggle, delete), with optimistic concurrency on `rules.md`
- ✅ Agents page (configure/remove, checks, honest presence detection that ignores Athena's own files)
- ✅ Activity page and robot component (8 animated states, `prefers-reduced-motion`). Only observed events: analyses, UI edits, `.athena/*.md` changes on disk. Agent activity is labeled not available.
- ✅ Search (⌘K), responsive layout, light/dark via `prefers-color-scheme`
- ✅ Tests: server security and API (inject + real sockets), XSS sanitization and token handling (jsdom), and a browser pass verifying the full flow

**Known Phase 2 limitations**
- No per-agent live activity (Phase 4).
- The server builds its static-asset allowlist at startup, so restart `athena open` after rebuilding the UI.
- No end-to-end browser test suite in CI yet. The UI was verified manually in a browser, and components are tested in jsdom.
- History shows committed versions only, without diffs.

## Phase 3: Continuous synchronization ✅

- ✅ Shared `IgnoreMatcher`: default ignores, root and nested `.gitignore` files (scoped to their directory), `.git/info/exclude`, config ignore/include. The walker and watcher use the same rules.
- ✅ Incremental analysis: files with unchanged size and mtime reuse their stored hash and binary flag
- ✅ Knowledge planning split from writing (`planKnowledge` / `writePlannedKnowledge`)
- ✅ Semantic impact analysis (`core/impact/model-diff.ts`): section-level model diff with human summaries ("1 route added (POST /refunds)") mapped to documents, combined with path-based impact rules
- ✅ `services/sync.ts`: plan (file changes, content-based renames, Git commits/branch/divergence, model changes, per-document reasons, unified diffs, preserved sections, stable plan id) and apply (refuses if documents changed since planning; refreshes model, index and state)
- ✅ Ignore a proposal; it resurfaces when content changes. Index-only refresh when files change but knowledge doesn't.
- ✅ `athena sync` (`--yes`, `--dry-run`, `--diff`, `--check`, `--force`) and `athena watch` (debounced bursts, max wait, Git HEAD watching, `--auto-apply`)
- ✅ `athena open` watches by default: live proposals over SSE, a Sync page with diffs and Update/Ignore, a sidebar badge, and an overview banner
- ✅ Document rendering stabilized so incidental changes don't churn knowledge (language shares instead of byte counts, hotspots without counts, no file totals)
- ✅ Tests: ignore matcher, model diff, plan/apply/conflict/rename/ignore/git, watcher (propose, auto-apply, ignored paths), sync API, CLI `sync`, DiffView XSS

**Known Phase 3 limitations**
- Detectors re-run over the whole project on each plan; only hashing is incremental. Per-detector input caching is future work. Planning takes about 3 seconds at 20k files.
- Applying is all-or-nothing per proposal. To keep your version of one section, edit that section, and it becomes developer-owned.
- Reasons for a document list every model change mapped to it, not only the ones that caused the specific changed lines.
- The watcher does not follow symlinked directories, and Git HEAD watching expects a standard `.git` directory layout.

## Phase 4: Deeper agent integration ✅

- ✅ Verified each agent's documented hook mechanism before implementing (Claude Code: `code.claude.com/docs/en/hooks`; Cursor: `cursor.com/docs/agent/hooks`, both checked 2026-09)
- ✅ Claude Code hooks in `.claude/settings.json` (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `Stop`, `SessionEnd`), exec form with `args` (no shell) and `async: true` so the agent is never blocked
- ✅ Cursor hooks in `.cursor/hooks.json` plus a generated forwarding script (Cursor executes a script path)
- ✅ `athena event`: reads the hook payload on stdin, never writes stdout, always exits 0, and appends to `.athena/.agent-events.jsonl` (no network, no token, rotated, gitignored)
- ✅ Honest normalization: tool → state (read → ANALYZING, edit → CODING, test command → TESTING, lint/audit → REVIEWING, stop → SUCCESS); `PostToolUse` ignored to avoid duplicates; prompt text never stored; secrets redacted; paths project-relative
- ✅ Server tails the log: live events over SSE, history seeded on startup, robot driven by the agent with a 5-minute freshness window
- ✅ `athena activity` CLI, per-agent observation status and session summaries in the UI and `athena doctor` (including a PATH check, since hooks invoke `athena`)
- ✅ JSON configs are merged, never overwritten: user hooks are preserved, Athena entries are marked, and removal restores the original file

**Known Phase 4 limitations**
- Antigravity publishes no hook mechanism, so its activity is reported as unsupported.
- The Cursor forwarding script is generated for the current platform (`.sh` or `.cmd`); a repo shared across platforms needs a re-run of `athena agents add cursor`.
- Athena cannot tell whether an agent is running when no hook has fired, and it never sees reasoning or plans.
- Hooks require `athena` on PATH (or `ATHENA_HOOK_COMMAND`); doctor warns when it is not.

## Phase 5: Security and review ✅

- ✅ `athena security`: runs native audit tools (`npm audit`, `pnpm audit`, `pip-audit`, `govulncheck`, `cargo audit`, `composer audit`) with fixed argv, per-tool timeouts, and availability checks — a missing tool is reported as unknown, never as "no problems"
- ✅ Findings normalized (package, severity, advisory, id, url, fix availability) and attributed to the producing tool; stored in `.athena/security-scan.json`
- ✅ Rendered into `security.md` through the normal sync flow, so scan results are reviewable like any other knowledge change
- ✅ `--fail-on <severity>` and secret findings for CI; `--last` to re-read the previous scan; `--no-audit` for secrets only
- ✅ `athena review`: deterministic checks over the current diff — secrets in added lines (blocker, exit 1), committed env files, new dependencies, source changed without tests, API/schema/auth touchpoints, large added files, debug leftovers, high/critical advisories from the last scan, and knowledge freshness
- ✅ Review prints the project's enabled rules and `code-review.md` checklist as items for a human or agent to apply, without claiming to evaluate them
- ✅ Security page in the web UI (scan, severity table, tool status, secret locations) and `/api/security`, `/api/security/scan`, `/api/review`
- ✅ Tests: tool availability/parsing/persistence, threshold logic, rendering with tool attribution, review findings and exit codes, and no-secret-leak assertions throughout

**Known Phase 5 limitations**
- Audits need the ecosystem's tool installed, and most need network access. Yarn (Berry) and bundler-audit are not covered.
- `npm audit` severities come from npm; `pip-audit` and `govulncheck` report no severity, so those findings show as unknown.
- Review is deterministic and syntactic: it reads paths and added lines, not semantics. It cannot tell whether a rule was actually followed.
- No SAST, no license checks, and no automatic fixes.

## Phase 6: Intelligence ✅

- ✅ **Project graph** (`core/graph/graph.ts`, `.athena/graph.json`): packages, files, routes, entities, frameworks, commands and infrastructure, connected by `contains`, `imports`, `handles`, `defines`, `depends_on` and `runs`. Import edges are resolved for TS/JS and Python; imported files are added to the graph, so it reaches beyond files the model referenced directly. Queries: `neighbors`, `expandFromFiles`.
- ✅ **Context engine** (`core/context/context-engine.ts`): keyword → area mapping, graph expansion from files named in the task, section-level ranking under a character budget, rules always included, and a stated reason per document. Fully deterministic.
- ✅ **MCP server** (`athena mcp`, official SDK, stdio) with 12 tools; read-only by default, `--allow-write` required for `update_knowledge` to apply. Registered with agents via `.mcp.json` / `.cursor/mcp.json`.
- ✅ **AI providers** (`ai/providers.ts`): Anthropic, OpenAI, Google and Ollama behind one `AIProvider` interface, with availability checks; keys from environment variables only.
- ✅ **AI enrichment** (`athena ai enrich`): consent-gated, knowledge-only (never source), redacted twice, output written to `.athena/ai-suggestions.md` labeled INFERRED and attributed to provider/model. Never modifies knowledge documents.
- ✅ **CLI**: `athena context`, `athena graph`, `athena architecture`, `athena mcp`, `athena ai`. Every previously reserved command is now implemented.
- ✅ **Web UI**: Context page (task → selected documents with reasons, related graph nodes, sections and content), graph build/rebuild.
- ✅ Tests: graph construction and queries, context selection/determinism/budget, MCP tool surface and read-only enforcement over a real client transport, AI availability/consent/redaction/error handling with a stubbed provider.

**Known Phase 6 limitations**
- The graph is built from analysis output plus import parsing; it has no call graph, type information or cross-language resolution, and TS path aliases are not resolved.
- Context selection is keyword- and graph-based. It has no semantic understanding, so unusual vocabulary can miss an area (rules are always included as a floor).
- `athena ai enrich` is the only AI feature, and its output is never applied automatically. Providers are called over plain HTTP APIs with no streaming or retries, and token costs are not estimated.
- API keys are read from environment variables; OS keychain storage is not implemented.
- MCP exposes stdio only (no HTTP transport), and one project per server process.
