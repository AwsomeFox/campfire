import { OpenAiProvider } from '../../src/modules/ai-dm/providers/openai-provider';
import { AiProviderError } from '../../src/modules/ai-dm/providers/errors';
import type { AiGenerateRequest, AiStreamEvent } from '../../src/modules/ai-dm/providers/ai-provider';
import { jsonResponse, errorResponse, streamResponse, fakeFetch, sequenceFetch, collect, sentBody } from './ai-provider-fixtures';

/**
 * OpenAI-compatible adapter (#309). Drives the adapter against RECORDED fixtures via an
 * injected fake fetch — never the live network. Covers request mapping, non-streaming
 * completion parsing (text + tool_calls + real usage), SSE streaming (deltas + stitched
 * tool-call arguments), and error classification/retry.
 */

const req: AiGenerateRequest = {
  system: 'You are the DM.',
  messages: [{ role: 'user', content: 'The party opens the door.' }],
  model: 'gpt-4o-mini',
  maxTokens: 200,
  temperature: 0.7,
};

describe('OpenAiProvider — request mapping', () => {
  it('sends system+messages, model, params, and the configured endpoint/auth', async () => {
    const { fetchImpl, calls } = fakeFetch(jsonResponse(completion('Hello.')));
    const p = new OpenAiProvider({ apiKey: 'sk-test', baseUrl: 'https://proxy.local/v1', model: 'default', fetchImpl });
    await p.generate(req);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://proxy.local/v1/chat/completions');
    expect(calls[0].init.headers.authorization).toBe('Bearer sk-test');
    const body = sentBody(calls[0].init);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.max_tokens).toBe(200);
    expect(body.temperature).toBe(0.7);
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are the DM.' },
      { role: 'user', content: 'The party opens the door.' },
    ]);
  });

  it('maps the tool registry to OpenAI function tools and defaults tool_choice to auto', async () => {
    const { fetchImpl, calls } = fakeFetch(jsonResponse(completion('ok')));
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    await p.generate({
      ...req,
      tools: [{ name: 'roll_dice', description: 'Roll dice', parameters: { type: 'object', properties: { sides: { type: 'number' } } } }],
    });
    const body = sentBody(calls[0].init);
    expect(body.tool_choice).toBe('auto');
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'roll_dice', description: 'Roll dice', parameters: { type: 'object', properties: { sides: { type: 'number' } } } } },
    ]);
  });

  it('maps assistant tool calls and tool results back into OpenAI wire messages', async () => {
    const { fetchImpl, calls } = fakeFetch(jsonResponse(completion('done')));
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    await p.generate({
      model: 'm',
      messages: [
        { role: 'user', content: 'roll' },
        { role: 'assistant', toolCalls: [{ id: 'call_1', name: 'roll_dice', arguments: { sides: 20 } }] },
        { role: 'tool', toolCallId: 'call_1', toolName: 'roll_dice', content: '17' },
      ],
    });
    const body = sentBody(calls[0].init) as { messages: unknown[] };
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'roll_dice', arguments: '{"sides":20}' } }],
    });
    expect(body.messages[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '17' });
  });
});

describe('OpenAiProvider — non-streaming completion parsing', () => {
  it('returns narration text + real usage + finishReason', async () => {
    const { fetchImpl } = fakeFetch(jsonResponse(completion('You push the door open.', { prompt: 42, completion: 8 })));
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const result = await p.generate(req);
    expect(result.text).toBe('You push the door open.');
    expect(result.toolCalls).toEqual([]);
    expect(result.usage).toEqual({ promptTokens: 42, completionTokens: 8, totalTokens: 50 });
    expect(result.finishReason).toBe('stop');
    expect(result.model).toBe('gpt-4o-mini');
  });

  it('normalizes tool_calls (parsing the JSON argument string) and maps finish_reason', async () => {
    const body = {
      model: 'gpt-4o-mini',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [{ id: 'call_abc', function: { name: 'roll_dice', arguments: '{"sides":20,"count":2}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const { fetchImpl } = fakeFetch(jsonResponse(body));
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const result = await p.generate(req);
    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls).toEqual([{ id: 'call_abc', name: 'roll_dice', arguments: { sides: 20, count: 2 } }]);
  });

  it('falls back to summing usage when total_tokens is absent', async () => {
    const { fetchImpl } = fakeFetch(jsonResponse(completion('x', { prompt: 3, completion: 4, omitTotal: true })));
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const result = await p.generate(req);
    expect(result.usage.totalTokens).toBe(7);
  });
});

describe('OpenAiProvider — streaming', () => {
  it('emits text deltas, stitches tool-call arguments across chunks, and finishes with usage', async () => {
    const frames = [
      `data: ${JSON.stringify(chunk({ content: 'You ' }))}\n\n`,
      `data: ${JSON.stringify(chunk({ content: 'open ' }))}\n\n`,
      `data: ${JSON.stringify(chunk({ content: 'the door.' }))}\n\n`,
      `data: ${JSON.stringify(chunk({ toolCall: { index: 0, id: 'call_1', name: 'roll_dice', args: '{"sid' } }))}\n\n`,
      `data: ${JSON.stringify(chunk({ toolCall: { index: 0, args: 'es":20}' } }))}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const { fetchImpl, calls } = fakeFetch(streamResponse(frames));
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const events = await collect(p.stream(req));

    // stream_options requested so usage arrives in the terminal chunk
    expect(sentBody(calls[0].init).stream_options).toEqual({ include_usage: true });

    const text = events.filter((e): e is Extract<AiStreamEvent, { type: 'text' }> => e.type === 'text').map((e) => e.delta).join('');
    expect(text).toBe('You open the door.');

    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' && done.result.text).toBe('You open the door.');
    expect(done && done.type === 'done' && done.result.toolCalls).toEqual([{ id: 'call_1', name: 'roll_dice', arguments: { sides: 20 } }]);
    expect(done && done.type === 'done' && done.result.usage).toEqual({ promptTokens: 12, completionTokens: 6, totalTokens: 18 });
    expect(done && done.type === 'done' && done.result.finishReason).toBe('tool_calls');
  });
});

describe('OpenAiProvider — error handling', () => {
  it('maps 401 to a non-retryable auth error (no retry)', async () => {
    const { fetchImpl, calls } = fakeFetch(errorResponse(401, '{"error":"bad key"}'));
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', fetchImpl, retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 } });
    await expect(p.generate(req)).rejects.toMatchObject({ kind: 'auth', retryable: false });
    expect(calls).toHaveLength(1);
  });

  it('maps a 400 context-length overflow to a context_length error', async () => {
    const { fetchImpl } = fakeFetch(errorResponse(400, '{"error":{"message":"This model\'s maximum context length is 8192 tokens"}}'));
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    await expect(p.generate(req)).rejects.toMatchObject({ kind: 'context_length' });
  });

  it('retries a 429 then succeeds, honouring the retry budget', async () => {
    const { fetchImpl, calls } = sequenceFetch([errorResponse(429, 'slow down'), jsonResponse(completion('recovered'))]);
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', fetchImpl, retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 } });
    const result = await p.generate(req);
    expect(result.text).toBe('recovered');
    expect(calls).toHaveLength(2);
  });

  it('throws a transport error and surfaces AiProviderError', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNREFUSED');
    };
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', fetchImpl, retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 } });
    await expect(p.generate(req)).rejects.toBeInstanceOf(AiProviderError);
    await expect(p.generate(req)).rejects.toMatchObject({ kind: 'transport' });
  });
});

// ---------- fixture builders ----------

function completion(text: string, opts: { prompt?: number; completion?: number; omitTotal?: boolean } = {}) {
  const prompt = opts.prompt ?? 5;
  const completion = opts.completion ?? 5;
  const usage: Record<string, number> = { prompt_tokens: prompt, completion_tokens: completion };
  if (!opts.omitTotal) usage.total_tokens = prompt + completion;
  return { model: 'gpt-4o-mini', choices: [{ finish_reason: 'stop', message: { content: text } }], usage };
}

function chunk(opts: { content?: string; toolCall?: { index: number; id?: string; name?: string; args?: string } }) {
  const delta: Record<string, unknown> = {};
  if (opts.content) delta.content = opts.content;
  if (opts.toolCall) {
    delta.tool_calls = [{ index: opts.toolCall.index, id: opts.toolCall.id, function: { name: opts.toolCall.name, arguments: opts.toolCall.args } }];
  }
  return { model: 'gpt-4o-mini', choices: [{ delta }] };
}
