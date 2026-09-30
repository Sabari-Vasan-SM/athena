import { describe, expect, it } from 'vitest';
import { API_ROUTE_PATH, API_SURFACE_PATH, AUTH_PATH, SCHEMA_PATH, SCHEMA_RELATED_PATH, SOURCE_FILE, TEST_FILE, TEST_RUNNER_CONFIG } from '../../src/core/patterns.js';
import { impactOf } from '../../src/core/impact/impact.js';

const all = (re: RegExp, xs: string[]) => xs.filter((x) => !re.test(x));

describe('shared path patterns', () => {
  it('TEST_FILE recognizes tests across ecosystems', () => {
    const tests = [
      'src/__tests__/a.ts', 'tests/unit/a.ts', 'test/a.js', 'spec/models/user_spec.rb', 'specs/a.ts', 'e2e/login.ts',
      'src/a.test.ts', 'src/a.spec.jsx', 'src/a.e2e.mts', 'web/a.test.cjs',
      'pkg/test_models.py', 'pkg/models_test.py', 'cmd/main_test.go', 'lib/app_test.exs', 'app/user_spec.rb',
      'src/main/java/FooTest.java', 'app/src/FooTests.kt', 'Foo.Tests/BarTests.cs',
      'integration_tests/app_test.dart', 'app/src/androidTest/java/Foo.java', 'test_driver/app.dart', 'lib/widget_test.dart',
    ];
    expect(all(TEST_FILE, tests)).toEqual([]);
    const notTests = ['src/app.ts', 'src/testing.ts', 'src/contest/a.ts', 'lib/attest.py', 'src/latest.go', 'README.md', 'src/Test.ts'];
    expect(notTests.filter((x) => TEST_FILE.test(x))).toEqual([]);
  });

  it('TEST_RUNNER_CONFIG matches runner configs only', () => {
    expect(all(TEST_RUNNER_CONFIG, ['vitest.config.ts', 'web/jest.config.js', 'playwright.config.ts', 'cypress.config.mjs'])).toEqual([]);
    expect(TEST_RUNNER_CONFIG.test('vite.config.ts')).toBe(false);
  });

  it('SOURCE_FILE matches code by extension', () => {
    expect(all(SOURCE_FILE, ['a.ts', 'a.tsx', 'a.mjs', 'a.cjs', 'a.py', 'a.go', 'a.rs', 'A.java', 'a.kt', 'a.cs', 'a.php', 'a.rb', 'a.dart', 'a.ex', 'a.swift', 'a.vue', 'a.svelte'])).toEqual([]);
    expect(['a.md', 'a.json', 'a.yml', 'a.css', 'Dockerfile'].filter((x) => SOURCE_FILE.test(x))).toEqual([]);
  });

  it('AUTH_PATH flags auth-related paths', () => {
    expect(all(AUTH_PATH, ['src/auth/login.ts', 'src/middleware.ts', 'app/policies/post.rb', 'src/jwt.ts', 'src/Session.ts', 'rbac.go'])).toEqual([]);
    expect(AUTH_PATH.test('src/orders/list.ts')).toBe(false);
  });

  it('API_SURFACE_PATH is a superset of API_ROUTE_PATH', () => {
    const routes = ['src/routes/a.ts', 'src/controllers/a.ts', 'api/x.py', 'app/api/orders/route.ts', 'app/route.js', 'shop/urls.py', 'config/routes.rb', 'src/resolvers/a.ts'];
    expect(all(API_ROUTE_PATH, routes)).toEqual([]);
    expect(all(API_SURFACE_PATH, routes)).toEqual([]);
    const surfaceOnly = ['app/views/home.py', 'schema.graphql', 'proto/a.proto', 'openapi.yaml', 'docs/swagger-v2.json'];
    expect(all(API_SURFACE_PATH, surfaceOnly)).toEqual([]);
    expect(surfaceOnly.filter((x) => API_ROUTE_PATH.test(x))).toEqual([]);
    expect(API_SURFACE_PATH.test('src/utils/format.ts')).toBe(false);
  });

  it('SCHEMA_RELATED_PATH is a superset of SCHEMA_PATH', () => {
    const schema = ['prisma/schema.prisma', 'db/migrations/0001.sql', 'alembic/versions/a.py', 'app/models.py', 'app/models/user.rb', 'migrate/001.go'];
    expect(all(SCHEMA_PATH, schema)).toEqual([]);
    expect(all(SCHEMA_RELATED_PATH, schema)).toEqual([]);
    const relatedOnly = ['db/changelog/001.xml', 'src/entities/user.ts', 'src/schema.ts'];
    expect(all(SCHEMA_RELATED_PATH, relatedOnly)).toEqual([]);
    expect(relatedOnly.filter((x) => SCHEMA_PATH.test(x))).toEqual([]);
  });

  it('impact analysis uses the shared test pattern', () => {
    expect(impactOf(['integration_tests/app_test.dart']).docs).toContain('testing');
    expect(impactOf(['vitest.config.ts']).docs).toContain('testing');
  });
});
