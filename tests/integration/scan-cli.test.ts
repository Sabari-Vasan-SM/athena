import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRequire } from 'node:module';
import { createMcpServer } from '../../src/mcp/server.js';
import { runPipeline } from '../../src/services/pipeline.js';
import { cleanupProjects, FAKE, gitInit, makeProject, REPO_ROOT, runCli } from '../helpers.js';

afterAll(cleanupProjects);

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const git = (cwd: string, args: string[]) => new Promise<string>((resolve, reject) => execFile('git', args, { cwd, env: ENV }, (err, out) => (err ? reject(err) : resolve(out))));
const commitAll = async (dir: string, msg: string) => {
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '--no-gpg-sign', '-m', msg]);
};

async function project(): Promise<string> {
  const dir = await makeProject({
    'package.json': JSON.stringify({ name: 'shop', version: '1.0.0' }),
    'src/config.ts': `export const token = "${FAKE.github}";\n`,
  });
  await runPipeline({ root: dir, mode: 'init', agents: [] });
  await gitInit(dir);
  return dir;
}

const noValues = (s: string) => {
  expect(s).not.toContain(FAKE.github);
  expect(s).not.toContain(FAKE.stripe);
  expect(s).not.toContain(FAKE.github.slice(4, 20));
};

describe('athena scan', () => {
  it('reports, fails the gate, baselines, and passes once the finding is baselined', async () => {
    const dir = await project();
    const first = await runCli(['scan', '--offline'], dir);
    expect(first.code, first.stderr).toBe(1);
    expect(first.stdout).toContain('secret/github-token');
    expect(first.stderr).toMatch(/quality gate failed/);
    noValues(first.stdout);

    const created = await runCli(['baseline', 'create', '--last', '--reason', 'legacy'], dir);
    expect(created.code, created.stderr).toBe(0);
    const baseline = JSON.parse(await fs.readFile(path.join(dir, '.athena/baseline.json'), 'utf8'));
    expect(baseline.entries).toHaveLength(1);
    noValues(JSON.stringify(baseline));

    const again = await runCli(['scan', '--offline'], dir);
    expect(again.code, again.stderr + again.stdout).toBe(0);
    expect((await runCli(['scan', '--offline', '--no-baseline'], dir)).code).toBe(1);
    expect((await runCli(['scan', '--offline', '--no-baseline', '--no-fail'], dir)).code).toBe(0);
  }, 120_000);

  it('writes schema-valid SARIF and JSON without secret values', async () => {
    const dir = await project();
    const sarif = await runCli(['scan', '--offline', '-f', 'sarif', '-o', 'out/athena.sarif', '--no-fail'], dir);
    expect(sarif.code, sarif.stderr).toBe(0);
    const doc = JSON.parse(await fs.readFile(path.join(dir, 'out/athena.sarif'), 'utf8'));
    const schema = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'tests/fixtures/sarif/sarif-2.1.0.schema.json'), 'utf8'));
    const require = createRequire(import.meta.url);
    const Ajv = require('ajv');
    const addFormats = require('ajv-formats');
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    expect(ajv.validate(schema, doc), JSON.stringify(ajv.errors)).toBe(true);
    expect(doc.runs[0].results[0].ruleId).toBe('secret/github-token');
    noValues(JSON.stringify(doc));

    const json = await runCli(['scan', '--offline', '--format', 'json', '--no-fail'], dir);
    const report = JSON.parse(json.stdout);
    expect(report.schemaVersion).toBe(1);
    expect(report.findings[0]).toMatchObject({ ruleId: 'secret/github-token', status: 'open' });
    expect(report.gate.passed).toBe(false);
    noValues(json.stdout);
  }, 120_000);

  it('scans only staged changes, and validates flags', async () => {
    const dir = await project();
    await fs.writeFile(path.join(dir, 'src/pay.ts'), `export const k = "${FAKE.stripe}";\n`);
    await git(dir, ['add', 'src/pay.ts']);
    const r = await runCli(['scan', '--staged', '--offline', '--only', 'secrets', '-f', 'json', '--no-fail'], dir);
    expect(r.code, r.stderr).toBe(0);
    const ids = JSON.parse(r.stdout).findings.map((f: { ruleId: string }) => f.ruleId);
    expect(ids).toEqual(['secret/stripe-key']); // the committed GitHub token is out of scope

    expect((await runCli(['scan', '--staged', '--changed'], dir)).code).toBe(1);
    expect((await runCli(['scan', '--only', 'nope'], dir)).stderr).toMatch(/Unknown scanner/);
    expect((await runCli(['scan', '--fail-on', 'severe'], dir)).stderr).toMatch(/Invalid --fail-on/);
    const bad = await runCli(['scan', '--base', 'no-such-ref', '--offline'], dir);
    expect(bad.code).toBe(2);
  }, 120_000);

  it('triages a finding by fingerprint prefix and flags policy changes against the base branch', async () => {
    const dir = await project();
    await git(dir, ['branch', '-M', 'main']);
    await runCli(['scan', '--offline', '--no-fail'], dir);
    const list = JSON.parse((await runCli(['findings', 'list', '--json'], dir)).stdout);
    const fp: string = list.findings[0].fingerprint;

    expect((await runCli(['findings', 'triage', fp.slice(0, 8), 'safe'], dir)).stderr).toMatch(/needs a reason/);
    const t = await runCli(['findings', 'triage', fp.slice(0, 8), 'false-positive', '--reason', 'test fixture token'], dir);
    expect(t.code, t.stderr).toBe(0);
    expect((await runCli(['scan', '--offline'], dir)).code).toBe(0);
    const shown = await runCli(['findings', 'show', fp.slice(0, 10)], dir);
    expect(shown.stdout).toMatch(/triaged:false-positive/);

    // On a branch, the triage decision is a policy change: with --policy-from the base
    // branch's (empty) triage applies and the change itself is reported.
    await git(dir, ['checkout', '-q', '-b', 'feature']);
    await commitAll(dir, 'triage');
    const ci = await runCli(['scan', '--offline', '--policy-from', 'main', '-f', 'json'], dir);
    expect(ci.code).toBe(1);
    const ids = JSON.parse(ci.stdout).findings.map((f: { ruleId: string }) => f.ruleId);
    expect(ids).toEqual(expect.arrayContaining(['secret/github-token', 'review/policy-weakened']));
  }, 120_000);

  it('lists and explains rules', async () => {
    const dir = await project();
    const rules = JSON.parse((await runCli(['scan', '--list-rules', '--json'], dir)).stdout);
    expect(rules.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining(['secret/github-token', 'dependency/vulnerable-package', 'review/policy-weakened']));
    const ex = await runCli(['explain', 'secret/github-token'], dir);
    expect(ex.code).toBe(0);
    expect(ex.stdout).toContain('CWE-798');
    expect((await runCli(['explain', 'nope/nothing'], dir)).code).toBe(1);
  }, 60_000);
});

describe('MCP findings tool', () => {
  it('summarizes the last scan without values, fenced as untrusted data', async () => {
    const dir = await project();
    const server = createMcpServer({ root: dir });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const call = async () => ((await client.callTool({ name: 'findings', arguments: {} })) as { content: Array<{ text: string }> }).content[0]!.text;
      expect(await call()).toMatch(/No scan results yet/);
      await runCli(['scan', '--offline', '--no-fail'], dir);
      const text = await call();
      expect(text).toContain('trust="untrusted-data"');
      expect(text).toContain('secret/github-token');
      expect(text).toMatch(/Gate: failed/);
      noValues(text);
    } finally {
      await client.close();
      await server.close();
    }
  }, 120_000);
});
