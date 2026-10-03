import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MEMORY_FILES, MEMORY_KINDS, MEMORY_STATUSES } from '../../core/memory/memory.js';
import { AthenaError } from '../../services/errors.js';
import { contentHash } from '../../services/knowledge.js';
import {
  addMemory,
  confirmMemory,
  forgetMemory,
  getMemory,
  listMemory,
  memoryDir,
  supersedeMemory,
  updateMemory,
  type MemoryInput,
  type MemoryKind,
  type MemoryStatus,
  type MemoryView,
} from '../../services/memory.js';
import type { ServerContext } from '../context.js';

/** Key under which memory files are recorded in `ctx.recentWrites` (to tell our writes from external ones). */
export const memoryWriteKey = (file: string) => `memory/${file}`;

const ID = '^m-[a-z0-9]{4,16}$';
const idParams = { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', pattern: ID } } } as const;

// Generous bounds: the memory core enforces the real limits with friendly messages.
const fields = {
  title: { type: 'string', maxLength: 1000 },
  details: { type: 'string', maxLength: 10_000 },
  files: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 500 } },
  tags: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 100 } },
  evidence: { type: 'string', maxLength: 2000 },
} as const;

export interface MemoryCounts {
  total: number;
  unreviewed: number;
  confirmed: number;
  superseded: number;
  stale: number;
  flagged: number;
}

export function memoryCounts(entries: MemoryView[]): MemoryCounts {
  return {
    total: entries.length,
    unreviewed: entries.filter((e) => e.status === 'unreviewed').length,
    confirmed: entries.filter((e) => e.status === 'confirmed').length,
    superseded: entries.filter((e) => e.status === 'superseded').length,
    stale: entries.filter((e) => e.stale).length,
    flagged: entries.filter((e) => e.flags.length > 0).length,
  };
}

/** Project memory (`.athena/memory/*.md`): list, review (confirm/supersede/edit/forget) and developer add. */
export function registerMemoryRoutes({ app, root, events, recentWrites }: ServerContext): void {
  /** Remember what we wrote so the watcher doesn't report our own writes as external. */
  const recordWrites = async () => {
    for (const file of Object.values(MEMORY_FILES)) {
      const text = await fs.readFile(path.join(memoryDir(root), file), 'utf8').catch(() => null);
      if (text !== null) recentWrites.set(memoryWriteKey(file), contentHash(text));
    }
  };
  const changed = async (action: string, id: string, message: string) => {
    await recordWrites();
    events.emit({ source: 'web-ui', type: 'memory.changed', level: 'success', message, data: { action, id } });
  };

  app.get<{ Querystring: { kind?: MemoryKind; status?: MemoryStatus; stale?: 'true' | 'false' } }>(
    '/api/memory',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { kind: { type: 'string', enum: [...MEMORY_KINDS] }, status: { type: 'string', enum: [...MEMORY_STATUSES] }, stale: { type: 'string', enum: ['true', 'false'] } },
        },
      },
    },
    async (req) => {
      const all = await listMemory(root);
      const { kind, status, stale } = req.query;
      const entries = all.filter((e) => (!kind || e.kind === kind) && (!status || e.status === status) && (stale === undefined || e.stale === (stale === 'true')));
      return { entries, counts: memoryCounts(all) };
    },
  );

  app.get<{ Params: { id: string } }>('/api/memory/:id', { schema: { params: idParams } }, async (req) => getMemory(root, req.params.id));

  app.post<{ Body: MemoryInput }>(
    '/api/memory',
    {
      schema: {
        body: {
          type: 'object',
          required: ['kind', 'title'],
          additionalProperties: false,
          properties: { kind: { type: 'string', enum: [...MEMORY_KINDS] }, ...fields, supersedes: { type: 'string', pattern: ID } },
        },
      },
    },
    async (req, reply) => {
      const entry = await addMemory(root, req.body, 'developer');
      await changed('add', entry.id, `Added memory: ${entry.title}`);
      return reply.code(201).send(entry);
    },
  );

  app.post<{ Params: { id: string } }>('/api/memory/:id/confirm', { schema: { params: idParams } }, async (req) => {
    const entry = await confirmMemory(root, req.params.id);
    await changed('confirm', entry.id, `Confirmed memory: ${entry.title}`);
    return entry;
  });

  app.post<{ Params: { id: string }; Body: { by: string } }>(
    '/api/memory/:id/supersede',
    { schema: { params: idParams, body: { type: 'object', required: ['by'], additionalProperties: false, properties: { by: { type: 'string', pattern: ID } } } } },
    async (req) => {
      const { id } = req.params;
      const { by } = req.body;
      await getMemory(root, id);
      // An unknown replacement is a bad request, not a missing resource.
      if (id !== by && !(await listMemory(root)).some((e) => e.id === by)) throw new AthenaError(`Cannot supersede ${id}: no memory with id ${by}.`);
      const entry = await supersedeMemory(root, id, by);
      await changed('supersede', entry.id, `Memory ${id} superseded by ${by}`);
      return entry;
    },
  );

  app.patch<{ Params: { id: string }; Body: Partial<Omit<MemoryInput, 'kind' | 'supersedes'>> }>(
    '/api/memory/:id',
    { schema: { params: idParams, body: { type: 'object', minProperties: 1, additionalProperties: false, properties: fields } } },
    async (req) => {
      const entry = await updateMemory(root, req.params.id, req.body);
      await changed('edit', entry.id, `Edited memory: ${entry.title}`);
      return entry;
    },
  );

  app.delete<{ Params: { id: string } }>('/api/memory/:id', { schema: { params: idParams } }, async (req) => {
    await forgetMemory(root, req.params.id);
    await changed('forget', req.params.id, `Forgot memory ${req.params.id}`);
    return { ok: true };
  });
}
