import { GeminiProvider } from '../../src/modules/ai-dm/providers/gemini-provider';
import { AiProviderError } from '../../src/modules/ai-dm/providers/errors';
import type { AiGenerateRequest, AiStreamEvent } from '../../src/modules/ai-dm/providers/ai-provider';
import { jsonResponse, errorResponse, streamResponse, fakeFetch, sequenceFetch, collect, sentBody } from './ai-provider-fixtures';

/**
 * Gemini adapter (#1062). Drives the adapter against RECORDED fixtures via an
 * injected fake fetch — never the live network. Covers request mapping (including
 * tool calls + tool results), non-streaming completion parsing (text + functionCall
 * parts), SSE streaming, and error classification.
 */

const req: AiGenerateRequest = {
  system: 'You are the DM.',
  messages: [{ role: 'user', content: 'The party opens the door.' }],
  model: 'gemini-1.5-flash',
  maxTokens: 200,
  temperature: 0.7,
};

describe('GeminiProvider — request mapping (buildBody)', () => {
  it('sends system instruction, user messages as contents, model params, and auth header', async () => {
    const { fetchImpl, calls } = fakeFetch(jsonResponse(geminiCompletion('Hello.')));
    const p = new GeminiProvider({ apiKey: 'test-key', baseUrl: 'https://proxy.local/v1beta', model: 'default', fetchImpl });
    await p.generate(req);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://proxy.local/v1beta/models/gemini-1.5-flash:generateContent');
    expect(calls[0].init.headers['x-goog-api-key']).toBe('test-key');
    const body = sentBody(calls[0].init);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'You are the DM.' }] });
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'The party opens the door.' }] },
    ]);
    expect((body.generationConfig as Record<string, unknown>).maxOutputTokens).toBe(200);
    expect((body.generationConfig as Record<string, unknown>).temperature).toBe(0.7);
  });

  it('maps assistant tool calls to functionCall parts in model role', async () => {
    const { fetchImpl, calls } = fakeFetch(jsonResponse(geminiCompletion('done')));
    const p = new GeminiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    await p.generate({
      model: 'm',
      messages: [
        { role: 'user', content: 'roll' },
        { role: 'assistant', toolCalls: [{ id: 'call_1', name: 'roll_dice', arguments: { sides: 20 } }] },
        { role: 'tool', toolCallId: 'call_1', toolName: 'roll_dice', content: '17' },
      ],
    });
    const body = sentBody(calls[0].init) as { contents: Array<{ role: string; parts: unknown[] }> };
    expect(body.contents[1]).toEqual({
      role: 'model',
      parts: [{ functionCall: { name: 'roll_dice', args: { sides: 20 } } }],
    });
    expect(body.contents[2]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { name: 'roll_dice', response: { content: '17' } } }],
    });
  });

  it('maps assistant messages with both text AND tool calls', async () => {
    const { fetchImpl, calls } = fakeFetch(jsonResponse(geminiCompletion('ok')));
    const p = new GeminiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    await p.generate({
      model: 'm',
      messages: [
        { role: 'user', content: 'attack' },
        { role: 'assistant', content: 'Rolling for you...', toolCalls: [{ id: 'call_0', name: 'roll_dice', arguments: { sides: 20 } }] },
      ],
    });
    const body = sentBody(calls[0].init) as { contents: Array<{ role: string; parts: unknown[] }> };
    expect(body.contents[1]).toEqual({
      role: 'model',
      parts: [
        { text: 'Rolling for you...' },
        { functionCall: { name: 'roll_dice', args: { sides: 20 } } },
      ],
    });
  });
});

describe('GeminiProvider — non-streaming completion parsing', () => {
  it('returns narration text + real usage + finishReason for text-only response', async () => {
    const { fetchImpl } = fakeFetch(jsonResponse(geminiCompletion('You push the door open.', { prompt: 42, completion: 8 })));
    const p = new GeminiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const result = await p.generate(req);
    expect(result.text).toBe('You push the door open.');
    expect(result.toolCalls).toEqual([]);
    expect(result.usage).toEqual({ promptTokens: 42, completionTokens: 8, totalTokens: 50 });
    expect(result.finishReason).toBe('stop');
  });

  it('extracts functionCall parts into toolCalls array', async () => {
    const body = {
      candidates: [{
        content: { role: 'model', parts: [{ functionCall: { name: 'roll_dice', args: { sides: 20 } } }] },
        finishReason: 'TOOL_CALLS',
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    };
    const { fetchImpl } = fakeFetch(jsonResponse(body));
    const p = new GeminiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const result = await p.generate(req);
    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls).toEqual([{ id: 'call_0', name: 'roll_dice', arguments: { sides: 20 } }]);
    expect(result.text).toBe('');
  });

  it('handles multiple functionCall parts', async () => {
    const body = {
      candidates: [{
        content: { role: 'model', parts: [
          { functionCall: { name: 'roll_dice', args: { sides: 20 } } },
          { functionCall: { name: 'lookup_rule', args: { rule: 'grapple' } } },
        ] },
        finishReason: 'TOOL_CALLS',
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 6, totalTokenCount: 16 },
    };
    const { fetchImpl } = fakeFetch(jsonResponse(body));
    const p = new GeminiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const result = await p.generate(req);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]).toEqual({ id: 'call_0', name: 'roll_dice', arguments: { sides: 20 } });
    expect(result.toolCalls[1]).toEqual({ id: 'call_1', name: 'lookup_rule', arguments: { rule: 'grapple' } });
  });

  it('throws on blocked content', async () => {
    const body = { candidates: [], promptFeedback: { blockReason: 'SAFETY' } };
    const { fetchImpl } = fakeFetch(jsonResponse(body));
    const p = new GeminiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    await expect(p.generate(req)).rejects.toMatchObject({ kind: 'invalid_request' });
  });
});

describe('GeminiProvider — streaming', () => {
  it('emits text deltas and finishes with aggregated result', async () => {
    const frames = [
      `data: ${JSON.stringify(geminiChunk({ text: 'You ' }))}\n\n`,
      `data: ${JSON.stringify(geminiChunk({ text: 'open the door.' }))}\n\n`,
      `data: ${JSON.stringify(geminiChunkFinish('STOP', { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 }))}\n\n`,
    ];
    const { fetchImpl } = fakeFetch(streamResponse(frames));
    const p = new GeminiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const events = await collect(p.stream(req));
    const textEvents = events.filter((e): e is Extract<AiStreamEvent, { type: 'text' }> => e.type === 'text');
    expect(textEvents.map((e) => e.delta).join('')).toBe('You open the door.');
    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' && done.result.text).toBe('You open the door.');
    expect(done && done.type === 'done' && done.result.toolCalls).toEqual([]);
  });

  it('emits tool_call events from streamed functionCall parts', async () => {
    const frames = [
      `data: ${JSON.stringify(geminiChunk({ functionCall: { name: 'roll_dice', args: { sides: 20 } } }))}\n\n`,
      `data: ${JSON.stringify(geminiChunkFinish('TOOL_CALLS', { promptTokenCount: 8, candidatesTokenCount: 3, totalTokenCount: 11 }))}\n\n`,
    ];
    const { fetchImpl } = fakeFetch(streamResponse(frames));
    const p = new GeminiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const events = await collect(p.stream(req));
    const toolCallEvents = events.filter((e): e is Extract<AiStreamEvent, { type: 'tool_call' }> => e.type === 'tool_call');
    expect(toolCallEvents).toHaveLength(1);
    expect(toolCallEvents[0]).toMatchObject({ index: 0, id: 'call_0', name: 'roll_dice' });
    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' && done.result.toolCalls).toEqual([
      { id: 'call_0', name: 'roll_dice', arguments: { sides: 20 } },
    ]);
    expect(done && done.type === 'done' && done.result.finishReason).toBe('tool_calls');
  });
});

describe('GeminiProvider — error handling', () => {
  it('maps 401 to a non-retryable auth error', async () => {
    const { fetchImpl, calls } = fakeFetch(errorResponse(401, '{"error":"bad key"}'));
    const p = new GeminiProvider({ apiKey: 'k', model: 'm', fetchImpl, retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 } });
    await expect(p.generate(req)).rejects.toMatchObject({ kind: 'auth', retryable: false });
    expect(calls).toHaveLength(1);
  });

  it('retries a 429 then succeeds', async () => {
    const { fetchImpl, calls } = sequenceFetch([errorResponse(429, 'slow down'), jsonResponse(geminiCompletion('recovered'))]);
    const p = new GeminiProvider({ apiKey: 'k', model: 'm', fetchImpl, retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 } });
    const result = await p.generate(req);
    expect(result.text).toBe('recovered');
    expect(calls).toHaveLength(2);
  });
});

// ---------- fixture builders ----------

function geminiCompletion(text: string, opts: { prompt?: number; completion?: number } = {}) {
  const prompt = opts.prompt ?? 5;
  const completion = opts.completion ?? 5;
  return {
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: prompt, candidatesTokenCount: completion, totalTokenCount: prompt + completion },
  };
}

function geminiChunk(part: { text?: string; functionCall?: { name: string; args: Record<string, unknown> } }) {
  const parts: Array<Record<string, unknown>> = [];
  if (part.text !== undefined) parts.push({ text: part.text });
  if (part.functionCall) parts.push({ functionCall: part.functionCall });
  return { candidates: [{ content: { role: 'model', parts } }] };
}

function geminiChunkFinish(finishReason: string, usageMetadata: Record<string, number>) {
  return { candidates: [{ content: { role: 'model', parts: [] }, finishReason }], usageMetadata };
}
