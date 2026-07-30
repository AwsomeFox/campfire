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
import { streamAbortError } from './http';

/** A single canned reply. Any field omitted gets a deterministic default. */
export interface MockResponse {
  /** Reply text. Defaults to an echo of the last user message. */
  text?: string;
  /** Tool calls to return (drives tool-loop tests without a live model). */
  toolCalls?: AiToolCall[];
  /** Override usage; otherwise derived from prompt + reply length. */
  usage?: AiUsage;
  finishReason?: AiFinishReason;
  /**
   * #598 — refusal characters the provider produced, as the real adapters report them: a
   * LENGTH, with the prose itself never surfacing as narration. Lets a test model the shape
   * that broke budget metering — a refusal-only turn whose only output is refusal text.
   */
  refusalChars?: number;
  /** How many text chunks `stream()` splits `text` into (default 3). */
  streamChunks?: number;
  /** When false, omit text deltas and only emit the final `done` (simulates done-only narration). */
  streamTextDeltas?: boolean;
  /**
   * After yielding this many text chunks, throw {@link throwError} (#1046).
   * Defaults to 0 (throw before any chunk) when `throwError` is set.
   */
  throwAfterChunks?: number;
  /**
   * After yielding this many text chunks, hang until `opts.signal` aborts (#1063).
   * Simulates a provider stream that stalls mid-body with no error.
   */
  stallAfterChunks?: number;
  /** Throw after emitting the usage frame but before `done` (#560). */
  throwAfterUsage?: boolean;
  /**
   * #598 — hang AFTER `done` until the generation signal aborts, then end the stream cleanly.
   *
   * Exists to make the teardown RACE deterministic: it holds the stream open at the one instant
   * where `result` is already populated (so the terminal safety frame has landed) but
   * streamStep's `finally` has not yet run. A test can then tear the session down inside that
   * window, which is otherwise a few microseconds wide and untestable.
   */
  stallAfterDone?: boolean;
  /** Throw when the first tool_call delta is yielded (#560). */
  throwDuringToolCall?: boolean;
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
  /**
   * #1500 — set the first time {@link next} is called past the end of the canned queue, i.e. the
   * provider fell back to an echo reply. Once true a scripted test has desynced: the driver made
   * more provider calls than were scripted, and every later `script(...)` push lands behind the
   * cursor and is silently dropped — so the harness refuses further `script(...)` calls until a
   * reset. Cleared by {@link clearResponses}.
   */
  private exhausted = false;
  /**
   * #1500 — how many provider calls were answered by the echo fallback (cursor already past the
   * canned queue) since the last reset. Zero means every call consumed a scripted response; the
   * harness' `assertScriptDrained` asserts this stays zero so a desynced test can no longer
   * echo-pass.
   */
  private echoFallbackCount = 0;
  /**
   * #598 — invoked the instant a {@link MockResponse.stallAfterDone} stall begins. Lets a test
   * act inside the window between the terminal frame landing and the driver's `finally`.
   */
  onStall?: () => void;

  constructor(opts: MockProviderOptions = {}) {
    this.name = opts.name ?? 'mock';
    this.model = opts.model ?? 'mock-model';
    this.queue = opts.responses ?? [];
  }

  /**
   * Drop unconsumed canned responses and rewind the cursor. Call between tests that share
   * one harness — a tool_error / budget_exhausted stop can leave queued turns that would
   * otherwise bleed into the next case.
   */
  clearResponses(): void {
    this.queue.length = 0;
    this.cursor = 0;
    // #1500 — a fresh queue is no longer exhausted and owes no echoes.
    this.exhausted = false;
    this.echoFallbackCount = 0;
  }

  /** Clear the request log (pairs with {@link clearResponses} for isolation). */
  clearReceived(): void {
    this.received.length = 0;
  }

  /** #1500 — true once the canned queue ran out and the provider served an echo fallback. */
  get isExhausted(): boolean {
    return this.exhausted;
  }

  /** #1500 — number of provider calls answered by the echo fallback since the last reset. */
  get echoFallbacks(): number {
    return this.echoFallbackCount;
  }

  /** Next canned response (or an echo fallback), advancing the cursor. */
  private next(): MockResponse {
    if (this.cursor >= this.queue.length) {
      // #1500 — record the desync: the driver asked for a turn no test scripted, so the mock is
      // about to return an echo with `finishReason: 'stop'` and no tool calls — a reply a
      // desynced test can silently read as a clean `complete`. Surfaced via isExhausted /
      // echoFallbacks so the harness can fail the test instead of echo-passing.
      this.exhausted = true;
      this.echoFallbackCount += 1;
      this.cursor += 1;
      return {};
    }
    const r = this.queue[this.cursor];
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
    return {
      text,
      toolCalls,
      usage,
      finishReason,
      model: this.model,
      ...(canned.refusalChars !== undefined ? { refusalChars: canned.refusalChars } : {}),
    };
  }

  async generate(req: AiGenerateRequest, _opts?: AiGenerateOptions): Promise<AiGenerateResult> {
    this.received.push(req);
    const canned = this.next();
    if (canned.throwError) throw canned.throwError;
    return this.build(req, canned);
  }

  async *stream(req: AiGenerateRequest, opts?: AiGenerateOptions): AsyncIterable<AiStreamEvent> {
    this.received.push(req);
    const canned = this.next();
    const result = this.build(req, canned);
    // Chunk the text so streaming consumers get multiple deltas, deterministically.
    const nChunks = Math.max(1, canned.streamChunks ?? 3);
    const parts = canned.streamTextDeltas === false ? [] : splitEven(result.text, nChunks);
    // Default to throw-before-first-chunk only for plain throwError; throwAfterUsage and
    // throwDuringToolCall need the stream to reach usage/tool-call frames first (#560).
    const throwAfter =
      canned.throwError && canned.throwAfterChunks !== undefined
        ? canned.throwAfterChunks
        : canned.throwError && !canned.throwAfterUsage && !canned.throwDuringToolCall
          ? 0
          : undefined;
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
      // Stall mid-body until the driver's idle AbortSignal fires (#1063).
      if (canned.stallAfterChunks !== undefined && yielded >= canned.stallAfterChunks) {
        await hangUntilAbort(opts?.signal);
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
      if (canned.throwError && canned.throwDuringToolCall) throw canned.throwError;
    }
    yield { type: 'usage', usage: result.usage };
    if (canned.throwError && canned.throwAfterUsage) throw canned.throwError;
    yield { type: 'done', result };
    if (canned.stallAfterDone) {
      this.onStall?.();
      // Resolve rather than reject: the stream ENDS normally, so the driver reaches its
      // `finally` with `result` set and the session already detached — the race under test.
      await resolveOnAbort(opts?.signal);
    }
  }
}

/**
 * Hang until `signal` aborts, then resolve. Used by {@link MockResponse.stallAfterDone}.
 */
function resolveOnAbort(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (!signal || signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * Hang until `signal` aborts, then reject with EXACTLY what the real transport would.
 *
 * #1052 — THIS FAKE USED TO LIE, and it lied in the most expensive direction. It built its own
 * `AiProviderError('timeout', …)` with no `retryable`, which defaults to TRUE, while the real
 * `raceRead` hardcoded `retryable: false` for every signal abort. Same trigger, opposite
 * classification: the retry suite exercised a path production never took, so every green test
 * about step-level retry was consistent with the feature never firing for the silent-stall case
 * it exists to recover from.
 *
 * The fix is not to hardcode the other answer here — that would just move the lie. It is to call
 * the SAME function production calls, so the fake cannot drift from the transport again without
 * the transport changing too. `streamAbortError` is exported for exactly this.
 */
function hangUntilAbort(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = () => reject(streamAbortError(signal, 'mock'));
    if (!signal) {
      // No signal → hang forever (test misconfiguration); still reject sync if already aborted.
      return;
    }
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener('abort', fail, { once: true });
  });
}

/** Split a string into `n` roughly-equal contiguous chunks (deterministic). */
function splitEven(text: string, n: number): string[] {
  if (text.length === 0) return [''];
  const size = Math.ceil(text.length / n);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
