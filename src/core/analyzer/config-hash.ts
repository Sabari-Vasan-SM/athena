import crypto from 'node:crypto';
import type { AthenaConfig } from '../config.js';

/** Hash of the config options facts depend on (what gets indexed and read). */
export function factsConfigHash(config: AthenaConfig): string {
  return crypto.createHash('sha256').update(JSON.stringify({ ignore: config.ignore, include: config.include, maxFileBytes: config.maxFileBytes })).digest('hex').slice(0, 16);
}
