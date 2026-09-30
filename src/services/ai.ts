import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { loadConfig } from '../core/config.js';
import { readLocalConfig } from '../core/local-config.js';
import { KNOWLEDGE_DOCS } from '../core/knowledge/documents.js';
import { redact, scanText } from '../core/security/secrets.js';
import { athenaDir } from '../core/state/state.js';
import { readTextIfExists, writeFileAtomic } from '../core/util/fs.js';
import { AiConfig, AiError, type AIProvider, type Availability } from '../ai/provider.js';
import { getProvider, isRemote, PROVIDERS } from '../ai/providers.js';
import { AthenaError } from './errors.js';

export const SUGGESTIONS_FILE = 'ai-suggestions.md';

export type TrustedSource = 'env' | 'local' | 'user';

export interface AiStatus {
  configured: AiConfig;
  providers: Array<{ id: string; name: string; remote: boolean; defaultModel: string; keyEnvVar?: string; availability: Availability; selected: boolean }>;
  consent: boolean;
  /** Where consent was granted, when it was. */
  consentSource?: TrustedSource;
  /** Settings Athena ignored, and how to fix them. */
  warnings: string[];
}

const TrustedAi = z.object({ baseUrl: z.string().optional(), consent: z.boolean().optional() });

/**
 * The user-level config file: `$XDG_CONFIG_HOME/athena/config.json` (default
 * `~/.config/athena/config.json`), or `%APPDATA%\athena\config.json` on Windows.
 */
export function userConfigPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const base = env.APPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.win32.join(base, 'athena', 'config.json');
  }
  const base = env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
  return path.join(base, 'athena', 'config.json');
}

async function readUserAi(): Promise<z.infer<typeof TrustedAi>> {
  const text = await readTextIfExists(userConfigPath()).catch(() => null);
  if (!text) return {};
  try {
    const parsed = TrustedAi.safeParse((JSON.parse(text) as { ai?: unknown })?.ai ?? {});
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function envConsent(): boolean | undefined {
  const v = process.env.ATHENA_AI_CONSENT?.trim().toLowerCase();
  if (!v) return undefined;
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  return undefined;
}

function validBaseUrl(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? v.replace(/\/+$/, '') : undefined;
  } catch {
    return undefined;
  }
}

export const MOVE_AI_HINT =
  'Set ATHENA_AI_BASE_URL / ATHENA_AI_CONSENT=1, or put them under "ai" in .athena/local.json (gitignored) or ~/.config/athena/config.json.';

/** Warning when the committed config tries to set where data goes, or to grant consent. */
export async function committedAiWarning(root: string): Promise<string | undefined> {
  const { config } = await loadConfig(root);
  const ignored = [config.ai?.baseUrl !== undefined ? 'ai.baseUrl' : '', config.ai?.consent !== undefined ? 'ai.consent' : ''].filter(Boolean);
  if (!ignored.length) return undefined;
  return `Ignoring ${ignored.join(' and ')} in .athena/config.json: that file is committed, so anyone who can push to the repository could redirect your API key and knowledge. ${MOVE_AI_HINT}`;
}

export interface ResolvedAiConfig {
  config: AiConfig;
  consentSource?: TrustedSource;
  warnings: string[];
}

/**
 * AI settings. Provider, model, mode and maxChars may come from the committed
 * `.athena/config.json`; `baseUrl` and `consent` decide where the API key and project
 * knowledge are sent, so they are only honoured from machine-local sources:
 * environment (ATHENA_AI_BASE_URL, ATHENA_AI_CONSENT) > .athena/local.json > user config.
 */
export async function resolveAiConfig(root: string): Promise<ResolvedAiConfig> {
  const { config } = await loadConfig(root);
  const warnings: string[] = [];
  const committedWarning = await committedAiWarning(root);
  if (committedWarning) warnings.push(committedWarning);
  const { baseUrl: _ignoredUrl, consent: _ignoredConsent, ...committed } = config.ai ?? {};

  const local = (await readLocalConfig(root)).ai ?? {};
  const user = await readUserAi();

  let baseUrl: string | undefined;
  let baseUrlSource: TrustedSource | undefined;
  const candidates: Array<[TrustedSource, string | undefined, string]> = [
    ['env', process.env.ATHENA_AI_BASE_URL, 'ATHENA_AI_BASE_URL'],
    ['local', local.baseUrl, '.athena/local.json'],
    ['user', user.baseUrl, userConfigPath()],
  ];
  for (const [source, raw, where] of candidates) {
    if (!raw?.trim()) continue;
    const url = validBaseUrl(raw);
    if (!url) {
      warnings.push(`Ignoring the AI base URL from ${where}: it must be an http(s) URL.`);
      continue;
    }
    baseUrl = url;
    baseUrlSource = source;
    break;
  }

  let consent = false;
  let consentSource: TrustedSource | undefined;
  for (const [source, value] of [['env', envConsent()], ['local', local.consent], ['user', user.consent]] as Array<[TrustedSource, boolean | undefined]>) {
    if (value === undefined) continue;
    consent = value;
    consentSource = value ? source : undefined;
    break;
  }

  const cfg = AiConfig.parse({ ...committed, consent, ...(baseUrl ? { baseUrl, baseUrlSource } : {}) });
  return { config: cfg, consentSource, warnings };
}

export async function aiConfig(root: string): Promise<AiConfig> {
  return (await resolveAiConfig(root)).config;
}

export async function aiStatus(root: string): Promise<AiStatus> {
  const { config: cfg, consentSource, warnings } = await resolveAiConfig(root);
  const providers = [];
  for (const p of PROVIDERS) providers.push({ id: p.id, name: p.name, remote: isRemote(p, cfg), defaultModel: p.defaultModel, keyEnvVar: p.keyEnvVar, availability: await p.available(cfg), selected: p.id === cfg.provider });
  return { configured: cfg, providers, consent: cfg.consent, consentSource, warnings };
}

export interface EnrichPayload {
  /** Exactly what would be sent, after redaction. */
  content: string;
  chars: number;
  documents: string[];
  provider: AIProvider;
  endpoint: string;
  remote: boolean;
  model: string;
  /** Settings that were ignored (e.g. an untrusted baseUrl in the committed config). */
  warnings: string[];
}

/**
 * Build the payload for enrichment: knowledge documents only — never source code —
 * passed through the secret redactor, and capped by config.
 */
export async function buildEnrichPayload(root: string, opts: { docs?: string[] } = {}): Promise<EnrichPayload> {
  const { config: cfg, warnings } = await resolveAiConfig(root);
  const provider = getProvider(cfg.provider);
  const wanted = opts.docs?.length ? opts.docs : ['project', 'architecture', 'database', 'api'];
  const parts: string[] = [];
  const included: string[] = [];
  for (const id of wanted) {
    const doc = KNOWLEDGE_DOCS.find((d) => d.id === id);
    if (!doc) throw new AthenaError(`Unknown document: ${id}`, `Available: ${KNOWLEDGE_DOCS.map((d) => d.id).join(', ')}`);
    const text = await readTextIfExists(path.join(athenaDir(root), doc.file));
    if (!text) continue;
    included.push(doc.file);
    parts.push(`--- ${doc.file} ---\n${text.replace(/<!--[\s\S]*?-->/g, '').trim()}`);
  }
  if (!included.length) throw new AthenaError('No knowledge documents to send.', 'Run `athena init` first.', 3);

  let content = redact(parts.join('\n\n'));
  if (content.length > cfg.maxChars) content = `${content.slice(0, cfg.maxChars)}\n\n[truncated to ${cfg.maxChars} characters]`;
  // Defense in depth: never send content that still looks like it holds a secret.
  const leftover = scanText(content);
  if (leftover.length) throw new AthenaError('Refusing to send: the knowledge still contains values that look like secrets.', 'Fix them in .athena/*.md first.');

  const availability = await provider.available(cfg);
  return { content, chars: content.length, documents: included, provider, endpoint: availability.endpoint, remote: isRemote(provider, cfg), model: cfg.model ?? provider.defaultModel, warnings };
}

const SYSTEM = [
  'You help maintain a project knowledge base for AI coding agents.',
  'You will be given generated documentation about a software project.',
  'Suggest concise, high-value additions a developer might record: the project purpose, architectural decisions worth documenting, risky areas, and candidate project rules.',
  'Rules: never invent facts that are not supported by the provided material; where you are unsure, say what is unknown and what would confirm it; do not restate the documents; no code.',
  'Output GitHub-flavoured Markdown with these sections: "## Suggested project summary", "## Questions Athena could not answer", "## Candidate rules" (as a bullet list).',
].join(' ');

export interface EnrichResult {
  markdown: string;
  file: string;
  provider: string;
  model: string;
  chars: number;
  documents: string[];
}

/**
 * Ask the configured provider for suggestions and write them to a clearly-labelled,
 * gitignored file. Nothing is added to the knowledge base automatically: AI output
 * is INFERRED, and the developer decides what (if anything) to keep.
 */
export async function enrich(root: string, opts: { docs?: string[]; consent?: boolean; signal?: AbortSignal } = {}): Promise<EnrichResult> {
  const cfg = await aiConfig(root);
  const payload = await buildEnrichPayload(root, { docs: opts.docs });
  const availability = await payload.provider.available(cfg);
  if (!availability.ok) throw new AthenaError(`${payload.provider.name} is not available: ${availability.reason}`, payload.provider.keyEnvVar ? `Set ${payload.provider.keyEnvVar}, or choose another provider in .athena/config.json.` : undefined);
  if (payload.remote && !cfg.consent && !opts.consent) {
    throw new AthenaError(
      `Sending project knowledge to ${payload.endpoint} requires consent.`,
      'Re-run with `athena ai enrich --consent`, set ATHENA_AI_CONSENT=1, or set "ai": { "consent": true } in .athena/local.json (machine-local, gitignored). Use a local Ollama to keep everything on this machine.',
    );
  }

  let result;
  try {
    result = await payload.provider.complete(cfg, { system: SYSTEM, prompt: payload.content, maxTokens: 2000, signal: opts.signal });
  } catch (err) {
    if (err instanceof AiError) throw new AthenaError(err.message, err.hint);
    throw err;
  }
  const body = redact(result.text.trim());
  if (!body) throw new AthenaError('The provider returned an empty response.');

  const markdown = [
    '# AI suggestions (INFERRED — not project knowledge)',
    '',
    `> Generated ${new Date().toISOString()} by ${result.provider} (${result.model}) from ${payload.documents.join(', ')}.`,
    '>',
    '> **Status: INFERRED.** Nothing here was verified against the code. Move anything useful into a document\'s Developer Notes or `rules.md` yourself; Athena will not do it for you.',
    '',
    body,
    '',
  ].join('\n');
  const file = path.join(athenaDir(root), SUGGESTIONS_FILE);
  await writeFileAtomic(file, markdown);
  return { markdown, file: SUGGESTIONS_FILE, provider: result.provider, model: result.model, chars: payload.chars, documents: payload.documents };
}
