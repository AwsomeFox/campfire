/**
 * Provider factory (#309). Selects and constructs an `AiProvider` from a vendor-neutral
 * config object. This issue consumes `{ providerType, model, apiKey, baseUrl, params }`
 * as plain inputs; the ENCRYPTED storage + admin allowlist that produce `apiKey`/`baseUrl`
 * land in #310 and call straight through here — no reshaping of this signature needed.
 *
 * The `custom` type is intentionally NOT built here: a self-hoster binding a fully custom
 * `AiProvider` supplies the instance directly through DI (the existing `AI_DM_PROVIDER`
 * seam), which is why `custom` has no adapter in this switch.
 */

import type { AiProvider, AiProviderType } from './ai-provider';
import { AiProviderError } from './errors';
import type { FetchLike, RetryConfig } from './http';
import { OpenAiProvider } from './openai-provider';
import { AnthropicProvider } from './anthropic-provider';
import { GeminiProvider } from './gemini-provider';
import { MockAiProvider, type MockResponse } from './mock-provider';

/** Default sampling/limit params for a provider. */
export interface AiProviderParams {
  temperature?: number;
  maxTokens?: number;
}

/**
 * The config the factory consumes. Mirrors the issue's stored shape
 * `{ providerType, baseUrl?, model, apiKeyRef, params }` — except `apiKey` is already
 * the DECRYPTED value here (resolving `apiKeyRef` is #310's job, upstream of this call).
 */
export interface AiProviderConfig {
  providerType: AiProviderType;
  model: string;
  /** Decrypted key. Required for `openai`/`anthropic`; unused by `mock`. */
  apiKey?: string;
  /** Base URL override — the key to OpenAI-compatible endpoints (Azure/OpenRouter/Groq/local). */
  baseUrl?: string;
  params?: AiProviderParams;
  /** Per-request timeout override (ms). */
  timeoutMs?: number;
  /** Retry policy override. */
  retry?: RetryConfig;
  /** Extra headers (e.g. OpenRouter attribution, Azure api-key). */
  headers?: Record<string, string>;
  /** Injected fetch (tests). Defaults to global fetch inside each adapter. */
  fetchImpl?: FetchLike;
  /** Canned responses when `providerType === 'mock'`. */
  mockResponses?: MockResponse[];
}

/**
 * Build a provider from config. Throws a typed `auth` error when a real provider is
 * requested without an API key, so the failure is the same shape #312 handles everywhere.
 */
export function createAiProvider(config: AiProviderConfig): AiProvider {
  switch (config.providerType) {
    case 'openai':
      requireKey(config);
      return new OpenAiProvider({
        apiKey: config.apiKey!,
        baseUrl: config.baseUrl,
        model: config.model,
        temperature: config.params?.temperature,
        maxTokens: config.params?.maxTokens,
        timeoutMs: config.timeoutMs,
        retry: config.retry,
        headers: config.headers,
        fetchImpl: config.fetchImpl,
      });
    case 'anthropic':
      requireKey(config);
      return new AnthropicProvider({
        apiKey: config.apiKey!,
        baseUrl: config.baseUrl,
        model: config.model,
        temperature: config.params?.temperature,
        maxTokens: config.params?.maxTokens,
        timeoutMs: config.timeoutMs,
        retry: config.retry,
        headers: config.headers,
        fetchImpl: config.fetchImpl,
      });
    case 'gemini':
      requireKey(config);
      return new GeminiProvider({
        apiKey: config.apiKey!,
        baseUrl: config.baseUrl,
        model: config.model,
        temperature: config.params?.temperature,
        maxTokens: config.params?.maxTokens,
        timeoutMs: config.timeoutMs,
        retry: config.retry,
        headers: config.headers,
        fetchImpl: config.fetchImpl,
      });
    case 'mock':
      return new MockAiProvider({ model: config.model, responses: config.mockResponses });
    case 'noop':
    case 'custom':
      throw new AiProviderError(
        'invalid_request',
        `createAiProvider does not build '${config.providerType}' providers — bind them via the AI_DM_PROVIDER DI seam instead.`,
        { provider: config.providerType },
      );
    default:
      throw new AiProviderError('invalid_request', `Unknown provider type: ${String(config.providerType)}`);
  }
}

function requireKey(config: AiProviderConfig): void {
  if (!config.apiKey) {
    throw new AiProviderError('auth', `${config.providerType}: an API key is required`, { provider: config.providerType });
  }
}
