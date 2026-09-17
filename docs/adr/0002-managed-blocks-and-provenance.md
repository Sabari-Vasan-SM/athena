# ADR 0002: Managed blocks and provenance

**Status:** Accepted · 2026-09

## Context

Athena regenerates documentation that developers are also expected to edit. Regeneration must never destroy developer knowledge. AI agents reading the documents must be able to tell verified facts from guesses.

## Decision

1. Generated content lives in `<!-- athena:generated:start id=… hash=… -->` / `<!-- athena:generated:end id=… -->` blocks. The hash is the SHA-256 prefix of the content Athena wrote.
   - A block whose content no longer matches its hash was edited by a person. It is preserved and reported, and only `--force` regenerates it.
   - A block that Athena previously wrote and that is now absent was deleted on purpose. It is not re-added.
   - Unterminated markers are treated as developer content.
2. Generated documents contain no timestamps. Timestamps live in `state.json`, so unchanged projects produce no Git diffs.
3. Every model fact carries `Provenance { status, confidence, source, evidence[] }`. `FACT` is reserved for declarations and developer assertions. AI output can never exceed `INFERRED`.
4. `rules.md` is plain Markdown (bullets under `##` sections, `[disabled]` prefix) with a lossless round-trip parser. It is the single source of truth for rules. The CLI and the future web UI edit it in place.
5. Integration content inside user-owned agent files uses a separate `<!-- athena:start -->…<!-- athena:end -->` block that Athena fully owns and can remove cleanly.
