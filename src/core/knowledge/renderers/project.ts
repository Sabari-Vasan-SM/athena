import type { ProjectModel } from '../../model/project-model.js';
import type { Section } from '../managed-blocks.js';
import { bullets, code, esc, evidenceList, notDetected, status, table, truncatedNote, unknown } from '../md.js';

export function renderProject(m: ProjectModel): Section[] {
  const sections: Section[] = [];

  const purpose = m.description
    ? `${esc(m.description)}\n\n_Source: package manifest description (FACT)._`
    : `${unknown('Project purpose', 'no description found in manifests. Describe the project in Developer Notes below.')}`;
  sections.push({ id: 'overview', content: `## Overview\n\n**Name:** ${esc(m.name)}\n\n${purpose}` });

  // Rounded shares keep this section stable: adding one file should not churn the document.
  const totalBytes = m.languages.reduce((n, l) => n + l.bytes, 0) || 1;
  const share = (bytes: number) => {
    const pct = (bytes / totalBytes) * 100;
    return pct < 5 ? '<5%' : `~${Math.round(pct / 5) * 5}%`;
  };
  const langRows = m.languages.slice(0, 12).map((l) => [esc(l.name), share(l.bytes)]);
  sections.push({
    id: 'technologies',
    content: [
      '## Technologies',
      '',
      '### Languages',
      '',
      langRows.length ? table(['Language', 'Share of source'], langRows) : notDetected('source languages'),
      '',
      '### Frameworks & Libraries',
      '',
      m.frameworks.length
        ? table(['Name', 'Category', 'Location', 'Status', 'Evidence'], m.frameworks.map((f) => [esc(f.name), f.category, code(f.root), status(f.provenance), evidenceList(f.provenance.evidence, 2)]))
        : notDetected('known frameworks'),
      '',
      '### Package Managers & Build Tools',
      '',
      m.packageManagers.length || m.buildSystems.length
        ? bullets([...m.packageManagers.map((p) => `Package manager: **${esc(p.name)}** — ${status(p.provenance)} (${evidenceList(p.provenance.evidence, 2)})`), ...m.buildSystems.map((b) => `Build tool: **${esc(b.name)}** — ${status(b.provenance)} (${evidenceList(b.provenance.evidence, 2)})`)])
        : notDetected('package managers or build tools'),
    ].join('\n'),
  });

  const ws = m.workspace;
  const structure: string[] = ['## Structure', ''];
  structure.push(`**Top-level directories:** ${m.topLevelDirs.length ? m.topLevelDirs.map(code).join(', ') : '_none_'}`);
  if (ws.isMonorepo) {
    structure.push('', `**Monorepo:** yes${ws.tool ? ` (${esc(ws.tool)})` : ''} — DETECTED`, '');
    structure.push(table(['Package', 'Path', 'Kind', 'Ecosystem', 'Internal deps'], ws.packages.map((p) => [esc(p.name), code(p.path), p.kind, p.ecosystem, p.internalDependencies.map(esc).join(', ') || '—'])));
  } else {
    structure.push('', '**Monorepo:** no workspace configuration detected.');
  }
  sections.push({ id: 'structure', content: structure.join('\n') });

  sections.push({
    id: 'entry-points',
    content: ['## Entry Points', '', m.entryPoints.length ? table(['Path', 'Status', 'Evidence'], m.entryPoints.map((e) => [code(e.path), status(e.provenance), esc(e.provenance.evidence[0]?.detail ?? evidenceList(e.provenance.evidence))])) : notDetected('entry points')].join('\n'),
  });

  const cmds = m.commands.slice(0, 40);
  sections.push({
    id: 'commands',
    content: ['## Commands', '', cmds.length ? table(['Name', 'Command', 'Purpose', 'Defined in'], cmds.map((c) => [code(c.name), code(c.command.length > 100 ? `${c.command.slice(0, 97)}...` : c.command), c.purpose, code(c.source)])) + truncatedNote(cmds.length, m.commands.length, 'commands') : notDetected('scripted commands (package scripts, Makefile, justfile)')].join('\n'),
  });

  const env: string[] = ['## Environment Requirements', ''];
  const runtimes = m.manifests.map((x) => x.ecosystem).filter((v, i, a) => a.indexOf(v) === i);
  env.push(`**Ecosystems:** ${runtimes.length ? runtimes.join(', ') : 'UNKNOWN'}`);
  env.push('', `**Environment variables referenced:** ${m.env.vars.length} (names only — see \`deployment.md\`)`);
  if (m.env.envFilesPresent.length) env.push('', `**Local env files present (contents never read):** ${m.env.envFilesPresent.map(code).join(', ')}`);
  env.push('', unknown('Required runtime versions', 'not inferred; check manifests/tool-version files'));
  sections.push({ id: 'environment', content: env.join('\n') });

  const devCmds = m.commands.filter((c) => ['dev', 'build', 'test', 'lint', 'start'].includes(c.purpose)).slice(0, 8);
  sections.push({
    id: 'workflow',
    content: ['## Development Workflow', '', devCmds.length ? `Detected workflow commands:\n\n${bullets(devCmds.map((c) => `${c.purpose}: ${code(c.command)} (${code(c.source)})`))}` : unknown('Development workflow', 'no dev/build/test commands detected'), '', '_Branching strategy, review process and release process are not detectable from code — document them in Developer Notes._'].join('\n'),
  });

  if (m.warnings.length) {
    sections.push({ id: 'analysis-warnings', content: ['## Analysis Warnings', '', bullets(m.warnings.slice(0, 20).map(esc))].join('\n') });
  } else {
    sections.push({ id: 'analysis-warnings', content: '## Analysis Warnings\n\nNone.' });
  }
  return sections;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
