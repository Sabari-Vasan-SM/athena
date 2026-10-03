import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Detector, FactDef, FactRuntime } from '../context.js';
import type { FileEntry } from '../../fs/walker.js';
import type { SecretFinding } from '../../model/project-model.js';
import { ephemeralFingerprint, scanText, type ScanStats, type SecretMatch } from '../../security/secrets.js';
import { getOrCreateSalt, keyedFingerprint, readLocalConfig } from '../../local-config.js';
import { ATHENA_DIR } from '../../config.js';

const SKIP = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock|poetry\.lock|uv\.lock|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock|pubspec\.lock)$|\.(min\.js|map|svg|snap)$/;
export const MAX_SECRET_FINDINGS = 500;

/**
 * Fingerprint function for stored secret findings: an HMAC keyed with the
 * machine-local salt in `.athena/local.json` (gitignored). The salt is only
 * created when `.athena/` already exists — analysis must not create the directory
 * (a fresh init builds it elsewhere and swaps it in). Otherwise a random
 * per-process key is used. Never an unsalted hash of the value.
 */
export async function secretFingerprinter(root: string): Promise<(value: string) => string> {
  return (await secretFingerprintKey(root)).fingerprint;
}

/**
 * The fingerprint function plus an id for its key (a hash of the salt, so cached
 * findings are only reused under the same key). `salt` overrides the project's
 * salt (a fresh init creates it before `.athena/` exists). The id is null for the
 * ephemeral per-process key: such findings are never persisted.
 */
export async function secretFingerprintKey(root: string, saltOverride?: string): Promise<FactRuntime> {
  try {
    let salt = saltOverride;
    if (!salt) salt = (await readLocalConfig(root)).salt;
    if (!salt) {
      const hasDir = await fs.stat(path.join(root, ATHENA_DIR)).then((s) => s.isDirectory(), () => false);
      if (hasDir) salt = await getOrCreateSalt(root);
    }
    if (salt) {
      const key = salt;
      return { fingerprint: (value) => keyedFingerprint(key, value), fingerprintKeyId: crypto.createHash('sha256').update(`athena-fingerprint-key:${key}`).digest('hex').slice(0, 12) };
    }
  } catch {
    /* fall back to an ephemeral key */
  }
  return { fingerprint: ephemeralFingerprint, fingerprintKeyId: null };
}

export interface SecretScanResult {
  findings: SecretFinding[];
  truncated: boolean;
  skippedLongLines: number;
  /** What the scan covered: files read, and files not read by reason. */
  files: { scanned: number; binary: number; tooLarge: number; minified: number; excluded: number; unreadable: number };
}

const MINIFIED = /\.(min\.js|map)$/;

/** Scan project files for likely credentials. Shared by the analyzer and `athena security`. */
export async function scanFilesForSecrets(
  files: FileEntry[],
  read: (rel: string) => Promise<string | null>,
  opts: {
    fingerprint: (value: string) => string;
    signal?: AbortSignal;
    max?: number;
    into?: SecretFinding[];
    /**
     * Called for each file with matches, with the file's text and the match offsets, so
     * a caller can locate and mask the matched span. Never store `text` or the values.
     */
    onFile?: (file: string, text: string, matches: SecretMatch[]) => void;
  },
): Promise<SecretScanResult> {
  const findings = opts.into ?? [];
  const max = opts.max ?? MAX_SECRET_FINDINGS;
  const stats: ScanStats = { skippedLongLines: 0 };
  const counts: SecretScanResult['files'] = { scanned: 0, binary: 0, tooLarge: 0, minified: 0, excluded: 0, unreadable: 0 };
  let truncated = false;
  for (const f of files) {
    if (f.binary) counts.binary++;
    else if (f.large) counts.tooLarge++;
    else if (SKIP.test(f.path)) {
      if (MINIFIED.test(f.path)) counts.minified++;
      else counts.excluded++;
    }
    if (f.binary || f.large || SKIP.test(f.path)) continue;
    if (findings.length >= max) {
      truncated = true;
      break;
    }
    opts.signal?.throwIfAborted();
    const text = await read(f.path);
    if (text === null) counts.unreadable++;
    else counts.scanned++;
    if (!text) continue;
    const matches = scanText(text, { fingerprint: opts.fingerprint, stats });
    for (const m of matches) findings.push({ type: m.type, file: f.path, line: m.line, fingerprint: m.fingerprint });
    if (matches.length) opts.onFile?.(f.path, text, matches);
  }
  return { findings, truncated, skippedLongLines: stats.skippedLongLines, files: counts };
}

/** Findings in one file: [type, line, keyed fingerprint]. Keyed by the fingerprint key. */
const secretsFact: FactDef<Array<[string, number, string]>> = {
  id: 'secrets',
  keyed: true,
  applies: (f) => !f.binary && !f.large && !SKIP.test(f.path),
  compute(text, _rel, rt) {
    if (!text) return [];
    return scanText(text, { fingerprint: rt.fingerprint }).map((m) => [m.type, m.line, m.fingerprint]);
  },
};

/**
 * Scans indexed text files for likely credentials. Only type, location and a keyed
 * fingerprint are recorded — never the value or a plain hash of it.
 */
export const secretsDetector: Detector = {
  id: 'secrets',
  version: 2,
  facts: [secretsFact],
  async run(ctx) {
    // Same traversal and cap as scanFilesForSecrets, from cached per-file findings.
    const findings = ctx.model.security.secrets;
    let truncated = false;
    for (const f of ctx.files) {
      if (f.binary || f.large || SKIP.test(f.path)) continue;
      if (findings.length >= MAX_SECRET_FINDINGS) {
        truncated = true;
        break;
      }
      ctx.signal?.throwIfAborted();
      const rows = await ctx.fact(f.path, secretsFact);
      if (!rows) continue;
      for (const [type, line, fingerprint] of rows) findings.push({ type, file: f.path, line, fingerprint });
    }
    if (truncated) ctx.warn(`Secret scan stopped after ${MAX_SECRET_FINDINGS} findings.`);
  },
};
