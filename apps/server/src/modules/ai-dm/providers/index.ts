/**
 * Provider layer barrel (#309) — the foundation of the AI program epic (#308).
 *
 * Public surface: the vendor-neutral `AiProvider` interface + its types, the typed error
 * taxonomy, the OpenAI-compatible / Anthropic / mock adapters, the config-driven factory,
 * the MCP tool-registry normalization, and the bridge onto the existing `AiDmProvider` seam.
 * Downstream issues (#310 keys, #312 driver runtime, #318 evals) import ONLY from here.
 */

export type {
  AiProvider,
  AiProviderType,
  AiRole,
  AiMessage,
  AiToolCall,
  AiToolSchema,
  AiToolChoice,
  AiGenerateRequest,
  AiGenerateOptions,
  AiUsage,
  AiFinishReason,
  AiGenerateResult,
  AiStreamEvent,
} from './ai-provider';

export { AiProviderError, classifyHttpStatus, getHttpStatusText, parseRetryAfterMs } from './errors';
export type { AiErrorKind, AiProviderErrorOptions } from './errors';

export { OpenAiProvider } from './openai-provider';
export type { OpenAiProviderOptions } from './openai-provider';

export { AnthropicProvider } from './anthropic-provider';
export type { AnthropicProviderOptions } from './anthropic-provider';

export { GeminiProvider } from './gemini-provider';
export type { GeminiProviderOptions } from './gemini-provider';

export { MockAiProvider, mockTokenCount } from './mock-provider';
export type { MockProviderOptions, MockResponse } from './mock-provider';

export { createAiProvider, createAiImageProvider } from './factory';
export type { AiProviderConfig, AiProviderParams } from './factory';

export { providerCapabilities, supportsImageGeneration, providerRequiresApiKey } from './capabilities';

export { OpenAiImageProvider } from './openai-image-provider';
export type { OpenAiImageProviderOptions } from './openai-image-provider';

export { MockImageProvider } from './mock-image-provider';
export type { MockImageProviderOptions } from './mock-image-provider';

export type {
  AiImageProvider,
  AiImageRequest,
  AiImageResult,
  AiImageOptions,
  AiImageUsage,
  AiGeneratedImage,
} from './image-provider';

export {
  mcpToolToAiSchema,
  mcpToolsToAiSchemas,
  aiToolCallToMcpInvocation,
  aiToolCallsToMcpInvocations,
} from './tool-registry';
export type { McpToolDefinition, McpToolInvocation } from './tool-registry';

export { ProviderBackedAiDmProvider } from './ai-dm-bridge';
export type { ProviderBackedAiDmOptions } from './ai-dm-bridge';

export type { FetchLike, FetchResponse, RetryConfig, ParseSseOptions } from './http';
export { DEFAULT_RETRY, DEFAULT_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS, parseSse, raceRead, streamAbortError } from './http';
