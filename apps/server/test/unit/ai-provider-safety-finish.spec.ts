import { OpenAiProvider } from '../../src/modules/ai-dm/providers/openai-provider';
import { AnthropicProvider } from '../../src/modules/ai-dm/providers/anthropic-provider';
import { GeminiProvider } from '../../src/modules/ai-dm/providers/gemini-provider';
import type { AiGenerateRequest } from '../../src/modules/ai-dm/providers/ai-provider';
import { isWithheldFinishReason } from '../../src/modules/ai-driver/driver-safety';
import { jsonResponse, streamResponse, fakeFetch, collect } from './ai-provider-fixtures';

/**
 * #598 — every wire protocol must surface its safety terminal state, on BOTH transports.
 *
 * The driver's withhold is only as good as the signal it is handed, and the adapters had real
 * holes: the OpenAI Responses protocol reports a content filter as `status: 'incomplete'` with
 * the actual cause buried in `incomplete_details.reason`, which was never read (so a filtered
 * turn arrived as an ordinary `length` truncation); its `refusal` parts were ignored entirely;
 * a filtered response that also carried tool calls reported `tool_calls`, erasing the filter;
 * and Gemini's newer safety finish reasons fell through to `unknown`, which the driver
 * delivers. These pin all of it.
 */

const req: AiGenerateRequest = {
  messages: [{ role: 'user', content: 'go' }],
  model: 'm',
};

describe('OpenAI Chat Completions — content_filter (#598)', () => {
  it('non-streaming: finish_reason content_filter is preserved and classified as withheld', async () => {
    const { fetchImpl } = fakeFetch(
      jsonResponse({
        model: 'gpt-4o-mini',
        choices: [{ finish_reason: 'content_filter', message: { content: 'partial unsafe pro' } }],
        usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
      }),
    );
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', endpointMode: 'chat_completions', fetchImpl });
    const result = await p.generate(req);
    expect(result.finishReason).toBe('content_filter');
    expect(isWithheldFinishReason(result.finishReason)).toBe(true);
  });

  it('streaming: the filter arrives on the LAST chunk, after the text deltas', async () => {
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'The alley ' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'narrows and' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ finish_reason: 'content_filter', delta: {} }] })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const { fetchImpl } = fakeFetch(streamResponse(frames));
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', endpointMode: 'chat_completions', fetchImpl });
    const events = await collect(p.stream(req));

    // This ordering IS the problem #598 exists for: the deltas are emitted first and the
    // refusal is only knowable at the terminal frame.
    const types = events.map((e) => e.type);
    expect(types.indexOf('text')).toBeLessThan(types.lastIndexOf('done'));
    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' && done.result.finishReason).toBe('content_filter');
  });
});

/**
 * The Chat Completions refusal — the nastiest of the three transports.
 *
 * A content filter at least changes `finish_reason` to something recognisable. A model
 * REFUSAL on this protocol does not: OpenAI reports it in `message.refusal` (or streamed
 * `delta.refusal`) while `finish_reason` stays **`stop`** — at that field, byte-identical to
 * a perfectly good answer. An adapter reading only `finish_reason` cannot tell the two apart,
 * so the driver files a refusal as ordinary narration or as `no_narration`.
 *
 * Third transport, same shape as the other two: the provider signalled a refusal in a field
 * the adapter modelled but never consulted.
 */
describe('OpenAI Chat Completions — message.refusal / delta.refusal (#598)', () => {
  it('non-streaming: a refusal is withheld even though finish_reason is `stop`', async () => {
    const { fetchImpl } = fakeFetch(
      jsonResponse({
        model: 'gpt-4o-mini',
        choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'I can’t help with that.' } }],
        usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
      }),
    );
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', endpointMode: 'chat_completions', fetchImpl });
    const result = await p.generate(req);
    expect(result.finishReason).toBe('refusal');
    expect(isWithheldFinishReason(result.finishReason)).toBe(true);
    // Refusal prose is NOT narration and must never be handed to the driver to broadcast.
    expect(result.text).toBe('');
  });

  it('non-streaming: a refusal outranks tool calls in the same response', async () => {
    // Otherwise the driver dispatches tools from a response the model just declined to stand
    // behind — the same precedence bug already closed on the Responses path.
    const { fetchImpl } = fakeFetch(
      jsonResponse({
        model: 'gpt-4o-mini',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              refusal: 'No.',
              tool_calls: [{ id: 'call_1', function: { name: 'roll_dice', arguments: '{}' } }],
            },
          },
        ],
      }),
    );
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', endpointMode: 'chat_completions', fetchImpl });
    const result = await p.generate(req);
    expect(result.finishReason).toBe('refusal');
    expect(isWithheldFinishReason(result.finishReason)).toBe(true);
  });

  it('streaming: delta.refusal is withheld, and its text never becomes a narration delta', async () => {
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { refusal: 'I can’t ' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { refusal: 'help with that.' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ finish_reason: 'stop', delta: {} }] })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const { fetchImpl } = fakeFetch(streamResponse(frames));
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', endpointMode: 'chat_completions', fetchImpl });
    const events = await collect(p.stream(req));

    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' && done.result.finishReason).toBe('refusal');
    // The refusal must never reach the delta stream. Forwarding it would put refused text on
    // the wire AHEAD of the terminal frame saying it was refused — the one ordering the
    // quarantine window cannot rescue, because the text arrives before the signal exists.
    expect(events.some((e) => e.type === 'text')).toBe(false);
    expect(JSON.stringify(events)).not.toContain('help with that.');
  });

  it('streaming: a refusal is sticky — a later clean finish cannot revive the turn', async () => {
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { refusal: 'No.' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'Actually, here you go…' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ finish_reason: 'stop', delta: {} }] })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const { fetchImpl } = fakeFetch(streamResponse(frames));
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', endpointMode: 'chat_completions', fetchImpl });
    const events = await collect(p.stream(req));
    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' && done.result.finishReason).toBe('refusal');
  });

  it('an ordinary `stop` with no refusal field is still delivered', async () => {
    // The control. The check must key on the FIELD, not on anything about `stop`, or every
    // successful Chat Completions turn would be withheld.
    const { fetchImpl } = fakeFetch(
      jsonResponse({ model: 'm', choices: [{ finish_reason: 'stop', message: { content: 'The alley narrows.' } }] }),
    );
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', endpointMode: 'chat_completions', fetchImpl });
    const result = await p.generate(req);
    expect(result.finishReason).toBe('stop');
    expect(isWithheldFinishReason(result.finishReason)).toBe(false);
    expect(result.text).toBe('The alley narrows.');
  });

  it('reports the refusal LENGTH so a refusal-only turn is still billable', async () => {
    // Discarding refusal prose (correct) also discarded the only measurement the budget
    // estimator had, so on a provider that omits usage a refusal metered as ZERO tokens. The
    // count escapes; the text does not. A character count leaks nothing a token count doesn't.
    const refusal = 'I can’t help with that.';
    const { fetchImpl } = fakeFetch(
      jsonResponse({ model: 'm', choices: [{ finish_reason: 'stop', message: { content: null, refusal } }] }),
    );
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', endpointMode: 'chat_completions', fetchImpl });
    const result = await p.generate(req);
    expect(result.refusalChars).toBe(refusal.length);
    // …and the prose itself is still nowhere in the result.
    expect(JSON.stringify(result)).not.toContain('help with that');
  });

  it('streaming: accumulates refusal length across deltas', async () => {
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { refusal: 'abcd' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { refusal: 'efg' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ finish_reason: 'stop', delta: {} }] })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const { fetchImpl } = fakeFetch(streamResponse(frames));
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', endpointMode: 'chat_completions', fetchImpl });
    const events = await collect(p.stream(req));
    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' && done.result.refusalChars).toBe(7);
  });

  it('an empty-string refusal is not a refusal', async () => {
    // Some OpenAI-compatible servers emit `refusal: ""` or `null` on every message. Keying on
    // presence-of-key would withhold every turn those servers produce.
    const { fetchImpl } = fakeFetch(
      jsonResponse({ model: 'm', choices: [{ finish_reason: 'stop', message: { content: 'hi', refusal: '' } }] }),
    );
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', endpointMode: 'chat_completions', fetchImpl });
    expect((await p.generate(req)).finishReason).toBe('stop');
  });
});

describe('OpenAI Responses — incomplete_details + refusal parts (#598)', () => {
  it('non-streaming: status=incomplete + reason=content_filter is a FILTER, not a length truncation', async () => {
    const { fetchImpl } = fakeFetch(
      jsonResponse({
        model: 'gpt-4o-mini',
        status: 'incomplete',
        incomplete_details: { reason: 'content_filter' },
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial' }] }],
        usage: { input_tokens: 3, output_tokens: 2 },
      }),
    );
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const result = await p.generate(req);
    expect(result.finishReason).toBe('content_filter');
  });

  it('non-streaming: an ordinary incomplete (max_output_tokens) is still `length`', async () => {
    const { fetchImpl } = fakeFetch(
      jsonResponse({
        model: 'gpt-4o-mini',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial' }] }],
      }),
    );
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const result = await p.generate(req);
    expect(result.finishReason).toBe('length');
    expect(isWithheldFinishReason(result.finishReason)).toBe(false);
  });

  it('non-streaming: a refusal part is a refusal, and its text never becomes narration', async () => {
    const { fetchImpl } = fakeFetch(
      jsonResponse({
        model: 'gpt-4o-mini',
        status: 'completed',
        output: [
          { type: 'message', content: [{ type: 'refusal', refusal: 'I can’t help with that.' }] },
        ],
      }),
    );
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const result = await p.generate(req);
    expect(result.finishReason).toBe('refusal');
    // The decline is a terminal state, not a DM line to broadcast.
    expect(result.text).toBe('');
  });

  it('TOOL MIXTURE: a refusal that also carried tool calls does NOT report tool_calls', async () => {
    const { fetchImpl } = fakeFetch(
      jsonResponse({
        model: 'gpt-4o-mini',
        status: 'completed',
        output: [
          { type: 'message', content: [{ type: 'refusal', refusal: 'no' }] },
          { type: 'function_call', call_id: 'call_1', name: 'update_character_hp', arguments: '{"hp":0}' },
        ],
      }),
    );
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const result = await p.generate(req);
    // Reporting `tool_calls` here is how the driver would have dispatched a mutation that came
    // packaged with a refusal. The tool call is still returned; the FINISH REASON is what says
    // "do not act on this", and the driver's guard reads that.
    expect(result.finishReason).toBe('refusal');
    expect(result.toolCalls).toHaveLength(1);
  });

  it('TOOL MIXTURE: a content filter that also carried tool calls does NOT report tool_calls', async () => {
    const { fetchImpl } = fakeFetch(
      jsonResponse({
        model: 'gpt-4o-mini',
        status: 'incomplete',
        incomplete_details: { reason: 'content_filter' },
        output: [{ type: 'function_call', call_id: 'c1', name: 'roll_dice', arguments: '{}' }],
      }),
    );
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const result = await p.generate(req);
    expect(result.finishReason).toBe('content_filter');
  });

  it('streaming: response.incomplete carries the filter reason the terminal frame would otherwise lose', async () => {
    const frames = [
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'The alley narrows' })}\n\n`,
      `data: ${JSON.stringify({
        type: 'response.incomplete',
        response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' }, usage: { input_tokens: 3, output_tokens: 4 } },
      })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const { fetchImpl } = fakeFetch(streamResponse(frames));
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const events = await collect(p.stream(req));
    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' && done.result.finishReason).toBe('content_filter');
  });

  it('streaming: a refusal delta sets the terminal state and is not forwarded as narration', async () => {
    const frames = [
      `data: ${JSON.stringify({ type: 'response.refusal.delta', delta: 'I can’t help with that.' })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const { fetchImpl } = fakeFetch(streamResponse(frames));
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const events = await collect(p.stream(req));
    expect(events.some((e) => e.type === 'text')).toBe(false);
    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' && done.result.finishReason).toBe('refusal');
  });
});

describe('Anthropic — stop_reason refusal (#598)', () => {
  it('non-streaming: refusal is its own terminal state, distinct from a content filter', async () => {
    const { fetchImpl } = fakeFetch(
      jsonResponse({
        model: 'claude-x',
        stop_reason: 'refusal',
        content: [{ type: 'text', text: 'partial' }],
        usage: { input_tokens: 3, output_tokens: 2 },
      }),
    );
    const p = new AnthropicProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const result = await p.generate(req);
    // Previously folded into `content_filter`. Both are withheld; keeping them apart is what
    // lets an incident record say whether the vendor's policy layer or the model itself fired.
    expect(result.finishReason).toBe('refusal');
    expect(isWithheldFinishReason(result.finishReason)).toBe(true);
  });

  it('streaming: the refusal lands in message_delta, AFTER every content_block_delta', async () => {
    const frames = [
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 4 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The alley narrows' } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { output_tokens: 5 } })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ];
    const { fetchImpl } = fakeFetch(streamResponse(frames));
    const p = new AnthropicProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const events = await collect(p.stream(req));

    const firstText = events.findIndex((e) => e.type === 'text');
    const done = events.findIndex((e) => e.type === 'done');
    expect(firstText).toBeGreaterThanOrEqual(0);
    expect(done).toBeGreaterThan(firstText); // the signal genuinely trails the prose
    const terminal = events[done];
    expect(terminal.type === 'done' && terminal.result.finishReason).toBe('refusal');
  });
});

describe('OpenAI Responses — refusal shapes count consistently (#598)', () => {
  it('counts a TOP-LEVEL refusal item, not just a refusal content part', async () => {
    // The counter ran in the content-part branch and not its sibling, so the SAME refusal
    // measured as its real length or as zero depending purely on which shape the wire used.
    // The driver no longer depends on this to avoid a free turn — an unmeasurable turn settles
    // as unknown spend — but an estimate that silently varies by wire shape is its own defect.
    const refusal = 'I cannot help with that request.';
    const { fetchImpl } = fakeFetch(
      jsonResponse({ model: 'm', status: 'completed', output: [{ type: 'refusal', refusal }] }),
    );
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', endpointMode: 'responses', fetchImpl });
    const result = await p.generate(req);
    expect(result.finishReason).toBe('refusal');
    expect(result.refusalChars).toBe(refusal.length);
    expect(JSON.stringify(result)).not.toContain('cannot help');
  });

  it('counts a refusal delivered only on `response.refusal.done`, with no deltas', async () => {
    // A stream may send the complete refusal on `.done` and no `.delta` frames at all. Counting
    // only deltas measured that as zero — the fourth door onto the same free-turn bug.
    const refusal = 'No.';
    const frames = [
      `data: ${JSON.stringify({ type: 'response.refusal.done', refusal })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`,
    ];
    const { fetchImpl } = fakeFetch(streamResponse(frames));
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', endpointMode: 'responses', fetchImpl });
    const events = await collect(p.stream(req));
    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' && done.result.refusalChars).toBe(refusal.length);
  });

  it('does not double-count a refusal sent as deltas AND a done frame', async () => {
    const frames = [
      `data: ${JSON.stringify({ type: 'response.refusal.delta', delta: 'No' })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.refusal.delta', delta: '.' })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.refusal.done', refusal: 'No.' })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`,
    ];
    const { fetchImpl } = fakeFetch(streamResponse(frames));
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', endpointMode: 'responses', fetchImpl });
    const events = await collect(p.stream(req));
    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' && done.result.refusalChars).toBe(3);
  });
});

describe('Gemini — safety finish reasons (#598)', () => {
  it.each(['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'SPII', 'BLOCKLIST', 'IMAGE_SAFETY'])(
    'maps %s to content_filter rather than letting it fall through to `unknown`',
    async (reason) => {
      const { fetchImpl } = fakeFetch(
        jsonResponse({
          candidates: [{ finishReason: reason, content: { parts: [{ text: 'partial' }] } }],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
        }),
      );
      const p = new GeminiProvider({ apiKey: 'k', model: 'm', fetchImpl });
      const result = await p.generate(req);
      // `unknown` is a DELIVERABLE disposition, so anything landing there is broadcast — which
      // is the same fail-open this issue closes, just on a third protocol.
      expect(result.finishReason).toBe('content_filter');
      expect(isWithheldFinishReason(result.finishReason)).toBe(true);
    },
  );

  /**
   * The OTHER Gemini block shape, and the one the candidate-level cases above cannot reach.
   *
   * When Gemini blocks the PROMPT it refuses before generating: the payload carries
   * `promptFeedback.blockReason`, NO candidate, and therefore no candidate `finishReason` for
   * the mapping to read. So the #598 finish-reason work was never invoked on this path —
   * streaming kept its `stop` default and non-streaming threw `invalid_request`, and the driver
   * filed the result as `no_narration` / `provider_error`. Both put the plumbing sentence and
   * the plumbing levers in front of the table for what is actually the safety layer working.
   */
  describe('prompt-level blocks (no candidate at all)', () => {
    const promptBlock = (blockReason: string) => ({
      promptFeedback: { blockReason },
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 0, totalTokenCount: 7 },
    });

    it.each(['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'IMAGE_SAFETY', 'OTHER'])(
      'non-streaming: promptFeedback.blockReason %s is content_filter, not a thrown invalid_request',
      async (reason) => {
        const { fetchImpl } = fakeFetch(jsonResponse(promptBlock(reason)));
        const p = new GeminiProvider({ apiKey: 'k', model: 'm', fetchImpl });
        const result = await p.generate(req);
        expect(result.finishReason).toBe('content_filter');
        expect(isWithheldFinishReason(result.finishReason)).toBe(true);
        expect(result.text).toBe('');
        expect(result.toolCalls).toEqual([]);
        // Usage still travels: the prompt tokens were spent whether or not anything came back.
        expect(result.usage.totalTokens).toBe(7);
      },
    );

    it('streaming: a prompt-block chunk is content_filter rather than the `stop` default', async () => {
      const frames = [`data: ${JSON.stringify(promptBlock('SAFETY'))}\n\n`, 'data: [DONE]\n\n'];
      const { fetchImpl } = fakeFetch(streamResponse(frames));
      const p = new GeminiProvider({ apiKey: 'k', model: 'm', fetchImpl });
      const events = await collect(p.stream(req));
      const done = events.find((e) => e.type === 'done');
      // `stop` is a DELIVERABLE disposition. Defaulting to it here is the fail-open.
      expect(done && done.type === 'done' && done.result.finishReason).toBe('content_filter');
      expect(events.some((e) => e.type === 'text')).toBe(false);
    });

    it('streaming: a prompt block is sticky — a later frame cannot make the turn deliverable', async () => {
      const frames = [
        `data: ${JSON.stringify(promptBlock('SAFETY'))}\n\n`,
        // A trailing chunk that looks like an ordinary clean finish. The policy layer refused
        // the request; nothing arriving afterwards re-opens that decision.
        `data: ${JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'hi' }] } }] })}\n\n`,
        'data: [DONE]\n\n',
      ];
      const { fetchImpl } = fakeFetch(streamResponse(frames));
      const p = new GeminiProvider({ apiKey: 'k', model: 'm', fetchImpl });
      const events = await collect(p.stream(req));
      const done = events.find((e) => e.type === 'done');
      expect(done && done.type === 'done' && done.result.finishReason).toBe('content_filter');
    });

    it('a response with no candidates AND no blockReason is still a malformed-payload error', async () => {
      // The two are different failures and must stay so: an empty payload is a broken provider
      // (retry / diagnose), not a refusal (retry with different framing).
      const { fetchImpl } = fakeFetch(jsonResponse({ usageMetadata: { totalTokenCount: 1 } }));
      const p = new GeminiProvider({ apiKey: 'k', model: 'm', fetchImpl });
      await expect(p.generate(req)).rejects.toThrow(/no candidates/i);
    });
  });
});

describe('Local / self-hosted models with no safety layer (#598)', () => {
  it('an OpenAI-compatible endpoint that reports plain `stop` is delivered, not withheld', async () => {
    // Ollama / llama.cpp / LM Studio / bare vLLM report `stop` for everything they generate.
    // This mechanism RELAYS a provider signal; it does not classify content. A test that
    // pretended otherwise would document a protection that does not exist.
    const { fetchImpl } = fakeFetch(
      jsonResponse({
        model: 'local-llama',
        choices: [{ finish_reason: 'stop', message: { content: 'Anything at all.' } }],
      }),
    );
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', endpointMode: 'chat_completions', fetchImpl });
    const result = await p.generate(req);
    expect(result.finishReason).toBe('stop');
    expect(isWithheldFinishReason(result.finishReason)).toBe(false);
  });

  it('an endpoint that omits finish_reason entirely still resolves to `stop`, not to a refusal', async () => {
    const { fetchImpl } = fakeFetch(
      jsonResponse({ model: 'local-llama', choices: [{ message: { content: 'hi' } }] }),
    );
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', endpointMode: 'chat_completions', fetchImpl });
    expect((await p.generate(req)).finishReason).toBe('stop');
  });
});
