import { afterAll, describe, expect, it } from 'vitest';
import { analyzeProject } from '../../src/core/analyzer/analyze.js';
import { cleanupProjects, FAKE, makeProject } from '../helpers.js';

afterAll(cleanupProjects);

const json = (v: unknown) => JSON.stringify(v, null, 2);

describe('analyzer: Node/TypeScript monorepo', async () => {
  const dir = await makeProject({
    'package.json': json({ name: 'acme', private: true, workspaces: ['apps/*', 'packages/*'], scripts: { dev: 'turbo dev', test: 'turbo test', build: 'turbo build' }, devDependencies: { turbo: '2.0.0' } }),
    'package-lock.json': '{}',
    'turbo.json': '{}',
    'apps/web/package.json': json({ name: '@acme/web', dependencies: { next: '15.0.0', react: '19.0.0', '@acme/ui': '*', 'next-auth': '5.0.0' } }),
    'apps/web/next.config.mjs': 'export default {}',
    'apps/web/app/api/billing/route.ts': 'export async function GET() {}\nexport const POST = async () => {}\n',
    'apps/web/app/(marketing)/api/health/route.ts': 'export function GET() {}\n',
    'apps/api/package.json': json({ name: '@acme/api', dependencies: { express: '5.0.0', '@prisma/client': '6.0.0', helmet: '8', zod: '3', ioredis: '5', bullmq: '5' }, devDependencies: { vitest: '3', supertest: '7' } }),
    'apps/api/src/server.ts': [
      "import express from 'express';",
      'const app = express();',
      'const router = express.Router();',
      "app.get('/health', (req, res) => res.send('ok'));",
      "router.post('/payments/:id/refund', async (req, res) => {});",
      'const secret = process.env.STRIPE_SECRET_KEY;',
      'const port = process.env.PORT;',
      '@Decorated class X {}',
    ].join('\n'),
    'apps/api/src/server.test.ts': "import { it } from 'vitest';",
    'apps/api/prisma/schema.prisma': [
      'datasource db {',
      '  provider = "postgresql"',
      '  url      = env("DATABASE_URL")',
      '}',
      'model User {',
      '  id       String @id @default(cuid())',
      '  tenantId String',
      '  email    String @unique',
      '  orders   Order[]',
      '  @@index([tenantId])',
      '}',
      'model Order {',
      '  id     String @id',
      '  userId String',
      '  user   User   @relation(fields: [userId], references: [id])',
      '}',
      'enum Role {',
      '  ADMIN',
      '}',
    ].join('\n'),
    'apps/api/prisma/migrations/20240101_init/migration.sql': 'CREATE TABLE "User" (id text);',
    'packages/ui/package.json': json({ name: '@acme/ui', dependencies: { react: '19.0.0' } }),
    'packages/ui/src/button.tsx': 'export const Button = () => null;',
    '.env.example': 'DATABASE_URL=\nSTRIPE_SECRET_KEY=\nPORT=3000\n',
    '.env': `STRIPE_SECRET_KEY=${FAKE.stripe}\n`,
    'Dockerfile': 'FROM node:22-alpine AS build\nEXPOSE 3000\n',
    'docker-compose.yml': 'services:\n  api:\n    build: .\n    ports: ["3000:3000"]\n    depends_on: [db, cache]\n  db:\n    image: postgres:16\n  cache:\n    image: redis:7\n',
    '.github/workflows/ci.yml': 'name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n      - run: npm test\n',
    '.github/dependabot.yml': 'version: 2',
    'apps/api/src/config.ts': `export const stripe = "${FAKE.stripe}";\nexport const gh = "${FAKE.github}";\n`,
  });
  const { model } = await analyzeProject(dir);

  it('detects the workspace', () => {
    expect(model.name).toBe('acme');
    expect(model.workspace.isMonorepo).toBe(true);
    expect(model.workspace.tool).toMatch(/workspaces/);
    const web = model.workspace.packages.find((p) => p.name === '@acme/web')!;
    expect(web.kind).toBe('app');
    expect(web.internalDependencies).toEqual(['@acme/ui']);
    expect(model.workspace.packages.find((p) => p.name === '@acme/ui')!.kind).toBe('package');
  });

  it('detects frameworks with evidence and confidence', () => {
    const next = model.frameworks.find((f) => f.name === 'Next.js')!;
    expect(next.root).toBe('apps/web');
    expect(next.provenance.status).toBe('DETECTED');
    expect(next.provenance.evidence.map((e) => e.file)).toContain('apps/web/next.config.mjs');
    expect(model.frameworks.map((f) => f.name)).toContain('Express');
    expect(model.packageManagers.map((p) => p.name)).toContain('npm');
    expect(model.buildSystems.map((b) => b.name)).toContain('Turborepo');
  });

  it('extracts routes from Express (AST) and Next.js app router', () => {
    const routes = model.routes.map((r) => `${r.method} ${r.path}`);
    expect(routes).toContain('GET /health');
    expect(routes).toContain('POST /payments/:id/refund');
    expect(routes).toContain('GET /api/billing');
    expect(routes).toContain('POST /api/billing');
    expect(routes).toContain('GET /api/health');
    const health = model.routes.find((r) => r.path === '/health')!;
    expect(health.file).toBe('apps/api/src/server.ts');
    expect(health.line).toBe(4);
  });

  it('parses the Prisma schema and migrations', () => {
    const user = model.dbEntities.find((e) => e.name === 'User')!;
    expect(user.fields.map((f) => f.name)).toEqual(expect.arrayContaining(['id', 'tenantId', 'email']));
    expect(user.indexes).toContain('@@index([tenantId])');
    expect(model.dbEntities.find((e) => e.name === 'Order')!.relations).toEqual(['user → User']);
    expect(model.databases.map((d) => d.name)).toEqual(expect.arrayContaining(['Prisma', 'postgresql (Prisma datasource)', 'PostgreSQL']));
    expect(model.caching.map((c) => c.name)).toContain('Redis (container)');
    expect(model.migrations[0]).toMatchObject({ tool: 'Prisma Migrate', path: 'apps/api/prisma/migrations', count: 1 });
  });

  it('detects auth, caching, queues, controls, tests', () => {
    expect(model.auth.map((a) => a.name)).toContain('NextAuth.js / Auth.js');
    expect(model.auth.some((a) => a.name === 'Role/permission definitions')).toBe(true);
    expect(model.queues.map((q) => q.name)).toContain('BullMQ');
    expect(model.security.controls.map((c) => c.name)).toEqual(expect.arrayContaining(['helmet', 'zod (schema validation)']));
    expect(model.tests.frameworks.map((f) => f.name)).toEqual(expect.arrayContaining(['Vitest', 'Supertest']));
    expect(model.tests.testFileCount).toBe(1);
    expect(model.tests.packagesWithoutTests).toEqual(expect.arrayContaining(['apps/web', 'packages/ui']));
    expect(model.security.tooling.map((t) => t.name)).toContain('Dependabot');
  });

  it('records env var names but never values', () => {
    const names = model.env.vars.map((v) => v.name);
    expect(names).toEqual(expect.arrayContaining(['DATABASE_URL', 'STRIPE_SECRET_KEY', 'PORT']));
    expect(model.env.vars.find((v) => v.name === 'STRIPE_SECRET_KEY')!.secretLike).toBe(true);
    expect(model.env.envFilesPresent).toContain('.env');
  });

  it('detects infrastructure and CI', () => {
    expect(model.containers.dockerfiles[0]).toMatchObject({ path: 'Dockerfile', baseImages: ['node:22-alpine'], exposedPorts: ['3000'] });
    expect(model.containers.services.find((s) => s.name === 'api')!.dependsOn).toEqual(['db', 'cache']);
    expect(model.ci[0]).toMatchObject({ system: 'GitHub Actions', name: 'test' });
    expect(model.ci[0]!.commands).toContain('npm test');
  });

  it('reports secret locations without values, and the model contains no secret', () => {
    const inConfig = model.security.secrets.filter((s) => s.file === 'apps/api/src/config.ts');
    expect(inConfig.map((s) => s.type).sort()).toEqual(['github-token', 'stripe-key']);
    const serialized = JSON.stringify(model);
    expect(serialized).not.toContain(FAKE.stripe);
    expect(serialized).not.toContain(FAKE.github);
  });
});

describe('analyzer: other ecosystems', () => {
  it('Python FastAPI + SQLAlchemy', async () => {
    const dir = await makeProject({
      'pyproject.toml': '[project]\nname = "svc"\ndependencies = ["fastapi>=0.110", "SQLAlchemy[asyncio]", "pydantic", "PyJWT"]\n[dependency-groups]\ndev = ["pytest"]\n',
      'uv.lock': '',
      'app/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n@app.get("/items/{id}")\ndef read(id): ...\n@router.post("/orders")\ndef create(): ...\nimport os\nos.environ.get("DATABASE_URL")\n',
      'app/models.py': 'class Item(Base):\n    __tablename__ = "items"\n    id = Column(Integer)\n    name = mapped_column(String)\n',
      'tests/test_main.py': 'def test_x(): pass\n',
    });
    const { model } = await analyzeProject(dir);
    expect(model.frameworks.map((f) => f.name)).toContain('FastAPI');
    expect(model.packageManagers.map((p) => p.name)).toContain('uv');
    expect(model.routes.map((r) => `${r.method} ${r.path}`)).toEqual(expect.arrayContaining(['GET /items/{id}', 'POST /orders']));
    expect(model.dbEntities.find((e) => e.name === 'items')!.fields.map((f) => f.name)).toEqual(['id', 'name']);
    expect(model.tests.frameworks.map((f) => f.name)).toContain('pytest');
    expect(model.env.vars.map((v) => v.name)).toContain('DATABASE_URL');
  });

  it('Django', async () => {
    const dir = await makeProject({
      'requirements.txt': 'Django==5.0\ndjangorestframework\n',
      'manage.py': '',
      'shop/urls.py': 'urlpatterns = [\n    path("products/", views.list),\n]\n',
      'shop/models.py': 'from django.db import models\n\nclass Product(models.Model):\n    name = models.CharField(max_length=10)\n    owner = models.ForeignKey("auth.User", on_delete=models.CASCADE)\n',
      'shop/migrations/0001_initial.py': '',
    });
    const { model } = await analyzeProject(dir);
    const django = model.frameworks.find((f) => f.name === 'Django')!;
    expect(django.provenance.evidence.map((e) => e.file)).toContain('manage.py');
    expect(model.routes.map((r) => r.path)).toContain('/products/');
    expect(model.dbEntities.find((e) => e.name === 'Product')!.relations).toEqual(['owner → auth.User']);
    expect(model.migrations.map((m) => m.tool)).toContain('Django migrations');
  });

  it('Go + Rust + Java + SQL', async () => {
    const dir = await makeProject({
      'go.mod': 'module example.com/svc\n\ngo 1.23\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.10.0\n\tgorm.io/gorm v1.25.0\n)\n',
      'cmd/server/main.go': 'package main\nfunc main() {\n r.GET("/ping", h)\n mux.HandleFunc("POST /v1/users", h)\n}\n',
      'cmd/server/main_test.go': 'package main',
      'crates/core/Cargo.toml': '[package]\nname = "core"\n[dependencies]\naxum = "0.7"\nsqlx = "0.8"\n',
      'crates/core/src/main.rs': 'let app = Router::new().route("/users", get(list));\n#[test]\nfn t() {}\n',
      'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
      'svc/pom.xml': '<project><artifactId>billing</artifactId><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency><dependency><artifactId>junit-jupiter</artifactId><scope>test</scope></dependency></dependencies></project>',
      'svc/src/main/java/BillingController.java': '@RestController\n@RequestMapping("/api/billing")\npublic class BillingController {\n  @GetMapping("/invoices")\n  public List<Invoice> list() {}\n}\n',
      'db/migrations/001_init.sql': '-- comment\nCREATE TABLE IF NOT EXISTS invoices (\n  id BIGINT PRIMARY KEY,\n  customer_id BIGINT NOT NULL REFERENCES customers(id),\n  amount NUMERIC(10,2)\n);\nCREATE UNIQUE INDEX invoices_customer ON invoices (customer_id);\n',
    });
    const { model } = await analyzeProject(dir);
    const names = model.frameworks.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['Gin', 'Axum', 'Spring Boot (Web)']));
    const routes = model.routes.map((r) => `${r.method} ${r.path}`);
    expect(routes).toEqual(expect.arrayContaining(['GET /ping', 'POST /v1/users', 'GET /users', 'GET /api/billing/invoices']));
    const inv = model.dbEntities.find((e) => e.name === 'invoices')!;
    expect(inv.fields.map((f) => f.name)).toEqual(['id', 'customer_id', 'amount']);
    expect(inv.relations).toEqual(['customer_id → customers']);
    expect(inv.indexes).toEqual(['UNIQUE invoices_customer (customer_id)']);
    expect(model.tests.frameworks.map((f) => f.name)).toEqual(expect.arrayContaining(['go test', 'cargo test', 'JUnit 5']));
    expect(model.workspace.isMonorepo).toBe(true);
  });

  it('survives malformed manifests and reports warnings', async () => {
    const dir = await makeProject({
      'package.json': '{ not json',
      'pyproject.toml': '[project\nname=',
      'docker-compose.yml': 'services: [unclosed',
      'src/index.ts': 'export {}',
      'src/broken.ts': 'app.get("/x", (req, res) => { ',
    });
    const { model } = await analyzeProject(dir);
    expect(model.warnings.join('\n')).toMatch(/package\.json/);
    expect(model.warnings.join('\n')).toMatch(/pyproject\.toml/);
    expect(model.languages[0]!.name).toBe('TypeScript');
  });

  it('handles an empty project honestly', async () => {
    const dir = await makeProject({});
    const { model } = await analyzeProject(dir);
    expect(model.stats.filesScanned).toBe(0);
    expect(model.frameworks).toEqual([]);
    expect(model.routes).toEqual([]);
  });
});
