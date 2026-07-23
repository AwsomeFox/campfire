/**
 * Anthropic Messages API adapter (#309). Thin fetch-based client (no vendor SDK) covering
 * the `/v1/messages` shape: content-block messages, tool_use / tool_result, streaming SSE,
 * and real input/output token usage. The `fetch` impl is injectable so tests run against
 * recorded fixtures.
 *
 * All Anthropic wire types stay INSIDE this file: the class only accepts/returns the
 * vendor-neutral `AiProvider` types. Notable shape differences the adapter normalizes:
 *   - the system prompt is a TOP-LEVEL field, not a message;
 *   - messages carry an array of content BLOCKS (text / tool_use / tool_result);
 *   - a neutral `tool` message becomes a `user` message with a `tool_result` block;
 *   - usage is split input/output (no total) — we sum it.
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
  postJson,
  parseSse,
} from './http';

export interface AnthropicProviderOptions {
  apiKey: string;
  /** Defaults to the public Anthropic endpoint; override for a proxy/gateway. */
  baseUrl?: string;
  model: string;
  temperature?: number;
  /** Anthropic REQUIRES max_tokens; falls back to this when the request omits it. */
  maxTokens?: number;
  /** Messages API version header. Defaults to a known-good stable value. */
  anthropicVersion?: string;
  timeoutMs?: number;
  retry?: RetryConfig;
  fetchImpl?: FetchLike;
  headers?: Record<string, string>;
  name?: string;
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 1024;

export class AnthropicProvider implements AiProvider {
  readonly providerType = 'anthropic' as const;
  readonly name: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly retry: RetryConfig;

  constructor(private readonly opts: AnthropicProviderOptions) {
    this.name = opts.name ?? 'anthropic';
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike);
    if (!this.fetchImpl) throw new AiProviderError('transport', 'anthropic: no fetch implementation available', { provider: this.name });
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retry = opts.retry ?? DEFAULT_RETRY;
  }

  private url(): string {
    return `${this.baseUrl}/v1/messages`;
  }

  private authHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': this.opts.apiKey,
      'anthropic-version': this.opts.anthropicVersion ?? DEFAULT_VERSION,
      ...this.opts.headers,
    };
  }

  private buildBody(req: AiGenerateRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model || this.opts.model,
      messages: toAnthropicMessages(req.messages),
      max_tokens: req.maxTokens ?? this.opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream,
    };
    if (req.system) body.system = req.system;
    const temperature = req.temperature ?? this.opts.temperature;
    if (temperature !== undefined) body.temperature = temperature;
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map(toAnthropicTool);
      if (req.toolChoice === 'required') body.tool_choice = { type: 'any' };
      else if (req.toolChoice === 'none') body.tool_choice = { type: 'none' };
      else body.tool_choice = { type: 'auto' };
    }
    return body;
  }

  async generate(req: AiGenerateRequest, opts?: AiGenerateOptions): Promise<AiGenerateResult> {
    const res = await postJson(this.fetchImpl, this.url(), this.authHeaders(), this.buildBody(req, false), {
      provider: this.name,
      timeoutMs: opts?.timeoutMs ?? this.timeoutMs,
      retry: this.retry,
      signal: opts?.signal,
    });
    const json = (await res.json()) as AnthropicMessage;
    return parseAnthropicMessage(json, req.model || this.opts.model);
  }

  async *stream(req: AiGenerateRequest, opts?: AiGenerateOptions): AsyncIterable<AiStreamEvent> {
    const res = await postJson(this.fetchImpl, this.url(), this.authHeaders(), this.buildBody(req, true), {
      provider: this.name,
      timeoutMs: opts?.timeoutMs ?? this.timeoutMs,
      retry: this.retry,
      signal: opts?.signal,
    });
    if (!res.body) throw new AiProviderError('transport', 'anthropic: streaming response had no body', { provider: this.name });

    const acc = new AnthropicStreamAccumulator(req.model || this.opts.model);
    for await (const { event, data } of parseSse(res.body)) {
      let payload: AnthropicStreamEvent;
      try {
        payload = JSON.parse(data) as AnthropicStreamEvent;
      } catch {
        continue;
      }
      for (const ev of acc.push(event, payload)) yield ev;
      if ((event ?? payload.type) === 'message_stop') break;
    }
    yield { type: 'done', result: acc.finish() };
  }
}

// ---------- request mapping (neutral → Anthropic wire) ----------

function toAnthropicMessages(messages: AiMessage[]): AnthropicWireMessage[] {
  const out: AnthropicWireMessage[] = [];
  let pendingToolResults: AnthropicContentBlock[] = [];

  for (const m of messages) {
    if (m.role === 'tool') {
      // Accumulate tool results — they'll be flushed as one user message
      pendingToolResults.push({ type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content ?? '' });
      continue;
    }

    // Flush any pending tool results before processing a non-tool message
    if (pendingToolResults.length > 0) {
      out.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = [];
    }

    if (m.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments ?? {} });
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    // user (and any stray system slipped into history) → user text block
    out.push({ role: 'user', content: [{ type: 'text', text: m.content ?? '' }] });
  }

  // Flush any trailing tool results
  if (pendingToolResults.length > 0) {
    out.push({ role: 'user', content: pendingToolResults });
  }

  return out;
}

function toAnthropicTool(t: AiToolSchema): AnthropicTool {
  return { name: t.name, description: t.description, input_schema: t.parameters };
}

function parseAnthropicMessage(json: AnthropicMessage, requestedModel: string): AiGenerateResult {
  let text = '';
  const toolCalls: AiToolCall[] = [];
  for (const block of json.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') text += block.text;
    else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id ?? `call_${toolCalls.length}`,
        name: block.name ?? '',
        arguments: (block.input as Record<string, unknown>) ?? {},
      });
    }
  }
  const input = json.usage?.input_tokens ?? 0;
  const output = json.usage?.output_tokens ?? 0;
  return {
    text,
    toolCalls,
    usage: { promptTokens: input, completionTokens: output, totalTokens: input + output },
    finishReason: mapStopReason(json.stop_reason),
    model: json.model ?? requestedModel,
  };
}

function mapStopReason(reason: string | null | undefined): AiFinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return reason ? 'unknown' : 'stop';
  }
}

/**
 * Accumulates Anthropic SSE events into a coherent result. Anthropic streams a message
 * as: message_start (input usage) → per-block content_block_start / _delta / _stop →
 * message_delta (stop_reason + output usage) → message_stop. Text deltas emit live;
 * tool_use JSON arrives as `input_json_delta` fragments stitched per block index.
 */
class AnthropicStreamAccumulator {
  private text = '';
  private readonly blocks = new Map<number, { type: string; id?: string; name?: string; json: string; text: string }>();
  private usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  private finishReason: AiFinishReason = 'stop';
  private model: string;

  constructor(requestedModel: string) {
    this.model = requestedModel;
  }

  *push(event: string | null, payload: AnthropicStreamEvent): Generator<AiStreamEvent> {
    const type = event ?? payload.type;
    switch (type) {
      case 'message_start': {
        if (payload.message?.model) this.model = payload.message.model;
        const input = payload.message?.usage?.input_tokens ?? 0;
        this.usage = { promptTokens: input, completionTokens: 0, totalTokens: input };
        break;
      }
      case 'content_block_start': {
        const idx = payload.index ?? 0;
        const block = payload.content_block;
        if (block?.type === 'tool_use') {
          this.blocks.set(idx, { type: 'tool_use', id: block.id, name: block.name, json: '', text: '' });
          yield { type: 'tool_call', index: idx, id: block.id, name: block.name };
        } else {
          this.blocks.set(idx, { type: 'text', json: '', text: '' });
        }
        break;
      }
      case 'content_block_delta': {
        const idx = payload.index ?? 0;
        const entry = this.blocks.get(idx) ?? { type: 'text', json: '', text: '' };
        const delta = payload.delta;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          entry.text += delta.text;
          this.text += delta.text;
          this.blocks.set(idx, entry);
          yield { type: 'text', delta: delta.text };
        } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          entry.json += delta.partial_json;
          this.blocks.set(idx, entry);
          yield { type: 'tool_call', index: idx, argumentsDelta: delta.partial_json };
        }
        break;
      }
      case 'message_delta': {
        if (payload.delta?.stop_reason) this.finishReason = mapStopReason(payload.delta.stop_reason);
        if (payload.usage?.output_tokens !== undefined) {
          this.usage = {
            promptTokens: this.usage.promptTokens,
            completionTokens: payload.usage.output_tokens,
            totalTokens: this.usage.promptTokens + payload.usage.output_tokens,
          };
          yield { type: 'usage', usage: this.usage };
        }
        break;
      }
      default:
        break;
    }
  }

  finish(): AiGenerateResult {
    const toolCalls: AiToolCall[] = [...this.blocks.entries()]
      .filter(([, b]) => b.type === 'tool_use')
      .sort((a, b) => a[0] - b[0])
      .map(([idx, b]) => ({ id: b.id || `call_${idx}`, name: b.name ?? '', arguments: parseJson(b.json) }));
    return { text: this.text, toolCalls, usage: this.usage, finishReason: this.finishReason, model: this.model };
  }
}

function parseJson(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const p = JSON.parse(raw);
    return p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---------- Anthropic wire types (private to this adapter) ----------

interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
}
interface AnthropicWireMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
}
interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
}
interface AnthropicMessage {
  model?: string;
  stop_reason?: string | null;
  usage?: AnthropicUsage;
  content?: AnthropicContentBlock[];
}
interface AnthropicStreamEvent {
  type: string;
  index?: number;
  message?: { model?: string; usage?: AnthropicUsage };
  content_block?: { type: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string | null };
  usage?: AnthropicUsage;
}
