import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { runPipeline } from '../../src/services/pipeline.js';
import { getRelevantContext, refreshGraph } from '../../src/services/context.js';
import { buildGraph, expandFromFiles, loadGraph, neighbors, nodeId } from '../../src/core/graph/graph.js';
import { documentSections, selectContext, tokenize, mentionedFiles } from '../../src/core/context/context-engine.js';
import { analyzeProject } from '../../src/core/analyzer/analyze.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { aiStatus, buildEnrichPayload, enrich } from '../../src/services/ai.js';
import { claudeCodeAdapter } from '../../src/agents/claude-code/adapter.js';
import { applyChanges } from '../../src/agents/registry.js';
import { cleanupProjects, FAKE, makeProject, runCli } from '../helpers.js';

afterAll(cleanupProjects);
afterEach(() => vi.unstubAllGlobals());

async function project(extra: Record<string, string> = {}): Promise<string> {
  const dir = await makeProject({
    'package.json': JSON.stringify({ name: 'shop', workspaces: ['packages/*'], dependencies: { express: '5', '@prisma/client': '6' } }),
    'packages/api/package.json': JSON.stringify({ name: '@shop/api', dependencies: { express: '5', '@shop/core': '*' } }),
    'packages/core/package.json': JSON.stringify({ name: '@shop/core' }),
    'packages/api/src/server.ts': "import express from 'express';\nimport { charge } from './payments';\nconst app = express();\napp.post('/payments', charge);\n",
    'packages/api/src/payments.ts': "export const charge = () => {};\n",
    'prisma/schema.prisma': 'datasource db {\n  provider = "postgresql"\n}\nmodel Payment {\n  id String @id\n  orderId String\n  order Order @relation(fields: [orderId], references: [id])\n}\nmodel Order {\n  id String @id\n  payments Payment[]\n}\n',
    ...extra,
  });
  await runPipeline({ root: dir, mode: 'init', agents: [] });
  return dir;
}

describe('project graph', () => {
  it('links packages, routes, entities and imports', async () => {
    const dir = await project();
    const graph = await refreshGraph(dir);
    const kinds = graph.stats.byKind;
    expect(kinds.package).toBeGreaterThanOrEqual(3);
    expect(kinds.route).toBeGreaterThanOrEqual(1);
    expect(kinds.entity).toBe(2);

    // Route → handler file
    const route = graph.nodes.find((n) => n.kind === 'route' && n.name.includes('/payments'))!;
    expect(route.path).toBe('packages/api/src/server.ts');
    expect(graph.edges).toContainEqual({ from: route.id, to: nodeId('file', 'packages/api/src/server.ts'), kind: 'handles' });

    // Import edge between project files
    expect(graph.edges).toContainEqual({ from: nodeId('file', 'packages/api/src/server.ts'), to: nodeId('file', 'packages/api/src/payments.ts'), kind: 'imports' });

    // Entity relation and workspace dependency
    expect(graph.edges.some((e) => e.kind === 'depends_on' && e.from.startsWith('entity:Payment'))).toBe(true);
    expect(graph.edges).toContainEqual({ from: nodeId('package', '@shop/api'), to: nodeId('package', '@shop/core'), kind: 'depends_on' });

    expect(await loadGraph(dir)).toMatchObject({ schemaVersion: 1 });
  }, 60_000);

  it('answers neighborhood and expansion queries', async () => {
    const dir = await project();
    const graph = await refreshGraph(dir);
    const hood = neighbors(graph, nodeId('file', 'packages/api/src/server.ts'))!;
    expect(hood.edges.some((e) => e.other.kind === 'route')).toBe(true);
    const expanded = expandFromFiles(graph, ['packages/api/src/server.ts'], 1);
    expect(expanded.some((n) => n.kind === 'route')).toBe(true);
    expect(expandFromFiles(graph, ['does/not/exist.ts'], 1)).toEqual([]);
  }, 60_000);

  it('builds an empty-but-valid graph for a bare project', async () => {
    const dir = await makeProject({ 'README.md': '# hi' });
    const { model } = await analyzeProject(dir);
    const graph = await buildGraph(model, { files: ['README.md'], read: async () => null });
    expect(graph.nodes.length).toBeGreaterThanOrEqual(0);
    expect(graph.stats.edges).toBe(0);
  });
});

describe('context engine', () => {
  it('selects areas from task wording and explains why', async () => {
    const dir = await project();
    const ctx = await getRelevantContext(dir, 'add refunds to the payments API and store them in the database', { buildGraph: true });
    const areas = ctx.areas.map((a) => a.id);
    expect(areas).toEqual(expect.arrayContaining(['api', 'database', 'security', 'testing']));
    expect(ctx.areas.find((a) => a.id === 'api')!.why.join()).toMatch(/task mentions/i);
    expect(ctx.sections.some((s) => s.doc === 'api')).toBe(true);
    expect(ctx.rules.length).toBeGreaterThan(0);
    expect(areas).not.toContain('deployment');
  }, 60_000);

  it('keeps small tasks small and picks up named files', async () => {
    const dir = await project();
    const typo = await getRelevantContext(dir, 'fix a typo in the footer copy');
    expect(typo.areas.length).toBe(0);
    expect(typo.rules.length).toBeGreaterThan(0);

    const named = await getRelevantContext(dir, 'refactor packages/api/src/payments.ts', { buildGraph: true });
    expect(named.mentionedFiles).toContain('packages/api/src/payments.ts');
    expect(named.graphNodes.length).toBeGreaterThan(0);
  }, 60_000);

  it('respects the character budget', async () => {
    const dir = await project();
    const ctx = await getRelevantContext(dir, 'change the database schema for payments', { maxChars: 1500 });
    expect(ctx.approxChars).toBeLessThanOrEqual(1500);
    expect(ctx.truncated).toBe(true);
  }, 60_000);

  it('is deterministic', async () => {
    const dir = await project();
    const a = await getRelevantContext(dir, 'add an auth guard to the payments endpoint');
    const b = await getRelevantContext(dir, 'add an auth guard to the payments endpoint');
    expect(a.sections.map((s) => s.section)).toEqual(b.sections.map((s) => s.section));
  }, 60_000);

  it('parses documents into sections including developer notes', () => {
    const md = '# Doc\n\n<!-- athena:generated:start id=a hash=abc123def456 -->\n## A\n\nbody\n<!-- athena:generated:end id=a -->\n\n## Developer Notes\n\nOur own note.\n';
    const sections = documentSections(md);
    expect(sections.map((s) => s.id)).toEqual(['a', 'developer-notes']);
    expect(sections[1]!.content).toContain('Our own note.');
  });

  it('tokenizes and matches file mentions', () => {
    expect(tokenize('Add the Refunds API')).toEqual(['refunds', 'api']);
    expect(mentionedFiles('touch src/a.ts please', ['src/a.ts', 'other.ts'])).toEqual(['src/a.ts']);
    expect(mentionedFiles('nothing here', ['src/a.ts'])).toEqual([]);
  });

  it('falls back to the broad document set when no area matches', () => {
    const ctx = selectContext({ task: 'do the thing nobody described', documents: [], rulesMarkdown: null });
    expect(ctx.areas.length).toBeGreaterThan(3);
    expect(ctx.areas[0]!.why[0]).toMatch(/no specific area/);
  });
});

describe('MCP server', () => {
  async function connect(root: string, allowWrite = false) {
    const server = createMcpServer({ root, allowWrite });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { client, close: async () => { await client.close(); await server.close(); } };
  }
  const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? '');

  it('exposes the documented tool set', async () => {
    const dir = await project();
    const { client, close } = await connect(dir);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(['get_project_context', 'get_architecture', 'get_database_schema', 'get_api_context', 'get_security_context', 'get_project_rules', 'get_relevant_context', 'get_project_changes', 'update_knowledge']),
      );
      expect(tools.every((t) => t.description && t.description.length > 10)).toBe(true);
    } finally {
      await close();
    }
  }, 60_000);

  it('returns task-relevant context and rules', async () => {
    const dir = await project();
    const { client, close } = await connect(dir);
    try {
      const ctx = text(await client.callTool({ name: 'get_relevant_context', arguments: { task: 'add refunds to the payments API' } }));
      expect(ctx).toContain('Athena context for: add refunds to the payments API');
      expect(ctx).toContain('Project rules (always apply)');
      expect(ctx).toContain('api.md');

      const rules = text(await client.callTool({ name: 'get_project_rules', arguments: {} }));
      expect(rules).toContain('Never add secrets');
      expect(rules).not.toContain('[disabled]');

      const graph = text(await client.callTool({ name: 'get_project_graph', arguments: { kind: 'entity' } }));
      expect(graph).toContain('entity: Payment');
    } finally {
      await close();
    }
  }, 60_000);

  it('is read-only by default and writes only with --allow-write', async () => {
    const dir = await project();
    await fs.appendFile(path.join(dir, 'packages/api/src/server.ts'), "app.get('/health', h);\n");
    const readOnly = await connect(dir);
    try {
      const res = await readOnly.client.callTool({ name: 'update_knowledge', arguments: { apply: true } });
      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(text(res)).toContain('read-only');
      expect(await fs.readFile(path.join(dir, '.athena/api.md'), 'utf8')).not.toContain('/health');
    } finally {
      await readOnly.close();
    }

    const writable = await connect(dir, true);
    try {
      expect(text(await writable.client.callTool({ name: 'update_knowledge', arguments: { apply: true } }))).toMatch(/Updated:/);
      expect(await fs.readFile(path.join(dir, '.athena/api.md'), 'utf8')).toContain('/health');
    } finally {
      await writable.close();
    }
  }, 60_000);

  it('registers itself with agents that support MCP', async () => {
    const dir = await project();
    await applyChanges(dir, await claudeCodeAdapter.plan({ root: dir, projectName: 'shop' }));
    const mcp = JSON.parse(await fs.readFile(path.join(dir, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.athena).toMatchObject({ command: 'athena', args: ['mcp'] });
    await claudeCodeAdapter.remove(dir);
    await expect(fs.access(path.join(dir, '.mcp.json'))).rejects.toThrow();
  }, 60_000);
});

describe('AI providers', () => {
  it('reports availability per provider without needing keys', async () => {
    const dir = await project();
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const status = await aiStatus(dir);
    expect(status.providers.map((p) => p.id)).toEqual(['anthropic', 'openai', 'google', 'ollama']);
    expect(status.providers.find((p) => p.id === 'anthropic')!.availability.ok).toBe(false);
    expect(status.providers.find((p) => p.id === 'anthropic')!.availability.reason).toContain('ANTHROPIC_API_KEY');
    expect(status.providers.find((p) => p.id === 'ollama')!.remote).toBe(false);
    expect(status.consent).toBe(false);
  }, 60_000);

  it('sends only redacted knowledge, never source code', async () => {
    const dir = await project({ 'src/keys.ts': `export const k = "${FAKE.stripe}";\n` });
    await runPipeline({ root: dir, mode: 'analyze', agents: [] });
    const payload = await buildEnrichPayload(dir);
    expect(payload.documents).toContain('project.md');
    expect(payload.content).not.toContain(FAKE.stripe);
    expect(payload.content).not.toContain('export const k');
    expect(payload.remote).toBe(true);
  }, 60_000);

  it('refuses to send to a remote provider without consent', async () => {
    const dir = await project();
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    await expect(enrich(dir)).rejects.toThrow(/requires consent/);
  }, 60_000);

  it('writes labelled INFERRED suggestions and never touches knowledge documents', async () => {
    const dir = await project();
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    const before = await fs.readFile(path.join(dir, '.athena/project.md'), 'utf8');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ model: 'claude-sonnet-5', content: [{ type: 'text', text: '## Suggested project summary\n\nA shop API.' }], usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await enrich(dir, { consent: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('api.anthropic.com');
    expect(String(init.body)).not.toContain('export const');

    const written = await fs.readFile(path.join(dir, '.athena', result.file), 'utf8');
    expect(written).toContain('INFERRED');
    expect(written).toContain('A shop API.');
    expect(written).toContain('claude-sonnet-5');
    expect(await fs.readFile(path.join(dir, '.athena/project.md'), 'utf8')).toBe(before);
  }, 60_000);

  it('surfaces provider errors as actionable messages', async () => {
    const dir = await project();
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })));
    await expect(enrich(dir, { consent: true })).rejects.toThrow(/429/);
  }, 60_000);
});

describe('CLI', () => {
  it('context, graph and ai status work end to end', async () => {
    const dir = await project();
    const graph = await runCli(['graph', '--build'], dir);
    expect(graph.code, graph.stderr).toBe(0);
    expect(graph.stdout).toMatch(/Graph built/);

    const ctx = await runCli(['context', 'add refunds to the payments API', '--json'], dir);
    expect(ctx.code).toBe(0);
    expect(JSON.parse(ctx.stdout).areas.map((a: { id: string }) => a.id)).toContain('api');

    const full = await runCli(['context', 'change the payment schema', '--full'], dir);
    expect(full.stdout).toContain('Athena context for:');

    const ai = await runCli(['ai', 'status'], dir);
    expect(ai.code).toBe(0);
    expect(ai.stdout).toContain('Ollama (local)');

    const dry = await runCli(['ai', 'enrich', '--dry-run'], dir);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toMatch(/no source code/);
  }, 120_000);
});

describe('local-only files', () => {
  it('gitignores every machine-specific file Athena writes', async () => {
    const dir = await project();
    const ignore = await fs.readFile(path.join(dir, '.athena/.gitignore'), 'utf8');
    for (const entry of ['state.json', 'model.json', 'graph.json', 'security-scan.json', 'ai-suggestions.md', '.server.json', '.sync-ignore.json', '.agent-events.jsonl']) {
      expect(ignore.split('\n'), entry).toContain(entry);
    }
    // Existing projects get missing entries appended rather than overwritten.
    await fs.writeFile(path.join(dir, '.athena/.gitignore'), '# mine\nstate.json\n');
    await runPipeline({ root: dir, mode: 'analyze', agents: [] });
    const updated = await fs.readFile(path.join(dir, '.athena/.gitignore'), 'utf8');
    expect(updated).toContain('# mine');
    expect(updated.split('\n')).toContain('graph.json');
  }, 60_000);
});
