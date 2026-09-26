# Athena Project Rules

<!--
This file is owned by you. Athena creates it once and never regenerates it.
AI agents configured by Athena are instructed to follow every enabled rule.

Format: one rule per top-level bullet under a "## Section" heading.
Disable a rule without deleting it by writing "- [disabled] ...".
Rules marked [disabled] below are SUGGESTIONS based on the detected stack — enable the ones that apply.
-->

## AI Agent Rules

- Read the relevant Athena knowledge (see the relevance map in your agent instructions) before making significant changes.
- Do not modify files unrelated to the task.
- Do not introduce new dependencies without stating the justification.
- Explain breaking changes (API, schema, configuration) before implementing them.
- Never add secrets, credentials or tokens to code, config, tests or logs.
- Treat statements marked INFERRED or UNKNOWN in Athena knowledge as unverified.

## Security

- Validate all external input at trust boundaries.
- Use parameterized queries or ORM query APIs; never build SQL from user input.

## Architecture

- [disabled] Keep business logic out of route handlers/controllers; use the service layer.

## Database

- [disabled] Schema changes must be reviewed before applying them to shared environments.

## API

- [disabled] Return consistent error responses across endpoints.
- [disabled] New endpoints must declare their authentication and authorization requirements.

## Testing

- [disabled] New business logic requires tests.
