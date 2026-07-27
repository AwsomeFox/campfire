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
  /** Which OpenAI API shape to use. Defaults to 'responses' (the modern Responses API).
   * Set to 'chat_completions' for OpenAI-compatible servers that only speak the legacy shape. */
  endpointMode?: 'chat_completions' | 'responses';
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export class OpenAiProvider implements AiProvider {
  readonly providerType = 'openai' as const;
  readonly name: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly retry: RetryConfig;
  private readonly endpointMode: 'chat_completions' | 'responses';

  constructor(private readonly opts: OpenAiProviderOptions) {
    this.name = opts.name ?? 'openai';
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike);
    if (!this.fetchImpl) throw new AiProviderError('transport', 'openai: no fetch implementation available', { provider: this.name });
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retry = opts.retry ?? DEFAULT_RETRY;
    this.endpointMode = opts.endpointMode ?? 'responses';
  }

  private url(): string {
    return this.endpointMode === 'responses'
      ? `${this.baseUrl}/responses`
      : `${this.baseUrl}/chat/completions`;
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

  private buildResponsesBody(req: AiGenerateRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model || this.opts.model,
      stream,
    };

    if (req.system) body.instructions = req.system;

    body.input = req.messages.flatMap(toResponsesInputItems);

    const temperature = req.temperature ?? this.opts.temperature;
    if (temperature !== undefined) body.temperature = temperature;
    const maxTokens = req.maxTokens ?? this.opts.maxTokens;
    if (maxTokens !== undefined) body.max_output_tokens = maxTokens;

    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map(toResponsesTool);
      if (req.toolChoice === 'none') body.tool_choice = 'none';
      else if (req.toolChoice === 'required') body.tool_choice = 'required';
    }

    return body;
  }

  async generate(req: AiGenerateRequest, opts?: AiGenerateOptions): Promise<AiGenerateResult> {
    const body = this.endpointMode === 'responses'
      ? this.buildResponsesBody(req, false)
      : this.buildBody(req, false);
    const res = await postJson(this.fetchImpl, this.url(), this.authHeaders(), body, {
      provider: this.name,
      timeoutMs: opts?.timeoutMs ?? this.timeoutMs,
      retry: this.retry,
      signal: opts?.signal,
    });
    const json = await res.json();
    return this.endpointMode === 'responses'
      ? this.parseResponsesResult(json as ResponsesApiResponse, req.model || this.opts.model)
      : this.parseCompletion(json as OpenAiCompletion, req.model || this.opts.model);
  }

  async *stream(req: AiGenerateRequest, opts?: AiGenerateOptions): AsyncIterable<AiStreamEvent> {
    const body = this.endpointMode === 'responses'
      ? this.buildResponsesBody(req, true)
      : this.buildBody(req, true);
    const res = await postJson(this.fetchImpl, this.url(), this.authHeaders(), body, {
      provider: this.name,
      timeoutMs: opts?.timeoutMs ?? this.timeoutMs,
      retry: this.retry,
      signal: opts?.signal,
    });
    if (!res.body) throw new AiProviderError('transport', 'openai: streaming response had no body', { provider: this.name });

    if (this.endpointMode === 'responses') {
      const acc = new ResponsesStreamAccumulator(req.model || this.opts.model);
      for await (const { data } of parseSse(res.body, {
        signal: opts?.signal,
        idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
        provider: this.name,
      })) {
        if (data === '[DONE]') break;
        let event: ResponsesStreamEvent;
        try {
          event = JSON.parse(data) as ResponsesStreamEvent;
        } catch {
          continue;
        }
        for (const ev of acc.push(event)) yield ev;
        // #598: break on EVERY terminal frame, not just the happy one. A content-filtered or
        // failed response ends on `response.incomplete` / `response.failed`; leaving the loop
        // spinning after one of those made the adapter depend on a trailing `[DONE]` to stop.
        // Real OpenAI sends it, but an OpenAI-compatible proxy that does not would hang here
        // until the idle timeout — and the frame it would be hanging after is precisely the one
        // that says the turn was refused, so the retraction would be delayed by that timeout.
        if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') break;
      }
      yield { type: 'done', result: acc.finish() };
    } else {
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
  }

  private parseCompletion(json: OpenAiCompletion, requestedModel: string): AiGenerateResult {
    const choice = json.choices?.[0];
    const msg = choice?.message;
    const toolCalls: AiToolCall[] = (msg?.tool_calls ?? []).map((tc, i) => ({
      id: tc.id || `call_${i}`,
      name: tc.function?.name ?? '',
      arguments: parseJsonArgs(tc.function?.arguments),
    }));
    // #598 — a Chat Completions refusal, which reports `finish_reason: 'stop'`. Its text is
    // deliberately NOT folded into `text`: a refusal is not narration, and this adapter's job
    // is to report the terminal state rather than hand the driver something to broadcast.
    const refused = typeof msg?.refusal === 'string' && msg.refusal.length > 0;
    return {
      text: msg?.content ?? '',
      toolCalls,
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
        totalTokens: json.usage?.total_tokens ?? (json.usage ? (json.usage.prompt_tokens ?? 0) + (json.usage.completion_tokens ?? 0) : 0),
      },
      // Safety-first precedence, matching the Responses path: a refusal outranks the wire's
      // `stop` (which it is always paired with) AND outranks `tool_calls`, so a response that
      // both declined and asked for tools can never dispatch them.
      finishReason: resolveChatFinish(choice?.finish_reason, refused, toolCalls.length),
      model: json.model ?? requestedModel,
    };
  }

  private parseResponsesResult(json: ResponsesApiResponse, requestedModel: string): AiGenerateResult {
    let text = '';
    let refused = false;
    const toolCalls: AiToolCall[] = [];

    for (const item of json.output ?? []) {
      if (item.type === 'message') {
        for (const part of item.content ?? []) {
          if (part.type === 'output_text') text += part.text ?? '';
          // #598: a `refusal` part is the model declining. Its text is deliberately NOT
          // concatenated into `text` — a refusal is not narration, and this adapter's job is
          // to report the terminal state, not to hand the driver something to broadcast.
          else if (part.type === 'refusal') refused = true;
        }
      } else if (item.type === 'refusal') {
        refused = true;
      } else if (item.type === 'function_call') {
        toolCalls.push({
          id: item.call_id ?? item.id ?? `call_${toolCalls.length}`,
          name: item.name ?? '',
          arguments: parseJsonArgs(item.arguments),
        });
      }
    }

    return {
      text,
      toolCalls,
      usage: {
        promptTokens: json.usage?.input_tokens ?? 0,
        completionTokens: json.usage?.output_tokens ?? 0,
        totalTokens: (json.usage?.input_tokens ?? 0) + (json.usage?.output_tokens ?? 0),
      },
      // #598: the SAFETY terminal state outranks `tool_calls`. A response that both refused
      // (or tripped the filter) and asked for tools previously reported `tool_calls`, which
      // erased the refusal entirely and let the driver dispatch the very calls that came
      // packaged with it. Resolve safety first, and only fall back to tool_calls.
      finishReason: resolveResponsesFinish(json, refused, toolCalls.length),
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

function toResponsesInputItems(m: AiMessage): ResponsesInputItem[] {
  if (m.role === 'tool') {
    return [{
      type: 'function_call_output',
      call_id: m.toolCallId ?? '',
      output: m.content ?? '',
    }];
  }
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    const items: ResponsesInputItem[] = m.toolCalls.map((tc) => ({
      type: 'function_call' as const,
      id: tc.id,
      call_id: tc.id,
      name: tc.name,
      arguments: JSON.stringify(tc.arguments ?? {}),
    }));
    if (m.content) {
      items.unshift({ type: 'message', role: 'assistant', content: m.content });
    }
    return items;
  }
  return [{
    type: 'message',
    role: m.role as 'user' | 'assistant',
    content: m.content ?? '',
  }];
}

function toResponsesTool(t: AiToolSchema): ResponsesTool {
  return {
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  };
}

/**
 * Map a Responses-API terminal status onto a normalized finish reason.
 *
 * `incompleteReason` is load-bearing (#598). The Responses protocol reports BOTH "ran out of
 * output tokens" and "the content filter stopped this" as `status: 'incomplete'`, and tells
 * them apart only in `incomplete_details.reason`. Ignoring that field — which is what this
 * adapter did — reported a filtered turn as `length`, i.e. as an ordinary truncation, so the
 * safety terminal state simply did not exist on this protocol. The Chat Completions path had
 * `finish_reason: 'content_filter'` all along; this closes the gap between the two.
 */
function mapResponsesStatus(status: string | undefined, incompleteReason?: string | null): AiFinishReason {
  switch (status) {
    case 'completed': return 'stop';
    case 'incomplete': return incompleteReason === 'content_filter' ? 'content_filter' : 'length';
    case 'failed': return incompleteReason === 'content_filter' ? 'content_filter' : 'unknown';
    default: return 'stop';
  }
}

/**
 * Resolve a Responses-API finish reason with SAFETY FIRST (#598).
 *
 * Order matters and is the point of this helper: an explicit refusal, then a filter status,
 * then tool calls, then whatever the status said. The old inline expression put `tool_calls`
 * first, so a filtered/refused response that happened to carry tool calls reported
 * `tool_calls` — the driver would then have dispatched tools from a response the provider had
 * just declined to stand behind.
 */
function resolveResponsesFinish(
  json: ResponsesApiResponse,
  refused: boolean,
  toolCallCount: number,
): AiFinishReason {
  if (refused) return 'refusal';
  const mapped = mapResponsesStatus(json.status, json.incomplete_details?.reason);
  if (mapped === 'content_filter') return 'content_filter';
  return toolCallCount > 0 ? 'tool_calls' : mapped;
}

/**
 * Resolve a CHAT COMPLETIONS finish reason with the same safety-first precedence (#598).
 *
 * The Chat Completions twin of the Responses gap above, and a nastier one. On this protocol a
 * model refusal is reported in `message.refusal` (or streamed `delta.refusal`) while
 * `finish_reason` stays **`stop`** — the identical terminal state as a perfectly good answer.
 * So unlike a content filter, there is no value of `finish_reason` that betrays it: an adapter
 * that reads only that field cannot distinguish a refusal from success, and the driver files
 * the turn as ordinary narration or `no_narration` rather than as a withheld incident.
 *
 * `refused` therefore outranks the wire's own finish reason rather than merely competing with
 * it, and — as on the Responses path — outranks `tool_calls`, so a response that both declined
 * and asked for tools can never dispatch them.
 *
 * @param wireReason the raw `finish_reason`, when the caller has one to map.
 * @param alreadyMapped a pre-mapped reason (the streaming accumulator maps as chunks arrive).
 */
function resolveChatFinish(
  wireReason: string | null | undefined,
  refused: boolean,
  toolCallCount: number,
  alreadyMapped?: AiFinishReason,
): AiFinishReason {
  if (refused) return 'refusal';
  const mapped = alreadyMapped ?? mapFinishReason(wireReason);
  if (mapped === 'content_filter') return 'content_filter';
  return toolCallCount > 0 && mapped === 'stop' ? 'tool_calls' : mapped;
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
  /** #598 — a `delta.refusal` arrived. Sticky: nothing later re-opens that decision. */
  private refused = false;
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
    // #598 — a streamed refusal. Sticky, and NOT emitted as a text delta: the whole point of
    // the withhold is that refusal prose never reaches the table, so forwarding it here would
    // put it on the wire ahead of the terminal frame that says it was refused.
    if (typeof delta.refusal === 'string' && delta.refusal.length > 0) this.refused = true;
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
      // Safety-first precedence, as on the non-streaming path.
      finishReason: resolveChatFinish(undefined, this.refused, toolCalls.length, this.finishReason),
      model: this.model,
    };
  }
}

class ResponsesStreamAccumulator {
  private text = '';
  private readonly toolAcc = new Map<string, { id: string; name: string; args: string }>();
  private usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  private model: string;
  private currentToolCallId = '';
  /** Terminal status from the last response.{completed,incomplete,failed} frame (#598). */
  private status: string | undefined;
  /** `incomplete_details.reason` — the only place this protocol says "content filter" (#598). */
  private incompleteReason: string | null = null;
  /** The model emitted a refusal part/delta this response (#598). */
  private refused = false;

  constructor(requestedModel: string) {
    this.model = requestedModel;
  }

  *push(event: ResponsesStreamEvent): Generator<AiStreamEvent> {
    switch (event.type) {
      case 'response.output_item.added': {
        if (event.item?.type === 'function_call') {
          this.currentToolCallId = event.item.call_id ?? event.item.id ?? '';
          this.toolAcc.set(this.currentToolCallId, {
            id: this.currentToolCallId,
            name: event.item.name ?? '',
            args: '',
          });
        }
        break;
      }
      case 'response.output_text.delta': {
        const delta = event.delta ?? '';
        this.text += delta;
        yield { type: 'text', delta };
        break;
      }
      case 'response.function_call_arguments.delta': {
        const delta = event.delta ?? '';
        const callId = event.call_id ?? event.item_id ?? this.currentToolCallId;
        const entry = this.toolAcc.get(callId);
        if (entry) entry.args += delta;
        const idx = [...this.toolAcc.keys()].indexOf(callId);
        yield {
          type: 'tool_call',
          index: idx >= 0 ? idx : 0,
          id: callId || undefined,
          argumentsDelta: delta,
        };
        break;
      }
      // #598: the model declining. A refusal delta is NOT forwarded as a text delta — it is
      // not narration, and forwarding it would put the decline into the table's DM bubble.
      // Recording the terminal state is the whole job here.
      case 'response.refusal.delta':
      case 'response.refusal.done': {
        this.refused = true;
        break;
      }
      // #598: `response.completed` is not the only terminal frame. A filtered or failed
      // response ends on `response.incomplete` / `response.failed`, neither of which this
      // accumulator looked at — so the stream simply ended with the default `stop` and the
      // safety signal never reached the driver.
      case 'response.completed':
      case 'response.incomplete':
      case 'response.failed': {
        const resp = event.response;
        if (resp?.usage) {
          this.usage = {
            promptTokens: resp.usage.input_tokens ?? 0,
            completionTokens: resp.usage.output_tokens ?? 0,
            totalTokens: (resp.usage.input_tokens ?? 0) + (resp.usage.output_tokens ?? 0),
          };
          yield { type: 'usage', usage: this.usage };
        }
        if (resp?.model) this.model = resp.model;
        this.status = resp?.status;
        this.incompleteReason = resp?.incomplete_details?.reason ?? null;
        break;
      }
    }
  }

  finish(): AiGenerateResult {
    const toolCalls: AiToolCall[] = [...this.toolAcc.values()].map((e) => ({
      id: e.id,
      name: e.name,
      arguments: parseJsonArgs(e.args),
    }));
    return {
      text: this.text,
      toolCalls,
      usage: this.usage,
      // Same safety-first resolution as the non-streaming path (#598), so the two protocols
      // and the two transports cannot disagree about whether a turn was withheld.
      finishReason: resolveResponsesFinish(
        { status: this.status, incomplete_details: { reason: this.incompleteReason } },
        this.refused,
        toolCalls.length,
      ),
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
      /**
       * #598 — the model declining, on the Chat Completions protocol.
       *
       * The trap is that this arrives alongside `finish_reason: 'stop'` — the SAME terminal
       * state as an ordinary successful answer. Reading only `finish_reason` therefore
       * classifies a refusal as deliverable, and the driver files it as a normal or empty
       * turn instead of a withheld one. The refusal is knowable ONLY from this field.
       */
      refusal?: string | null;
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
      /** #598 — streamed counterpart of `message.refusal`, with the same `stop` trap. */
      refusal?: string | null;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
}

// ---------- OpenAI Responses API wire types (private to this adapter) ----------

interface ResponsesInputItem {
  type: 'message' | 'function_call' | 'function_call_output';
  role?: 'user' | 'assistant';
  content?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
}

interface ResponsesTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface ResponsesApiResponse {
  id?: string;
  model?: string;
  status?: string;
  /**
   * Why an `incomplete` response stopped (#598). Without this the adapter could only see
   * `status: 'incomplete'` and reported every one as `length`, so a content-filtered turn on
   * this protocol was indistinguishable from one that merely ran out of output tokens.
   */
  incomplete_details?: { reason?: string | null };
  output?: {
    // `refusal` is a first-class output/content part on this protocol: the model declines and
    // the decline text comes back in its own part rather than as `output_text` (#598).
    type: 'message' | 'function_call' | 'refusal';
    content?: { type: string; text?: string; refusal?: string }[];
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

interface ResponsesStreamEvent {
  type: string;
  item?: {
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
  };
  delta?: string;
  call_id?: string;
  item_id?: string;
  response?: ResponsesApiResponse;
}
