/**
 * Model adapter layer.
 *
 * One interface, several implementations. The OpenAI-compatible adapter covers
 * OpenAI, DeepSeek, Together, Groq, vLLM, Ollama gateways and most local
 * servers, so it is the only transport we ship for the MVP. Adding a provider
 * means adding a `ChatTransport` — nothing else in the engine changes.
 */
import { assertSafeProviderUrl } from '../security/ssrf';
import { redactSecrets } from '../security/ssrf';
import { env } from '../config';
import type { ProviderKind } from '../../shared/types';

export interface ChatRequest {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  seed?: number;
  signal?: AbortSignal;
}

export interface ChatResponse {
  text: string;
  providerResponseId: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
  raw: unknown;
}

export type AdapterErrorKind = 'timeout' | 'auth' | 'rate-limit' | 'server' | 'network' | 'bad-response';

export class AdapterError extends Error {
  readonly kind: AdapterErrorKind;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(kind: AdapterErrorKind, message: string, status: number | null = null) {
    super(redactSecrets(message));
    this.name = 'AdapterError';
    this.kind = kind;
    this.status = status;
    this.retryable = kind === 'timeout' || kind === 'rate-limit' || kind === 'network' || kind === 'server';
  }
}

export interface ChatTransport {
  readonly kind: ProviderKind;
  chat(request: ChatRequest): Promise<ChatResponse>;
}

function classifyStatus(status: number): AdapterErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'bad-response';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate-limit';
  if (status >= 500) return 'server';
  return 'bad-response';
}

/**
 * Maps pricing metadata (USD per 1M tokens) to an estimated cost. Providers
 * often omit cost, so this is explicitly an *estimate* and is labelled as such
 * in reports. Unknown pricing yields null rather than a fabricated number.
 */
export interface Pricing {
  inputPerMillion: number | null;
  outputPerMillion: number | null;
}

export function estimateCostUsd(
  pricing: Pricing | undefined,
  promptTokens: number | null,
  completionTokens: number | null,
): number | null {
  if (!pricing) return null;
  const inPrice = pricing.inputPerMillion;
  const outPrice = pricing.outputPerMillion;
  if (inPrice === null && outPrice === null) return null;
  const inCost = inPrice !== null && promptTokens !== null ? (promptTokens / 1_000_000) * inPrice : 0;
  const outCost =
    outPrice !== null && completionTokens !== null ? (completionTokens / 1_000_000) * outPrice : 0;
  if (inPrice === null && promptTokens !== null) return null;
  return inCost + outCost;
}

const openAiCompatible: ChatTransport = {
  kind: 'openai-compatible',
  async chat(request) {
    const base = await assertSafeProviderUrl(request.baseUrl);
    const url = `${base}/chat/completions`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    const onExternalAbort = () => controller.abort();
    request.signal?.addEventListener('abort', onExternalAbort);

    const started = Date.now();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${request.apiKey}`,
        },
        body: JSON.stringify({
          model: request.modelId,
          messages: request.messages,
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          ...(request.seed !== undefined ? { seed: request.seed } : {}),
        }),
        signal: controller.signal,
      });

      const latencyMs = Date.now() - started;

      if (!response.ok) {
        const bodyText = await safeText(response);
        throw new AdapterError(
          classifyStatus(response.status),
          `Provider returned ${response.status}: ${truncate(bodyText, 500)}`,
          response.status,
        );
      }

      const payload = (await response.json()) as {
        id?: string;
        choices?: Array<{ message?: { content?: string | null } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const text = payload.choices?.[0]?.message?.content;
      if (typeof text !== 'string') {
        throw new AdapterError('bad-response', 'Provider response did not contain message content.');
      }

      return {
        text,
        providerResponseId: payload.id ?? null,
        promptTokens: payload.usage?.prompt_tokens ?? null,
        completionTokens: payload.usage?.completion_tokens ?? null,
        latencyMs,
        raw: payload,
      };
    } catch (err) {
      if (err instanceof AdapterError) throw err;
      if ((err as Error).name === 'AbortError') {
        throw new AdapterError('timeout', `Request timed out after ${request.timeoutMs}ms`);
      }
      throw new AdapterError('network', `Network error: ${(err as Error).message}`);
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', onExternalAbort);
    }
  },
};

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable body>';
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

const TRANSPORTS: Record<string, ChatTransport> = {
  'openai-compatible': openAiCompatible,
  openai: openAiCompatible,
  deepseek: openAiCompatible,
  custom: openAiCompatible,
  anthropic: openAiCompatible,
};

export function getTransport(kind: ProviderKind): ChatTransport {
  return TRANSPORTS[kind] ?? openAiCompatible;
}

/**
 * Resolves the effective base URL for a provider row.
 *
 * The database row is the source of truth: it is what the user configured and
 * what the run snapshot records, so two runs of the same model always describe
 * where they were sent. An environment variable only fills in when the row has
 * no usable URL, which keeps headless bootstrap working without silently
 * redirecting an already-configured provider.
 */
export function resolveBaseUrl(kind: ProviderKind, storedBaseUrl: string): string {
  if (storedBaseUrl && storedBaseUrl.trim().length > 0) return storedBaseUrl;

  if (kind === 'openai' && env.OPENAI_BASE_URL) return env.OPENAI_BASE_URL;
  if (kind === 'deepseek' && env.DEEPSEEK_BASE_URL) return env.DEEPSEEK_BASE_URL;
  if (kind === 'openai-compatible' && env.OPENAI_COMPATIBLE_BASE_URL) {
    return env.OPENAI_COMPATIBLE_BASE_URL;
  }
  return storedBaseUrl;
}

/** Cheap reachability probe used by /api/health. Never sends a real prompt. */
export async function probeProvider(baseUrl: string): Promise<'ok' | 'unconfigured'> {
  try {
    await assertSafeProviderUrl(baseUrl);
    return 'ok';
  } catch {
    return 'unconfigured';
  }
}
