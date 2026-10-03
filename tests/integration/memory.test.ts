import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  addMemory,
  confirmMemory,
  forgetMemory,
  getMemory,
  listMemory,
  recallMemory,
  supersedeMemory,
  updateMemory,
} from '../../src/services/memory.js';
import { AthenaError } from '../../src/services/errors.js';
import { cleanupProjects, FAKE, makeProject } from '../helpers.js';

afterAll(cleanupProjects);

const project = () => makeProject({ 'src/jobs/queue.ts': 'export const q = 1;\n', 'src/api/refunds.ts': 'export {}\n', '.athena/.gitignore': 'cache/\n' });

describe('project memory', () => {
  it('records agent memories as unreviewed (INFERRED) and developer ones as confirmed (FACT)', async () => {
    const dir = await project();
    const a = await addMemory(dir, { kind: 'decision', title: 'Queue uses advisory locks', files: ['src/jobs/queue.ts'], tags: ['jobs'] }, 'agent:claude-code');
    expect(a).toMatchObject({ status: 'unreviewed', label: 'INFERRED', source: 'agent:claude-code', stale: false });
    expect(a.anchors['src/jobs/queue.ts']).toMatch(/^[a-f0-9]{16}$/);
    const d = await addMemory(dir, { kind: 'convention', title: 'Money is stored in cents' }, 'developer');
    expect(d).toMatchObject({ status: 'confirmed', label: 'FACT' });

    const text = await fs.readFile(path.join(dir, '.athena/memory/decisions.md'), 'utf8');
    expect(text).toContain('### Queue uses advisory locks');
    expect(text).toContain('<!-- athena:memory id=');
    expect((await listMemory(dir)).map((m) => m.id).sort()).toEqual([a.id, d.id].sort());
  });

  it('refuses secrets without writing anything', async () => {
    const dir = await project();
    await expect(addMemory(dir, { kind: 'fact', title: 'Test key', details: FAKE.stripe }, 'agent:cursor')).rejects.toThrow(AthenaError);
    await expect(fs.access(path.join(dir, '.athena/memory'))).rejects.toThrow();
  });

  it('confirming re-anchors; editing a linked file makes the memory stale', async () => {
    const dir = await project();
    const m = await addMemory(dir, { kind: 'gotcha', title: 'Queue batch size is 50', files: ['src/jobs/queue.ts'] }, 'agent:codex');
    await fs.appendFile(path.join(dir, 'src/jobs/queue.ts'), 'export const batch = 50;\n');
    expect((await getMemory(dir, m.id)).stale).toBe(true);
    const confirmed = await confirmMemory(dir, m.id);
    expect(confirmed).toMatchObject({ status: 'confirmed', label: 'FACT', stale: false });
    await fs.rm(path.join(dir, 'src/jobs/queue.ts'));
    expect((await getMemory(dir, m.id)).changedFiles).toEqual(['src/jobs/queue.ts']);
  });

  it('supersedes and forgets; recall skips superseded entries', async () => {
    const dir = await project();
    const old = await addMemory(dir, { kind: 'decision', title: 'Queue uses Redis', files: ['src/jobs/queue.ts'] }, 'developer');
    const neu = await addMemory(dir, { kind: 'decision', title: 'Queue uses advisory locks', files: ['src/jobs/queue.ts'], supersedes: old.id }, 'developer');
    expect((await getMemory(dir, old.id)).status).toBe('superseded');
    expect((await recallMemory(dir, { files: ['src/jobs/queue.ts'] })).map((h) => h.entry.id)).toEqual([neu.id]);

    // An agent proposing a replacement doesn't retire the old entry until confirmed.
    const proposal = await addMemory(dir, { kind: 'decision', title: 'Queue uses a job table', supersedes: neu.id }, 'agent:claude-code');
    expect((await getMemory(dir, neu.id)).status).toBe('confirmed');
    await confirmMemory(dir, proposal.id);
    expect((await getMemory(dir, neu.id)).status).toBe('superseded');

    await supersedeMemory(dir, neu.id, proposal.id);
    await forgetMemory(dir, old.id);
    await expect(getMemory(dir, old.id)).rejects.toThrow(/No memory/);
  });

  it('preserves developer text in memory files across writes', async () => {
    const dir = await project();
    const m = await addMemory(dir, { kind: 'bug', title: 'Refund double-charge', files: ['src/api/refunds.ts'] }, 'developer');
    const file = path.join(dir, '.athena/memory/bugs.md');
    await fs.appendFile(file, '\nHand-written note at the end.\n');
    await updateMemory(dir, m.id, { details: 'Caused by retrying without an idempotency key.' });
    await addMemory(dir, { kind: 'bug', title: 'Another one' }, 'agent:cursor');
    const text = await fs.readFile(file, 'utf8');
    expect(text).toContain('Hand-written note at the end.');
    expect(text).toContain('idempotency key');
  });

  it('does not lose entries when several writers record at once', async () => {
    const dir = await project();
    await Promise.all(Array.from({ length: 12 }, (_, i) => addMemory(dir, { kind: 'fact', title: `Fact number ${i}` }, `agent:a${i}`)));
    expect(await listMemory(dir)).toHaveLength(12);
  });
});
