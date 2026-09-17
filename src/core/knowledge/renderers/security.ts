import type { ProjectModel } from '../../model/project-model.js';
import type { Section } from '../managed-blocks.js';
import { bullets, code, esc, evidenceList, notDetected, table, unknown } from '../md.js';

export function renderSecurity(m: ProjectModel): Section[] {
  const s: Section[] = [];

  s.push({
    id: 'classification',
    content: [
      '## How to Read This Document',
      '',
      bullets([
        '**Detected** — observed directly in code/config by Athena, with evidence.',
        '**Verified** — confirmed by a human or a dedicated security tool run. _Athena Phase 1 produces no Verified findings._',
        '**Potential** — pattern that may indicate a problem; requires human review.',
        '**Unknown** — not determinable by static analysis.',
      ]),
      '',
      '_This document improves security awareness. It is not a security audit and does not certify the absence of vulnerabilities._',
    ].join('\n'),
  });

  const surface: string[] = [];
  if (m.routes.length) surface.push(`**Detected:** ${m.routes.length} HTTP route definitions (see \`api.md\`).`);
  if (m.apiSpecs.length) surface.push(`**Detected:** ${m.apiSpecs.length} API specification files.`);
  const exposed = m.containers.services.filter((c) => c.ports.length);
  if (exposed.length) surface.push(`**Detected:** compose services publishing ports: ${exposed.map((c) => `${esc(c.name)} (${c.ports.map(esc).join(', ')})`).join('; ')}.`);
  const exposedDocker = m.containers.dockerfiles.filter((d) => d.exposedPorts.length);
  if (exposedDocker.length) surface.push(`**Detected:** Dockerfile EXPOSE: ${exposedDocker.map((d) => `${code(d.path)} → ${d.exposedPorts.map(esc).join(', ')}`).join('; ')}.`);
  if (m.frameworks.some((f) => ['frontend', 'fullstack', 'mobile'].includes(f.category))) surface.push('**Detected:** client-side code exists — anything bundled into the client is public.');
  if (m.queues.length) surface.push(`**Detected:** message/queue consumers may process untrusted payloads (${m.queues.map((q) => esc(q.name)).join(', ')}).`);
  s.push({ id: 'attack-surface', content: ['## Attack Surface', '', surface.length ? bullets(surface) : unknown('Attack surface', 'no routes, exposed ports or client code detected')].join('\n') });

  s.push({
    id: 'controls',
    content: ['## Security Controls (declared)', '', m.security.controls.length ? table(['Control', 'Evidence'], m.security.controls.map((c) => [esc(c.name), evidenceList(c.provenance.evidence, 2)])) : notDetected('security middleware or validation libraries'), '', '_Detected as dependencies. Whether they are applied to every relevant code path is **Unknown**._'].join('\n'),
  });

  const secretRows = m.security.secrets.slice(0, 100).map((f) => [esc(f.type), code(`${f.file}:${f.line}`), code(f.fingerprint)]);
  const secretBody: string[] = ['## Secret Management', ''];
  if (m.security.secrets.length) {
    secretBody.push(`**Potential:** ${m.security.secrets.length} possible hardcoded secret(s). Values are never recorded; the fingerprint is a truncated SHA-256 for tracking. Review each and rotate any real credential.`, '', table(['Type', 'Location', 'Fingerprint'], secretRows));
  } else {
    secretBody.push('No likely secrets matched Athena\'s patterns in scanned files. This is **not** proof that no secrets exist (gitignored and oversized files are not scanned).');
  }
  if (m.env.envFilesPresent.length) secretBody.push('', `Local env files present: ${m.env.envFilesPresent.map(code).join(', ')}. Athena does not read their contents. Ensure they are gitignored.`);
  const secretVars = m.env.vars.filter((v) => v.secretLike);
  if (secretVars.length) secretBody.push('', `Secret-like environment variable names (values configured externally): ${secretVars.slice(0, 30).map((v) => code(v.name)).join(', ')}`);
  s.push({ id: 'secrets', content: secretBody.join('\n') });

  const risks: string[] = [];
  const hasBackend = m.frameworks.some((f) => ['backend', 'fullstack'].includes(f.category));
  const names = new Set([...m.security.controls.map((c) => c.name)]);
  if (hasBackend && m.routes.length && !m.auth.some((a) => a.kind !== 'hashing')) risks.push('**Potential:** routes detected but no authentication library/provider detected. Auth may be custom, external (gateway) or absent — verify.');
  if (hasBackend && ![...names].some((n) => /zod|joi|yup|validator|pydantic|validation/i.test(n))) risks.push('**Unknown:** input validation approach — no schema-validation library detected.');
  if (m.frameworks.some((f) => ['Express', 'Fastify', 'Koa', 'Hono'].includes(f.name)) && ![...names].some((n) => /helmet/i.test(n))) risks.push('**Potential:** no security-headers middleware (e.g. helmet) detected for the Node HTTP server.');
  if (hasBackend && ![...names].some((n) => /cors/i.test(n))) risks.push('**Unknown:** CORS policy — no CORS library detected (may be configured in framework/gateway).');
  if (m.frameworks.some((f) => ['Express', 'Fastify', 'Koa'].includes(f.name)) && ![...names].some((n) => /rate-limit/i.test(n))) risks.push('**Unknown:** rate limiting — no rate-limit middleware detected.');
  if (m.databases.some((d) => d.kind === 'driver') && !m.databases.some((d) => d.kind === 'orm')) risks.push('**Potential:** raw database driver without an ORM detected — review queries for injection (use parameterized queries).');
  if (m.auth.some((a) => /csurf/.test(a.name)) || names.has('csurf (deprecated)')) risks.push('**Detected:** `csurf` is deprecated; consider a maintained CSRF library.');
  risks.push('**Unknown:** CSRF protection for cookie-based sessions, SSRF protections for server-side fetches, and output encoding — not analyzed in this version.');
  s.push({ id: 'risks', content: ['## Risk Areas', '', bullets(risks)].join('\n') });

  s.push({
    id: 'tooling',
    content: ['## Security Tooling', '', m.security.tooling.length ? table(['Tool', 'Evidence'], dedupe(m.security.tooling).map((t) => [esc(t.name), evidenceList(t.provenance.evidence, 2)])) : notDetected('security tooling (dependency scanning, SAST, secret scanning)')].join('\n'),
  });

  s.push({
    id: 'dependencies',
    content: ['## Dependency Risks', '', 'Not analyzed in Phase 1. Athena will integrate native audit tools (`npm audit`, `pip-audit`, `govulncheck`, `cargo audit`) in a later phase.', '', `Manifests in scope: ${m.manifests.length ? m.manifests.map((x) => code(x.path)).slice(0, 15).join(', ') : '_none_'}`].join('\n'),
  });

  s.push({ id: 'known-issues', content: '## Known Unresolved Security Issues\n\n_None recorded by Athena._ Track confirmed issues in Developer Notes (without exploit details or secrets).' });
  return s;
}

function dedupe<T extends { name: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.name) ? false : (seen.add(i.name), true)));
}
