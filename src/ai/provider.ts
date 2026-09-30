import { z } from 'zod';

/**
 * Provider abstraction. Athena never requires AI: analysis, sync, context and MCP
 * are all deterministic. AI is opt-in enrichment, and anything it produces is
 * labelled INFERRED and reviewed by the developer before it becomes knowledge.
 */

export const AiConfig = z.object({
  provider: z.enum(['anthropic', 'openai', 'google', 'ollama']).default('anthropic'),
  model: z.string().optional(),
  /** cloud: a hosted API · local: a model on this machine (Ollama). */
  mode: z.enum(['cloud', 'local']).default('cloud'),
  /** Must be true (or --consent passed) before any project content leaves the machine. */
  consent: z.boolean().default(false),
  /** Upper bound on characters of knowledge sent in one request. */
  maxChars: z.number().int().min(500).max(200_000).default(24_000),
  /**
   * Ollama base URL, or a custom compatible endpoint. Only ever set from a trusted,
   * machine-local source (see resolveAiConfig in src/services/ai.ts) — never from the
   * committed .athena/config.json, which anyone with push access controls.
   */
  baseUrl: z.string().optional(),
  /** Where baseUrl came from. Providers refuse a baseUrl without a trusted source. */
  baseUrlSource: z.enum(['env', 'local', 'user']).optional(),
});
export type AiConfig = z.infer<typeof AiConfig>;

export interface CompletionRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface CompletionResult {
  text: string;
  model: string;
  provider: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface Availability {
  ok: boolean;
  /** Why the provider cannot be used (missing key, unreachable host…). */
  reason?: string;
  /** Where data would be sent. "local" for on-device models. */
  endpoint: string;
  keyEnvVar?: string;
}

export interface AIProvider {
  id: AiConfig['provider'];
  name: string;
  /** True when project content would leave this machine. */
  remote: boolean;
  defaultModel: string;
  keyEnvVar?: string;
  available(config: AiConfig): Promise<Availability>;
  complete(config: AiConfig, req: CompletionRequest): Promise<CompletionResult>;
}

export class AiError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || host === '127.0.0.1';
  } catch {
    return false;
  }
}

/**
 * The endpoint a provider talks to: its default, or a baseUrl that came from a trusted
 * machine-local source. API keys are only ever sent to the result of this function.
 */
export function providerBase(config: AiConfig, fallback: string): string {
  if (!config.baseUrl) return fallback;
  if (!config.baseUrlSource) {
    throw new AiError('Refusing to use an AI base URL that did not come from a trusted source.', 'Set ATHENA_AI_BASE_URL, or "ai.baseUrl" in .athena/local.json or your user config.');
  }
  return config.baseUrl.replace(/\/+$/, '');
}

export async function postJson(url: string, body: unknown, headers: Record<string, string>, req: CompletionRequest): Promise<Record<string, unknown>> {
  const timeout = AbortSignal.timeout(req.timeoutMs ?? 120_000);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  } catch (err) {
    throw new AiError(`Could not reach ${new URL(url).host}: ${(err as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    const detail = text.slice(0, 300);
    throw new AiError(`${new URL(url).host} returned ${res.status}`, detail || undefined);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new AiError('Provider returned a non-JSON response');
  }
}

export function envKey(name: string | undefined): string | undefined {
  return name ? process.env[name]?.trim() || undefined : undefined;
}
