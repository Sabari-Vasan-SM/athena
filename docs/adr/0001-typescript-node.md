# ADR 0001: TypeScript on Node.js for the CLI and core

**Status:** Accepted · 2026-09

## Context

Athena needs a cross-platform CLI with heavy filesystem work, process management (git, later native audit tools), a local HTTP server and a React web UI. It will be installed by developers across many ecosystems.

## Options

- **Go:** single static binary, fast. But it splits the codebase from the React UI and its types, and multi-language AST parsing would need cgo tree-sitter.
- **Rust:** fastest and single binary. Highest implementation cost and slowest iteration for a product whose value is breadth of detection.
- **TypeScript/Node:** one language across core, server and UI, with shared zod schemas as the API contract. Mature libraries (commander, chokidar, fastify). Babel and web-tree-sitter parse without native builds. Installs via `npm install -g`, which the target audience already has.

## Decision

TypeScript on **Node.js ≥ 22.12**. Node 20 reached end of life in April 2026, and current commander, vitest and Babel require 22.12+.

The CLI is bundled with tsup into a single ESM file. A Node single-executable build can be added later for users without Node.

## Consequences

- Startup time is about 100 ms, which is acceptable for a CLI that is not called in tight loops.
- Native dependencies are avoided so Windows installs stay reliable.
- We keep one package with enforced internal boundaries (`core` ← `agents` ← `cli`, checked by a test) rather than npm workspaces. This can be split into packages later without code changes.
