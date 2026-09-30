import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { analyzeProject, redactDeep } from '../core/analyzer/analyze.js';
import { REAL_ENV_NAMES } from '../core/analyzer/detectors/env.js';
import { loadConfig } from '../core/config.js';
import { athenaDir } from '../core/paths.js';
import { cacheRoot } from '../core/cache/facts-cache.js';
import { gitInfo, isGitRepo } from '../core/git/git.js';
import { IndexSnapshotError, snapshotReader, updateIndexSnapshot, type IndexSnapshot, type SnapshotManifest } from '../core/git/index-snapshot.js';
import { planKnowledge } from '../core/knowledge/generate.js';
import type { ProjectModel } from '../core/model/project-model.js';
import { readLocalConfig } from '../core/local-config.js';
import { SCAN_FILE } from '../core/model/security-scan.js';
import { readFileIndex, readState } from '../core/state/state.js';
import { readTextIfExists, writeFileAtomic } from '../core/util/fs.js';
import { AthenaError, EXIT } from './errors.js';
import { HISTORY_SECTIONS } from './sync.js';

/**
 * `athena sync --check --staged`: is the knowledge in the index (`.athena/*.md` as
 * staged) what Athena would generate from the code in the index?
 *
 * The index is mirrored into `.athena/cache/staged/tree/` (see index-snapshot.ts:
 * files that match the working tree are sparse placeholders whose hashes and
 * facts come from the last analysis and the facts cache, so only staged changes
 * are read) and analyzed there. The tree and its manifest are kept between runs
 * and updated incrementally. Untracked files and unstaged edits are invisible to
 * the check, as they are to the commit — except local env files (a `.env` that isn't
 * committed): staged knowledge written with or without them is accepted.
 * Git-history sections (hotspots) are ignored, as with `sync --check`.
 */

export interface StagedDocument {
  file: string;
  /** `missing`: the document is not in the index. */
  status: 'missing' | 'outdated';
  changedSections: string[];
  /** The working-tree copy already has the expected content: it only needs `git add`. */
  syncedButUnstaged: boolean;
}

export interface StagedCheckResult {
  inSync: boolean;
  stale: StagedDocument[];
  /** Index entries analyzed, and how many had their content read from Git objects. */
  files: number;
  fromIndex: number;
  durationMs: number;
}

const STAGED_DIR = 'staged';
const MANIFEST_VERSION = 1;
const STALE_MS = 60 * 60 * 1000;

interface ManifestFile {
  v: number;
  root: string;
  entries: SnapshotManifest;
}

async function readManifest(file: string, root: string): Promise<SnapshotManifest | null> {
  try {
    const m = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<ManifestFile>;
    return m.v === MANIFEST_VERSION && m.root === root && m.entries && typeof m.entries === 'object' ? m.entries : null;
  } catch {
    return null;
  }
}

/** Exclusive lock on the persistent tree; null when another check holds it. */
async function lock(file: string): Promise<(() => Promise<void>) | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await fs.open(file, 'wx');
      await fh.writeFile(String(process.pid));
      await fh.close();
      return () => fs.rm(file, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      const [pid, st] = await Promise.all([fs.readFile(file, 'utf8').catch(() => ''), fs.stat(file).catch(() => null)]);
      let alive = Date.now() - (st?.mtimeMs ?? 0) < STALE_MS;
      try {
        if (alive && Number(pid) > 0) process.kill(Number(pid), 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
      }
      if (alive) return null;
      await fs.rm(file, { force: true }); // left behind by a process that no longer runs
    }
  }
  return null;
}

async function linkOrCopy(src: string, dst: string): Promise<void> {
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.link(src, dst).catch(() => fs.copyFile(src, dst));
}

/**
 * Local inputs of the analysis that are never committed: the facts cache (hard links;
 * the analyzer replaces shard files atomically, so the originals are never modified),
 * the last security scan (rendered into security.md) and Git's exclude rules.
 */
async function addLocalInputs(root: string, snapRoot: string, snap: IndexSnapshot): Promise<void> {
  const dir = athenaDir(root);
  const snapAthena = athenaDir(snapRoot);
  await fs.rm(path.join(snapRoot, '.git'), { recursive: true, force: true });
  await Promise.all(REAL_ENV_NAMES.filter((n) => !snap.manifest[n]).map((n) => fs.rm(path.join(snapRoot, n), { force: true, recursive: true })));
  // Facts: the project's shard files, linked; links from the previous run that still point at them are kept.
  const facts = path.join(cacheRoot(dir), 'facts');
  const snapFacts = path.join(cacheRoot(snapAthena), 'facts');
  const [names, old] = await Promise.all([fs.readdir(facts).catch(() => [] as string[]), fs.readdir(snapFacts).catch(() => [] as string[])]);
  const keep = new Set(names);
  await Promise.all(old.filter((n) => !keep.has(n)).map((n) => fs.rm(path.join(snapFacts, n), { force: true, recursive: true })));
  await Promise.all(
    names.map(async (n) => {
      const [a, b] = await Promise.all([fs.stat(path.join(facts, n)).catch(() => null), fs.stat(path.join(snapFacts, n)).catch(() => null)]);
      if (!a?.isFile() || (b && a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.mtimeMs === b.mtimeMs)) return;
      await fs.rm(path.join(snapFacts, n), { force: true, recursive: true });
      await linkOrCopy(path.join(facts, n), path.join(snapFacts, n)).catch(() => {});
    }),
  );
  if (!snap.manifest[`.athena/${SCAN_FILE}`]) {
    await fs.rm(path.join(snapAthena, SCAN_FILE), { force: true });
    await linkOrCopy(path.join(dir, SCAN_FILE), path.join(snapAthena, SCAN_FILE)).catch(() => {});
  }
  const exclude = await readTextIfExists(path.join(root, '.git', 'info', 'exclude')).catch(() => null);
  if (exclude) {
    await fs.mkdir(path.join(snapRoot, '.git', 'info'), { recursive: true });
    await fs.writeFile(path.join(snapRoot, '.git', 'info', 'exclude'), exclude);
  }
}

/** Local env files (e.g. a gitignored `.env`) that exist in the working tree but are not in the index. */
async function untrackedEnvFiles(root: string, snap: IndexSnapshot): Promise<string[]> {
  const out: string[] = [];
  for (const name of REAL_ENV_NAMES) {
    if (!snap.manifest[name] && (await fs.stat(path.join(root, name)).then((s) => s.isFile(), () => false))) out.push(name);
  }
  return out;
}

async function removeStale(parent: string): Promise<void> {
  const names = await fs.readdir(parent).catch(() => [] as string[]);
  await Promise.all(
    names
      .filter((n) => n.startsWith('tmp-'))
      .map(async (n) => {
        const st = await fs.stat(path.join(parent, n)).catch(() => null);
        if (st && Date.now() - st.mtimeMs > STALE_MS) await fs.rm(path.join(parent, n), { recursive: true, force: true }).catch(() => {});
      }),
  );
}

export async function checkStaged(rootInput: string, opts: { signal?: AbortSignal } = {}): Promise<StagedCheckResult> {
  const started = Date.now();
  const { signal } = opts;
  const root = await fs.realpath(rootInput);
  const dir = athenaDir(root);
  const st = await readState(dir);
  if (st.kind === 'missing' && !(await readTextIfExists(path.join(dir, 'rules.md')))) {
    throw new AthenaError('Athena is not initialized in this project.', 'Run `athena init` first.', EXIT.NOT_INITIALIZED);
  }
  if (!(await isGitRepo(root, { signal }))) throw new AthenaError('`--staged` needs a Git repository.', 'Use `athena sync --check` outside Git.', EXIT.NOT_AVAILABLE);

  const parent = path.join(cacheRoot(dir), '..', STAGED_DIR);
  await fs.mkdir(parent, { recursive: true });
  // Ignored by Git on its own, even where `.athena/.gitignore` predates the `cache/` entry.
  const ignoreFile = path.join(parent, '.gitignore');
  if ((await readTextIfExists(ignoreFile)) !== '*\n') await fs.writeFile(ignoreFile, '*\n');
  await removeStale(parent);
  const manifestFile = path.join(parent, 'manifest.json');
  const unlock = await lock(path.join(parent, 'lock'));
  // Another check is running: build a throwaway tree instead of waiting.
  const base = unlock ? path.join(parent, 'tree') : path.join(parent, `tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  // Same base name as the project: the model's default name comes from the directory.
  const snapRoot = path.join(base, path.basename(root));
  try {
    const history = gitInfo(root, { signal });
    history.catch(() => {});
    const { config } = await loadConfig(root);
    let previous = unlock ? await readManifest(manifestFile, root) : null;
    if (!previous) await fs.rm(base, { recursive: true, force: true });
    await fs.rm(manifestFile, { force: true }); // an interrupted update must not be trusted next time
    await fs.mkdir(snapRoot, { recursive: true });

    let snap: IndexSnapshot;
    try {
      snap = await updateIndexSnapshot(root, snapRoot, { maxFileBytes: config.maxFileBytes, previous, signal });
      // The staged config may change the size cap: blobs are sized against the one the analysis uses.
      const staged = await loadConfig(snapRoot);
      if (staged.config.maxFileBytes !== config.maxFileBytes) {
        previous = snap.manifest;
        snap = await updateIndexSnapshot(root, snapRoot, { maxFileBytes: staged.config.maxFileBytes, previous, signal });
      }
    } catch (err) {
      if (err instanceof IndexSnapshotError) throw new AthenaError(`Cannot read the staged files: ${err.message}.`, 'Resolve it (for example, finish the merge), or check the working tree with `athena sync --check`.', EXIT.NOT_AVAILABLE);
      throw err;
    }
    if (unlock) await writeFileAtomic(manifestFile, JSON.stringify({ v: MANIFEST_VERSION, root, entries: snap.manifest } satisfies ManifestFile));
    if (!Object.keys(snap.manifest).some((p) => p.startsWith('.athena/'))) {
      throw new AthenaError('No Athena knowledge is staged or committed (.athena/ is not in the index).', 'Commit .athena/ to check knowledge before commits.', EXIT.NOT_INITIALIZED);
    }
    await addLocalInputs(root, snapRoot, snap);

    // Placeholders share size and mtime with the working tree, so the last analysis's hashes apply to them.
    const prevIndex = await readFileIndex(dir);
    const reuse: typeof prevIndex = {};
    for (const p of snap.placeholders) if (prevIndex[p]) reuse[p] = prevIndex[p]!;
    const salt = (await readLocalConfig(root)).salt;
    const reader = snapshotReader(await fs.realpath(snapRoot), root, snap.placeholders);
    const analyze = async (): Promise<ProjectModel> => {
      const analysis = await analyzeProject(snapRoot, { signal, reuse, fingerprintSalt: salt, readFile: reader });
      return { ...analysis.model, root, git: redactDeep(await history) };
    };

    const prevState = st.kind === 'ok' ? st.state : null;
    const previousBlocks = prevState ? Object.fromEntries(Object.entries(prevState.documents).map(([k, v]) => [k, v.blocks])) : undefined;
    const staleDocs = async (model: ProjectModel): Promise<StagedDocument[]> => {
      const out: StagedDocument[] = [];
      for (const p of await planKnowledge(athenaDir(snapRoot), model, { previousBlocks })) {
        if (p.status === 'unchanged') continue;
        if (p.status === 'updated' && p.changedBlocks.length && p.changedBlocks.every((b) => HISTORY_SECTIONS.has(b))) continue;
        const worktree = await readTextIfExists(path.join(dir, p.file));
        out.push({ file: p.file, status: p.status === 'created' ? 'missing' : 'outdated', changedSections: p.changedBlocks, syncedButUnstaged: worktree === p.after });
      }
      return out;
    };
    const model = await analyze();
    let stale = await staleDocs(model);

    // Local env files (a `.env` that isn't committed) are machine-local. The knowledge
    // notes which exist, and `athena sync` analyzes them like any file unless they are
    // gitignored. Accept staged knowledge written with or without them: first any subset
    // listed as present, then (rarely needed, one more mostly cached analysis) with their
    // content, which is what `athena sync` here writes and what is reported otherwise.
    const localEnv = await untrackedEnvFiles(root, snap);
    if (stale.length && localEnv.length) {
      const withEnv = (names: string[]): ProjectModel => ({ ...model, env: { ...model.env, envFilesPresent: [...new Set([...model.env.envFilesPresent, ...names])].sort() } });
      const all = (1 << localEnv.length) - 1;
      const masks = localEnv.length <= 3 ? Array.from({ length: all }, (_, i) => i + 1).reverse() : [all];
      for (const mask of masks) {
        if (!(await staleDocs(withEnv(localEnv.filter((_, i) => mask & (1 << i))))).length) {
          stale = [];
          break;
        }
      }
      if (stale.length) {
        await Promise.all(localEnv.map((n) => linkOrCopy(path.join(root, n), path.join(snapRoot, n))));
        try {
          stale = await staleDocs(await analyze());
        } finally {
          await Promise.all(localEnv.map((n) => fs.rm(path.join(snapRoot, n), { force: true })));
        }
      }
    }
    return { inSync: stale.length === 0, stale, files: snap.entries, fromIndex: snap.fromIndex, durationMs: Date.now() - started };
  } finally {
    if (unlock) await unlock();
    else await fs.rm(base, { recursive: true, force: true }).catch(() => {});
  }
}
