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
  postAndReadJson,
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
    const data = await postAndReadJson<GeminiResponse>(this.fetchImpl, url, this.authHeaders(), body, {
      provider: this.name,
      timeoutMs: opts?.timeoutMs ?? this.timeoutMs,
      retry: this.retry,
      signal: opts?.signal,
    });
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
    // Default to 'stop' (parity with parseResult and the OpenAI/Anthropic stream
    // adapters) so an omitted Gemini finishReason never leaks 'unknown' downstream.
    let finishReason: AiFinishReason = 'stop';
    // #598: a PROMPT-level block, which is a different payload shape from a candidate-level
    // one — see `isPromptBlocked`. Sticky and terminal: once the policy layer has refused the
    // request there is no later frame that can make the turn deliverable again.
    let promptBlocked = false;

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
      // #598: when Gemini blocks the PROMPT it sends no candidate at all — so the parts branch
      // below never runs, `finishReason` kept its `stop` default, and the driver saw an
      // ordinary empty turn (`no_narration`) instead of a withheld one. The block reason lives
      // on `promptFeedback`, which can ride the SAME chunk as a candidate — so it is read
      // BEFORE the parts loop, not after it, or a chunk carrying both would broadcast its text
      // before the block was known.
      if (isPromptBlocked(chunk)) promptBlocked = true;
      if (candidate?.content?.parts) {
        for (const part of candidate.content.parts) {
          // Handle text and functionCall independently (a part could carry both),
          // mirroring the non-streaming parse so the two paths never diverge.
          if (part.text) {
            totalText += part.text;
            // NO PATH MAY BROADCAST TEXT FOR A TURN ALREADY KNOWN TO BE WITHHELD — the
            // invariant driver-safety.ts opens with, applied here the way the OpenAI chat
            // accumulator applies it after a refusal. Once the block is known every later
            // delta belongs to a refused turn, so this is not the quarantine's bounded
            // residual: it would be text released after the very signal the window waits for.
            //
            // `totalText` still accumulates, deliberately. It never reaches the table; it is
            // what the budget estimator measures, and a turn that generated tokens must still
            // be paid for. Stop the broadcast, keep the measurement.
            //
            // Unreachable on today's wire — a prompt block arrives with no candidate and the
            // stream ends there — so this is defence against a wire change, not a live leak.
            if (!promptBlocked) yield { type: 'text', delta: part.text };
          }
          if (part.functionCall) {
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
        // A prompt block outranks anything a candidate reported (and outranks the
        // tool-call normalization): the policy layer refused the request itself.
        finishReason: promptBlocked ? 'content_filter' : resolveStreamFinishReason(finishReason, toolCalls.length),
        model: req.model || this.opts.model,
      },
    };
  }

  private parseResult(data: GeminiResponse, model: string): AiGenerateResult {
    const candidate = data.candidates?.[0];
    // #598 — a PROMPT-level block: Gemini refused the request before generating, so it returns
    // `promptFeedback.blockReason` with no candidate and no candidate `finishReason`. This used
    // to throw `invalid_request`, which the driver reports as `provider_error` — a plumbing
    // fault, with the plumbing sentence and the plumbing lever set in front of the table for
    // what is actually the safety layer doing its job. It is a normal, complete, empty result
    // carrying `content_filter`, so the withhold path records it like every other refusal.
    if (isPromptBlocked(data)) {
      return {
        text: '',
        toolCalls: [],
        usage: data.usageMetadata ? mapUsage(data.usageMetadata) : { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: 'content_filter',
        model: model || this.opts.model,
      };
    }
    if (!candidate) {
      throw new AiProviderError('invalid_request', `${this.name}: no candidates in response`, { provider: this.name });
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
    const { getJson, readJsonBody } = await import('./http');
    const res = await getJson(this.fetchImpl, `${this.baseUrl}/models`, this.authHeaders(), {
      provider: this.name,
      timeoutMs: this.timeoutMs,
    });
    if (!res.ok) throw new AiProviderError('invalid_request', `${this.name}: models request failed (${res.status})`, { provider: this.name });
    // `getJson` has no retry loop (model lists are not transient), so the parse guard is
    // applied at the call site rather than through `postAndReadJson`.
    const data = await readJsonBody<{ models?: Array<{ name: string }> }>(res, this.name);
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
    // #598: every one of these is Gemini's policy layer stopping the generation. The newer
    // members (PROHIBITED_CONTENT / SPII / BLOCKLIST / IMAGE_SAFETY) were falling through to
    // `unknown`, which the driver treats as a deliverable turn — the exact fail-open this
    // issue is about, just on a third protocol.
    case 'SAFETY':
    case 'RECITATION':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'BLOCKLIST':
    case 'IMAGE_SAFETY':
      return 'content_filter';
    default:
      return 'unknown';
  }
}

/**
 * Did Gemini block the PROMPT (#598)?
 *
 * A distinct payload shape from a candidate-level block: `promptFeedback.blockReason` is set,
 * there is no candidate, and therefore no candidate `finishReason` for {@link mapFinishReason}
 * to read. Both transports have to recognise it separately or a prompt block silently becomes
 * a deliverable empty turn.
 *
 * Any non-empty `blockReason` counts, including `OTHER` and the `BLOCK_REASON_UNSPECIFIED`
 * sentinel. The field exists ONLY to say "this was blocked" — Gemini omits it entirely
 * otherwise — so an unrecognised value is a block whose category this adapter does not know,
 * not a non-block. Guessing the other way is the fail-open #598 exists to close.
 */
function isPromptBlocked(data: GeminiResponse): boolean {
  return typeof data.promptFeedback?.blockReason === 'string' && data.promptFeedback.blockReason.length > 0;
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
