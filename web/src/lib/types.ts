// Mirrors of server response shapes (kept deliberately small).

export type DocId = 'project' | 'architecture' | 'database' | 'api' | 'auth' | 'security' | 'testing' | 'debugging' | 'performance' | 'code-review' | 'deployment' | 'rules';
export type SyncState = 'missing' | 'developer-owned' | 'synchronized' | 'may-be-outdated';

export interface DocMeta {
  id: DocId;
  file: string;
  title: string;
  purpose: string;
  present: boolean;
  bytes: number;
  hash: string | null;
  lastGeneratedAt: string | null;
  lastChangedAt: string | null;
  generatedSections: number;
  editedSections: string[];
  sync: SyncState;
  affectedBy: string[];
}

export type Segment = { kind: 'generated'; id: string; modified: boolean; content: string } | { kind: 'developer'; content: string };

export interface DocContent extends DocMeta {
  content: string;
  segments: Segment[];
}

export interface Rule {
  index: number;
  section: string;
  text: string;
  enabled: boolean;
}

export interface RulesView {
  hash: string;
  rules: Rule[];
  sections: string[];
}

export interface Overview {
  athenaVersion: string;
  project: { name: string; description: string | null; root: string };
  analyzedAt: string;
  analysisDurationMs: number;
  git: { isRepo: boolean; branch: string | null; head: string | null };
  summary: null | {
    filesAnalyzed: number;
    languages: Array<{ name: string; files: number }>;
    frameworks: Array<{ name: string; category: string; root: string; status: string; confidence: string }>;
    monorepo: { isMonorepo: boolean; tool: string | null; packages: number };
    databases: string[];
    entities: number;
    migrations: number;
    routes: number;
    apiSpecs: number;
    auth: string[];
    testFrameworks: string[];
    testFiles: number;
    ci: string[];
    containers: number;
    hosting: string[];
    envVars: number;
    potentialSecrets: number;
    securityControls: number;
    warnings: string[];
  };
}

export interface StatusReport {
  project: string;
  health: 'healthy' | 'needs-update' | 'degraded';
  analyzedAt: string;
  changes: { added: string[]; modified: string[]; deleted: string[] };
  git: { isRepo: boolean; branch?: string; uncommitted: number | null };
  affectedDocuments: Array<{ file: string; reasons: string[] }>;
  sync: 'up-to-date' | 'needs-update';
}

export interface AgentView {
  id: string;
  name: string;
  configured: boolean;
  configuredAt: string | null;
  files: string[];
  detectedInProject: boolean;
  evidence: string[];
  note: string;
  capabilities: { instructionsFile: boolean; scopedRules: boolean; hooks: boolean; mcp: boolean };
  checks: Array<{ ok: boolean; level: 'ok' | 'warn' | 'error'; message: string }>;
  activityObservation: 'hooks' | 'not-configured' | 'unsupported';
  lastActivityAt: string | null;
  observedEvents: number;
}

export interface AgentSession {
  agent: string;
  session: string | null;
  lastEventAt: string;
  lastMessage: string;
  events: number;
}

export interface ActivityResponse {
  activity: Activity;
  events: AthenaEvent[];
  sessions: AgentSession[];
  agentObservation: { available: boolean; agents: string[]; reason: string };
}

export type ActivityState = 'IDLE' | 'ANALYZING' | 'PLANNING' | 'CODING' | 'TESTING' | 'REVIEWING' | 'SUCCESS' | 'ERROR';

export interface Activity {
  state: ActivityState;
  actor: 'athena' | 'agent' | 'none';
  task: string | null;
  reading: string[];
  since: string;
}

export interface AthenaEvent {
  id: string;
  ts: string;
  source: 'athena' | 'web-ui' | 'filesystem' | 'agent';
  type: string;
  message: string;
  level: 'info' | 'success' | 'warn' | 'error';
  data?: Record<string, unknown>;
}

export interface HistoryResponse {
  available: boolean;
  reason?: string;
  entries: Array<{ sha: string; date: string; subject: string }>;
}

export interface SearchHit {
  id: DocId;
  file: string;
  title: string;
  line: number;
  text: string;
}

export interface ProposedDocument {
  id: DocId;
  file: string;
  title: string;
  status: 'created' | 'updated';
  reasons: string[];
  changedSections: string[];
  preservedSections: string[];
  /** The diff itself is fetched on demand from GET /api/sync/:id (see SyncDocDiff). */
  diffTruncated: boolean;
  additions: number;
  deletions: number;
  baseHash: string | null;
}

/** GET /api/sync/:id — one proposed document's unified diff. */
export interface SyncDocDiff {
  planId: string;
  id: DocId;
  file: string;
  diff: string;
  diffTruncated: boolean;
  additions: number;
  deletions: number;
}

export interface SyncPlan {
  id: string;
  createdAt: string;
  previousAnalysisAt: string | null;
  upToDate: boolean;
  fileChanges: { added: string[]; modified: string[]; deleted: string[]; renamed: Array<{ from: string; to: string }> };
  git: { isRepo: boolean; previousHead: string | null; head: string | null; previousBranch: string | null; branch: string | null; branchChanged: boolean; commits: Array<{ sha: string; subject: string }>; diverged: boolean; truncated: boolean };
  modelChanges: Array<{ label: string; summary: string; docs: DocId[] }>;
  documents: ProposedDocument[];
  checkedUnchanged: string[];
  ignored: boolean;
  durationMs: number;
  warnings: string[];
}

export interface SyncStatus {
  watching: boolean;
  lastCheckedAt: string | null;
  plan: SyncPlan | null;
}

export type Severity = 'critical' | 'high' | 'moderate' | 'low' | 'unrated';

export interface Vulnerability {
  package: string;
  severity: Severity;
  title: string;
  id?: string;
  url?: string;
  vulnerableRange?: string;
  fixAvailable?: boolean;
}

export interface SecurityScan {
  scannedAt: string;
  durationMs: number;
  tools: Array<{ tool: string; ecosystem: string; status: 'ok' | 'unavailable' | 'failed' | 'timeout'; message?: string; durationMs: number; findings: Vulnerability[] }>;
  counts: Record<Severity, number>;
  secrets: { count: number; files: string[] };
}

export interface SecurityState {
  scan: SecurityScan | null;
  running: boolean;
}

export interface GraphSummary {
  built: boolean;
  builtAt: string | null;
  stats: { nodes: number; edges: number; byKind: Record<string, number> } | null;
  building?: boolean;
}

export interface RelevantContext {
  task: string;
  areas: Array<{ id: DocId; score: number; why: string[] }>;
  sections: Array<{ doc: DocId; file: string; section: string; content: string; score: number }>;
  rules: Rule[];
  graphNodes: Array<{ id: string; kind: string; name: string; path?: string }>;
  mentionedFiles: string[];
  truncated: boolean;
  approxChars: number;
}

export interface AiProviderStatus {
  id: string;
  name: string;
  remote: boolean;
  defaultModel: string;
  keyEnvVar?: string;
  availability: { ok: boolean; reason?: string; endpoint: string };
  selected: boolean;
}

export interface AiStatus {
  configured: { provider: string; model?: string; mode: string; consent: boolean };
  providers: AiProviderStatus[];
  consent: boolean;
}

export type MemoryKind = 'decision' | 'gotcha' | 'bug' | 'convention' | 'todo' | 'fact';
export type MemoryStatus = 'unreviewed' | 'confirmed' | 'superseded';

/** One project-memory entry as GET /api/memory returns it. */
export interface MemoryView {
  id: string;
  kind: MemoryKind;
  status: MemoryStatus;
  /** `developer` or `agent:<id>`. */
  source: string;
  title: string;
  details: string;
  files: string[];
  tags: string[];
  evidence?: string;
  createdAt: string;
  confirmedAt?: string;
  supersedes?: string;
  supersededBy?: string;
  anchors: Record<string, string>;
  /** FACT once a developer confirmed it; INFERRED otherwise. */
  label: 'FACT' | 'INFERRED';
  stale: boolean;
  changedFiles: string[];
  /** Possible prompt-injection warnings. */
  flags: string[];
}

export interface MemoryCounts {
  total: number;
  unreviewed: number;
  confirmed: number;
  superseded: number;
  stale: number;
  flagged: number;
}

export interface MemoryList {
  entries: MemoryView[];
  counts: MemoryCounts;
}
