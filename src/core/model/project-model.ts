import { z } from 'zod';
import { Provenance } from './fact.js';

const Named = z.object({ name: z.string(), provenance: Provenance });

export const Language = z.object({
  name: z.string(),
  files: z.number().int(),
  bytes: z.number().int(),
});

export const Framework = Named.extend({
  category: z.enum(['frontend', 'backend', 'fullstack', 'mobile', 'desktop', 'orm', 'testing', 'other']),
  version: z.string().optional(),
  /** Workspace package root (repo-relative) this belongs to; "." for root. */
  root: z.string(),
});

export const Manifest = z.object({
  path: z.string(),
  ecosystem: z.string(),
  name: z.string().optional(),
  version: z.string().optional(),
  dependencies: z.array(z.string()),
  devDependencies: z.array(z.string()),
});

export const WorkspacePackage = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(['app', 'package', 'root', 'unknown']),
  ecosystem: z.string(),
  /** Names of other workspace packages this one depends on. */
  internalDependencies: z.array(z.string()),
});

export const Command = z.object({
  name: z.string(),
  command: z.string(),
  source: z.string(),
  purpose: z.enum(['dev', 'build', 'test', 'lint', 'format', 'start', 'migrate', 'deploy', 'other']),
});

export const Route = z.object({
  method: z.string(),
  path: z.string(),
  framework: z.string(),
  file: z.string(),
  line: z.number().int().optional(),
  provenance: Provenance,
});

export const DbEntity = z.object({
  name: z.string(),
  kind: z.enum(['table', 'model', 'collection']),
  fields: z.array(z.object({ name: z.string(), type: z.string().optional(), attributes: z.array(z.string()) })),
  indexes: z.array(z.string()),
  relations: z.array(z.string()),
  file: z.string(),
  provenance: Provenance,
});

export const Database = Named.extend({ kind: z.enum(['engine', 'orm', 'driver', 'service']) });

export const EnvVar = z.object({
  name: z.string(),
  /** Where the name was seen. Values are NEVER recorded. */
  references: z.array(z.string()),
  secretLike: z.boolean(),
});

export const SecretFinding = z.object({
  type: z.string(),
  file: z.string(),
  line: z.number().int(),
  /** Short sha256 prefix of the matched value — allows dedup without storing the secret. */
  fingerprint: z.string(),
});

export const CiJob = z.object({ system: z.string(), file: z.string(), name: z.string(), commands: z.array(z.string()) });

export const ContainerService = z.object({
  name: z.string(),
  image: z.string().optional(),
  ports: z.array(z.string()),
  dependsOn: z.array(z.string()),
  file: z.string(),
});

export const TestInfo = z.object({
  frameworks: z.array(Named),
  testFileCount: z.number().int(),
  testDirs: z.array(z.string()),
  coverageConfigs: z.array(z.string()),
  /** Workspace packages that contain source files but zero detected test files (structural, not coverage). */
  packagesWithoutTests: z.array(z.string()),
});

export const GitInfo = z.object({
  available: z.boolean(),
  isRepo: z.boolean(),
  branch: z.string().optional(),
  head: z.string().optional(),
  lastCommitDate: z.string().optional(),
  contributorCount: z.number().int().optional(),
  hotspots: z.array(z.object({ path: z.string(), commits: z.number().int() })),
});

export const ProjectModel = z.object({
  schemaVersion: z.literal(1),
  name: z.string(),
  description: z.string().optional(),
  root: z.string(),
  stats: z.object({
    filesScanned: z.number().int(),
    skippedBinary: z.number().int(),
    skippedLarge: z.number().int(),
    skippedUnreadable: z.number().int(),
  }),
  topLevelDirs: z.array(z.string()),
  languages: z.array(Language),
  manifests: z.array(Manifest),
  packageManagers: z.array(Named),
  buildSystems: z.array(Named),
  workspace: z.object({
    isMonorepo: z.boolean(),
    tool: z.string().optional(),
    packages: z.array(WorkspacePackage),
  }),
  frameworks: z.array(Framework),
  entryPoints: z.array(z.object({ path: z.string(), provenance: Provenance })),
  commands: z.array(Command),
  databases: z.array(Database),
  dbEntities: z.array(DbEntity),
  migrations: z.array(z.object({ path: z.string(), tool: z.string(), count: z.number().int() })),
  routes: z.array(Route),
  apiSpecs: z.array(z.object({ path: z.string(), kind: z.enum(['openapi', 'graphql', 'grpc']) })),
  auth: z.array(Named.extend({ kind: z.enum(['library', 'provider', 'hashing', 'middleware', 'token']) })),
  containers: z.object({ dockerfiles: z.array(z.object({ path: z.string(), baseImages: z.array(z.string()), exposedPorts: z.array(z.string()) })), services: z.array(ContainerService) }),
  infrastructure: z.array(Named.extend({ kind: z.string(), file: z.string() })),
  ci: z.array(CiJob),
  tests: TestInfo,
  env: z.object({ vars: z.array(EnvVar), envFilesPresent: z.array(z.string()) }),
  security: z.object({
    secrets: z.array(SecretFinding),
    tooling: z.array(Named),
    /** Libraries/middleware relevant to web security controls (helmet, cors, csrf...). */
    controls: z.array(Named),
  }),
  caching: z.array(Named),
  queues: z.array(Named),
  observability: z.array(Named),
  git: GitInfo,
  warnings: z.array(z.string()),
});

export type ProjectModel = z.infer<typeof ProjectModel>;
export type Framework = z.infer<typeof Framework>;
export type Manifest = z.infer<typeof Manifest>;
export type WorkspacePackage = z.infer<typeof WorkspacePackage>;
export type Command = z.infer<typeof Command>;
export type Route = z.infer<typeof Route>;
export type DbEntity = z.infer<typeof DbEntity>;
export type EnvVar = z.infer<typeof EnvVar>;
export type SecretFinding = z.infer<typeof SecretFinding>;
export type CiJob = z.infer<typeof CiJob>;
export type ContainerService = z.infer<typeof ContainerService>;
export type GitInfo = z.infer<typeof GitInfo>;
export type NamedFact = z.infer<typeof Named>;

export function emptyModel(name: string, root: string): ProjectModel {
  return {
    schemaVersion: 1,
    name,
    root,
    stats: { filesScanned: 0, skippedBinary: 0, skippedLarge: 0, skippedUnreadable: 0 },
    topLevelDirs: [],
    languages: [],
    manifests: [],
    packageManagers: [],
    buildSystems: [],
    workspace: { isMonorepo: false, packages: [] },
    frameworks: [],
    entryPoints: [],
    commands: [],
    databases: [],
    dbEntities: [],
    migrations: [],
    routes: [],
    apiSpecs: [],
    auth: [],
    containers: { dockerfiles: [], services: [] },
    infrastructure: [],
    ci: [],
    tests: { frameworks: [], testFileCount: 0, testDirs: [], coverageConfigs: [], packagesWithoutTests: [] },
    env: { vars: [], envFilesPresent: [] },
    security: { secrets: [], tooling: [], controls: [] },
    caching: [],
    queues: [],
    observability: [],
    git: { available: false, isRepo: false, hotspots: [] },
    warnings: [],
  };
}
