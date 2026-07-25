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
import { createAiProviderGuardedFetch } from '../../../common/ai-provider-outbound';
import { resolveAiProviderBaseUrlPolicy } from '../../../common/ai-provider-baseurl';
import { OpenAiProvider } from './openai-provider';
import { AnthropicProvider } from './anthropic-provider';
import { GeminiProvider } from './gemini-provider';
import { MockAiProvider, type MockResponse } from './mock-provider';
import type { AiImageProvider } from './image-provider';
import { OpenAiImageProvider } from './openai-image-provider';
import { supportsImageGeneration } from './capabilities';

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

function defaultFetchImpl(config: AiProviderConfig): FetchLike {
  return config.fetchImpl ?? createAiProviderGuardedFetch(resolveAiProviderBaseUrlPolicy());
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
        fetchImpl: defaultFetchImpl(config),
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
        fetchImpl: defaultFetchImpl(config),
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
        fetchImpl: defaultFetchImpl(config),
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

/**
 * Build an IMAGE provider from a text-provider config (issue #410). Only provider types that
 * declare the `imageGeneration` capability get a concrete adapter — everything else throws
 * `invalid_request` so the map router degrades to the honest procedural-blueprint fallback
 * rather than pretending a text-only model drew an image. `imageModel` overrides the config's
 * `model` (a chat model id is rarely the right image model), keeping selection explicit.
 */
export function createAiImageProvider(config: AiProviderConfig, imageModel?: string): AiImageProvider {
  if (!supportsImageGeneration(config.providerType)) {
    throw new AiProviderError(
      'invalid_request',
      `Provider '${config.providerType}' does not support image generation; route through the procedural-blueprint fallback instead.`,
      { provider: config.providerType },
    );
  }
  // Today only the OpenAI-compatible family exposes an /images endpoint we implement.
  if (config.providerType === 'openai') {
    requireKey(config);
    return new OpenAiImageProvider({
      apiKey: config.apiKey!,
      baseUrl: config.baseUrl,
      model: imageModel ?? config.model,
      timeoutMs: config.timeoutMs,
      retry: config.retry,
      headers: config.headers,
      fetchImpl: defaultFetchImpl(config),
    });
  }
  throw new AiProviderError(
    'invalid_request',
    `No image adapter is implemented for provider '${config.providerType}'.`,
    { provider: config.providerType },
  );
}
