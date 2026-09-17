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

## Phase 2: Local server and web UI 🔜

- Fastify bound to `127.0.0.1` on the first free port from 7432. Random per-session token plus Host/Origin checks (CSRF and DNS-rebinding protection).
- File API restricted to the fixed `.athena` document allowlist.
- React (Vite) UI: overview (real counts only), document viewer/editor with sanitized Markdown and Mermaid (`securityLevel: 'strict'`), search, sync status, history from `git log -- .athena/<file>`.
- Rules editor (add/edit/delete/enable/disable), using `rules.md` as the source of truth.
- Agents page and an activity page with the robot state component. The robot shows "Waiting for an AI coding agent…" until real events arrive (Phase 4).

## Phase 3: Continuous synchronization 📋

- `athena watch` (chokidar, debounced) and `athena sync`
- Detector input tracking, so only affected detectors re-run and only affected blocks regenerate
- Proposed updates (review / update / ignore) instead of silent overwrites
- Nested `.gitignore` support, and git rename awareness

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
