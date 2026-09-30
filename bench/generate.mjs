#!/usr/bin/env node
// Generate a deterministic synthetic repository for benchmarks.
//   node bench/generate.mjs <dir> [fileCount=20000]
// Mix: TS/JS with Express routes and imports, Python, Go, SQL, config/infra files,
// a few large files and minified single-line bundles (the cases that hurt scanners).
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const [dirArg, countArg] = process.argv.slice(2);
if (!dirArg) {
  console.error('usage: node bench/generate.mjs <dir> [fileCount]');
  process.exit(2);
}
const dir = path.resolve(dirArg);
const total = Number(countArg ?? 20000);

// Small deterministic PRNG so every run produces the same repository.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

async function write(rel, content) {
  const file = path.join(dir, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

function tsFile(i, dirs) {
  const lines = [`import express from 'express';`];
  if (i > 0) lines.push(`import { v${i - 1} } from '../m${(i - 1) % dirs}/f${i - 1}';`);
  lines.push(`export const v${i} = ${i};`);
  if (i % 20 === 0) lines.push(`const router = express.Router();`, `router.get('/items/${i}', (req, res) => res.json({ id: ${i} }));`, `export default router;`);
  if (i % 50 === 0) lines.push(`const url = process.env.SERVICE_${i % 7}_URL;`);
  for (let k = 0; k < 20 + Math.floor(rand() * 40); k++) lines.push(`export function fn${i}_${k}(a: number): number { return a * ${k} + v${i}; }`);
  return `${lines.join('\n')}\n`;
}

function pyFile(i) {
  const lines = ['from fastapi import APIRouter', 'router = APIRouter()'];
  if (i % 10 === 0) lines.push(`@router.get("/py/${i}")`, `def handler_${i}():`, `    return {"id": ${i}}`);
  for (let k = 0; k < 20; k++) lines.push(`def f${i}_${k}(x):`, `    return x * ${k}`);
  return `${lines.join('\n')}\n`;
}

function goFile(i) {
  const lines = ['package svc', ''];
  for (let k = 0; k < 20; k++) lines.push(`func F${i}_${k}(x int) int { return x * ${k} }`);
  return `${lines.join('\n')}\n`;
}

async function main() {
  await fs.mkdir(dir, { recursive: true });
  const fixed = 12;
  const n = Math.max(0, total - fixed);
  const dirs = Math.max(1, Math.round(n / 200));

  await write('package.json', JSON.stringify({ name: 'bench-repo', private: true, scripts: { test: 'vitest run', build: 'tsc' }, dependencies: { express: '5.0.0', '@prisma/client': '6.0.0', helmet: '8.0.0' }, devDependencies: { vitest: '3.0.0', typescript: '5.6.0' } }, null, 2));
  await write('requirements.txt', 'fastapi==0.110.0\nuvicorn==0.29.0\n');
  await write('go.mod', 'module example.com/svc\n\ngo 1.22\n');
  await write('prisma/schema.prisma', 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\nmodel User {\n  id String @id\n  email String @unique\n  orders Order[]\n}\nmodel Order {\n  id String @id\n  userId String\n  user User @relation(fields: [userId], references: [id])\n}\n');
  await write('Dockerfile', 'FROM node:22-slim\nWORKDIR /app\nCOPY . .\nRUN npm ci\nEXPOSE 3000\nCMD ["node", "dist/server.js"]\n');
  await write('.github/workflows/ci.yml', 'name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n      - run: npm test\n');
  await write('.env.example', 'DATABASE_URL=\nSERVICE_0_URL=\n');
  await write('README.md', '# bench repo\n');
  // Large and minified files: the cases that make naive scanners slow.
  await write('assets/large-a.txt', 'lorem ipsum dolor sit amet '.repeat(30000));
  await write('assets/large-b.txt', 'x'.repeat(900_000));
  await write('public/bundle.js', `(function(){${'var a=b.c.d.e.f-g-h;'.repeat(15000)}})();`);
  await write('public/vendor.js', `!function(){${'a.b.c.d.e.f.g.h.i.j.k-'.repeat(20000)}}();`);

  for (let i = 0; i < n; i++) {
    const r = rand();
    if (r < 0.75) await write(`src/m${i % dirs}/f${i}.ts`, tsFile(i, dirs));
    else if (r < 0.88) await write(`py/pkg${i % dirs}/mod_${i}.py`, pyFile(i));
    else if (r < 0.96) await write(`go/svc${i % dirs}/f${i}.go`, goFile(i));
    else await write(`db/migrations/${String(i).padStart(6, '0')}_create.sql`, `CREATE TABLE t${i} (id serial primary key, name text);\nCREATE INDEX idx_t${i} ON t${i}(name);\n`);
  }

  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'bench', GIT_AUTHOR_EMAIL: 'bench@example.com', GIT_COMMITTER_NAME: 'bench', GIT_COMMITTER_EMAIL: 'bench@example.com' } });
  git(['init', '-q', '-b', 'main']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'initial']);
  console.log(`generated ${total} files in ${dir}`);
}

await main();
