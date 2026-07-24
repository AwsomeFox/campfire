import { OpenAiProvider } from '../../src/modules/ai-dm/providers/openai-provider';
import type { AiGenerateRequest, AiStreamEvent } from '../../src/modules/ai-dm/providers/ai-provider';
import { jsonResponse, errorResponse, streamResponse, fakeFetch, collect, sentBody } from './ai-provider-fixtures';

const req: AiGenerateRequest = {
  system: 'You are the DM.',
  messages: [{ role: 'user', content: 'The party opens the door.' }],
  model: 'gpt-4o-mini',
  maxTokens: 200,
  temperature: 0.7,
};

describe('OpenAiProvider — Responses API — request mapping', () => {
  it('sends system+messages, model, params, and the configured endpoint/auth', async () => {
    const { fetchImpl, calls } = fakeFetch(jsonResponse(responsesCompletion('Hello.')));
    // Note: endpointMode defaults to 'responses' so we don't need to specify it
    const p = new OpenAiProvider({ apiKey: 'sk-test', baseUrl: 'https://proxy.local/v1', model: 'default', fetchImpl });
    await p.generate(req);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://proxy.local/v1/responses');
    expect(calls[0].init.headers.authorization).toBe('Bearer sk-test');
    const body = sentBody(calls[0].init);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.max_output_tokens).toBe(200);
    expect(body.temperature).toBe(0.7);
    expect(body.instructions).toBe('You are the DM.');
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: 'The party opens the door.' },
    ]);
  });

  it('maps the tool registry to Responses function tools and defaults tool_choice to auto (omitted)', async () => {
    const { fetchImpl, calls } = fakeFetch(jsonResponse(responsesCompletion('ok')));
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    await p.generate({
      ...req,
      tools: [{ name: 'roll_dice', description: 'Roll dice', parameters: { type: 'object', properties: { sides: { type: 'number' } } } }],
    });
    const body = sentBody(calls[0].init);
    expect(body.tool_choice).toBeUndefined(); // 'auto' is default, not set
    expect(body.tools).toEqual([
      { type: 'function', name: 'roll_dice', description: 'Roll dice', parameters: { type: 'object', properties: { sides: { type: 'number' } } } },
    ]);
  });

  it('maps assistant tool calls and tool results back into Responses input items', async () => {
    const { fetchImpl, calls } = fakeFetch(jsonResponse(responsesCompletion('done')));
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    await p.generate({
      model: 'm',
      messages: [
        { role: 'user', content: 'roll' },
        { role: 'assistant', toolCalls: [{ id: 'call_1', name: 'roll_dice', arguments: { sides: 20 } }] },
        { role: 'tool', toolCallId: 'call_1', toolName: 'roll_dice', content: '17' },
      ],
    });
    const body = sentBody(calls[0].init) as { input: unknown[] };
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: 'roll' },
      { type: 'function_call', id: 'call_1', call_id: 'call_1', name: 'roll_dice', arguments: '{"sides":20}' },
      { type: 'function_call_output', call_id: 'call_1', output: '17' },
    ]);
  });
});

describe('OpenAiProvider — Responses API — non-streaming parsing', () => {
  it('returns narration text + real usage + finishReason', async () => {
    const { fetchImpl } = fakeFetch(jsonResponse(responsesCompletion('You push the door open.', { prompt: 42, completion: 8 })));
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const result = await p.generate(req);
    expect(result.text).toBe('You push the door open.');
    expect(result.toolCalls).toEqual([]);
    expect(result.usage).toEqual({ promptTokens: 42, completionTokens: 8, totalTokens: 50 });
    expect(result.finishReason).toBe('stop');
    expect(result.model).toBe('gpt-4o-mini');
  });

  it('normalizes tool_calls (parsing the JSON argument string) and maps status', async () => {
    const body = {
      model: 'gpt-4o-mini',
      status: 'completed',
      output: [
        {
          type: 'function_call',
          call_id: 'call_abc',
          name: 'roll_dice',
          arguments: '{"sides":20,"count":2}',
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    };
    const { fetchImpl } = fakeFetch(jsonResponse(body));
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const result = await p.generate(req);
    expect(result.finishReason).toBe('stop');
    expect(result.toolCalls).toEqual([{ id: 'call_abc', name: 'roll_dice', arguments: { sides: 20, count: 2 } }]);
  });
});

describe('OpenAiProvider — Responses API — streaming', () => {
  it('emits text deltas, stitches tool-call arguments across chunks, and finishes with usage', async () => {
    const frames = [
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'You ' })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'open ' })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'the door.' })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.output_item.added', item: { type: 'function_call', call_id: 'call_1', name: 'roll_dice' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.function_call_arguments.delta', call_id: 'call_1', delta: '{"sid' })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.function_call_arguments.delta', call_id: 'call_1', delta: 'es":20}' })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18 } } })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const { fetchImpl } = fakeFetch(streamResponse(frames));
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const events = await collect(p.stream(req));

    // stream_options isn't passed for Responses API in the provided impl
    const text = events.filter((e): e is Extract<AiStreamEvent, { type: 'text' }> => e.type === 'text').map((e) => e.delta).join('');
    expect(text).toBe('You open the door.');

    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' && done.result.text).toBe('You open the door.');
    expect(done && done.type === 'done' && done.result.toolCalls).toEqual([{ id: 'call_1', name: 'roll_dice', arguments: { sides: 20 } }]);
    expect(done && done.type === 'done' && done.result.usage).toEqual({ promptTokens: 12, completionTokens: 6, totalTokens: 18 });
    expect(done && done.type === 'done' && done.result.finishReason).toBe('stop');
  });
});

describe('OpenAiProvider — error handling', () => {
  it('maps 401 to a non-retryable auth error (no retry)', async () => {
    const { fetchImpl, calls } = fakeFetch(errorResponse(401, '{"error":"bad key"}'));
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', fetchImpl, retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 } });
    await expect(p.generate(req)).rejects.toMatchObject({ kind: 'auth', retryable: false });
    expect(calls).toHaveLength(1);
  });
});

// ---------- fixture builders ----------

function responsesCompletion(text: string, opts: { prompt?: number; completion?: number } = {}) {
  const prompt = opts.prompt ?? 5;
  const completion = opts.completion ?? 5;
  const usage: Record<string, number> = { input_tokens: prompt, output_tokens: completion, total_tokens: prompt + completion };
  return {
    model: 'gpt-4o-mini',
    status: 'completed',
    output: [
      {
        type: 'message',
        content: [{ type: 'output_text', text }],
      },
    ],
    usage,
  };
}
