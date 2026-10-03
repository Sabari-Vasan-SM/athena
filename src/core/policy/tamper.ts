import path from 'node:path';
import { git, isSafeRef, type GitRunOptions } from '../git/git.js';
import { readTextIfExists, readTextInsideRoot } from '../util/fs.js';
import { BASELINE_FILE, parseBaseline, type Baseline } from '../findings/baseline.js';
import { CONFIDENCE_RANK, Finding, SEVERITY_RANK } from '../findings/finding.js';
import { codeFingerprint, fileFingerprint, normalizeLine, occurrenceCounter } from '../findings/fingerprint.js';
import { DEFAULT_SUPPRESSION_MAX_BYTES, findSuppressions, parseSuppressionLine } from '../findings/suppress.js';
import { CLOSING_TRIAGE, parseTriage, TRIAGE_FILE, type Triage } from '../findings/triage.js';
import { DEFAULT_POLICY, parsePolicy, POLICY_FILE, PolicyError, type Policy, type RuleSetting } from './policy.js';

/**
 * Anti-tamper for CI (`--policy-from <ref>`): a pull request must not be able to pass
 * the gate by weakening the policy it is judged by. The gate uses the base branch's
 * policy, baseline and triage (read with `git show <ref>:<path>`; missing there =
 * defaults), and every change to them — or an `athena-ignore` comment added — between
 * merge-base(ref, HEAD) and the working tree is reported as `review/policy-weakened`:
 * `high` when it relaxes the gate, `info` otherwise. A base policy can downgrade that
 * rule (e.g. to `info`) if the team prefers review comments over a failing check.
 */
export const POLICY_WEAKENED = 'review/policy-weakened';

export interface PolicyState {
  policy: Policy;
  baseline: Baseline | null;
  triage: Triage | null;
}

export interface PolicyChange {
  /** What changed, e.g. `gate.failOn`, `rules.sast/js/eval`, `baseline`, `src/a.ts:12`. */
  key: string;
  text: string;
  relaxes: boolean;
}

export interface AddedSuppression {
  file: string;
  line: number;
  ruleId: string;
  reason: string;
  lineText: string;
}

export interface PolicyFromResult {
  ref: string;
  /** The commit `ref` resolved to: whose policy/baseline/triage the gate uses. */
  commit: string;
  /** merge-base(ref, HEAD): what the change is compared against. */
  mergeBase: string;
  base: PolicyState;
  changes: { policy: PolicyChange[]; baseline: PolicyChange[]; triage: PolicyChange[] };
  addedSuppressions: AddedSuppression[];
  /** `review/policy-weakened` findings. */
  findings: Finding[];
}

const GIT_TIMEOUT_MS = 60_000;

async function gitText(root: string, args: string[], opts: GitRunOptions): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const r = await git(root, args, { timeoutMs: GIT_TIMEOUT_MS, ...opts });
  if (r.aborted) throw opts.signal?.reason ?? new Error('Aborted');
  return r;
}

/** Contents of `rel` (relative to `root`) at `commit`, or null when the file doesn't exist there. */
export async function readFileAtCommit(root: string, commit: string, rel: string, opts: GitRunOptions = {}): Promise<string | null> {
  const spec = `${commit}:./${rel}`;
  const exists = await gitText(root, ['cat-file', '-e', spec], opts);
  if (!exists.ok) return null;
  const r = await gitText(root, ['show', '--no-textconv', spec], { ...opts, maxBytes: 8 * 1024 * 1024 });
  if (!r.ok) throw new PolicyError(`Couldn't read ${rel} at ${commit.slice(0, 12)}: ${r.stderr.trim().split('\n').pop()?.slice(0, 200) ?? 'git show failed'}`);
  return r.stdout;
}

interface RawState {
  policy: string | null;
  baseline: string | null;
  triage: string | null;
}

function parseState(raw: RawState, where: string): PolicyState {
  return {
    policy: raw.policy === null ? DEFAULT_POLICY : parsePolicy(raw.policy, `${POLICY_FILE} at ${where}`),
    baseline: raw.baseline === null ? null : parseBaseline(raw.baseline, `${BASELINE_FILE} at ${where}`),
    triage: raw.triage === null ? null : parseTriage(raw.triage, `${TRIAGE_FILE} at ${where}`),
  };
}

async function rawAtCommit(root: string, commit: string, opts: GitRunOptions): Promise<RawState> {
  const [policy, baseline, triage] = await Promise.all([POLICY_FILE, BASELINE_FILE, TRIAGE_FILE].map((f) => readFileAtCommit(root, commit, f, opts)));
  return { policy: policy!, baseline: baseline!, triage: triage! };
}

async function rawWorkingTree(root: string): Promise<RawState> {
  const [policy, baseline, triage] = await Promise.all([POLICY_FILE, BASELINE_FILE, TRIAGE_FILE].map((f) => readTextIfExists(path.join(root, f))));
  return { policy: policy!, baseline: baseline!, triage: triage! };
}

/** Policy, baseline and triage as committed at `commit` (missing files = defaults / none). */
export async function readPolicyStateAt(root: string, commit: string, opts: GitRunOptions = {}): Promise<PolicyState> {
  return parseState(await rawAtCommit(root, commit, opts), commit.slice(0, 12));
}

// ── Comparisons ─────────────────────────────────────────────────────────────

/** True unless the change provably tightens: anything ambiguous counts as relaxing. */
function ruleChangeRelaxes(b: RuleSetting | undefined, h: RuleSetting | undefined): boolean {
  if (h === 'off') return true;
  if (b === 'off') return false; // was off, now on (possibly with overrides) — stricter
  const sevOk = h?.severity === undefined ? b?.severity === undefined : h.severity === 'critical' || (b?.severity !== undefined && SEVERITY_RANK[h.severity] >= SEVERITY_RANK[b.severity]);
  const confOk = h?.confidence === undefined ? b?.confidence === undefined : h.confidence === 'high' || (b?.confidence !== undefined && CONFIDENCE_RANK[h.confidence] >= CONFIDENCE_RANK[b.confidence]);
  return !(sevOk && confOk);
}

const show = (s: RuleSetting | undefined) => (s === undefined ? 'default' : s === 'off' ? 'off' : JSON.stringify(s));

export function comparePolicies(base: Policy, head: Policy): PolicyChange[] {
  const out: PolicyChange[] = [];
  const bg = base.gate;
  const hg = head.gate;
  if (bg.failOn !== hg.failOn) out.push({ key: 'gate.failOn', text: `gate.failOn ${bg.failOn} → ${hg.failOn}`, relaxes: SEVERITY_RANK[hg.failOn] > SEVERITY_RANK[bg.failOn] });
  if (bg.minConfidence !== hg.minConfidence) {
    out.push({ key: 'gate.minConfidence', text: `gate.minConfidence ${bg.minConfidence} → ${hg.minConfidence}`, relaxes: CONFIDENCE_RANK[hg.minConfidence] > CONFIDENCE_RANK[bg.minConfidence] });
  }
  if (bg.unrated !== hg.unrated) out.push({ key: 'gate.unrated', text: `gate.unrated ${bg.unrated} → ${hg.unrated}`, relaxes: hg.unrated === 'warn' });
  if (bg.scope !== hg.scope) out.push({ key: 'gate.scope', text: `gate.scope ${bg.scope} → ${hg.scope}`, relaxes: hg.scope === 'new' });
  const removedCats = bg.categories.filter((c) => !hg.categories.includes(c));
  const addedCats = hg.categories.filter((c) => !bg.categories.includes(c));
  if (removedCats.length) out.push({ key: 'gate.categories', text: `gate.categories no longer include ${removedCats.join(', ')}`, relaxes: true });
  if (addedCats.length) out.push({ key: 'gate.categories+', text: `gate.categories now include ${addedCats.join(', ')}`, relaxes: false });

  for (const key of [...new Set([...Object.keys(base.rules), ...Object.keys(head.rules)])].sort()) {
    const b = base.rules[key];
    const h = head.rules[key];
    if (JSON.stringify(b) === JSON.stringify(h)) continue;
    out.push({ key: `rules.${key}`, text: `rules["${key}"] ${show(b)} → ${show(h)}`, relaxes: ruleChangeRelaxes(b, h) });
  }

  const listDiff = (key: string, b: string[], h: string[], addRelaxes: boolean) => {
    const added = h.filter((x) => !b.includes(x));
    const removed = b.filter((x) => !h.includes(x));
    if (added.length) out.push({ key: `${key}+`, text: `${key} added ${added.map((x) => JSON.stringify(x)).join(', ')}`, relaxes: addRelaxes });
    if (removed.length) out.push({ key: `${key}-`, text: `${key} removed ${removed.map((x) => JSON.stringify(x)).join(', ')}`, relaxes: !addRelaxes });
  };
  listDiff('paths.exclude', base.paths.exclude, head.paths.exclude, true);
  // Test globs don't affect the gate; changes are reported for review only.
  if (JSON.stringify(base.paths.tests) !== JSON.stringify(head.paths.tests)) out.push({ key: 'paths.tests', text: 'paths.tests changed', relaxes: false });
  listDiff('licenses.deny', base.licenses.deny, head.licenses.deny, false);
  if (JSON.stringify(base.licenses.warn) !== JSON.stringify(head.licenses.warn)) out.push({ key: 'licenses.warn', text: 'licenses.warn changed', relaxes: false });
  for (const e of ['semgrep', 'gitleaks', 'trivy', 'osv-scanner'] as const) {
    if (base.external[e] !== head.external[e]) out.push({ key: `external.${e}`, text: `external.${e} ${base.external[e]} → ${head.external[e]}`, relaxes: head.external[e] === 'off' });
  }
  if (base.external.network !== head.external.network) {
    out.push({ key: 'external.network', text: `external.network ${base.external.network} → ${head.external.network}`, relaxes: head.external.network === 'deny' });
  }
  return out;
}

export function compareBaselines(base: Baseline | null, head: Baseline | null): PolicyChange[] {
  const b = new Map((base?.entries ?? []).map((e) => [e.fingerprint, e]));
  const h = new Map((head?.entries ?? []).map((e) => [e.fingerprint, e]));
  const added = [...h.values()].filter((e) => !b.has(e.fingerprint));
  const removed = [...b.values()].filter((e) => !h.has(e.fingerprint));
  const out: PolicyChange[] = [];
  if (added.length) {
    const rules = [...new Set(added.map((e) => e.ruleId))].sort();
    out.push({ key: 'baseline+', text: `${added.length} baseline entr${added.length === 1 ? 'y' : 'ies'} added (${rules.slice(0, 5).join(', ')}${rules.length > 5 ? ', …' : ''})`, relaxes: true });
  }
  if (removed.length) out.push({ key: 'baseline-', text: `${removed.length} baseline entr${removed.length === 1 ? 'y' : 'ies'} removed`, relaxes: false });
  return out;
}

export function compareTriage(base: Triage | null, head: Triage | null): PolicyChange[] {
  const b = base?.entries ?? {};
  const h = head?.entries ?? {};
  let closedNew = 0;
  let otherChanges = 0;
  let removed = 0;
  for (const [fp, he] of Object.entries(h)) {
    const be = b[fp];
    const closes = CLOSING_TRIAGE.has(he.status);
    if (!be) {
      if (closes) closedNew++;
      else otherChanges++;
    } else if (be.status !== he.status || be.reason !== he.reason) {
      if (closes && !CLOSING_TRIAGE.has(be.status)) closedNew++;
      else otherChanges++;
    }
  }
  for (const fp of Object.keys(b)) if (!(fp in h)) removed++;
  const out: PolicyChange[] = [];
  if (closedNew) out.push({ key: 'triage+', text: `${closedNew} finding${closedNew === 1 ? '' : 's'} newly triaged as not needing a fix (safe / false-positive / accepted-risk / fixed)`, relaxes: true });
  if (otherChanges) out.push({ key: 'triage~', text: `${otherChanges} other triage change${otherChanges === 1 ? '' : 's'}`, relaxes: false });
  if (removed) out.push({ key: 'triage-', text: `${removed} triage entr${removed === 1 ? 'y' : 'ies'} removed`, relaxes: false });
  return out;
}

/** Valid `athena-ignore` comments on lines added in a unified diff (`git diff -U0 --no-prefix` output). */
export function addedSuppressionsInDiff(diff: string): AddedSuppression[] {
  const out: AddedSuppression[] = [];
  let file: string | null = null;
  let inHeader = false;
  let line = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      inHeader = true;
      file = null;
      continue;
    }
    if (inHeader) {
      if (!raw.startsWith('@@')) {
        if (raw.startsWith('+++ ')) file = unquotePath(raw.slice(4));
        continue;
      }
      inHeader = false;
    }
    if (raw.startsWith('@@')) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      line = m ? Number(m[1]) : 0;
      continue;
    }
    if (raw.startsWith('+')) {
      const text = raw.slice(1).replace(/\r$/, '');
      const s = file && file !== '/dev/null' ? parseSuppressionLine(text, line) : null;
      if (s && !s.problem) out.push({ file: file!, line, ruleId: s.ruleId!, reason: s.reason!, lineText: text });
      line++;
    } else if (raw.startsWith(' ')) line++;
  }
  return out;
}

function unquotePath(p: string): string {
  if (p.startsWith('"') && p.endsWith('"')) {
    try {
      return Buffer.from(
        p.slice(1, -1).replace(/\\([0-7]{3})|\\(.)/g, (_m, oct: string | undefined, ch: string | undefined) => {
          if (oct) return String.fromCharCode(parseInt(oct, 8));
          return ch === 'n' ? '\n' : ch === 't' ? '\t' : (ch ?? '');
        }),
        'latin1',
      ).toString('utf8');
    } catch {
      return p;
    }
  }
  return p;
}

// ── Findings ────────────────────────────────────────────────────────────────

function weakenedFinding(file: string, changes: PolicyChange[], ref: string): Finding {
  const relaxes = changes.some((c) => c.relaxes);
  const list = changes.map((c) => `${c.relaxes ? '[relaxes] ' : ''}${c.text}`).join('; ');
  return Finding.parse({
    fingerprint: fileFingerprint({ ruleId: POLICY_WEAKENED, file, key: changes.map((c) => c.key).sort().join(',') }),
    ruleId: POLICY_WEAKENED,
    category: 'review',
    severity: relaxes ? 'high' : 'info',
    confidence: 'high',
    label: 'FACT',
    title: relaxes ? `${file} relaxed in this change` : `${file} changed in this change`,
    message: `${file} differs from ${ref}: ${list}. The gate used the version from ${ref}; a maintainer should review this change on its own.`,
    location: { file },
    engine: { id: 'athena' },
  });
}

function invalidHeadFinding(file: string, problem: string, ref: string): Finding {
  return Finding.parse({
    fingerprint: fileFingerprint({ ruleId: POLICY_WEAKENED, file, key: 'invalid' }),
    ruleId: POLICY_WEAKENED,
    category: 'review',
    severity: 'high',
    confidence: 'high',
    label: 'FACT',
    title: `${file} is invalid in this change`,
    message: `${problem}. The gate used the version from ${ref}.`,
    location: { file },
    engine: { id: 'athena' },
  });
}

export interface PolicyFromOptions {
  signal?: AbortSignal;
}

/**
 * Resolve `ref`, read its policy state, and compare it (and inline suppressions) with
 * the working tree since merge-base(ref, HEAD). Throws PolicyError for an unsafe or
 * unknown ref, a missing merge base (shallow clone), or an invalid policy at the base.
 */
export async function checkPolicyFrom(root: string, ref: string, opts: PolicyFromOptions = {}): Promise<PolicyFromResult> {
  if (!isSafeRef(ref)) throw new PolicyError(`Invalid ref for --policy-from: ${ref.slice(0, 120)}`);
  const runOpts: GitRunOptions = { signal: opts.signal };
  const FETCH = 'Fetch the base branch with enough history (e.g. `git fetch --depth=200 origin main`, or `fetch-depth: 0` in actions/checkout).';
  const c = await gitText(root, ['rev-parse', '--verify', '-q', `${ref}^{commit}`], runOpts);
  if (!c.ok || !c.stdout.trim()) throw new PolicyError(`Can't read the policy from ${ref}: it is not a commit in this repository.`, FETCH);
  const commit = c.stdout.trim();
  const mb = await gitText(root, ['merge-base', commit, 'HEAD'], runOpts);
  if (!mb.ok || !mb.stdout.trim()) throw new PolicyError(`Can't compare with ${ref}: no common ancestor with HEAD (the clone may be shallow).`, FETCH);
  const mergeBase = mb.stdout.trim();

  const base = await readPolicyStateAt(root, commit, runOpts);
  const [rawMb, rawHead] = await Promise.all([rawAtCommit(root, mergeBase, runOpts), rawWorkingTree(root)]);

  const findings: Finding[] = [];
  const changes: PolicyFromResult['changes'] = { policy: [], baseline: [], triage: [] };
  // Compare merge-base → working tree, so only this change's edits count (not later edits on the base branch).
  const compare = <T>(file: string, mbText: string | null, headText: string | null, parse: (t: string) => T, fallback: T, diff: (b: T, h: T) => PolicyChange[]): PolicyChange[] => {
    if (mbText === headText) return [];
    let b: T;
    try {
      b = mbText === null ? fallback : parse(mbText);
    } catch {
      b = fallback; // invalid at the merge base: compare with defaults
    }
    let h: T;
    try {
      h = headText === null ? fallback : parse(headText);
    } catch (err) {
      findings.push(invalidHeadFinding(file, (err as Error).message, ref));
      return [];
    }
    let list = diff(b, h);
    if (!list.length) list = [{ key: 'edited', text: 'edited without an effective change', relaxes: false }];
    findings.push(weakenedFinding(file, list, ref));
    return list;
  };
  changes.policy = compare(POLICY_FILE, rawMb.policy, rawHead.policy, (t) => parsePolicy(t), DEFAULT_POLICY, comparePolicies);
  changes.baseline = compare<Baseline | null>(BASELINE_FILE, rawMb.baseline, rawHead.baseline, (t) => parseBaseline(t), null, compareBaselines);
  changes.triage = compare<Triage | null>(TRIAGE_FILE, rawMb.triage, rawHead.triage, (t) => parseTriage(t), null, compareTriage);

  const addedSuppressions = await suppressionsAddedSince(root, mergeBase, runOpts);
  const occ = occurrenceCounter();
  for (const s of addedSuppressions) {
    findings.push(
      Finding.parse({
        fingerprint: codeFingerprint({ ruleId: POLICY_WEAKENED, file: s.file, lineText: s.lineText, occurrence: occ(POLICY_WEAKENED, s.file, normalizeLine(s.lineText)) }),
        ruleId: POLICY_WEAKENED,
        category: 'review',
        severity: 'high',
        confidence: 'high',
        label: 'FACT',
        title: `Suppression added for ${s.ruleId}`,
        message: `An \`athena-ignore ${s.ruleId}\` comment was added in this change (reason: "${s.reason.slice(0, 200)}"). It hides a finding from the gate; a maintainer should confirm it.`,
        location: { file: s.file, startLine: s.line },
        engine: { id: 'athena' },
      }),
    );
  }
  return { ref, commit, mergeBase, base, changes, addedSuppressions, findings };
}

/** `athena-ignore` comments added between `mergeBase` and the working tree (tracked changes plus untracked files). */
async function suppressionsAddedSince(root: string, mergeBase: string, opts: GitRunOptions): Promise<AddedSuppression[]> {
  const d = await gitText(root, ['-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--relative', '--no-renames', '--no-prefix', mergeBase, '--', '.'], opts);
  if (!d.ok) throw new PolicyError(`Couldn't diff against the merge base: ${d.stderr.trim().split('\n').pop()?.slice(0, 200) ?? 'git diff failed'}`);
  const out = addedSuppressionsInDiff(d.stdout);
  const u = await gitText(root, ['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard', '-z', '--', '.'], opts);
  if (u.ok) {
    for (const file of u.stdout.split('\0').filter(Boolean).sort()) {
      const r = await readTextInsideRoot(root, file, DEFAULT_SUPPRESSION_MAX_BYTES);
      if (!r.ok) continue;
      for (const s of findSuppressions(r.text)) if (!s.problem) out.push({ file, line: s.line, ruleId: s.ruleId!, reason: s.reason!, lineText: s.lineText });
    }
  }
  return out;
}
