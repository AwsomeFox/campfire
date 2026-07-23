/**
 * Deterministic mock / echo provider (#309, unblocks #318 evals). Makes NO network call,
 * returns canned responses, and RECORDS every request it received so tests can assert on
 * the exact prompt/message history/tools a caller assembled. Fully implements the
 * `AiProvider` contract, including a streaming path that chunks the canned text so
 * streaming consumers exercise the same code path they would against a real provider.
 *
 * Behaviour is a small deterministic queue:
 *   - `responses`: an ordered list consumed one per `generate`/`stream` call;
 *   - when exhausted (or empty), falls back to `echo` — the reply text echoes the last
 *     user message, verbatim and reproducibly.
 * Usage counts are derived deterministically from text length (a stable ~4-chars/token
 * model) so budget-metering assertions are exact and reproducible.
 */

import type {
  AiProvider,
  AiGenerateRequest,
  AiGenerateResult,
  AiGenerateOptions,
  AiStreamEvent,
  AiToolCall,
  AiFinishReason,
  AiUsage,
} from './ai-provider';

/** A single canned reply. Any field omitted gets a deterministic default. */
export interface MockResponse {
  /** Reply text. Defaults to an echo of the last user message. */
  text?: string;
  /** Tool calls to return (drives tool-loop tests without a live model). */
  toolCalls?: AiToolCall[];
  /** Override usage; otherwise derived from prompt + reply length. */
  usage?: AiUsage;
  finishReason?: AiFinishReason;
  /** How many text chunks `stream()` splits `text` into (default 3). */
  streamChunks?: number;
  /**
   * After yielding this many text chunks, throw {@link throwError} (#1046).
   * Defaults to 0 (throw before any chunk) when `throwError` is set.
   */
  throwAfterChunks?: number;
  /** Throw this error from `generate`/`stream` instead of returning a reply (#1046). */
  throwError?: Error;
}

export interface MockProviderOptions {
  /** Ordered canned responses, consumed one per call. */
  responses?: MockResponse[];
  /** Model label echoed back in results. */
  model?: string;
  name?: string;
}

/** ~4 chars/token, matching the repo's existing back-of-envelope ratio. Never zero for non-empty text. */
export function mockTokenCount(text: string): number {
  return text.length === 0 ? 0 : Math.max(1, Math.ceil(text.length / 4));
}

export class MockAiProvider implements AiProvider {
  readonly providerType = 'mock' as const;
  readonly name: string;
  readonly model: string;
  /** Every request this provider was asked to serve, in order — inspect in tests. */
  readonly received: AiGenerateRequest[] = [];
  private readonly queue: MockResponse[];
  private cursor = 0;

  constructor(opts: MockProviderOptions = {}) {
    this.name = opts.name ?? 'mock';
    this.model = opts.model ?? 'mock-model';
    this.queue = opts.responses ?? [];
  }

  /** Next canned response (or an echo fallback), advancing the cursor. */
  private next(): MockResponse {
    const r = this.cursor < this.queue.length ? this.queue[this.cursor] : {};
    this.cursor += 1;
    return r;
  }

  private build(req: AiGenerateRequest, canned: MockResponse): AiGenerateResult {
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    const text = canned.text ?? (lastUser?.content ? `echo: ${lastUser.content}` : '');
    const toolCalls = canned.toolCalls ?? [];
    const promptText = (req.system ?? '') + req.messages.map((m) => m.content ?? '').join('\n');
    const usage: AiUsage = canned.usage ?? {
      promptTokens: mockTokenCount(promptText),
      completionTokens: mockTokenCount(text),
      totalTokens: mockTokenCount(promptText) + mockTokenCount(text),
    };
    const finishReason: AiFinishReason = canned.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop');
    return { text, toolCalls, usage, finishReason, model: this.model };
  }

  async generate(req: AiGenerateRequest, _opts?: AiGenerateOptions): Promise<AiGenerateResult> {
    this.received.push(req);
    const canned = this.next();
    if (canned.throwError) throw canned.throwError;
    return this.build(req, canned);
  }

  async *stream(req: AiGenerateRequest, _opts?: AiGenerateOptions): AsyncIterable<AiStreamEvent> {
    this.received.push(req);
    const canned = this.next();
    const result = this.build(req, canned);
    // Chunk the text so streaming consumers get multiple deltas, deterministically.
    const nChunks = Math.max(1, canned.streamChunks ?? 3);
    const parts = splitEven(result.text, nChunks);
    const throwAfter = canned.throwError ? (canned.throwAfterChunks ?? 0) : undefined;
    let yielded = 0;
    if (throwAfter === 0 && canned.throwError) throw canned.throwError;
    for (const part of parts) {
      if (part.length > 0) {
        yield { type: 'text', delta: part };
        yielded += 1;
      }
      // Mid-stream provider failure (#1046) — e.g. upstream 500 after first tokens.
      if (canned.throwError && throwAfter !== undefined && yielded >= throwAfter) {
        throw canned.throwError;
      }
    }
    for (let index = 0; index < result.toolCalls.length; index++) {
      const tc = result.toolCalls[index];
      yield {
        type: 'tool_call',
        index,
        id: tc.id,
        name: tc.name,
        argumentsDelta: JSON.stringify(tc.arguments ?? {}),
      };
    }
    yield { type: 'usage', usage: result.usage };
    yield { type: 'done', result };
  }
}

/** Split a string into `n` roughly-equal contiguous chunks (deterministic). */
function splitEven(text: string, n: number): string[] {
  if (text.length === 0) return [''];
  const size = Math.ceil(text.length / n);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
