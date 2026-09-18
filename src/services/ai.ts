import path from 'node:path';
import { loadConfig } from '../core/config.js';
import { KNOWLEDGE_DOCS } from '../core/knowledge/documents.js';
import { redact, scanText } from '../core/security/secrets.js';
import { athenaDir } from '../core/state/state.js';
import { readTextIfExists, writeFileAtomic } from '../core/util/fs.js';
import { AiConfig, AiError, type AIProvider, type Availability } from '../ai/provider.js';
import { getProvider, PROVIDERS } from '../ai/providers.js';
import { AthenaError } from './errors.js';

export const SUGGESTIONS_FILE = 'ai-suggestions.md';

export interface AiStatus {
  configured: AiConfig;
  providers: Array<{ id: string; name: string; remote: boolean; defaultModel: string; keyEnvVar?: string; availability: Availability; selected: boolean }>;
  consent: boolean;
}

export async function aiConfig(root: string): Promise<AiConfig> {
  const { config } = await loadConfig(root);
  return AiConfig.parse(config.ai ?? {});
}

export async function aiStatus(root: string): Promise<AiStatus> {
  const cfg = await aiConfig(root);
  const providers = [];
  for (const p of PROVIDERS) providers.push({ id: p.id, name: p.name, remote: p.remote, defaultModel: p.defaultModel, keyEnvVar: p.keyEnvVar, availability: await p.available(cfg), selected: p.id === cfg.provider });
  return { configured: cfg, providers, consent: cfg.consent };
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
}

/**
 * Build the payload for enrichment: knowledge documents only — never source code —
 * passed through the secret redactor, and capped by config.
 */
export async function buildEnrichPayload(root: string, opts: { docs?: string[] } = {}): Promise<EnrichPayload> {
  const cfg = await aiConfig(root);
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
  return { content, chars: content.length, documents: included, provider, endpoint: availability.endpoint, remote: provider.remote, model: cfg.model ?? provider.defaultModel };
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
      'Re-run with --consent, or set "ai": { "consent": true } in .athena/config.json. Use the ollama provider to keep everything local.',
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
