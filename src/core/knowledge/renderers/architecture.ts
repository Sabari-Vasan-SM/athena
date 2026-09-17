import type { ProjectModel } from '../../model/project-model.js';
import type { Section } from '../managed-blocks.js';
import { bullets, code, esc, evidenceList, mermaidId, mermaidLabel, notDetected, status, table, unknown } from '../md.js';

export function renderArchitecture(m: ProjectModel): Section[] {
  const s: Section[] = [];
  const fe = m.frameworks.filter((f) => ['frontend', 'fullstack', 'mobile', 'desktop'].includes(f.category));
  const be = m.frameworks.filter((f) => ['backend', 'fullstack'].includes(f.category));

  const summary: string[] = ['## System Overview', ''];
  const layers: string[] = [];
  if (fe.length) layers.push(`Client/UI layer: ${[...new Set(fe.map((f) => f.name))].map(esc).join(', ')} — DETECTED`);
  if (be.length) layers.push(`Server/API layer: ${[...new Set(be.map((f) => f.name))].map(esc).join(', ')} — DETECTED`);
  if (m.databases.length) layers.push(`Data layer: ${m.databases.map((d) => esc(d.name)).join(', ')} — DETECTED`);
  if (m.caching.length) layers.push(`Caching: ${m.caching.map((d) => esc(d.name)).join(', ')} — DETECTED`);
  if (m.queues.length) layers.push(`Async/queues: ${m.queues.map((d) => esc(d.name)).join(', ')} — DETECTED`);
  summary.push(layers.length ? bullets(layers) : unknown('Architecture layers', 'no known frameworks or data stores detected'));
  summary.push('', '_Layer membership is based on declared dependencies. How components interact at runtime is not verified by static analysis._');
  s.push({ id: 'overview', content: summary.join('\n') });

  const ws = m.workspace;
  if (ws.isMonorepo && ws.packages.length > 1) {
    const edges = ws.packages.flatMap((p) => p.internalDependencies.map((d) => [p.name, d] as const));
    const lines = ['```mermaid', 'graph LR'];
    for (const p of ws.packages) if (p.path !== '.') lines.push(`  ${mermaidId(p.name)}["${mermaidLabel(`${p.name} (${p.kind})`)}"]`);
    for (const [from, to] of edges) lines.push(`  ${mermaidId(from)} --> ${mermaidId(to)}`);
    lines.push('```');
    s.push({
      id: 'modules',
      content: ['## Workspace Modules & Dependencies', '', `Edges are declared internal dependencies between workspace packages (DETECTED from manifests).`, '', lines.join('\n'), '', edges.length ? '' : '_No internal dependencies declared between packages._'].join('\n').trim(),
    });
  } else {
    const dirs = m.topLevelDirs.filter((d) => !d.startsWith('.'));
    s.push({ id: 'modules', content: ['## Modules', '', dirs.length ? `Top-level directories: ${dirs.map(code).join(', ')}` : '_Flat project structure._', '', unknown('Module boundaries and responsibilities', 'describe them in Developer Notes')].join('\n') });
  }

  if (m.containers.services.length) {
    const lines = ['```mermaid', 'graph TD'];
    for (const svc of m.containers.services) lines.push(`  ${mermaidId(svc.name)}["${mermaidLabel(`${svc.name}${svc.image ? ` · ${svc.image}` : ''}`)}"]`);
    for (const svc of m.containers.services) for (const dep of svc.dependsOn) lines.push(`  ${mermaidId(svc.name)} --> ${mermaidId(dep)}`);
    lines.push('```');
    s.push({
      id: 'services',
      content: ['## Service Topology (containers)', '', 'From compose files. Arrows are `depends_on` relationships (DETECTED).', '', lines.join('\n'), '', table(['Service', 'Image', 'Ports', 'Depends on', 'File'], m.containers.services.map((c) => [esc(c.name), esc(c.image ?? '—'), c.ports.map(esc).join(', ') || '—', c.dependsOn.map(esc).join(', ') || '—', code(c.file)]))].join('\n'),
    });
  } else {
    s.push({ id: 'services', content: '## Service Topology\n\n_No container orchestration (compose) detected._ Runtime service topology: **UNKNOWN**.' });
  }

  const flow: string[] = ['## Data Flow', ''];
  if (fe.length && be.length && m.databases.length) {
    flow.push('```mermaid', 'graph LR', '  client["Client / UI"] --> api["API / Server"]', '  api --> data["Data store"]', '```', '', '_INFERRED from the presence of UI, server and data-layer dependencies. Actual request paths are not verified._');
  } else if (be.length && m.databases.length) {
    flow.push('```mermaid', 'graph LR', '  caller["Caller"] --> api["API / Server"]', '  api --> data["Data store"]', '```', '', '_INFERRED from server and data-layer dependencies._');
  } else {
    flow.push(unknown('Data flow', 'insufficient evidence to infer a request/data path'));
  }
  s.push({ id: 'data-flow', content: flow.join('\n') });

  const external = [...m.auth.filter((a) => a.kind === 'provider'), ...m.observability, ...m.infrastructure.filter((i) => i.kind === 'hosting')];
  s.push({
    id: 'external-services',
    content: ['## External Services', '', external.length ? table(['Service', 'Status', 'Evidence'], external.map((e) => [esc(e.name), status(e.provenance), evidenceList(e.provenance.evidence, 2)])) : notDetected('external service integrations'), '', '_Only services identifiable from dependencies/config are listed. Third-party APIs called over plain HTTP are not detected in this version._'].join('\n'),
  });

  s.push({ id: 'decisions', content: '## Architectural Decisions\n\n_Athena does not infer architectural decisions. Record them in Developer Notes (or link ADRs) so agents can respect them._' });
  return s;
}
