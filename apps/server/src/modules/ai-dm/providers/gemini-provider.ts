/**
 * Google Gemini AI provider adapter (issue #987).
 *
 * Implements the vendor-neutral {@link AiProvider} interface for Google's
 * Generative Language API (Gemini / Google AI Studio). Uses the REST endpoint:
 *   POST ${baseUrl}/models/${model}:generateContent       (single-shot)
 *   POST ${baseUrl}/models/${model}:streamGenerateContent  (streaming, SSE)
 *
 * Auth is via the `x-goog-api-key` header (the standard Gemini API key pattern).
 * The API key may come from the provider config or the `GEMINI_API_KEY` /
 * `GOOGLE_API_KEY` environment variable (resolved by AiProviderConfigService).
 */
import {
  type AiFinishReason,
  type AiGenerateOptions,
  type AiGenerateRequest,
  type AiGenerateResult,
  type AiMessage,
  type AiProvider,
  type AiStreamEvent,
  type AiToolCall,
  type AiToolSchema,
  type AiUsage,
} from './ai-provider';
import { AiProviderError } from './errors';
import {
  DEFAULT_RETRY,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  type FetchLike,
  type RetryConfig,
  postJson,
  parseSse,
} from './http';

export interface GeminiProviderOptions {
  apiKey: string;
  baseUrl?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  retry?: RetryConfig;
  headers?: Record<string, string>;
  fetchImpl?: FetchLike;
  name?: string;
}

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** A Gemini `functionCall` part — the model asking to invoke a declared tool. */
interface GeminiFunctionCall {
  name?: string;
  args?: Record<string, unknown>;
}
/** A Gemini `functionResponse` part — a tool result fed back to the model (matched BY NAME). */
interface GeminiFunctionResponse {
  name: string;
  response: Record<string, unknown>;
}
interface GeminiPart {
  text?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: GeminiFunctionResponse;
}
interface GeminiContent {
  role?: string;
  parts: GeminiPart[];
}
interface GeminiResponse {
  candidates?: Array<{
    content?: GeminiContent;
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  promptFeedback?: {
    blockReason?: string;
  };
}

export class GeminiProvider implements AiProvider {
  readonly providerType = 'gemini' as const;
  readonly name: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly retry: RetryConfig;

  constructor(private readonly opts: GeminiProviderOptions) {
    this.name = opts.name ?? 'gemini';
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike);
    if (!this.fetchImpl) throw new AiProviderError('transport', 'gemini: no fetch implementation available', { provider: this.name });
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retry = opts.retry ?? DEFAULT_RETRY;
  }

  private authHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-goog-api-key': this.opts.apiKey,
      ...this.opts.headers,
    };
  }

  private generateUrl(model: string, stream: boolean): string {
    const m = model || this.opts.model;
    const action = stream ? 'streamGenerateContent' : 'generateContent';
    return `${this.baseUrl}/models/${m}:${action}${stream ? '?alt=sse' : ''}`;
  }

  private buildBody(req: AiGenerateRequest): Record<string, unknown> {
    const contents: GeminiContent[] = [];

    // Gemini uses "contents" with role "user"/"model" (not system/assistant).
    // System instructions go in a separate `systemInstruction` field.
    const body: Record<string, unknown> = {};

    if (req.system) {
      body.systemInstruction = { parts: [{ text: req.system }] };
    }

    // Map the neutral history onto Gemini `contents`, preserving the tool loop:
    // assistant tool calls become `functionCall` parts and tool results become
    // `functionResponse` parts (#1062) — not text — so the model can actually act.
    for (const msg of req.messages) {
      contents.push(toGeminiContent(msg));
    }
    body.contents = contents;

    const temperature = req.temperature ?? this.opts.temperature;
    if (temperature !== undefined) {
      body.generationConfig = { ...(body.generationConfig as object | undefined), temperature };
    }
    const maxTokens = req.maxTokens ?? this.opts.maxTokens;
    if (maxTokens !== undefined) {
      body.generationConfig = { ...(body.generationConfig as object | undefined), maxOutputTokens: maxTokens };
    }

    // Honor the neutral toolChoice (parity with the OpenAI/Anthropic adapters):
    // 'none' opts out entirely (advertise nothing), 'required' forces a call (ANY),
    // 'auto'/default lets the model decide (AUTO).
    if (req.tools && req.tools.length > 0 && req.toolChoice !== 'none') {
      body.tools = [{ functionDeclarations: req.tools.map(toGeminiTool) }];
      const mode = req.toolChoice === 'required' ? 'ANY' : 'AUTO';
      body.toolConfig = { functionCallingConfig: { mode } };
    }

    return body;
  }

  async generate(req: AiGenerateRequest, opts?: AiGenerateOptions): Promise<AiGenerateResult> {
    const url = this.generateUrl(req.model, false);
    const body = this.buildBody(req);
    const res = await postJson(this.fetchImpl, url, this.authHeaders(), body, {
      provider: this.name,
      timeoutMs: opts?.timeoutMs ?? this.timeoutMs,
      retry: this.retry,
      signal: opts?.signal,
    });
    const data = (await res.json()) as GeminiResponse;
    return this.parseResult(data, req.model);
  }

  async *stream(req: AiGenerateRequest, opts?: AiGenerateOptions): AsyncIterable<AiStreamEvent> {
    const url = this.generateUrl(req.model, true);
    const body = this.buildBody(req);
    const res = await postJson(this.fetchImpl, url, this.authHeaders(), body, {
      provider: this.name,
      timeoutMs: opts?.timeoutMs ?? this.timeoutMs,
      retry: this.retry,
      signal: opts?.signal,
    });
    if (!res.body) throw new AiProviderError('transport', `${this.name}: streaming response has no body`, { provider: this.name });

    let totalText = '';
    const toolCalls: AiToolCall[] = [];
    let usage: AiUsage | undefined;
    let finishReason: AiFinishReason = 'unknown';

    // Idle/read timeout stays armed until the body completes or aborts (#1063).
    for await (const event of parseSse(res.body, {
      signal: opts?.signal,
      idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
      provider: this.name,
    })) {
      if (!event.data || event.data === '[DONE]') continue;
      let chunk: GeminiResponse;
      try {
        chunk = JSON.parse(event.data) as GeminiResponse;
      } catch {
        continue;
      }
      const candidate = chunk.candidates?.[0];
      if (candidate?.content?.parts) {
        for (const part of candidate.content.parts) {
          if (part.text) {
            totalText += part.text;
            yield { type: 'text', delta: part.text };
          } else if (part.functionCall) {
            // Gemini streams each functionCall as a whole part (not JSON deltas), so
            // emit the complete call in one tool_call event and record it for `done`.
            const index = toolCalls.length;
            const call: AiToolCall = {
              id: `call_${index}`,
              name: part.functionCall.name ?? '',
              arguments: part.functionCall.args ?? {},
            };
            toolCalls.push(call);
            yield { type: 'tool_call', index, id: call.id, name: call.name, argumentsDelta: JSON.stringify(call.arguments) };
          }
        }
      }
      if (candidate?.finishReason) {
        finishReason = mapFinishReason(candidate.finishReason);
      }
      if (chunk.usageMetadata) {
        usage = mapUsage(chunk.usageMetadata);
      }
    }

    yield {
      type: 'done',
      result: {
        text: totalText,
        toolCalls,
        usage: usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: resolveStreamFinishReason(finishReason, toolCalls.length),
        model: req.model || this.opts.model,
      },
    };
  }

  private parseResult(data: GeminiResponse, model: string): AiGenerateResult {
    const candidate = data.candidates?.[0];
    if (!candidate) {
      const blockReason = data.promptFeedback?.blockReason;
      throw new AiProviderError(
        'invalid_request',
        blockReason ? `${this.name}: content blocked (${blockReason})` : `${this.name}: no candidates in response`,
        { provider: this.name },
      );
    }
    const parts = candidate.content?.parts ?? [];
    const text = parts.map((p) => p.text ?? '').join('');
    const toolCalls = extractToolCalls(parts);
    const usage = data.usageMetadata ? mapUsage(data.usageMetadata) : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    return {
      text,
      toolCalls,
      usage,
      finishReason: resolveFinishReason(candidate.finishReason, toolCalls.length),
      model: model || this.opts.model,
    };
  }

  /** Issue #987: list models from `GET ${baseUrl}/models`. */
  async listModels(): Promise<string[]> {
    const { getJson } = await import('./http');
    const res = await getJson(this.fetchImpl, `${this.baseUrl}/models`, this.authHeaders(), {
      provider: this.name,
      timeoutMs: this.timeoutMs,
    });
    if (!res.ok) throw new AiProviderError('invalid_request', `${this.name}: models request failed (${res.status})`, { provider: this.name });
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return (data.models ?? []).map((m) => m.name.replace(/^models\//, '')).sort();
  }
}

function mapUsage(meta: NonNullable<GeminiResponse['usageMetadata']>): AiUsage {
  return {
    promptTokens: meta.promptTokenCount ?? 0,
    completionTokens: meta.candidatesTokenCount ?? 0,
    totalTokens: meta.totalTokenCount ?? 0,
  };
}

function mapFinishReason(reason: string): AiGenerateResult['finishReason'] {
  switch (reason.toUpperCase()) {
    case 'STOP':
    case 'MAX_TOKENS':
      return reason.toUpperCase() === 'STOP' ? 'stop' : 'length';
    case 'SAFETY':
    case 'RECITATION':
      return 'content_filter';
    default:
      return 'unknown';
  }
}

function toGeminiTool(tool: AiToolSchema): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

/**
 * Map one neutral message onto a Gemini `content` entry, preserving the tool loop (#1062):
 *   - `assistant` → role `model`, with a `functionCall` part per tool call (plus any text);
 *   - `tool`      → role `user`, with a `functionResponse` part matched to the call BY NAME
 *                   (Gemini has no call ids), using the driver-populated `toolName`;
 *   - everything else → role `user` text.
 */
function toGeminiContent(msg: AiMessage): GeminiContent {
  if (msg.role === 'tool') {
    return {
      role: 'user',
      parts: [{ functionResponse: { name: msg.toolName ?? '', response: toResponseStruct(msg.content) } }],
    };
  }
  if (msg.role === 'assistant') {
    const parts: GeminiPart[] = [];
    if (msg.content) parts.push({ text: msg.content });
    for (const tc of msg.toolCalls ?? []) parts.push({ functionCall: { name: tc.name, args: tc.arguments ?? {} } });
    // A `model` turn must carry at least one part even when it is a bare tool call.
    if (parts.length === 0) parts.push({ text: '' });
    return { role: 'model', parts };
  }
  return { role: 'user', parts: [{ text: typeof msg.content === 'string' ? msg.content : '' }] };
}

/**
 * Gemini's `functionResponse.response` must be a JSON object (struct). MCP tool results
 * arrive as strings — often JSON — so parse a JSON object through unchanged and wrap any
 * scalar/array/plain-text result under a `result` key.
 */
function toResponseStruct(content: string | undefined): Record<string, unknown> {
  if (!content) return {};
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return { result: parsed };
  } catch {
    return { result: content };
  }
}

/** Pull every `functionCall` part out of a candidate's parts as neutral tool calls. */
function extractToolCalls(parts: GeminiPart[]): AiToolCall[] {
  const calls: AiToolCall[] = [];
  for (const part of parts) {
    if (part.functionCall) {
      calls.push({
        // Gemini assigns no call id; synthesize a stable one for the neutral tool loop.
        id: `call_${calls.length}`,
        name: part.functionCall.name ?? '',
        arguments: part.functionCall.args ?? {},
      });
    }
  }
  return calls;
}

/** Map a RAW Gemini finishReason, then normalize for the presence of tool calls. */
function resolveFinishReason(raw: string | undefined, toolCallCount: number): AiFinishReason {
  return normalizeToolFinish(raw ? mapFinishReason(raw) : 'stop', toolCallCount);
}

/** Normalize an already-mapped finishReason for the presence of tool calls. */
function resolveStreamFinishReason(mapped: AiFinishReason, toolCallCount: number): AiFinishReason {
  return normalizeToolFinish(mapped, toolCallCount);
}

/**
 * Gemini reports `STOP` even when the turn is purely function calls. Normalize that to
 * `tool_calls` so the driver runs the tools instead of treating it as a narration stop
 * (a bare tool-call turn would otherwise look like empty narration and park the seat).
 */
function normalizeToolFinish(mapped: AiFinishReason, toolCallCount: number): AiFinishReason {
  if (toolCallCount > 0 && (mapped === 'stop' || mapped === 'unknown')) return 'tool_calls';
  return mapped;
}
