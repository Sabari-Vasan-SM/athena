# Security

## Athena's security model

- **Local-first.** Athena Phase 1 makes no network requests and uploads nothing.
- **No secret persistence.** Analysis records environment variable *names* only. `.env` files are never read. Likely secrets found in source are reported by type, location and a truncated SHA-256 fingerprint, never by value. Every generated document and `model.json` goes through a redaction pass.
- **No shell execution.** External tools (currently only `git`) are invoked with `execFile` and fixed argument lists.
- **Filesystem containment.** Writes are resolved inside the project root and refuse symlinked targets. The walker does not follow symlinks that leave the project root.
- **No silent overwrites.** Athena owns only `.athena/`, its own integration files and marked blocks. It never overwrites a user file at an Athena-owned path.

When the local web server ships (Phase 2), it will bind to `127.0.0.1`, require a per-session token, validate Host/Origin headers, and only serve the fixed set of `.athena` documents.

## Limitations

Athena's security documentation raises awareness. It is **not** a security audit. Pattern-based secret detection has false negatives and false positives. "No findings" does not mean "no vulnerabilities".

## Reporting a vulnerability

Please report vulnerabilities privately through the repository's security advisory feature rather than in a public issue.
