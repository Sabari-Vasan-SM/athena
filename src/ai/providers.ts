import { AiError, envKey, isLoopbackUrl, postJson, providerBase, type AIProvider, type AiConfig, type Availability, type CompletionRequest, type CompletionResult } from './provider.js';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function keyAvailability(provider: AIProvider, endpoint: string): Availability {
  const key = envKey(provider.keyEnvVar);
  return key ? { ok: true, endpoint, keyEnvVar: provider.keyEnvVar } : { ok: false, reason: `${provider.keyEnvVar} is not set`, endpoint, keyEnvVar: provider.keyEnvVar };
}

export const anthropicProvider: AIProvider = {
  id: 'anthropic',
  name: 'Anthropic (Claude)',
  remote: true,
  defaultModel: 'claude-sonnet-5',
  keyEnvVar: 'ANTHROPIC_API_KEY',
  async available(config) {
    return keyAvailability(anthropicProvider, providerBase(config, 'https://api.anthropic.com'));
  },
  async complete(config, req) {
    const key = envKey(anthropicProvider.keyEnvVar);
    if (!key) throw new AiError('ANTHROPIC_API_KEY is not set');
    const model = config.model ?? anthropicProvider.defaultModel;
    const json = await postJson(
      `${providerBase(config, 'https://api.anthropic.com')}/v1/messages`,
      { model, max_tokens: req.maxTokens ?? 2000, system: req.system, messages: [{ role: 'user', content: req.prompt }] },
      { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      req,
    );
    const content = Array.isArray(json.content) ? json.content : [];
    const text = content.map((c) => (c && typeof c === 'object' ? str((c as Record<string, unknown>).text) : '')).join('');
    const usage = (json.usage ?? {}) as Record<string, number>;
    return { text, model: str(json.model) || model, provider: 'anthropic', usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } };
  },
};

export const openaiProvider: AIProvider = {
  id: 'openai',
  name: 'OpenAI',
  remote: true,
  defaultModel: 'gpt-4.1-mini',
  keyEnvVar: 'OPENAI_API_KEY',
  async available(config) {
    return keyAvailability(openaiProvider, providerBase(config, 'https://api.openai.com'));
  },
  async complete(config, req) {
    const key = envKey(openaiProvider.keyEnvVar);
    if (!key) throw new AiError('OPENAI_API_KEY is not set');
    const model = config.model ?? openaiProvider.defaultModel;
    const json = await postJson(
      `${providerBase(config, 'https://api.openai.com')}/v1/chat/completions`,
      { model, max_completion_tokens: req.maxTokens ?? 2000, messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.prompt }] },
      { authorization: `Bearer ${key}` },
      req,
    );
    const choices = Array.isArray(json.choices) ? json.choices : [];
    const first = (choices[0] ?? {}) as Record<string, unknown>;
    const message = (first.message ?? {}) as Record<string, unknown>;
    const usage = (json.usage ?? {}) as Record<string, number>;
    return { text: str(message.content), model: str(json.model) || model, provider: 'openai', usage: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens } };
  },
};

export const googleProvider: AIProvider = {
  id: 'google',
  name: 'Google (Gemini)',
  remote: true,
  defaultModel: 'gemini-2.5-flash',
  keyEnvVar: 'GEMINI_API_KEY',
  async available(config) {
    const key = envKey('GEMINI_API_KEY') ?? envKey('GOOGLE_API_KEY');
    const endpoint = providerBase(config, 'https://generativelanguage.googleapis.com');
    return key ? { ok: true, endpoint, keyEnvVar: 'GEMINI_API_KEY' } : { ok: false, reason: 'GEMINI_API_KEY (or GOOGLE_API_KEY) is not set', endpoint, keyEnvVar: 'GEMINI_API_KEY' };
  },
  async complete(config, req) {
    const key = envKey('GEMINI_API_KEY') ?? envKey('GOOGLE_API_KEY');
    if (!key) throw new AiError('GEMINI_API_KEY is not set');
    const model = config.model ?? googleProvider.defaultModel;
    const json = await postJson(
      `${providerBase(config, 'https://generativelanguage.googleapis.com')}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      { systemInstruction: { parts: [{ text: req.system }] }, contents: [{ role: 'user', parts: [{ text: req.prompt }] }], generationConfig: { maxOutputTokens: req.maxTokens ?? 2000 } },
      { 'x-goog-api-key': key },
      req,
    );
    const candidates = Array.isArray(json.candidates) ? json.candidates : [];
    const parts = ((candidates[0] as Record<string, unknown> | undefined)?.content as Record<string, unknown> | undefined)?.parts;
    const text = Array.isArray(parts) ? parts.map((p) => str((p as Record<string, unknown>).text)).join('') : '';
    return { text, model, provider: 'google' };
  },
};

export const ollamaProvider: AIProvider = {
  id: 'ollama',
  name: 'Ollama (local)',
  remote: false,
  defaultModel: 'llama3.1',
  async available(config) {
    const endpoint = ollamaEndpoint(config);
    try {
      const res = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return { ok: false, reason: `Ollama responded ${res.status}`, endpoint };
      const json = (await res.json()) as { models?: Array<{ name?: string }> };
      const models = (json.models ?? []).map((m) => m.name).filter(Boolean);
      return models.length ? { ok: true, endpoint } : { ok: false, reason: 'Ollama is running but has no models pulled (try `ollama pull llama3.1`)', endpoint };
    } catch {
      return { ok: false, reason: 'Ollama is not reachable (start it with `ollama serve`)', endpoint };
    }
  },
  async complete(config, req) {
    const endpoint = ollamaEndpoint(config);
    const model = config.model ?? ollamaProvider.defaultModel;
    const json = await postJson(
      `${endpoint}/api/chat`,
      { model, stream: false, options: { num_predict: req.maxTokens ?? 2000 }, messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.prompt }] },
      {},
      req,
    );
    const message = (json.message ?? {}) as Record<string, unknown>;
    return { text: str(message.content), model, provider: 'ollama' };
  },
};

/** Ollama's endpoint: a trusted baseUrl, then OLLAMA_HOST, then the local default. */
export function ollamaEndpoint(config: AiConfig): string {
  const env = process.env.OLLAMA_HOST?.trim();
  const fromEnv = env ? (/^https?:\/\//i.test(env) ? env : `http://${env}`) : undefined;
  return providerBase(config, fromEnv ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
}

/**
 * True when project content would leave this machine. Hosted providers always do;
 * Ollama does whenever its endpoint is not a loopback address.
 */
export function isRemote(provider: AIProvider, config: AiConfig): boolean {
  if (provider.id === 'ollama') return !isLoopbackUrl(ollamaEndpoint(config));
  return provider.remote;
}

export const PROVIDERS: AIProvider[] = [anthropicProvider, openaiProvider, googleProvider, ollamaProvider];

export function getProvider(id: AiConfig['provider']): AIProvider {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new AiError(`Unknown AI provider: ${id}`, `Supported: ${PROVIDERS.map((x) => x.id).join(', ')}`);
  return p;
}
