# Roadmap

Status legend: ✅ done · 🔜 next · 📋 planned

## Phase 1: Foundation ✅

- ✅ CLI: `init`, `analyze`, `status`, `doctor`, `rules`, `agents`, `clean`, `version`, `--json`, `--quiet`, `--cwd`
- ✅ Safe walker: ignores, `.gitignore`, symlink safety, binary/large-file handling, hashing, abort support
- ✅ Detectors for 10 ecosystems: manifests, frameworks, workspaces/monorepos, commands, env var names, Docker/compose/k8s/Terraform/hosting, CI, tests, database schema and migrations, HTTP routes, auth signals, entry points, secrets, git
- ✅ Provenance model (`FACT`/`DETECTED`/`INFERRED`/`UNKNOWN`)
- ✅ 12 knowledge documents with managed blocks and developer notes; `rules.md` round-trip
- ✅ `state.json` with a file index and change detection; impact mapping for `status`
- ✅ Agent adapters: Claude Code, Cursor, Antigravity, AGENTS.md
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

## Phase 4: Deeper agent integration 📋

- Claude Code hooks (`PreToolUse`/`PostToolUse`/`UserPromptSubmit`/`Stop`) call `athena event`, which posts observed activity to the local server
- Cursor hooks where supported
- Process detection, clearly labeled "running, not confirmed working"
- Re-verify each agent's instruction mechanism against its current docs

## Phase 5: Security and review 📋

- Native audit tools (`npm audit`, `pip-audit`, `govulncheck`, `cargo audit`) run with fixed argv; findings are labeled *Detected by tool*
- `athena security`, and `athena review` of the git diff against rules and `code-review.md`
- Secret-scan CI mode

## Phase 6: Intelligence 📋

- `AIProvider` abstraction (Anthropic, OpenAI, Google, Ollama) with Cloud / Local / Hybrid modes. Keys go in the OS keychain; explicit consent is required and redaction always runs first.
- Project graph (files, modules, routes, entities, dependencies) using web-tree-sitter
- Context engine: `get_relevant_context(task)`
- MCP server (`athena mcp`, stdio) exposing project context tools
