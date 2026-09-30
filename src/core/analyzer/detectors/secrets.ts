import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Detector } from '../context.js';
import type { FileEntry } from '../../fs/walker.js';
import type { SecretFinding } from '../../model/project-model.js';
import { ephemeralFingerprint, scanText, type ScanStats } from '../../security/secrets.js';
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
  try {
    const existing = (await readLocalConfig(root)).salt;
    let salt = existing;
    if (!salt) {
      const hasDir = await fs.stat(path.join(root, ATHENA_DIR)).then((s) => s.isDirectory(), () => false);
      if (hasDir) salt = await getOrCreateSalt(root);
    }
    if (salt) {
      const key = salt;
      return (value) => keyedFingerprint(key, value);
    }
  } catch {
    /* fall back to an ephemeral key */
  }
  return ephemeralFingerprint;
}

export interface SecretScanResult {
  findings: SecretFinding[];
  truncated: boolean;
  skippedLongLines: number;
}

/** Scan project files for likely credentials. Shared by the analyzer and `athena security`. */
export async function scanFilesForSecrets(
  files: FileEntry[],
  read: (rel: string) => Promise<string | null>,
  opts: { fingerprint: (value: string) => string; signal?: AbortSignal; max?: number; into?: SecretFinding[] },
): Promise<SecretScanResult> {
  const findings = opts.into ?? [];
  const max = opts.max ?? MAX_SECRET_FINDINGS;
  const stats: ScanStats = { skippedLongLines: 0 };
  let truncated = false;
  for (const f of files) {
    if (f.binary || f.large || SKIP.test(f.path)) continue;
    if (findings.length >= max) {
      truncated = true;
      break;
    }
    opts.signal?.throwIfAborted();
    const text = await read(f.path);
    if (!text) continue;
    for (const m of scanText(text, { fingerprint: opts.fingerprint, stats })) findings.push({ type: m.type, file: f.path, line: m.line, fingerprint: m.fingerprint });
  }
  return { findings, truncated, skippedLongLines: stats.skippedLongLines };
}

/**
 * Scans indexed text files for likely credentials. Only type, location and a keyed
 * fingerprint are recorded — never the value or a plain hash of it.
 */
export const secretsDetector: Detector = {
  id: 'secrets',
  version: 2,
  async run(ctx) {
    const fingerprint = await secretFingerprinter(ctx.root);
    const r = await scanFilesForSecrets(ctx.files, (rel) => ctx.read(rel), { fingerprint, signal: ctx.signal, into: ctx.model.security.secrets });
    if (r.truncated) ctx.warn(`Secret scan stopped after ${MAX_SECRET_FINDINGS} findings.`);
  },
};
