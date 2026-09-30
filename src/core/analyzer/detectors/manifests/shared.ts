import type { Command, Manifest } from '../../../model/project-model.js';

/** Helpers and types shared by the per-ecosystem manifest parsers. */

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const keys = (v: unknown): string[] => (isObj(v) ? Object.keys(v) : []);

export interface Parsed {
  manifest: Manifest;
  workspaceGlobs?: string[];
  workspaceTool?: string;
  commands?: Command[];
}

export type Warn = (message: string) => void;
export type Parser = (text: string, p: string, warn: Warn) => Parsed | null;

export function commandPurpose(name: string, cmd: string): Command['purpose'] {
  const n = name.toLowerCase();
  if (/^(dev|develop|serve|watch)(:|$)/.test(n)) return 'dev';
  if (/^build(:|$)/.test(n)) return 'build';
  if (/^(test|e2e|spec|coverage)(:|$)/.test(n) || /\b(jest|vitest|pytest|playwright|cypress)\b/.test(cmd)) return 'test';
  if (/^lint(:|$)|typecheck|type-check/.test(n)) return 'lint';
  if (/^(format|fmt|prettier)(:|$)/.test(n)) return 'format';
  if (/^start(:|$)/.test(n)) return 'start';
  if (/migrat|db:/.test(n)) return 'migrate';
  if (/deploy|release|publish/.test(n)) return 'deploy';
  return 'other';
}
