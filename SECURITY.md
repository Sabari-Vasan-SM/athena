# Security

## Athena's security model

- **Local-first.** Athena makes no outbound network requests and uploads nothing. The optional web UI is served from your own machine.
- **No secret persistence.** Analysis records environment variable *names* only. `.env` files are never read. Likely secrets found in source are reported by type, location and a truncated SHA-256 fingerprint, never by value. Every generated document and `model.json` goes through a redaction pass.
- **No shell execution.** External tools (currently only `git`) are invoked with `execFile` and fixed argument lists.
- **Filesystem containment.** Writes are resolved inside the project root and refuse symlinked targets. The walker does not follow symlinks that leave the project root.
- **No silent overwrites.** Athena owns only `.athena/`, its own integration files and marked blocks. It never overwrites a user file at an Athena-owned path.

- **Local web server (`athena open`).**
  - **Binding:** `127.0.0.1` only. Binding elsewhere requires `--allow-remote`.
  - **Access:** every API call needs a random 256-bit per-session token, delivered in the URL fragment. The instance file holding it is written with mode 0600 and gitignored.
  - **Request checks:** Host allowlist against DNS rebinding; Origin and JSON content-type checks on writes; strict schema validation.
  - **Headers:** a CSP with `script-src 'self'`, `frame-ancestors 'none'`, and `no-referrer`.
  - **Files:** documents are addressed by id from a fixed allowlist, and static files come from an allowlist built at startup. No request input is ever joined into a filesystem path.
  - **Rendering:** Markdown goes through a strict sanitizer allowlist. Mermaid runs with `securityLevel: 'strict'`, and its SVG output passes through DOMPurify.
  - **Secrets:** saves that look like they contain secrets are rejected.

- **Agent hooks.** Hook events are written to a local, gitignored file — never sent over the network. Athena records the tool name, file paths and command only; prompts and model output are not stored, commands are redacted with the same secret patterns, and paths are stored project-relative. Athena's hook entries are marked and merged into agent config without touching your own hooks.
- **Dependency audits.** External audit tools run with `execFile` and fixed arguments, with per-tool timeouts. Athena ships no vulnerability database and attributes every finding to the tool that produced it. Most of these tools contact their ecosystem's advisory service; run `athena security --no-audit` to stay fully offline.

- **MCP server.** Runs on stdio for the project it was started in, and is read-only unless `--allow-write` is passed. It exposes `.athena` knowledge only — never arbitrary file reads.
- **AI providers (optional).** Disabled until configured. Nothing is sent without explicit consent (`--consent` or `"ai": { "consent": true }`), only `.athena` documents are sent (never source code), the payload passes through the secret redactor and is refused if anything secret-looking remains, and `--dry-run` shows the exact payload, provider and endpoint first. API keys are read from environment variables and never written to disk. Choosing the `ollama` provider keeps everything on your machine.

## Limitations

Athena's security documentation raises awareness, and `athena security` reports what external audit tools find. Neither is a security audit of your code. Pattern-based secret detection has false negatives and false positives. "No findings" does not mean "no vulnerabilities".

## Reporting a vulnerability

Please report vulnerabilities privately through the repository's security advisory feature rather than in a public issue.
