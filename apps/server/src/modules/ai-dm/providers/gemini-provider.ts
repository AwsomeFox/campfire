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
  type AiGenerateOptions,
  type AiGenerateRequest,
  type AiGenerateResult,
  type AiMessage,
  type AiProvider,
  type AiStreamEvent,
  type AiToolSchema,
  type AiUsage,
} from './ai-provider';
import { AiProviderError } from './errors';
import {
  DEFAULT_RETRY,
  DEFAULT_TIMEOUT_MS,
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

interface GeminiPart {
  text?: string;
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

    for (const msg of req.messages) {
      const role = msg.role === 'assistant' ? 'model' : 'user';
      const text = typeof msg.content === 'string' ? msg.content : '';
      contents.push({ role, parts: [{ text }] });
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

    if (req.tools && req.tools.length > 0) {
      body.tools = [{ functionDeclarations: req.tools.map(toGeminiTool) }];
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
    let usage: AiUsage | undefined;
    let finishReason = 'unknown';

    for await (const event of parseSse(res.body)) {
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
        toolCalls: [],
        usage: usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: finishReason as AiGenerateResult['finishReason'],
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
    const text = candidate.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    const usage = data.usageMetadata ? mapUsage(data.usageMetadata) : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    return {
      text,
      toolCalls: [],
      usage,
      finishReason: candidate.finishReason ? mapFinishReason(candidate.finishReason) : 'stop',
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

// Suppress unused-import warning for AiMessage (referenced in type annotations)
export type { AiMessage };
