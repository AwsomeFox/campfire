import { AnthropicProvider } from '../../src/modules/ai-dm/providers/anthropic-provider';
import type { AiGenerateRequest, AiStreamEvent } from '../../src/modules/ai-dm/providers/ai-provider';
import { jsonResponse, errorResponse, streamResponse, fakeFetch, collect, sentBody } from './ai-provider-fixtures';

/**
 * Anthropic Messages adapter (#309). Offline fixtures via injected fake fetch. Covers the
 * shape differences the adapter normalizes (top-level system, content blocks, tool_result
 * as a user message), non-streaming parsing (text + tool_use + summed usage), and the SSE
 * event sequence (message_start → content_block deltas → message_delta → message_stop).
 */

const req: AiGenerateRequest = {
  system: 'You are the DM.',
  messages: [{ role: 'user', content: 'The party opens the door.' }],
  model: 'claude-3-5-sonnet',
  maxTokens: 300,
};

describe('AnthropicProvider — request mapping', () => {
  it('sends x-api-key + version headers, top-level system, and block-form messages', async () => {
    const { fetchImpl, calls } = fakeFetch(jsonResponse(message('Hi.')));
    const p = new AnthropicProvider({ apiKey: 'ak-test', model: 'default', fetchImpl });
    await p.generate(req);

    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0].init.headers['x-api-key']).toBe('ak-test');
    expect(calls[0].init.headers['anthropic-version']).toBe('2023-06-01');
    const body = sentBody(calls[0].init);
    expect(body.system).toBe('You are the DM.');
    expect(body.max_tokens).toBe(300);
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'The party opens the door.' }] }]);
  });

  it('maps tools to input_schema and required tool_choice to {type:any}', async () => {
    const { fetchImpl, calls } = fakeFetch(jsonResponse(message('ok')));
    const p = new AnthropicProvider({ apiKey: 'k', model: 'm', fetchImpl });
    await p.generate({
      ...req,
      toolChoice: 'required',
      tools: [{ name: 'roll_dice', description: 'Roll dice', parameters: { type: 'object', properties: { sides: { type: 'number' } } } }],
    });
    const body = sentBody(calls[0].init);
    expect(body.tool_choice).toEqual({ type: 'any' });
    expect(body.tools).toEqual([{ name: 'roll_dice', description: 'Roll dice', input_schema: { type: 'object', properties: { sides: { type: 'number' } } } }]);
  });

  it('maps assistant tool_use + a tool result into assistant blocks and a user tool_result', async () => {
    const { fetchImpl, calls } = fakeFetch(jsonResponse(message('done')));
    const p = new AnthropicProvider({ apiKey: 'k', model: 'm', fetchImpl });
    await p.generate({
      model: 'm',
      messages: [
        { role: 'user', content: 'roll' },
        { role: 'assistant', content: 'rolling', toolCalls: [{ id: 'tu_1', name: 'roll_dice', arguments: { sides: 20 } }] },
        { role: 'tool', toolCallId: 'tu_1', content: '17' },
      ],
    });
    const body = sentBody(calls[0].init) as { messages: unknown[] };
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'rolling' },
        { type: 'tool_use', id: 'tu_1', name: 'roll_dice', input: { sides: 20 } },
      ],
    });
    expect(body.messages[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '17' }] });
  });
});

describe('AnthropicProvider — non-streaming parsing', () => {
  it('concatenates text blocks and sums input/output usage', async () => {
    const { fetchImpl } = fakeFetch(jsonResponse(message('You push the door open.', { input: 40, output: 9 })));
    const p = new AnthropicProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const result = await p.generate(req);
    expect(result.text).toBe('You push the door open.');
    expect(result.usage).toEqual({ promptTokens: 40, completionTokens: 9, totalTokens: 49 });
    expect(result.finishReason).toBe('stop');
  });

  it('normalizes tool_use blocks and maps stop_reason tool_use', async () => {
    const body = {
      model: 'claude-3-5-sonnet',
      stop_reason: 'tool_use',
      usage: { input_tokens: 12, output_tokens: 7 },
      content: [
        { type: 'text', text: 'Let me roll.' },
        { type: 'tool_use', id: 'tu_9', name: 'roll_dice', input: { sides: 20, count: 2 } },
      ],
    };
    const { fetchImpl } = fakeFetch(jsonResponse(body));
    const p = new AnthropicProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const result = await p.generate(req);
    expect(result.text).toBe('Let me roll.');
    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls).toEqual([{ id: 'tu_9', name: 'roll_dice', arguments: { sides: 20, count: 2 } }]);
  });
});

describe('AnthropicProvider — streaming', () => {
  it('emits text deltas, stitches input_json_delta into tool args, and reports usage', async () => {
    const frames = [
      sse('message_start', { type: 'message_start', message: { model: 'claude-3-5-sonnet', usage: { input_tokens: 15, output_tokens: 0 } } }),
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'You ' } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'open it.' } }),
      sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
      sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'roll_dice' } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"sid' } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'es":20}' } }),
      sse('content_block_stop', { type: 'content_block_stop', index: 1 }),
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 11 } }),
      sse('message_stop', { type: 'message_stop' }),
    ];
    const { fetchImpl } = fakeFetch(streamResponse(frames));
    const p = new AnthropicProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const events = await collect(p.stream(req));

    const text = events.filter((e): e is Extract<AiStreamEvent, { type: 'text' }> => e.type === 'text').map((e) => e.delta).join('');
    expect(text).toBe('You open it.');

    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' && done.result.text).toBe('You open it.');
    expect(done && done.type === 'done' && done.result.toolCalls).toEqual([{ id: 'tu_1', name: 'roll_dice', arguments: { sides: 20 } }]);
    expect(done && done.type === 'done' && done.result.usage).toEqual({ promptTokens: 15, completionTokens: 11, totalTokens: 26 });
    expect(done && done.type === 'done' && done.result.finishReason).toBe('tool_calls');
  });
});

describe('AnthropicProvider — error handling', () => {
  it('maps 429 to a retryable rate_limit error', async () => {
    const { fetchImpl } = fakeFetch(errorResponse(429, 'overloaded'));
    const p = new AnthropicProvider({ apiKey: 'k', model: 'm', fetchImpl, retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 } });
    await expect(p.generate(req)).rejects.toMatchObject({ kind: 'rate_limit', retryable: true });
  });
});

// ---------- fixture builders ----------

function message(text: string, opts: { input?: number; output?: number } = {}) {
  return {
    model: 'claude-3-5-sonnet',
    stop_reason: 'end_turn',
    usage: { input_tokens: opts.input ?? 5, output_tokens: opts.output ?? 5 },
    content: [{ type: 'text', text }],
  };
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
