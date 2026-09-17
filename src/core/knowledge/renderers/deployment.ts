import type { ProjectModel } from '../../model/project-model.js';
import type { Section } from '../managed-blocks.js';
import { bullets, code, esc, evidenceList, notDetected, table, truncatedNote, unknown } from '../md.js';

export function renderDeployment(m: ProjectModel): Section[] {
  const s: Section[] = [];
  const hosting = m.infrastructure.filter((i) => i.kind === 'hosting');
  const iac = m.infrastructure.filter((i) => i.kind === 'iac');
  const k8s = m.infrastructure.filter((i) => i.kind === 'kubernetes');
  const proxy = m.infrastructure.filter((i) => i.kind === 'reverse-proxy');

  s.push({
    id: 'architecture',
    content: [
      '## Deployment Architecture',
      '',
      hosting.length ? `**Hosting/platform configuration:**\n\n${table(['Platform', 'File'], hosting.map((h) => [esc(h.name), code(h.file)]))}` : unknown('Hosting platform', 'no platform configuration files detected'),
      '',
      iac.length ? `**Infrastructure as code:** ${iac.map((i) => `${esc(i.name)} (${code(i.file)})`).join(', ')}` : '_No infrastructure-as-code detected._',
      '',
      k8s.length ? `**Kubernetes resources:** ${k8s.map((i) => `${esc(i.name)} (${code(i.file)})`).join(', ')}` : '',
      proxy.length ? `**Reverse proxy:** ${proxy.map((i) => `${esc(i.name)} (${code(i.file)})`).join(', ')}` : '',
    ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n').trim(),
  });

  const df = m.containers.dockerfiles;
  s.push({
    id: 'containers',
    content: ['## Containers', '', df.length ? table(['Dockerfile', 'Base images', 'Exposed ports'], df.map((d) => [code(d.path), d.baseImages.map(esc).join(', ') || '—', d.exposedPorts.map(esc).join(', ') || '—'])) : notDetected('Dockerfiles'), '', m.containers.services.length ? `Compose services: ${m.containers.services.map((c) => code(c.name)).join(', ')} (see \`architecture.md\`).` : ''].join('\n').trim(),
  });

  const jobs = m.ci.slice(0, 30);
  s.push({
    id: 'ci-cd',
    content: [
      '## CI/CD',
      '',
      jobs.length
        ? table(['System', 'Job', 'Key steps', 'File'], jobs.map((j) => [esc(j.system), esc(j.name), j.commands.slice(0, 4).map((c) => code(c)).join('<br>') || '—', code(j.file)])) + truncatedNote(jobs.length, m.ci.length, 'CI jobs')
        : notDetected('CI/CD pipelines'),
    ].join('\n'),
  });

  s.push({ id: 'environments', content: ['## Environments', '', unknown('Environment list (dev/staging/production), domains and promotion flow', 'not determinable from code — document them in Developer Notes')].join('\n') });

  const vars = m.env.vars.slice(0, 80);
  s.push({
    id: 'env-vars',
    content: [
      '## Environment Variables',
      '',
      'Names only. **Values are never read or stored by Athena** — all values are `<configured externally>`.',
      '',
      vars.length ? table(['Variable', 'Value', 'Referenced in'], vars.map((v) => [code(v.name), v.secretLike ? '`<secret>`' : '`<configured externally>`', v.references.slice(0, 2).map(code).join(', ') + (v.references.length > 2 ? ` +${v.references.length - 2}` : '')])) + truncatedNote(vars.length, m.env.vars.length, 'variables') : notDetected('environment variable references'),
    ].join('\n'),
  });

  const deployCmds = m.commands.filter((c) => ['build', 'deploy', 'migrate', 'start'].includes(c.purpose)).slice(0, 15);
  s.push({
    id: 'commands',
    content: ['## Build, Release & Migration Commands', '', deployCmds.length ? table(['Purpose', 'Command', 'Defined in'], deployCmds.map((c) => [c.purpose, code(c.command), code(c.source)])) : notDetected('build/deploy commands'), '', m.migrations.length ? `Migrations: ${m.migrations.map((x) => `${esc(x.tool)} in ${code(x.path)}`).join(', ')}. ${unknown('When migrations run during deploy')}` : ''].join('\n').trim(),
  });
  s.push({ id: 'notes', content: ['## Deployment Safety', '', bullets(['Never commit secrets; configure them in the hosting platform or a secret manager.', 'Document rollback procedures in Developer Notes.']), '', `_Evidence for this document comes from ${m.infrastructure.length + m.ci.length + df.length} infrastructure/CI files (${evidenceList(m.infrastructure.flatMap((i) => i.provenance.evidence), 3)})._`].join('\n') });
  return s;
}
