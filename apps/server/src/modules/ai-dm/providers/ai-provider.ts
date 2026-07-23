/**
 * Provider-agnostic LLM interface — the foundation of the AI program epic (#308).
 *
 * Everything downstream (encrypted key storage #310, the driver runtime #312, evals
 * #318) talks to an LLM ONLY through the `AiProvider` interface defined here. The
 * interface is deliberately vendor-neutral: NO OpenAI/Anthropic request or response
 * types leak across it. A caller assembles a system prompt + message history + an
 * optional tool registry, and gets back normalized narration + tool calls + real
 * token usage, with an equivalent streaming path.
 *
 * Two wire formats sit behind this one shape (see openai-provider.ts /
 * anthropic-provider.ts); a deterministic mock (mock-provider.ts) implements it with
 * no network for tests/evals. Selection is by config through `createAiProvider`
 * (factory.ts) — #310 supplies the decrypted key + base URL, this issue just consumes
 * `{ providerType, model, apiKey, baseUrl, params }`.
 *
 * This is intentionally separate from the existing `AiDmProvider` DI seam
 * (ai-dm.provider.ts), which stays bound to the no-op default. `ProviderBackedAiDmProvider`
 * bridges the two so #312 can bind a real provider without reshaping either interface.
 */

/** Which built-in adapter (or a fully custom binding) backs a provider. */
export type AiProviderType = 'openai' | 'anthropic' | 'gemini' | 'mock' | 'noop' | 'custom';

/** Role of a message in the conversation. `tool` carries a tool result back to the model. */
export type AiRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * A single tool/function call the model asked to make. Arguments are the PARSED
 * JSON object (both wire formats are normalized to this), never a raw string — the
 * driver runtime (#312) maps `{name, arguments}` straight onto an MCP tool invocation.
 */
export interface AiToolCall {
  /** Provider-assigned call id, echoed back on the matching tool-result message. */
  id: string;
  /** Tool name — matches an `AiToolSchema.name` from the registry passed in. */
  name: string;
  /** Parsed JSON arguments. Empty object when the model called with no/blank arguments. */
  arguments: Record<string, unknown>;
}

/**
 * One conversation message. A full tool loop is expressible: an `assistant` message
 * may carry `toolCalls`, and each is answered by a `tool` message whose `toolCallId`
 * matches. `system` is passed via `AiGenerateRequest.system`, not as a message.
 */
export interface AiMessage {
  role: AiRole;
  /** Text content. Optional on an assistant message that only issues tool calls. */
  content?: string;
  /** assistant only — tool calls the model wants executed this turn. */
  toolCalls?: AiToolCall[];
  /** tool only — the id of the assistant tool call this message answers. */
  toolCallId?: string;
  /** tool only — the tool's name (informational; some wire formats want it). */
  toolName?: string;
}

/**
 * A tool the model may call, in the ONE canonical shape. Adapters translate this to
 * OpenAI `tools[].function` and Anthropic `tools[].input_schema` — one registry, two
 * wire formats. `parameters` is a JSON Schema object (the same object Campfire already
 * derives from its MCP tool zod schemas).
 */
export interface AiToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the arguments object (`{ type: 'object', properties, required }`). */
  parameters: Record<string, unknown>;
}

/** How the model should treat the tool registry for this request. */
export type AiToolChoice = 'auto' | 'none' | 'required';

/** A request to the model — provider-agnostic. */
export interface AiGenerateRequest {
  /** System prompt / persona / house rules. Assembled by the caller. */
  system?: string;
  /** Conversation history in order (excludes the system prompt). */
  messages: AiMessage[];
  /** Model id to serve the request (provider-specific string, chosen by config). */
  model: string;
  /** Upper bound on output tokens this turn. */
  maxTokens?: number;
  /** Sampling temperature. */
  temperature?: number;
  /** Tool registry the model may call. Omitted/empty ⇒ no tools offered. */
  tools?: AiToolSchema[];
  /** Tool-use policy. Default `auto` when tools are present. */
  toolChoice?: AiToolChoice;
}

/** Real prompt/completion token accounting from the provider response (#budget metering). */
export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Why generation stopped — normalized across providers. */
export type AiFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'unknown';

/** The complete result of a (possibly streamed) generation. */
export interface AiGenerateResult {
  /** Concatenated narration text (may be empty when the turn is purely tool calls). */
  text: string;
  /** Normalized tool calls the model requested (empty when none). */
  toolCalls: AiToolCall[];
  /** Real token usage from the provider. */
  usage: AiUsage;
  finishReason: AiFinishReason;
  /** Model that actually served the request (echoed by the provider when available). */
  model: string;
}

/**
 * A streaming event. `text` deltas flow token-by-token to the driver runtime;
 * `tool_call` deltas accumulate an argument string per call index; `done` carries the
 * fully-aggregated `AiGenerateResult` so a consumer can ignore deltas and just await
 * the terminal event if it wants the non-streaming shape.
 */
export type AiStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: 'usage'; usage: AiUsage }
  | { type: 'done'; result: AiGenerateResult };

/** Per-call knobs the caller/runtime controls (cancellation, timeout override). */
export interface AiGenerateOptions {
  /** Abort the in-flight request (the runtime wires this to its own cancellation). */
  signal?: AbortSignal;
  /** Override the provider's configured per-request timeout (ms). */
  timeoutMs?: number;
}

/**
 * The one interface every model integration implements. Vendor-neutral by contract:
 * no OpenAI/Anthropic types appear in any signature here.
 */
export interface AiProvider {
  /** Short machine name surfaced in results/audit (e.g. 'openai', 'anthropic', 'mock'). */
  readonly name: string;
  /** Which adapter family this is. */
  readonly providerType: AiProviderType;
  /** Single-shot generation. Resolves with narration + tool calls + real usage. */
  generate(req: AiGenerateRequest, opts?: AiGenerateOptions): Promise<AiGenerateResult>;
  /**
   * Streaming generation. Yields text/tool-call/usage/done deltas and finishes with a
   * single `done` event carrying the aggregated result.
   */
  stream(req: AiGenerateRequest, opts?: AiGenerateOptions): AsyncIterable<AiStreamEvent>;
  /**
   * List available model IDs from the provider's API (issue #987). Optional — providers
   * that don't support model discovery leave this undefined.
   */
  listModels?(): Promise<string[]>;
}
