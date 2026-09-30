/**
 * Shared path classifiers. One source of truth for "is this a test / source /
 * auth / API / schema file?" so `review`, impact analysis and the analyzer
 * can't drift apart. All patterns take POSIX-style relative paths.
 */

/** Test files and test directories across ecosystems (JS/TS, Python, Go, Elixir, Ruby, JVM, .NET, Dart/Flutter, Android). */
export const TEST_FILE = /(^|\/)(__tests__|tests?|spec|specs|e2e|integration_tests|androidTest|test_driver)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go|exs)$|_spec\.rb$|Tests?\.(java|kt|cs)$|_test\.dart$/;

/** Test runner configuration files (a change affects how tests run, not what they test). */
export const TEST_RUNNER_CONFIG = /(^|\/)(jest|vitest|playwright|cypress)\.config\./;

/** Application source code (by extension). Combine with `!TEST_FILE` for non-test source. */
export const SOURCE_FILE = /\.(m|c)?(t|j)sx?$|\.(py|go|rs|java|kt|cs|php|rb|dart|ex|swift|vue|svelte)$/;

/** Paths that look authentication/authorization related. Deliberately broad; pair with SOURCE_FILE when only code matters. */
export const AUTH_PATH = /(auth|session|login|oauth|jwt|guard|permission|rbac|acl|polic(y|ies)|middleware)/i;

/** Code that defines HTTP routes/handlers. */
export const API_ROUTE_PATH = /(^|\/)(routes?|controllers?|handlers?|api|endpoints?|resolvers?)\/|(^|\/)(urls\.py|routes\.rb)$|(^|\/)app\/(.+\/)?route\.(t|j)sx?$/i;

/**
 * Anything that shapes the API surface: route code (a superset of API_ROUTE_PATH,
 * adding `views/`), GraphQL/protobuf schemas and OpenAPI/Swagger specs.
 */
export const API_SURFACE_PATH = /(^|\/)(routes?|controllers?|handlers?|api|endpoints?|views|resolvers?)\/|(^|\/)(urls\.py|routes\.rb)$|(^|\/)app\/(.+\/)?route\.(t|j)sx?$|\.(graphql|gql|proto)$|(openapi|swagger)[^/]*\.(json|ya?ml)$/i;

/** Database schema and migration files. */
export const SCHEMA_PATH = /\.prisma$|\.sql$|(^|\/)(migrations?|migrate|alembic)\/|(^|\/)models(\.py|\/)/i;

/**
 * Paths that may touch the data model: SCHEMA_PATH plus Liquibase-style `changelog/`
 * directories and schema/entity-named files. Broader, for impact heuristics.
 */
export const SCHEMA_RELATED_PATH = /\.prisma$|\.sql$|(^|\/)(migrations?|migrate|alembic|changelog)\/|(^|\/)models(\.py|\/)|(^|\/)(schema|entities|entity)\b/i;
