import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ProjectModel } from '../model/project-model.js';
import type { Severity as LegacySeverity, ToolResult, Vulnerability } from '../model/security-scan.js';
import type { CoverageInput, FindingInput, Severity } from '../findings/finding.js';
import { packageFingerprint } from '../findings/fingerprint.js';
import { walkProject, type FileEntry } from '../fs/walker.js';
import { whichExecutable } from '../util/which.js';
import type { ScanContext, Scanner, ScannerOutput } from './types.js';

/**
 * Dependency audit: runs the audit tools each ecosystem provides (npm/pnpm audit,
 * pip-audit, govulncheck, cargo audit, composer audit) and reports what they found.
 * Athena never bundles a vulnerability database: findings are FACTs attributed to
 * the tool, and a tool that is missing, fails or times out is recorded in coverage
 * — never read as "no vulnerabilities".
 */

/** A tool ran but its output says it did not complete the audit (e.g. npm offline). */
export class AuditToolError extends Error {}

/** One advisory as reported by a tool. */
export interface AdvisoryDetail {
  id?: string;
  /** All ids the tool gave (GHSA, CVE, PYSEC, GO-, RUSTSEC…), primary first. */
  ids: string[];
  title: string;
  severity: LegacySeverity;
  url?: string;
  cwe: string[];
  /** Affected version range, when the tool reports one. */
  range?: string;
  fixedIn?: string;
}

/**
 * A row as parsed from a tool's output. The base fields are the legacy
 * `security-scan.json` vulnerability (one row per package for npm ≥7); the extra
 * fields feed the findings model. Extras are stripped before the legacy file is written.
 */
export interface AuditVulnerability extends Vulnerability {
  version?: string;
  /** Advisories behind this row; empty for npm rows that are only vulnerable through another package. */
  advisories?: AdvisoryDetail[];
  /** npm ≥7: names of vulnerable packages this one depends on (transitive rows). */
  via?: string[];
}

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

type ManifestInfo = Pick<ProjectModel, 'manifests'>;

interface Runner {
  tool: string;
  /** Engine id for findings and coverage (`npm-audit`, …). */
  engine: string;
  ecosystem: string;
  command: string;
  /** Lockfile or manifest the tool audits, when it runs once per project. */
  manifest?: (has: (file: string) => boolean) => string | undefined;
  /** Run only when this returns true for the project. */
  applies(model: ManifestInfo, has: (file: string) => boolean, ctx: PlanContext): boolean;
  /** Invocations to run, or a reason there is nothing to audit (reported as `unavailable`). */
  plan(ctx: PlanContext): Promise<Invocation[] | string>;
  parse(stdout: string, stderr: string): AuditVulnerability[];
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []);
const cwes = (v: unknown): string[] => strings(v).filter((c) => /^CWE-\d+$/.test(c));
const uniq = (xs: Array<string | undefined>): string[] => [...new Set(xs.filter((x): x is string => Boolean(x)))];
const GHSA = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i;

const sev = (s: unknown): LegacySeverity => {
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
function parseAdvisories(advisories: Record<string, unknown>): AuditVulnerability[] {
  const out: AuditVulnerability[] = [];
  for (const [key, raw] of Object.entries(advisories)) {
    const a = asRecord(raw);
    const versions = [...new Set((Array.isArray(a.findings) ? a.findings : []).map((f) => asRecord(f).version).filter((v): v is string => typeof v === 'string'))];
    const patched = typeof a.patched_versions === 'string' ? a.patched_versions.trim() : '';
    const id = typeof a.github_advisory_id === 'string' ? a.github_advisory_id : Array.isArray(a.cves) && typeof a.cves[0] === 'string' ? a.cves[0] : String(a.id ?? key);
    const url = typeof a.url === 'string' ? a.url : undefined;
    const title = String(a.title ?? `Vulnerable dependency: ${String(a.module_name ?? key)}`);
    const range = typeof a.vulnerable_versions === 'string' ? a.vulnerable_versions : undefined;
    out.push({
      package: String(a.module_name ?? 'unknown'),
      severity: sev(a.severity),
      title,
      id,
      url,
      vulnerableRange: range !== undefined ? range + (versions.length ? ` (installed ${versions.join(', ')})` : '') : undefined,
      fixAvailable: Boolean(patched) && patched !== '<0.0.0',
      ...(versions.length === 1 ? { version: versions[0] } : {}),
      advisories: [{ id, ids: uniq([id, typeof a.github_advisory_id === 'string' ? a.github_advisory_id : undefined, ...strings(a.cves), a.id !== undefined ? String(a.id) : undefined]), title, severity: sev(a.severity), url, cwe: cwes(a.cwe), range, ...(patched && patched !== '<0.0.0' ? { fixedIn: patched } : {}) }],
    });
  }
  return out;
}

/** `npm audit --json` (npm ≥7: `vulnerabilities`; npm ≤6: `advisories`). Exit code 1 with vulnerabilities is success. */
export function parseNpmAudit(stdout: string): AuditVulnerability[] {
  const json = parseJsonObject(stdout, 'npm audit');
  throwIfToolError(json, 'npm audit');
  if (!isObject(json.vulnerabilities)) {
    if (isObject(json.advisories)) return parseAdvisories(json.advisories);
    throw new AuditToolError('npm audit output has no "vulnerabilities" report');
  }
  const out: AuditVulnerability[] = [];
  for (const [name, raw] of Object.entries(json.vulnerabilities)) {
    const v = asRecord(raw);
    const via = Array.isArray(v.via) ? v.via : [];
    const objects = via.filter(isObject);
    const advisory = objects[0];
    const viaNames = via.filter((x): x is string => typeof x === 'string');
    const fix = asRecord(v.fixAvailable);
    out.push({
      package: name,
      severity: sev(v.severity),
      title: String(advisory?.title ?? (viaNames.length ? `Depends on vulnerable ${viaNames.join(', ')}` : `Vulnerable dependency: ${name}`)),
      id: advisory?.source !== undefined ? String(advisory.source) : undefined,
      url: typeof advisory?.url === 'string' ? advisory.url : undefined,
      vulnerableRange: typeof v.range === 'string' ? v.range : undefined,
      fixAvailable: Boolean(v.fixAvailable),
      via: viaNames,
      advisories: objects
        // An advisory object always describes the package it is listed under; skip anything else.
        .filter((a) => typeof a.name !== 'string' || a.name === name)
        .map((a) => {
          const url = typeof a.url === 'string' ? a.url : undefined;
          const ghsa = url ? GHSA.exec(url)?.[0] : undefined;
          return {
            id: ghsa ?? (a.source !== undefined ? String(a.source) : undefined),
            ids: uniq([ghsa, a.source !== undefined ? String(a.source) : undefined]),
            title: String(a.title ?? `Vulnerable dependency: ${name}`),
            severity: sev(a.severity ?? v.severity),
            url,
            cwe: cwes(a.cwe),
            range: typeof a.range === 'string' ? a.range : typeof v.range === 'string' ? v.range : undefined,
            ...(fix.name === name && typeof fix.version === 'string' ? { fixedIn: fix.version } : {}),
          };
        }),
    });
  }
  return out;
}

/** `pnpm audit --json`: the legacy `{ advisories: { <id>: {...} }, metadata }` shape. */
export function parsePnpmAudit(stdout: string): AuditVulnerability[] {
  const json = parseJsonObject(stdout, 'pnpm audit');
  throwIfToolError(json, 'pnpm audit');
  if (!isObject(json.advisories)) throw new AuditToolError('pnpm audit output has no "advisories" report');
  return parseAdvisories(json.advisories);
}

/** `pip-audit --format json`: `{ dependencies: [{ name, version, vulns: [...] } | { name, skip_reason }], fixes }`. */
export function parsePipAudit(stdout: string): AuditVulnerability[] {
  const text = stdout.trim();
  if (!text) throw new AuditToolError('pip-audit produced no output');
  const json = JSON.parse(text) as unknown;
  const deps = isObject(json) && Array.isArray(json.dependencies) ? json.dependencies : Array.isArray(json) ? json : null;
  if (!deps) throw new AuditToolError('pip-audit output has no "dependencies" list');
  const out: AuditVulnerability[] = [];
  for (const raw of deps) {
    const d = asRecord(raw);
    for (const vRaw of Array.isArray(d.vulns) ? d.vulns : []) {
      const v = asRecord(vRaw);
      const aliases = strings(v.aliases);
      const id = typeof v.id === 'string' ? v.id : undefined;
      const fixes = strings(v.fix_versions);
      const title = String(v.description ?? id ?? 'Known vulnerability').split('\n')[0]!.slice(0, 300);
      const url = id ? `https://osv.dev/vulnerability/${id}` : undefined;
      out.push({
        package: String(d.name ?? 'unknown'),
        severity: 'unrated', // pip-audit does not report severity
        title,
        id: id ?? aliases[0],
        url,
        vulnerableRange: typeof d.version === 'string' ? `installed ${d.version}` : undefined,
        fixAvailable: fixes.length > 0,
        ...(typeof d.version === 'string' ? { version: d.version } : {}),
        advisories: [{ id: id ?? aliases[0], ids: uniq([id, ...aliases]), title, severity: 'unrated', url, cwe: [], ...(fixes[0] ? { fixedIn: fixes[0] } : {}) }],
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
export function parseGovulncheck(stdout: string): AuditVulnerability[] {
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
    const title = `${String(osv.summary ?? id)} (${label[f.reach]})`;
    const url = `https://pkg.go.dev/vuln/${id}`;
    return {
      package: f.module ?? String(asRecord(affected.package).name ?? 'unknown'),
      severity: 'unrated' as const, // the Go vulnerability database does not assign severities
      title,
      id,
      url,
      vulnerableRange: f.version ? `installed ${f.version}` : undefined,
      fixAvailable: Boolean(f.fixed),
      ...(f.version ? { version: f.version } : {}),
      advisories: [{ id, ids: uniq([id, ...strings(osv.aliases)]), title, severity: 'unrated' as const, url, cwe: [], ...(f.fixed ? { fixedIn: f.fixed } : {}) }],
    };
  });
}

export function parseCargoAudit(stdout: string): AuditVulnerability[] {
  const json = parseJsonObject(stdout, 'cargo audit');
  if (!isObject(json.vulnerabilities)) throw new AuditToolError('cargo audit output has no "vulnerabilities" report');
  const list = Array.isArray(json.vulnerabilities.list) ? json.vulnerabilities.list : [];
  return list.map((raw) => {
    const v = asRecord(raw);
    const advisory = asRecord(v.advisory);
    const pkg = asRecord(v.package);
    const id = typeof advisory.id === 'string' ? advisory.id : undefined;
    const title = String(advisory.title ?? 'Known vulnerability');
    const url = typeof advisory.url === 'string' ? advisory.url : undefined;
    const severity = sev(asRecord(advisory.cvss).severity ?? advisory.severity);
    const patched = strings(asRecord(v.versions).patched);
    return {
      package: String(pkg.name ?? 'unknown'),
      severity,
      title,
      id,
      url,
      ...(typeof pkg.version === 'string' ? { version: pkg.version } : {}),
      advisories: [{ id, ids: uniq([id, ...strings(advisory.aliases)]), title, severity, url, cwe: [], ...(patched[0] ? { fixedIn: patched.join(', ') } : {}) }],
    };
  });
}

export function parseComposerAudit(stdout: string): AuditVulnerability[] {
  const json = parseJsonObject(stdout, 'composer audit');
  if (json.advisories === undefined) throw new AuditToolError('composer audit output has no "advisories" report');
  const advisories = asRecord(json.advisories); // `[]` when there are none
  const out: AuditVulnerability[] = [];
  for (const [pkg, raw] of Object.entries(advisories)) {
    for (const aRaw of Array.isArray(raw) ? raw : Object.values(asRecord(raw))) {
      const a = asRecord(aRaw);
      const id = typeof a.cve === 'string' ? a.cve : typeof a.advisoryId === 'string' ? a.advisoryId : undefined;
      const title = String(a.title ?? 'Known vulnerability');
      const url = typeof a.link === 'string' ? a.link : undefined;
      const range = typeof a.affectedVersions === 'string' ? a.affectedVersions : undefined;
      out.push({
        package: pkg,
        severity: sev(a.severity),
        title,
        id,
        url,
        vulnerableRange: range,
        advisories: [{ id, ids: uniq([id, typeof a.advisoryId === 'string' ? a.advisoryId : undefined, typeof a.cve === 'string' ? a.cve : undefined]), title, severity: sev(a.severity), url, cwe: [], range }],
      });
    }
  }
  return out;
}

/** Max number of Python inputs audited in one scan. */
export const MAX_PIP_TARGETS = 10;
const REQUIREMENTS_FILE = /(^|\/)requirements[\w.-]*\.txt$/i;
const PYTHON_MANIFEST = /(^|\/)(pyproject\.toml|setup\.py|setup\.cfg|Pipfile)$/;

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
const first = (...files: string[]) => (has: (f: string) => boolean) => files.find(has);

export const RUNNERS: Runner[] = [
  {
    tool: 'npm audit',
    engine: 'npm-audit',
    ecosystem: 'npm',
    command: 'npm',
    manifest: first('package-lock.json', 'npm-shrinkwrap.json'),
    applies: (_m, has) => has('package-lock.json') || has('npm-shrinkwrap.json'),
    plan: single(['audit', '--json', '--audit-level=low']),
    parse: parseNpmAudit,
  },
  {
    tool: 'pnpm audit',
    engine: 'pnpm-audit',
    ecosystem: 'npm',
    command: 'pnpm',
    manifest: first('pnpm-lock.yaml'),
    applies: (_m, has) => has('pnpm-lock.yaml'),
    plan: single(['audit', '--json']),
    parse: parsePnpmAudit,
  },
  {
    tool: 'pip-audit',
    engine: 'pip-audit',
    ecosystem: 'python',
    command: 'pip-audit',
    applies: (m, _has, ctx) => m.manifests.some((x) => x.ecosystem === 'python') || ctx.files.some((f) => REQUIREMENTS_FILE.test(f)),
    plan: planPipAudit,
    parse: parsePipAudit,
  },
  {
    tool: 'govulncheck',
    engine: 'govulncheck',
    ecosystem: 'go',
    command: 'govulncheck',
    manifest: first('go.mod'),
    applies: (_m, has) => has('go.mod'),
    plan: single(['-format=json', './...']),
    parse: parseGovulncheck,
  },
  {
    tool: 'cargo audit',
    engine: 'cargo-audit',
    ecosystem: 'cargo',
    command: 'cargo',
    manifest: first('Cargo.lock'),
    applies: (_m, has) => has('Cargo.lock'),
    plan: single(['audit', '--json']),
    parse: parseCargoAudit,
  },
  {
    tool: 'composer audit',
    engine: 'composer-audit',
    ecosystem: 'composer',
    command: 'composer',
    manifest: first('composer.lock'),
    applies: (_m, has) => has('composer.lock'),
    plan: single(['audit', '--format=json']),
    parse: parseComposerAudit,
  },
];

/** Engine id for a legacy tool name (`npm audit` → `npm-audit`). */
export const engineIdForTool = (tool: string): string => RUNNERS.find((r) => r.tool === tool)?.engine ?? tool.trim().toLowerCase().replace(/\s+/g, '-');

function run(command: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; timedOut: boolean; error: Error | null }> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, signal, env: { ...process.env, NO_COLOR: '1', npm_config_color: 'false' } }, (error, stdout, stderr) => {
      const timedOut = Boolean(error && ((error as NodeJS.ErrnoException).code === 'ETIMEDOUT' || ((error as { killed?: boolean }).killed && !signal?.aborted)));
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), timedOut, error: error ?? null });
    });
  });
}

/** A tool run with the parsed rows (legacy `ToolResult` plus extras). */
export interface AuditRun extends Omit<ToolResult, 'status' | 'findings'> {
  engine: string;
  status: ToolResult['status'] | 'skipped';
  /** Lockfile/manifest audited, if known. */
  manifest?: string;
  network: boolean;
  findings: AuditVulnerability[];
}

async function runTool(runner: Runner, inv: Invocation, root: string, timeoutMs: number, manifest: string | undefined, signal?: AbortSignal): Promise<AuditRun> {
  const t = Date.now();
  const base = { tool: runner.tool, engine: runner.engine, ecosystem: runner.ecosystem, ...(inv.target ? { target: inv.target } : {}), ...(manifest ? { manifest } : {}), network: true };
  const r = await run(runner.command, inv.args, root, timeoutMs, signal);
  signal?.throwIfAborted();
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

export interface DependencyAuditOptions {
  /** Project model: manifests and package-manager evidence decide which tools apply. Optional. */
  model?: Pick<ProjectModel, 'manifests' | 'packageManagers'>;
  /** A project walk to reuse (otherwise the project is walked). */
  walk?: FileEntry[];
  /** Per-tool timeout (default 120 s). */
  timeoutMs?: number;
  onTool?: (tool: string) => void;
}

/**
 * Run every audit tool that applies. Dependency audits always cover the whole
 * project (a vulnerable package is not tied to changed files), whatever ctx.files says.
 */
export async function runAudits(ctx: ScanContext, opts: DependencyAuditOptions = {}): Promise<AuditRun[]> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const walk = opts.walk ?? (await walkProject(ctx.root, { config: ctx.config, signal: ctx.signal })).files;
  const plan: PlanContext = { root: ctx.root, files: walk.map((f) => f.path) };
  const model: ManifestInfo = opts.model ?? { manifests: plan.files.filter((f) => PYTHON_MANIFEST.test(f)).map((p) => ({ path: p, ecosystem: 'python' }) as ProjectModel['manifests'][number]) };

  const files = new Set(model.manifests.map((m) => m.path));
  for (const pm of opts.model?.packageManagers ?? []) for (const e of pm.provenance.evidence) files.add(e.file);
  for (const f of plan.files) files.add(f);
  const has = (file: string) => files.has(file);

  const runs: AuditRun[] = [];
  for (const runner of RUNNERS) {
    if (!runner.applies(model, has, plan)) continue;
    ctx.signal?.throwIfAborted();
    const t = Date.now();
    const manifest = runner.manifest?.(has);
    const base = { tool: runner.tool, engine: runner.engine, ecosystem: runner.ecosystem, ...(manifest ? { manifest } : {}), findings: [] };
    if (ctx.offline) {
      runs.push({ ...base, status: 'skipped', message: `offline: ${runner.tool} queries an online advisory database`, network: false, durationMs: 0 });
      continue;
    }
    opts.onTool?.(runner.tool);
    const bin = await whichExecutable(runner.command);
    if (!bin) {
      runs.push({ ...base, status: 'unavailable', message: `${runner.command} is not installed or not on PATH`, network: false, durationMs: Date.now() - t });
      continue;
    }
    const invocations = await runner.plan(plan);
    if (typeof invocations === 'string') {
      runs.push({ ...base, status: 'unavailable', message: invocations, network: false, durationMs: Date.now() - t });
      continue;
    }
    for (const inv of invocations) {
      ctx.signal?.throwIfAborted();
      runs.push(await runTool(runner, inv, ctx.root, timeoutMs, inv.target ?? manifest, ctx.signal));
    }
  }
  return runs;
}

const SEVERITY: Record<LegacySeverity, Severity> = { critical: 'critical', high: 'high', moderate: 'medium', low: 'low', unrated: 'unrated' };
export const mapLegacySeverity = (s: LegacySeverity): Severity => SEVERITY[s];

/** Strip the findings-model extras from a parsed row (for `security-scan.json`). */
export function legacyVulnerability(v: AuditVulnerability): Vulnerability {
  return {
    package: v.package,
    severity: v.severity,
    title: v.title,
    ...(v.id !== undefined ? { id: v.id } : {}),
    ...(v.url !== undefined ? { url: v.url } : {}),
    ...(v.vulnerableRange !== undefined ? { vulnerableRange: v.vulnerableRange } : {}),
    ...(v.fixAvailable !== undefined ? { fixAvailable: v.fixAvailable } : {}),
  };
}

/** The legacy `ToolResult` for a run (`skipped` is reported as `unavailable`, which v1 knows). */
export function legacyToolResult(r: AuditRun): ToolResult {
  return {
    tool: r.tool,
    ecosystem: r.ecosystem,
    ...(r.target ? { target: r.target } : {}),
    status: r.status === 'skipped' ? 'unavailable' : r.status,
    ...(r.message ? { message: r.message } : {}),
    durationMs: r.durationMs,
    findings: r.findings.map(legacyVulnerability),
  };
}

export const DEPENDENCY_RULE = 'dependency/vulnerable-package';

/**
 * Findings for one tool run: one per (package, advisory). npm ≥7 lists packages that
 * are only vulnerable through another package (`via: ["minimist"]`); those are not
 * counted again when the package they go through is reported itself.
 */
export function auditFindings(r: Pick<AuditRun, 'engine' | 'ecosystem' | 'manifest' | 'target' | 'findings'>): FindingInput[] {
  const reported = new Set(r.findings.filter((v) => v.advisories === undefined || v.advisories.length > 0).map((v) => v.package));
  const manifest = r.target ?? r.manifest;
  const out = new Map<string, FindingInput>();
  for (const v of r.findings) {
    let advisories = v.advisories;
    if (advisories && !advisories.length) {
      if ((v.via ?? []).some((name) => reported.has(name))) continue; // transitive duplicate
      advisories = undefined;
    }
    for (const a of advisories ?? [{ id: v.id, ids: uniq([v.id]), title: v.title, severity: v.severity, url: v.url, cwe: [], range: v.vulnerableRange }]) {
      const advisoryId = a.id ?? a.ids[0];
      const fingerprint = packageFingerprint({ ruleId: DEPENDENCY_RULE, ecosystem: r.ecosystem, name: v.package, manifest, advisoryId: advisoryId ?? a.title });
      if (out.has(fingerprint)) continue;
      const fixedIn = a.fixedIn;
      const at = v.version ? `${v.package}@${v.version}` : v.package;
      out.set(fingerprint, {
        fingerprint,
        ruleId: DEPENDENCY_RULE,
        category: 'dependency',
        severity: mapLegacySeverity(a.severity),
        confidence: 'high',
        label: 'FACT',
        potential: false,
        title: `${v.package}: ${a.title}`.slice(0, 300),
        message: `${at} is affected by ${advisoryId ?? 'a known vulnerability'}${a.title ? ` (${a.title})` : ''}, as reported by ${r.engine}.`.slice(0, 600),
        cwe: a.cwe,
        package: {
          ecosystem: r.ecosystem,
          name: v.package,
          ...(v.version ? { version: v.version } : {}),
          ...(manifest ? { manifest } : {}),
          advisoryIds: a.ids,
          ...(a.range ? { vulnerableRange: a.range } : {}),
          ...(fixedIn ? { fixedIn } : {}),
          ...(v.fixAvailable !== undefined || fixedIn ? { fixAvailable: Boolean(v.fixAvailable || fixedIn) } : {}),
        },
        engine: { id: r.engine },
        help: {
          text: fixedIn ? `Upgrade ${v.package} to ${fixedIn} or later.` : v.fixAvailable ? `A fixed version of ${v.package} is available; upgrade it.` : `No fixed version was reported for ${v.package}. Check the advisory for mitigations.`,
          ...(a.url ? { url: a.url } : {}),
        },
      });
    }
  }
  return [...out.values()];
}

/** One coverage record per tool run. */
export function auditCoverage(r: Pick<AuditRun, 'engine' | 'status' | 'message' | 'target' | 'manifest' | 'network' | 'durationMs'>): CoverageInput {
  const target = r.target ?? r.manifest;
  return {
    engine: r.engine,
    category: 'dependency',
    status: r.status,
    ...(r.message ? { reason: r.message } : {}),
    ...(target ? { target } : {}),
    network: r.network,
    durationMs: r.durationMs,
  };
}

export async function auditDependencies(ctx: ScanContext, opts: DependencyAuditOptions = {}): Promise<ScannerOutput & { runs: AuditRun[] }> {
  const runs = await runAudits(ctx, opts);
  return { runs, findings: runs.flatMap((r) => (r.status === 'ok' ? auditFindings(r) : [])), coverage: runs.map(auditCoverage) };
}

export function dependencyScanner(opts: DependencyAuditOptions = {}): Scanner {
  return {
    id: 'athena-dependencies',
    category: 'dependency',
    title: 'Vulnerable dependencies',
    async run(ctx) {
      const { findings, coverage } = await auditDependencies(ctx, opts);
      return { findings, coverage };
    },
  };
}
