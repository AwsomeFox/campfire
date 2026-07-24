/**
 * OpenAI-compatible adapter (#309). One adapter covers OpenAI, Azure OpenAI, OpenRouter,
 * Groq, and local servers (Ollama / llama.cpp / LM Studio) — anything that speaks the
 * `/chat/completions` shape — via a configurable `baseUrl`. Thin fetch-based client (no
 * vendor SDK); the `fetch` impl is injectable so tests run against recorded fixtures.
 *
 * All OpenAI wire types stay INSIDE this file: the class only ever accepts/returns the
 * vendor-neutral `AiProvider` types.
 */

import type {
  AiProvider,
  AiGenerateRequest,
  AiGenerateResult,
  AiGenerateOptions,
  AiStreamEvent,
  AiToolCall,
  AiFinishReason,
  AiMessage,
  AiToolSchema,
} from './ai-provider';
import { AiProviderError } from './errors';
import {
  type FetchLike,
  type RetryConfig,
  DEFAULT_RETRY,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  postJson,
  getJson,
  parseSse,
} from './http';

export interface OpenAiProviderOptions {
  apiKey: string;
  /** Defaults to the public OpenAI endpoint; override for Azure/OpenRouter/Groq/local. */
  baseUrl?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  retry?: RetryConfig;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: FetchLike;
  /** Extra headers (e.g. OpenRouter's HTTP-Referer, Azure api-key). */
  headers?: Record<string, string>;
  /** Short provider name surfaced in results/audit. */
  name?: string;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export class OpenAiProvider implements AiProvider {
  readonly providerType = 'openai' as const;
  readonly name: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly retry: RetryConfig;

  constructor(private readonly opts: OpenAiProviderOptions) {
    this.name = opts.name ?? 'openai';
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike);
    if (!this.fetchImpl) throw new AiProviderError('transport', 'openai: no fetch implementation available', { provider: this.name });
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retry = opts.retry ?? DEFAULT_RETRY;
  }

  private url(): string {
    return `${this.baseUrl}/chat/completions`;
  }

  private authHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.opts.apiKey}`,
      ...this.opts.headers,
    };
  }

  private buildBody(req: AiGenerateRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model || this.opts.model,
      messages: toOpenAiMessages(req),
      stream,
    };
    const temperature = req.temperature ?? this.opts.temperature;
    if (temperature !== undefined) body.temperature = temperature;
    const maxTokens = req.maxTokens ?? this.opts.maxTokens;
    if (maxTokens !== undefined) body.max_tokens = maxTokens;
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map(toOpenAiTool);
      body.tool_choice = req.toolChoice ?? 'auto';
    }
    if (stream) body.stream_options = { include_usage: true }; // real usage in the terminal chunk
    return body;
  }

  async generate(req: AiGenerateRequest, opts?: AiGenerateOptions): Promise<AiGenerateResult> {
    const res = await postJson(this.fetchImpl, this.url(), this.authHeaders(), this.buildBody(req, false), {
      provider: this.name,
      timeoutMs: opts?.timeoutMs ?? this.timeoutMs,
      retry: this.retry,
      signal: opts?.signal,
    });
    const json = (await res.json()) as OpenAiCompletion;
    return this.parseCompletion(json, req.model || this.opts.model);
  }

  async *stream(req: AiGenerateRequest, opts?: AiGenerateOptions): AsyncIterable<AiStreamEvent> {
    const res = await postJson(this.fetchImpl, this.url(), this.authHeaders(), this.buildBody(req, true), {
      provider: this.name,
      timeoutMs: opts?.timeoutMs ?? this.timeoutMs,
      retry: this.retry,
      signal: opts?.signal,
    });
    if (!res.body) throw new AiProviderError('transport', 'openai: streaming response had no body', { provider: this.name });

    const acc = new OpenAiStreamAccumulator(req.model || this.opts.model);
    // Idle/read timeout stays armed until the body completes or aborts (#1063).
    for await (const { data } of parseSse(res.body, {
      signal: opts?.signal,
      idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
      provider: this.name,
    })) {
      if (data === '[DONE]') break;
      let chunk: OpenAiChunk;
      try {
        chunk = JSON.parse(data) as OpenAiChunk;
      } catch {
        continue; // ignore keep-alive / non-JSON frames
      }
      for (const ev of acc.push(chunk)) yield ev;
    }
    yield { type: 'done', result: acc.finish() };
  }

  private parseCompletion(json: OpenAiCompletion, requestedModel: string): AiGenerateResult {
    const choice = json.choices?.[0];
    const msg = choice?.message;
    const toolCalls: AiToolCall[] = (msg?.tool_calls ?? []).map((tc, i) => ({
      id: tc.id || `call_${i}`,
      name: tc.function?.name ?? '',
      arguments: parseJsonArgs(tc.function?.arguments),
    }));
    return {
      text: msg?.content ?? '',
      toolCalls,
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
        totalTokens: json.usage?.total_tokens ?? (json.usage ? (json.usage.prompt_tokens ?? 0) + (json.usage.completion_tokens ?? 0) : 0),
      },
      finishReason: mapFinishReason(choice?.finish_reason),
      model: json.model ?? requestedModel,
    };
  }

  /** Issue #987: list models from `GET ${baseUrl}/models`. */
  async listModels(): Promise<string[]> {
    const res = await getJson(this.fetchImpl, `${this.baseUrl}/models`, this.authHeaders(), {
      provider: this.name,
      timeoutMs: this.timeoutMs,
    });
    if (!res.ok) throw new AiProviderError('invalid_request', `${this.name}: models request failed (${res.status})`, { provider: this.name });
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    return (data.data ?? []).map((m) => m.id).sort();
  }
}

// ---------- request mapping (neutral → OpenAI wire) ----------

function toOpenAiMessages(req: AiGenerateRequest): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  if (req.system) out.push({ role: 'system', content: req.system });
  for (const m of req.messages) out.push(toOpenAiMessage(m));
  return out;
}

function toOpenAiMessage(m: AiMessage): OpenAiMessage {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content ?? '' };
  }
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: m.content ?? null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
      })),
    };
  }
  return { role: m.role as 'system' | 'user' | 'assistant', content: m.content ?? '' };
}

function toOpenAiTool(t: AiToolSchema): OpenAiTool {
  return { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } };
}

function mapFinishReason(reason: string | null | undefined): AiFinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return reason ? 'unknown' : 'stop';
  }
}

export function parseJsonArgs(raw: string | undefined | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Accumulates streamed OpenAI chunks into a coherent result. Text deltas are emitted
 * live; tool-call argument fragments are stitched per `index` (OpenAI streams a call's
 * JSON arguments across many chunks) and only parsed once at `finish()`.
 */
class OpenAiStreamAccumulator {
  private text = '';
  private readonly toolAcc = new Map<number, { id?: string; name?: string; args: string }>();
  private usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  private finishReason: AiFinishReason = 'stop';
  private model: string;

  constructor(requestedModel: string) {
    this.model = requestedModel;
  }

  *push(chunk: OpenAiChunk): Generator<AiStreamEvent> {
    if (chunk.model) this.model = chunk.model;
    if (chunk.usage) {
      this.usage = {
        promptTokens: chunk.usage.prompt_tokens ?? 0,
        completionTokens: chunk.usage.completion_tokens ?? 0,
        totalTokens: chunk.usage.total_tokens ?? (chunk.usage.prompt_tokens ?? 0) + (chunk.usage.completion_tokens ?? 0),
      };
      yield { type: 'usage', usage: this.usage };
    }
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) this.finishReason = mapFinishReason(choice.finish_reason);
    const delta = choice.delta;
    if (!delta) return;
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      this.text += delta.content;
      yield { type: 'text', delta: delta.content };
    }
    for (const tc of delta.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      const entry = this.toolAcc.get(idx) ?? { args: '' };
      if (tc.id) entry.id = tc.id;
      if (tc.function?.name) entry.name = tc.function.name;
      if (tc.function?.arguments) entry.args += tc.function.arguments;
      this.toolAcc.set(idx, entry);
      yield {
        type: 'tool_call',
        index: idx,
        id: tc.id,
        name: tc.function?.name,
        argumentsDelta: tc.function?.arguments,
      };
    }
  }

  finish(): AiGenerateResult {
    const toolCalls: AiToolCall[] = [...this.toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([idx, e]) => ({ id: e.id || `call_${idx}`, name: e.name ?? '', arguments: parseJsonArgs(e.args) }));
    return {
      text: this.text,
      toolCalls,
      usage: this.usage,
      finishReason: this.finishReason,
      model: this.model,
    };
  }
}

// ---------- OpenAI wire types (private to this adapter) ----------

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
}
interface OpenAiTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}
interface OpenAiCompletion {
  model?: string;
  usage?: OpenAiUsage;
  choices?: {
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      tool_calls?: { id: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
}
interface OpenAiChunk {
  model?: string;
  usage?: OpenAiUsage;
  choices?: {
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
}
