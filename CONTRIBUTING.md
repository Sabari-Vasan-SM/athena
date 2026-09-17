# Contributing

## Setup

```bash
npm install
npm run typecheck
npm test          # builds the CLI for end-to-end tests
```

Node.js ≥ 22.12 is required.

## Ground rules

- **Never fabricate.** A detector may only emit `DETECTED` with evidence (file, and line where possible). Heuristics are `INFERRED`. If a renderer can't determine something, it prints `UNKNOWN`.
- **Core stays agent-agnostic.** `src/core` must not import from `src/agents` or `src/cli`, or mention agent-specific files. `tests/unit/architecture.test.ts` enforces this.
- **No secret values in output.** Add a leak assertion when you add a detector that reads file contents.
- **No shells.** Use `execFile` with fixed argv.
- **Cross-platform.** Store paths as repo-relative POSIX strings (`core/util/paths.ts`).

## Adding a framework or library

Add an entry to `src/core/analyzer/catalog.ts`, with `markers` for config files that corroborate usage, and a test in `tests/integration/analyzer.test.ts`.

## Adding a detector

1. Implement `Detector` in `src/core/analyzer/detectors/` and give it a `version`.
2. Register it in `DETECTORS` (`analyze.ts`). Order matters when you read earlier results.
3. Extend `ProjectModel` (zod) if you need new fields, and render them in `core/knowledge/renderers/`.
4. Add impact rules in `core/impact/impact.ts` for the files it reads, and map new model fields to documents in `core/impact/model-diff.ts` (`MODEL_SECTIONS`) so sync proposals can explain changes.
5. Keep rendered output stable: no volatile counts or sizes in generated sections.

## Adding an agent adapter

Implement `AgentAdapter` in `src/agents/<agent>/` using the agent's **documented** instruction mechanism. Cite the documentation in a comment. Register it in `src/agents/registry.ts`, and add doctor checks and an end-to-end test.
