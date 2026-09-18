import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { KNOWLEDGE_DOCS, RELEVANCE_MAP } from '../core/knowledge/documents.js';
import { athenaDir, readState } from '../core/state/state.js';
import { readTextIfExists } from '../core/util/fs.js';
import { listRules, parseRules } from '../core/knowledge/rules.js';
import { formatContext, getGraph, getRelevantContext, graphSummary } from '../services/context.js';
import { buildStatus } from '../services/status.js';
import { planSync, applySync, summarizePlan } from '../services/sync.js';
import { loadScan } from '../core/model/security-scan.js';
import { ATHENA_VERSION } from '../services/version.js';

/**
 * MCP server exposing Athena's project intelligence to any MCP-capable agent.
 *
 * Read-only by default: `update_knowledge` only *proposes* changes unless the
 * server was started with --allow-write, so an agent can never silently rewrite
 * a developer's knowledge base.
 */

export interface McpOptions {
  root: string;
  allowWrite?: boolean;
}

const textResult = (text: string) => ({ content: [{ type: 'text' as const, text }] });

async function docText(root: string, file: string): Promise<string> {
  const text = await readTextIfExists(path.join(athenaDir(root), file));
  return text ?? `${file} does not exist yet. Run \`athena init\` or \`athena analyze\` in this project.`;
}

export function createMcpServer(opts: McpOptions): McpServer {
  const { root } = opts;
  const server = new McpServer(
    { name: 'athena', version: ATHENA_VERSION },
    {
      instructions: [
        'Athena provides maintained project knowledge for this repository.',
        'Call get_relevant_context with the task you were given before making significant changes — it returns only the knowledge that matters for that task, plus the project rules.',
        'Every statement carries a label: FACT and DETECTED are evidence-backed; INFERRED and UNKNOWN are not — verify those in the code before relying on them.',
        'get_project_rules returns rules the developer expects you to follow.',
      ].join(' '),
    },
  );

  server.registerTool(
    'get_relevant_context',
    {
      title: 'Get relevant project context for a task',
      description: 'Given a task description, return only the knowledge sections that matter for it, the project rules, and related code from the project graph. Prefer this over reading whole documents.',
      inputSchema: { task: z.string().min(3).describe('What you are about to do, e.g. "add refunds to the payments API"'), maxChars: z.number().int().min(500).max(60_000).optional() },
    },
    async ({ task, maxChars }) => textResult(formatContext(await getRelevantContext(root, task, { maxChars, buildGraph: true }))),
  );

  server.registerTool(
    'get_project_context',
    { title: 'Project overview', description: 'Technologies, structure, entry points and commands (project.md).', inputSchema: {} },
    async () => textResult(await docText(root, 'project.md')),
  );

  server.registerTool(
    'get_architecture',
    { title: 'Architecture', description: 'System and module architecture, service topology and data flow (architecture.md).', inputSchema: {} },
    async () => textResult(await docText(root, 'architecture.md')),
  );

  server.registerTool(
    'get_database_schema',
    { title: 'Database schema', description: 'Databases, entities, relationships, indexes and migrations (database.md).', inputSchema: {} },
    async () => textResult(await docText(root, 'database.md')),
  );

  server.registerTool(
    'get_api_context',
    { title: 'API context', description: 'Detected endpoints, API specifications and error handling notes (api.md).', inputSchema: {} },
    async () => textResult(await docText(root, 'api.md')),
  );

  server.registerTool(
    'get_security_context',
    { title: 'Security context', description: 'Attack surface, controls, potential secrets and dependency audit results (security.md).', inputSchema: {} },
    async () => {
      const scan = await loadScan(root);
      const doc = await docText(root, 'security.md');
      const suffix = scan ? `\n\n_Last dependency scan: ${scan.scannedAt}._` : '\n\n_No dependency audit has been run (`athena security`)._';
      return textResult(doc + suffix);
    },
  );

  server.registerTool(
    'get_project_rules',
    { title: 'Project rules', description: 'Developer-defined rules this project expects agents to follow. Disabled rules are excluded.', inputSchema: {} },
    async () => {
      const text = await readTextIfExists(path.join(athenaDir(root), 'rules.md'));
      if (!text) return textResult('No rules.md found. Run `athena init` in this project.');
      const rules = listRules(parseRules(text)).filter((r) => r.enabled);
      return textResult(rules.length ? ['# Project rules (all apply)', '', ...rules.map((r) => `- [${r.section}] ${r.text}`)].join('\n') : 'rules.md contains no enabled rules.');
    },
  );

  server.registerTool(
    'get_knowledge_document',
    {
      title: 'Read one knowledge document',
      description: `Read a full Athena document. Available: ${KNOWLEDGE_DOCS.map((d) => d.id).join(', ')}.`,
      inputSchema: { document: z.enum(KNOWLEDGE_DOCS.map((d) => d.id) as [string, ...string[]]) },
    },
    async ({ document }) => textResult(await docText(root, KNOWLEDGE_DOCS.find((d) => d.id === document)!.file)),
  );

  server.registerTool(
    'get_project_changes',
    { title: 'Project changes since the last analysis', description: 'Files changed since Athena last analyzed the project, and which knowledge may be affected.', inputSchema: {} },
    async () => {
      const status = await buildStatus(root);
      const c = status.changes;
      return textResult(
        [
          `Knowledge health: ${status.health}; synchronization: ${status.sync}.`,
          `Changed since last analysis: ${c.modified.length} modified, ${c.added.length} added, ${c.deleted.length} deleted.`,
          c.modified.length ? `Modified: ${c.modified.slice(0, 40).join(', ')}` : '',
          c.added.length ? `Added: ${c.added.slice(0, 40).join(', ')}` : '',
          c.deleted.length ? `Deleted: ${c.deleted.slice(0, 40).join(', ')}` : '',
          status.affectedDocuments.length ? `Possibly affected knowledge: ${status.affectedDocuments.map((a) => `${a.file} (${a.reasons.join(', ')})`).join('; ')}` : 'No knowledge documents look affected.',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    },
  );

  server.registerTool(
    'get_project_graph',
    {
      title: 'Project graph',
      description: 'Structured nodes (packages, files, routes, entities, frameworks) and their relationships. Optionally filter by kind or a search term.',
      inputSchema: { kind: z.enum(['package', 'file', 'route', 'entity', 'framework', 'command', 'infra']).optional(), search: z.string().optional(), limit: z.number().int().min(1).max(200).optional() },
    },
    async ({ kind, search, limit }) => {
      const graph = await getGraph(root, { build: true });
      if (!graph) return textResult('The project graph is not available. Run `athena analyze` first.');
      const q = search?.toLowerCase();
      const nodes = graph.nodes
        .filter((n) => (!kind || n.kind === kind) && (!q || `${n.name} ${n.path ?? ''}`.toLowerCase().includes(q)))
        .slice(0, limit ?? 60);
      const summary = Object.entries(graph.stats.byKind).map(([k, n]) => `${n} ${k}`).join(', ');
      return textResult([`Graph built ${graph.builtAt} — ${summary}; ${graph.stats.edges} relationships.`, '', ...nodes.map((n) => `- ${n.kind}: ${n.name}${n.path ? ` (${n.path})` : ''}`)].join('\n'));
    },
  );

  server.registerTool(
    'update_knowledge',
    {
      title: 'Update Athena knowledge',
      description: opts.allowWrite
        ? 'Re-analyze the project and update knowledge documents whose content changed.'
        : 'Check what a knowledge update would change. This server is read-only, so nothing is written — report the proposal to the developer, who can apply it with `athena sync`.',
      inputSchema: { apply: z.boolean().optional().describe('Apply the update (only permitted when the server runs with --allow-write)') },
    },
    async ({ apply }) => {
      const plan = await planSync(root);
      if (plan.upToDate) return textResult('Knowledge is already up to date; nothing to change.');
      const summary = [`${plan.documents.length} document(s) would change:`, ...plan.documents.map((d) => `- ${d.file}: ${d.reasons[0] ?? 'content differs'}`)].join('\n');
      if (!apply) return textResult(`${summary}\n\nNothing was written. Run \`athena sync\` to review and apply.`);
      if (!opts.allowWrite) {
        return { ...textResult(`${summary}\n\nRefused: this MCP server is read-only. Ask the developer to run \`athena sync\`.`), isError: true };
      }
      const result = await applySync(root, plan);
      return textResult(`Updated: ${result.applied.join(', ')}.${result.preserved.length ? ` Developer-edited sections preserved in ${result.preserved.map((p) => p.file).join(', ')}.` : ''}`);
    },
  );

  server.registerTool(
    'get_athena_status',
    { title: 'Athena status', description: 'Whether Athena knowledge exists, when it was last analyzed, and what it covers.', inputSchema: {} },
    async () => {
      const st = await readState(athenaDir(root));
      if (st.kind !== 'ok') return textResult(`Athena state is ${st.kind}. Run \`athena init\` (or \`athena analyze\`) in ${root}.`);
      const graph = await graphSummary(root);
      const plan = await planSync(root).catch(() => null);
      return textResult(
        [
          `Project: ${st.state.projectName} (${root})`,
          `Last analyzed: ${st.state.analyzedAt}`,
          `Documents: ${Object.keys(st.state.documents).length}`,
          graph.built ? `Graph: ${graph.stats!.nodes} nodes, ${graph.stats!.edges} edges (built ${graph.builtAt})` : 'Graph: not built yet',
          plan ? (plan.upToDate ? 'Knowledge is in sync with the code.' : `Knowledge is out of date: ${plan.documents.map((d) => d.file).join(', ')} would change.`) : '',
          `Relevance map: ${RELEVANCE_MAP.length} task types.`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    },
  );

  return server;
}

/** Connect over stdio and resolve when the client disconnects (or `signal` aborts). */
export async function runMcpServer(opts: McpOptions & { signal?: AbortSignal }): Promise<void> {
  const server = createMcpServer(opts);
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    opts.signal?.addEventListener('abort', () => resolve(), { once: true });
  });
  await server.connect(transport);
  await closed;
  await server.close().catch(() => {});
}

export { summarizePlan };
