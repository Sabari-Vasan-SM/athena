import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers.js';

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await sourceFiles(p)));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

async function imports(file: string): Promise<string[]> {
  const text = await fs.readFile(file, 'utf8');
  return [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!).filter((s) => s.startsWith('.'));
}

describe('module boundaries', () => {
  it('core does not depend on agents or cli, and has no agent-specific logic', async () => {
    const core = path.join(REPO_ROOT, 'src/core');
    for (const file of await sourceFiles(core)) {
      for (const spec of await imports(file)) {
        const target = path.resolve(path.dirname(file), spec);
        expect(target.startsWith(core), `${path.relative(REPO_ROOT, file)} imports ${spec}`).toBe(true);
      }
      const text = await fs.readFile(file, 'utf8');
      expect(/CLAUDE\.md|\.cursor\/|\.agents\/rules/.test(text), `${path.relative(REPO_ROOT, file)} contains agent-specific paths`).toBe(false);
    }
  });

  it('agents do not depend on cli', async () => {
    const agents = path.join(REPO_ROOT, 'src/agents');
    for (const file of await sourceFiles(agents)) {
      for (const spec of await imports(file)) {
        expect(path.resolve(path.dirname(file), spec).startsWith(path.join(REPO_ROOT, 'src/cli')), `${file} imports ${spec}`).toBe(false);
      }
    }
  });
});
