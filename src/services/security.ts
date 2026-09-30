import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ProjectModel } from '../core/model/project-model.js';
import { type SecurityScan, type Severity, type ToolResult, type Vulnerability } from '../core/model/security-scan.js';
import { loadConfig } from '../core/config.js';
import { walkProject, type FileEntry } from '../core/fs/walker.js';
import { scanFilesForSecrets, secretFingerprinter } from '../core/analyzer/detectors/secrets.js';
import { whichExecutable } from './which.js';

export { loadScan, saveScan, totalFindings, meetsThreshold, unratedFindings, SCAN_FILE, SEVERITY_ORDER, RATED_SEVERITIES } from '../core/model/security-scan.js';
export type { SecurityScan, Severity, ToolResult, Vulnerability, ThresholdOptions } from '../core/model/security-scan.js';

/** A tool ran but its output says it did not complete the audit (e.g. npm offline). */
export class AuditToolError extends Error {}

export interface Invocation {
  args: string[];
  /** What this invocation audits, when a tool runs once per input file. */
  target?: string;
}

export interface PlanContext {
  root: string;
  /** Repo-relative POSIX paths of the project's (non-ignored) files. */
  files: string[];
}

interface Runner {
  tool: string;
  ecosystem: string;
  command: string;
  /** Run only when this returns true for the project. */
  applies(model: ProjectModel, has: (file: string) => boolean, ctx: PlanContext): boolean;
  /** Invocations to run, or a reason there is nothing to audit (reported as `unavailable`). */
  plan(ctx: PlanContext): Promise<Invocation[] | string>;
  parse(stdout: string, stderr: string): Vulnerability[];
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const sev = (s: unknown): Severity => {
  const v = String(s ?? '').toLowerCase();
  if (v === 'critical') return 'critical';
  if (v === 'high') return 'high';
  if (v === 'moderate' || v === 'medium') return 'moderate';
  if (v === 'low' || v === 'info') return 'low';
  return 'unrated';
};

function parseJsonObject(stdout: string, tool: string): Record<string, unknown> {
  const text = stdout.trim();
  if (!text) throw new AuditToolError(`${tool} produced no output`);
  const json = JSON.parse(text) as unknown;
  if (!isObject(json)) throw new AuditToolError(`${tool} produced unexpected output`);
  return json;
}

/** npm and pnpm report failures (offline, registry errors) as `{ "error": { code, summary, detail } }`. */
function throwIfToolError(json: Record<string, unknown>, tool: string): void {
  if (json.error === undefined) return;
  const e = asRecord(json.error);
  const parts = [e.code, e.summary ?? e.message].filter((x) => typeof x === 'string' && x.trim()) as string[];
  const text = parts.length ? parts.join(': ') : typeof json.error === 'string' ? json.error : 'unknown error';
  throw new AuditToolError(`${tool} reported an error: ${text.split('\n')[0]!.slice(0, 200)}`);
}

/** Legacy advisory shape: `pnpm audit --json` and npm ≤6. */
function parseAdvisories(advisories: Record<string, unknown>): Vulnerability[] {
  const out: Vulnerability[] = [];
  for (const [key, raw] of Object.entries(advisories)) {
    const a = asRecord(raw);
    const versions = [...new Set((Array.isArray(a.findings) ? a.findings : []).map((f) => asRecord(f).version).filter((v): v is string => typeof v === 'string'))];
    const patched = typeof a.patched_versions === 'string' ? a.patched_versions.trim() : '';
    out.push({
      package: String(a.module_name ?? 'unknown'),
      severity: sev(a.severity),
      title: String(a.title ?? `Vulnerable dependency: ${String(a.module_name ?? key)}`),
      id: typeof a.github_advisory_id === 'string' ? a.github_advisory_id : Array.isArray(a.cves) && typeof a.cves[0] === 'string' ? a.cves[0] : String(a.id ?? key),
      url: typeof a.url === 'string' ? a.url : undefined,
      vulnerableRange: typeof a.vulnerable_versions === 'string' ? a.vulnerable_versions + (versions.length ? ` (installed ${versions.join(', ')})` : '') : undefined,
      fixAvailable: Boolean(patched) && patched !== '<0.0.0',
    });
  }
  return out;
}

/** `npm audit --json` (npm ≥7: `vulnerabilities`; npm ≤6: `advisories`). Exit code 1 with vulnerabilities is success. */
export function parseNpmAudit(stdout: string): Vulnerability[] {
  const json = parseJsonObject(stdout, 'npm audit');
  throwIfToolError(json, 'npm audit');
  if (!isObject(json.vulnerabilities)) {
    if (isObject(json.advisories)) return parseAdvisories(json.advisories);
    throw new AuditToolError('npm audit output has no "vulnerabilities" report');
  }
  const out: Vulnerability[] = [];
  for (const [name, raw] of Object.entries(json.vulnerabilities)) {
    const v = asRecord(raw);
    const via = Array.isArray(v.via) ? v.via : [];
    const advisory = via.find((x) => x && typeof x === 'object') as Record<string, unknown> | undefined;
    const viaNames = via.filter((x): x is string => typeof x === 'string');
    out.push({
      package: name,
      severity: sev(v.severity),
      title: String(advisory?.title ?? (viaNames.length ? `Depends on vulnerable ${viaNames.join(', ')}` : `Vulnerable dependency: ${name}`)),
      id: advisory?.source !== undefined ? String(advisory.source) : undefined,
      url: typeof advisory?.url === 'string' ? advisory.url : undefined,
      vulnerableRange: typeof v.range === 'string' ? v.range : undefined,
      fixAvailable: Boolean(v.fixAvailable),
    });
  }
  return out;
}

/** `pnpm audit --json`: the legacy `{ advisories: { <id>: {...} }, metadata }` shape. */
export function parsePnpmAudit(stdout: string): Vulnerability[] {
  const json = parseJsonObject(stdout, 'pnpm audit');
  throwIfToolError(json, 'pnpm audit');
  if (!isObject(json.advisories)) throw new AuditToolError('pnpm audit output has no "advisories" report');
  return parseAdvisories(json.advisories);
}

/** `pip-audit --format json`: `{ dependencies: [{ name, version, vulns: [...] } | { name, skip_reason }], fixes }`. */
export function parsePipAudit(stdout: string): Vulnerability[] {
  const text = stdout.trim();
  if (!text) throw new AuditToolError('pip-audit produced no output');
  const json = JSON.parse(text) as unknown;
  const deps = isObject(json) && Array.isArray(json.dependencies) ? json.dependencies : Array.isArray(json) ? json : null;
  if (!deps) throw new AuditToolError('pip-audit output has no "dependencies" list');
  const out: Vulnerability[] = [];
  for (const raw of deps) {
    const d = asRecord(raw);
    for (const vRaw of Array.isArray(d.vulns) ? d.vulns : []) {
      const v = asRecord(vRaw);
      const aliases = Array.isArray(v.aliases) ? v.aliases.filter((a): a is string => typeof a === 'string') : [];
      const id = typeof v.id === 'string' ? v.id : undefined;
      out.push({
        package: String(d.name ?? 'unknown'),
        severity: 'unrated', // pip-audit does not report severity
        title: String(v.description ?? id ?? 'Known vulnerability').split('\n')[0]!.slice(0, 300),
        id: id ?? aliases[0],
        url: id ? `https://osv.dev/vulnerability/${id}` : undefined,
        vulnerableRange: typeof d.version === 'string' ? `installed ${d.version}` : undefined,
        fixAvailable: Array.isArray(v.fix_versions) && v.fix_versions.length > 0,
      });
    }
  }
  return out;
}

/** Split a stream of concatenated (possibly pretty-printed) JSON objects. */
export function splitJsonStream(text: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      if (depth > 0) inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0) {
        out.push(JSON.parse(text.slice(start, i + 1)));
        start = -1;
      }
    }
  }
  if (depth !== 0) throw new AuditToolError('truncated JSON output');
  return out;
}

const REACH_RANK = { required: 0, imported: 1, called: 2 } as const;
type Reach = keyof typeof REACH_RANK;

/**
 * `govulncheck -format=json`: a stream of JSON objects (pretty-printed in current
 * versions): `{config}`, `{progress}`, `{osv}`, `{finding}`. A vulnerability is
 * reported when at least one finding references it; the reachability (called /
 * imported / required only) is noted in the title.
 */
export function parseGovulncheck(stdout: string): Vulnerability[] {
  const messages = splitJsonStream(stdout).map(asRecord);
  if (!messages.some((m) => isObject(m.config))) throw new AuditToolError('govulncheck produced no JSON report');
  const osvs = new Map<string, Record<string, unknown>>();
  for (const m of messages) {
    const osv = asRecord(m.osv);
    if (typeof osv.id === 'string') osvs.set(osv.id, osv);
  }
  const found = new Map<string, { module?: string; version?: string; fixed?: string; reach: Reach }>();
  for (const m of messages) {
    const f = asRecord(m.finding);
    if (typeof f.osv !== 'string') continue;
    const trace = (Array.isArray(f.trace) ? f.trace : []).map(asRecord);
    const reach: Reach = trace.some((t) => typeof t.function === 'string') ? 'called' : trace.some((t) => typeof t.package === 'string') ? 'imported' : 'required';
    const first = trace[0] ?? {};
    const prev = found.get(f.osv);
    if (prev && REACH_RANK[prev.reach] >= REACH_RANK[reach]) continue;
    found.set(f.osv, {
      module: typeof first.module === 'string' ? first.module : prev?.module,
      version: typeof first.version === 'string' ? first.version : prev?.version,
      fixed: typeof f.fixed_version === 'string' ? f.fixed_version : prev?.fixed,
      reach,
    });
  }
  const label: Record<Reach, string> = { called: 'called by your code', imported: 'package imported, vulnerable symbol not called', required: 'module required, package not imported' };
  return [...found].map(([id, f]) => {
    const osv = osvs.get(id) ?? {};
    const affected = Array.isArray(osv.affected) ? asRecord(osv.affected[0]) : {};
    return {
      package: f.module ?? String(asRecord(affected.package).name ?? 'unknown'),
      severity: 'unrated' as const, // the Go vulnerability database does not assign severities
      title: `${String(osv.summary ?? id)} (${label[f.reach]})`,
      id,
      url: `https://pkg.go.dev/vuln/${id}`,
      vulnerableRange: f.version ? `installed ${f.version}` : undefined,
      fixAvailable: Boolean(f.fixed),
    };
  });
}

export function parseCargoAudit(stdout: string): Vulnerability[] {
  const json = parseJsonObject(stdout, 'cargo audit');
  if (!isObject(json.vulnerabilities)) throw new AuditToolError('cargo audit output has no "vulnerabilities" report');
  const list = Array.isArray(json.vulnerabilities.list) ? json.vulnerabilities.list : [];
  return list.map((raw) => {
    const v = asRecord(raw);
    const advisory = asRecord(v.advisory);
    const pkg = asRecord(v.package);
    return {
      package: String(pkg.name ?? 'unknown'),
      severity: sev(asRecord(advisory.cvss).severity ?? advisory.severity),
      title: String(advisory.title ?? 'Known vulnerability'),
      id: typeof advisory.id === 'string' ? advisory.id : undefined,
      url: typeof advisory.url === 'string' ? advisory.url : undefined,
    };
  });
}

export function parseComposerAudit(stdout: string): Vulnerability[] {
  const json = parseJsonObject(stdout, 'composer audit');
  if (json.advisories === undefined) throw new AuditToolError('composer audit output has no "advisories" report');
  const advisories = asRecord(json.advisories); // `[]` when there are none
  const out: Vulnerability[] = [];
  for (const [pkg, raw] of Object.entries(advisories)) {
    for (const aRaw of Array.isArray(raw) ? raw : Object.values(asRecord(raw))) {
      const a = asRecord(aRaw);
      out.push({
        package: pkg,
        severity: sev(a.severity),
        title: String(a.title ?? 'Known vulnerability'),
        id: typeof a.cve === 'string' ? a.cve : typeof a.advisoryId === 'string' ? a.advisoryId : undefined,
        url: typeof a.link === 'string' ? a.link : undefined,
        vulnerableRange: typeof a.affectedVersions === 'string' ? a.affectedVersions : undefined,
      });
    }
  }
  return out;
}

/** Max number of Python inputs audited in one scan. */
export const MAX_PIP_TARGETS = 10;
const REQUIREMENTS_FILE = /(^|\/)requirements[\w.-]*\.txt$/i;

/**
 * pip-audit must audit the project's declared dependencies — never whatever Python
 * environment happens to be active. Each `requirements*.txt` is audited with `-r`;
 * a PEP 621 `pyproject.toml` (with a `[project]` table) in a directory without
 * requirements files is audited as a project path (`pip-audit <dir>`).
 */
export async function planPipAudit(ctx: PlanContext): Promise<Invocation[] | string> {
  const common = ['--format', 'json', '--progress-spinner', 'off'];
  const reqs = ctx.files.filter((f) => REQUIREMENTS_FILE.test(f)).sort();
  const reqDirs = new Set(reqs.map((f) => path.posix.dirname(f)));
  const out: Invocation[] = reqs.map((f) => ({ target: f, args: ['-r', f, ...common] }));
  for (const f of ctx.files.filter((x) => x === 'pyproject.toml' || x.endsWith('/pyproject.toml')).sort()) {
    const dir = path.posix.dirname(f);
    if (reqDirs.has(dir)) continue;
    const text = await fs.readFile(path.join(ctx.root, f), 'utf8').catch(() => '');
    if (!/^\s*\[project\]\s*$/m.test(text)) continue;
    out.push({ target: f, args: [...common, dir === '.' ? '.' : `./${dir}`] });
  }
  if (!out.length) return 'no requirements file to audit (pip-audit needs requirements*.txt or a PEP 621 pyproject.toml; the active Python environment is never audited)';
  return out.slice(0, MAX_PIP_TARGETS);
}

const single = (args: string[]) => async (): Promise<Invocation[]> => [{ args }];

export const RUNNERS: Runner[] = [
  {
    tool: 'npm audit',
    ecosystem: 'npm',
    command: 'npm',
    applies: (_m, has) => has('package-lock.json') || has('npm-shrinkwrap.json'),
    plan: single(['audit', '--json', '--audit-level=low']),
    parse: parseNpmAudit,
  },
  {
    tool: 'pnpm audit',
    ecosystem: 'npm',
    command: 'pnpm',
    applies: (_m, has) => has('pnpm-lock.yaml'),
    plan: single(['audit', '--json']),
    parse: parsePnpmAudit,
  },
  {
    tool: 'pip-audit',
    ecosystem: 'python',
    command: 'pip-audit',
    applies: (m, _has, ctx) => m.manifests.some((x) => x.ecosystem === 'python') || ctx.files.some((f) => REQUIREMENTS_FILE.test(f)),
    plan: planPipAudit,
    parse: parsePipAudit,
  },
  {
    tool: 'govulncheck',
    ecosystem: 'go',
    command: 'govulncheck',
    applies: (_m, has) => has('go.mod'),
    plan: single(['-format=json', './...']),
    parse: parseGovulncheck,
  },
  {
    tool: 'cargo audit',
    ecosystem: 'cargo',
    command: 'cargo',
    applies: (_m, has) => has('Cargo.lock'),
    plan: single(['audit', '--json']),
    parse: parseCargoAudit,
  },
  {
    tool: 'composer audit',
    ecosystem: 'composer',
    command: 'composer',
    applies: (_m, has) => has('composer.lock'),
    plan: single(['audit', '--format=json']),
    parse: parseComposerAudit,
  },
];

function run(command: string, args: string[], cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; timedOut: boolean; error: Error | null }> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: { ...process.env, NO_COLOR: '1', npm_config_color: 'false' } }, (error, stdout, stderr) => {
      const timedOut = Boolean(error && ((error as NodeJS.ErrnoException).code === 'ETIMEDOUT' || (error as { killed?: boolean }).killed));
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), timedOut, error: error ?? null });
    });
  });
}

export interface ScanOptions {
  signal?: AbortSignal;
  /** Per-tool timeout. */
  timeoutMs?: number;
  /** Skip dependency audits (secrets only). */
  skipAudit?: boolean;
  onTool?: (tool: string) => void;
}

async function runTool(runner: Runner, inv: Invocation, root: string, timeoutMs: number): Promise<ToolResult> {
  const t = Date.now();
  const base = { tool: runner.tool, ecosystem: runner.ecosystem, ...(inv.target ? { target: inv.target } : {}) };
  const r = await run(runner.command, inv.args, root, timeoutMs);
  if (r.timedOut) return { ...base, status: 'timeout', message: `Timed out after ${timeoutMs / 1000}s`, durationMs: Date.now() - t, findings: [] };
  try {
    // Audit tools exit non-zero when they find something; the output decides success.
    const findings = runner.parse(r.stdout, r.stderr);
    return { ...base, status: 'ok', durationMs: Date.now() - t, findings };
  } catch (err) {
    const reason =
      err instanceof AuditToolError
        ? err.message
        : `Could not parse output: ${r.stderr.trim().split('\n')[0] || r.error?.message || (err as Error).message || 'unreadable output'}`;
    return { ...base, status: 'failed', message: reason.slice(0, 300), durationMs: Date.now() - t, findings: [] };
  }
}

/**
 * Run the audit tools the project's ecosystems provide, and scan the project's
 * files for secrets (fresh — not from a cached model). Athena never bundles a
 * vulnerability database: findings are attributed to the tool that produced them,
 * and a missing tool is reported as "not installed" rather than "no problems".
 */
export async function runSecurityScan(root: string, model: ProjectModel, opts: ScanOptions = {}): Promise<SecurityScan> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 120_000;

  const { config } = await loadConfig(root);
  const walk = await walkProject(root, { config, signal: opts.signal });
  const ctx: PlanContext = { root, files: walk.files.map((f) => f.path) };

  const files = new Set(model.manifests.map((m) => m.path));
  for (const pm of model.packageManagers) for (const e of pm.provenance.evidence) files.add(e.file);
  for (const f of ctx.files) files.add(f);
  const has = (file: string) => files.has(file);

  const tools: ToolResult[] = [];
  if (!opts.skipAudit) {
    for (const runner of RUNNERS) {
      if (!runner.applies(model, has, ctx)) continue;
      opts.signal?.throwIfAborted();
      const t = Date.now();
      opts.onTool?.(runner.tool);
      const bin = await whichExecutable(runner.command);
      if (!bin) {
        tools.push({ tool: runner.tool, ecosystem: runner.ecosystem, status: 'unavailable', message: `${runner.command} is not installed or not on PATH`, durationMs: Date.now() - t, findings: [] });
        continue;
      }
      const plan = await runner.plan(ctx);
      if (typeof plan === 'string') {
        tools.push({ tool: runner.tool, ecosystem: runner.ecosystem, status: 'unavailable', message: plan, durationMs: Date.now() - t, findings: [] });
        continue;
      }
      for (const inv of plan) {
        opts.signal?.throwIfAborted();
        tools.push(await runTool(runner, inv, root, timeoutMs));
      }
    }
  }

  const counts: Record<Severity, number> = { critical: 0, high: 0, moderate: 0, low: 0, unrated: 0 };
  for (const t of tools) for (const f of t.findings) counts[f.severity]++;

  const secrets = await scanProjectSecrets(root, walk.files, opts.signal);

  const scan: SecurityScan = {
    schemaVersion: 1,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    tools,
    counts,
    secrets: {
      count: secrets.findings.length,
      files: [...new Set(secrets.findings.map((s) => s.file))].slice(0, 50),
      skippedLongLines: secrets.skippedLongLines,
      ...(secrets.truncated ? { truncated: true } : {}),
    },
  };
  return scan;
}

/** Fresh secret scan of the project's files (same rules as the analyzer's secrets detector). */
async function scanProjectSecrets(root: string, files: FileEntry[], signal?: AbortSignal) {
  const fingerprint = await secretFingerprinter(root);
  const read = async (rel: string) => fs.readFile(path.join(root, rel), 'utf8').catch(() => null);
  return scanFilesForSecrets(files, read, { fingerprint, signal });
}
