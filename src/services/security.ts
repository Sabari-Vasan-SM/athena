import { execFile } from 'node:child_process';
import { ProjectModel } from '../core/model/project-model.js';
import { SEVERITY_ORDER, type SecurityScan, type Severity, type ToolResult, type Vulnerability } from '../core/model/security-scan.js';
import { whichExecutable } from './which.js';

export { loadScan, saveScan, totalFindings, meetsThreshold, SCAN_FILE, SEVERITY_ORDER } from '../core/model/security-scan.js';
export type { SecurityScan, Severity, ToolResult, Vulnerability } from '../core/model/security-scan.js';

interface Runner {
  tool: string;
  ecosystem: string;
  command: string;
  args: string[];
  /** Run only when this returns true for the project. */
  applies(model: ProjectModel, has: (file: string) => boolean): boolean;
  parse(stdout: string, stderr: string): Vulnerability[];
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const sev = (s: unknown): Severity => {
  const v = String(s ?? '').toLowerCase();
  if (v === 'critical') return 'critical';
  if (v === 'high') return 'high';
  if (v === 'moderate' || v === 'medium') return 'moderate';
  if (v === 'low') return 'low';
  return 'unknown';
};

function parseNpmAudit(stdout: string): Vulnerability[] {
  const json = JSON.parse(stdout) as Record<string, unknown>;
  const vulns = asRecord(json.vulnerabilities);
  const out: Vulnerability[] = [];
  for (const [name, raw] of Object.entries(vulns)) {
    const v = asRecord(raw);
    const via = Array.isArray(v.via) ? v.via : [];
    const advisory = via.find((x) => x && typeof x === 'object') as Record<string, unknown> | undefined;
    out.push({
      package: name,
      severity: sev(v.severity),
      title: String(advisory?.title ?? `Vulnerable dependency: ${name}`),
      id: advisory?.source !== undefined ? String(advisory.source) : undefined,
      url: typeof advisory?.url === 'string' ? advisory.url : undefined,
      vulnerableRange: typeof v.range === 'string' ? v.range : undefined,
      fixAvailable: Boolean(v.fixAvailable),
    });
  }
  return out;
}

function parsePipAudit(stdout: string): Vulnerability[] {
  const json = JSON.parse(stdout) as Record<string, unknown>;
  const deps = Array.isArray(json.dependencies) ? json.dependencies : Array.isArray(json) ? json : [];
  const out: Vulnerability[] = [];
  for (const raw of deps) {
    const d = asRecord(raw);
    for (const vRaw of Array.isArray(d.vulns) ? d.vulns : []) {
      const v = asRecord(vRaw);
      out.push({
        package: String(d.name ?? 'unknown'),
        severity: 'unknown', // pip-audit does not report severity
        title: String(v.description ?? v.id ?? 'Known vulnerability'),
        id: typeof v.id === 'string' ? v.id : undefined,
        vulnerableRange: typeof d.version === 'string' ? `installed ${d.version}` : undefined,
        fixAvailable: Array.isArray(v.fix_versions) && v.fix_versions.length > 0,
      });
    }
  }
  return out;
}

function parseGovulncheck(stdout: string): Vulnerability[] {
  const out = new Map<string, Vulnerability>();
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const msg = asRecord(JSON.parse(line));
      const finding = asRecord(msg.finding);
      const osv = asRecord(msg.osv);
      if (typeof osv.id === 'string') {
        out.set(osv.id, {
          package: String(asRecord(asRecord(osv.affected?.[0 as keyof typeof osv.affected]).package).name ?? 'unknown'),
          severity: 'unknown',
          title: String(osv.summary ?? osv.id),
          id: osv.id,
          url: `https://pkg.go.dev/vuln/${osv.id}`,
        });
      }
      if (typeof finding.osv === 'string' && out.has(finding.osv)) {
        const trace = Array.isArray(finding.trace) ? asRecord(finding.trace[0]) : {};
        const pkg = typeof trace.module === 'string' ? trace.module : undefined;
        if (pkg) out.set(finding.osv, { ...out.get(finding.osv)!, package: pkg });
      }
    } catch {
      /* skip non-JSON lines */
    }
  }
  return [...out.values()];
}

function parseCargoAudit(stdout: string): Vulnerability[] {
  const json = asRecord(JSON.parse(stdout));
  const list = Array.isArray(asRecord(json.vulnerabilities).list) ? (asRecord(json.vulnerabilities).list as unknown[]) : [];
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

function parseComposerAudit(stdout: string): Vulnerability[] {
  const json = asRecord(JSON.parse(stdout));
  const advisories = asRecord(json.advisories);
  const out: Vulnerability[] = [];
  for (const [pkg, raw] of Object.entries(advisories)) {
    for (const aRaw of Array.isArray(raw) ? raw : []) {
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

export const RUNNERS: Runner[] = [
  {
    tool: 'npm audit',
    ecosystem: 'npm',
    command: 'npm',
    args: ['audit', '--json', '--audit-level=low'],
    applies: (_m, has) => has('package-lock.json') || has('npm-shrinkwrap.json'),
    parse: parseNpmAudit,
  },
  {
    tool: 'pnpm audit',
    ecosystem: 'npm',
    command: 'pnpm',
    args: ['audit', '--json'],
    applies: (_m, has) => has('pnpm-lock.yaml'),
    parse: parseNpmAudit,
  },
  {
    tool: 'pip-audit',
    ecosystem: 'python',
    command: 'pip-audit',
    args: ['--format=json', '--progress-spinner=off'],
    applies: (m) => m.manifests.some((x) => x.ecosystem === 'python'),
    parse: parsePipAudit,
  },
  {
    tool: 'govulncheck',
    ecosystem: 'go',
    command: 'govulncheck',
    args: ['-format=json', './...'],
    applies: (_m, has) => has('go.mod'),
    parse: parseGovulncheck,
  },
  {
    tool: 'cargo audit',
    ecosystem: 'cargo',
    command: 'cargo',
    args: ['audit', '--json'],
    applies: (_m, has) => has('Cargo.lock'),
    parse: parseCargoAudit,
  },
  {
    tool: 'composer audit',
    ecosystem: 'composer',
    command: 'composer',
    args: ['audit', '--format=json'],
    applies: (_m, has) => has('composer.lock'),
    parse: parseComposerAudit,
  },
];

function run(command: string, args: string[], cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; timedOut: boolean; error: Error | null }> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: { ...process.env, NO_COLOR: '1', npm_config_color: 'false' } }, (error, stdout, stderr) => {
      const timedOut = Boolean(error && (error as NodeJS.ErrnoException).code === 'ETIMEDOUT');
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

/**
 * Run the audit tools the project's ecosystems provide. Athena never bundles a
 * vulnerability database: findings are attributed to the tool that produced them,
 * and a missing tool is reported as "not installed" rather than "no problems".
 */
export async function runSecurityScan(root: string, model: ProjectModel, opts: ScanOptions = {}): Promise<SecurityScan> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const files = new Set(model.manifests.map((m) => m.path));
  for (const pm of model.packageManagers) for (const e of pm.provenance.evidence) files.add(e.file);
  const has = (file: string) => files.has(file);

  const tools: ToolResult[] = [];
  if (!opts.skipAudit) {
    for (const runner of RUNNERS) {
      if (!runner.applies(model, has)) continue;
      opts.signal?.throwIfAborted();
      const t = Date.now();
      opts.onTool?.(runner.tool);
      const bin = await whichExecutable(runner.command);
      if (!bin) {
        tools.push({ tool: runner.tool, ecosystem: runner.ecosystem, status: 'unavailable', message: `${runner.command} is not installed or not on PATH`, durationMs: Date.now() - t, findings: [] });
        continue;
      }
      const r = await run(runner.command, runner.args, root, timeoutMs);
      if (r.timedOut) {
        tools.push({ tool: runner.tool, ecosystem: runner.ecosystem, status: 'timeout', message: `Timed out after ${timeoutMs / 1000}s`, durationMs: Date.now() - t, findings: [] });
        continue;
      }
      try {
        // Audit tools exit non-zero when they find something; parse output regardless.
        const findings = runner.parse(r.stdout, r.stderr);
        tools.push({ tool: runner.tool, ecosystem: runner.ecosystem, status: 'ok', durationMs: Date.now() - t, findings });
      } catch {
        const reason = r.stderr.trim().split('\n')[0] ?? r.error?.message ?? 'unreadable output';
        tools.push({ tool: runner.tool, ecosystem: runner.ecosystem, status: 'failed', message: `Could not parse output: ${reason.slice(0, 200)}`, durationMs: Date.now() - t, findings: [] });
      }
    }
  }

  const counts: Record<Severity, number> = { critical: 0, high: 0, moderate: 0, low: 0, unknown: 0 };
  for (const t of tools) for (const f of t.findings) counts[f.severity]++;

  const scan: SecurityScan = {
    schemaVersion: 1,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    tools,
    counts,
    secrets: { count: model.security.secrets.length, files: [...new Set(model.security.secrets.map((s) => s.file))].slice(0, 50) },
  };
  return scan;
}

