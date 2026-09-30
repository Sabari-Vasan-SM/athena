import crypto from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { ATHENA_DIR } from './config.js';
import { readTextIfExists, writeFileAtomic } from './util/fs.js';

/**
 * `.athena/local.json` — machine-local settings that must never be committed.
 *
 * `.athena/config.json` is committed, so anyone who can push to the repo controls
 * it. Settings that decide where data (or API keys) are sent, or that hold
 * per-machine secrets, therefore live here instead. The file is listed in
 * `.athena/.gitignore`.
 */
export const LOCAL_CONFIG_FILE = 'local.json';

export const LocalConfig = z
  .object({
    /** Random per-machine salt for keyed fingerprints of secret findings. Never leaves this machine. */
    salt: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    /** AI settings trusted only from machine-local sources (see src/services/ai.ts). */
    ai: z
      .object({
        baseUrl: z.string().optional(),
        consent: z.boolean().optional(),
      })
      .optional(),
  })
  .passthrough();
export type LocalConfig = z.infer<typeof LocalConfig>;

function localPath(root: string): string {
  return path.join(root, ATHENA_DIR, LOCAL_CONFIG_FILE);
}

/** Read `.athena/local.json`. Missing or malformed files yield `{}` (never throws on content). */
export async function readLocalConfig(root: string): Promise<LocalConfig> {
  const text = await readTextIfExists(localPath(root)).catch(() => null);
  if (text === null) return {};
  try {
    const parsed = LocalConfig.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export async function writeLocalConfig(root: string, cfg: LocalConfig): Promise<void> {
  // Make sure Git ignores this file before it exists, even in projects set up by older versions.
  const ignoreFile = path.join(root, ATHENA_DIR, '.gitignore');
  const ignore = await readTextIfExists(ignoreFile);
  if (!ignore?.split(/\r?\n/).includes(LOCAL_CONFIG_FILE)) {
    await writeFileAtomic(ignoreFile, `${(ignore ?? '').replace(/\s*$/, '')}${ignore ? '\n' : ''}${LOCAL_CONFIG_FILE}\n`);
  }
  await writeFileAtomic(localPath(root), `${JSON.stringify(cfg, null, 2)}\n`);
}

/** The per-machine salt, created on first use. */
export async function getOrCreateSalt(root: string): Promise<string> {
  const cfg = await readLocalConfig(root);
  if (cfg.salt) return cfg.salt;
  const salt = crypto.randomBytes(32).toString('hex');
  await writeLocalConfig(root, { ...cfg, salt });
  return salt;
}

/** Keyed fingerprint: an HMAC, so a published fingerprint can't be used to confirm guessed values offline. */
export function keyedFingerprint(salt: string, value: string, length = 16): string {
  return crypto.createHmac('sha256', salt).update(value).digest('hex').slice(0, length);
}
