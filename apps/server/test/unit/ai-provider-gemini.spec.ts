import { GeminiProvider } from '../../src/modules/ai-dm/providers/gemini-provider';
import type { AiGenerateRequest, AiStreamEvent } from '../../src/modules/ai-dm/providers/ai-provider';
import { jsonResponse, streamResponse, fakeFetch, collect, sentBody } from './ai-provider-fixtures';

/**
 * Gemini adapter (#987) tool-call support (#1062). Offline fixtures via injected fake
 * fetch. Covers the tool loop the adapter previously dropped: assistant `functionCall`
 * parts and `functionResponse` results on the way out, and `functionCall` extraction
 * (single-shot + streaming) on the way back — plus the STOP→tool_calls finish-reason
 * normalization that keeps a bare tool-call turn from looking like empty narration.
 */

const req: AiGenerateRequest = {
  system: 'You are the DM.',
  messages: [{ role: 'user', content: 'The party opens the door.' }],
  model: 'gemini-1.5-pro',
  maxTokens: 300,
};

/** A minimal non-streaming Gemini response with the given parts. */
function response(parts: unknown[], finishReason = 'STOP') {
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 },
  };
}

/** Wrap a Gemini JSON chunk as one SSE frame (the adapter requests `?alt=sse`). */
function frame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

describe('GeminiProvider — request mapping (#1062)', () => {
  it('sends x-goog-api-key, system instruction, and a user text content', async () => {
    const { fetchImpl, calls } = fakeFetch(jsonResponse(response([{ text: 'Hi.' }])));
    const p = new GeminiProvider({ apiKey: 'gk-test', model: 'default', fetchImpl });
    await p.generate(req);

    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent');
    expect(calls[0].init.headers['x-goog-api-key']).toBe('gk-test');
    const body = sentBody(calls[0].init);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'You are the DM.' }] });
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'The party opens the door.' }] }]);
  });

  it('advertises tools as functionDeclarations', async () => {
    const { fetchImpl, calls } = fakeFetch(jsonResponse(response([{ text: 'ok' }])));
    const p = new GeminiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    await p.generate({
      ...req,
      tools: [{ name: 'roll_dice', description: 'Roll dice', parameters: { type: 'object', properties: { sides: { type: 'number' } } } }],
    });
    const body = sentBody(calls[0].init) as { tools: unknown[] };
    expect(body.tools).toEqual([
      { functionDeclarations: [{ name: 'roll_dice', description: 'Roll dice', parameters: { type: 'object', properties: { sides: { type: 'number' } } } }] },
    ]);
  });

  it('maps an assistant tool call to a functionCall part and a tool result to a functionResponse part', async () => {
    const { fetchImpl, calls } = fakeFetch(jsonResponse(response([{ text: 'done' }])));
    const p = new GeminiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    await p.generate({
      model: 'm',
      messages: [
        { role: 'user', content: 'roll' },
        { role: 'assistant', content: 'rolling', toolCalls: [{ id: 'call_0', name: 'roll_dice', arguments: { sides: 20 } }] },
        { role: 'tool', toolCallId: 'call_0', toolName: 'roll_dice', content: '{"total":17}' },
      ],
    });
    const body = sentBody(calls[0].init) as { contents: unknown[] };
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'roll' }] },
      { role: 'model', parts: [{ text: 'rolling' }, { functionCall: { name: 'roll_dice', args: { sides: 20 } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'roll_dice', response: { total: 17 } } }] },
    ]);
  });

  it('wraps a non-object tool result under a `result` key and a bare tool-call assistant turn gets an empty text part', async () => {
    const { fetchImpl, calls } = fakeFetch(jsonResponse(response([{ text: 'k' }])));
    const p = new GeminiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    await p.generate({
      model: 'm',
      messages: [
        { role: 'assistant', toolCalls: [{ id: 'call_0', name: 'roll_dice', arguments: {} }] },
        { role: 'tool', toolCallId: 'call_0', toolName: 'roll_dice', content: '17' },
      ],
    });
    const body = sentBody(calls[0].init) as { contents: Array<{ role: string; parts: unknown[] }> };
    expect(body.contents[0]).toEqual({ role: 'model', parts: [{ functionCall: { name: 'roll_dice', args: {} } }] });
    expect(body.contents[1]).toEqual({ role: 'user', parts: [{ functionResponse: { name: 'roll_dice', response: { result: 17 } } }] });
  });
});

describe('GeminiProvider — non-streaming parse (#1062)', () => {
  it('parses text-only with no tool calls', async () => {
    const { fetchImpl } = fakeFetch(jsonResponse(response([{ text: 'A door creaks.' }])));
    const p = new GeminiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const r = await p.generate(req);
    expect(r.text).toBe('A door creaks.');
    expect(r.toolCalls).toEqual([]);
    expect(r.finishReason).toBe('stop');
    expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 4, totalTokens: 14 });
  });

  it('extracts functionCall parts and normalizes STOP → tool_calls', async () => {
    const { fetchImpl } = fakeFetch(
      jsonResponse(response([{ functionCall: { name: 'roll_dice', args: { sides: 20 } } }, { functionCall: { name: 'update_character_hp', args: { characterId: 3, delta: -5 } } }])),
    );
    const p = new GeminiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const r = await p.generate(req);
    expect(r.finishReason).toBe('tool_calls');
    expect(r.toolCalls).toEqual([
      { id: 'call_0', name: 'roll_dice', arguments: { sides: 20 } },
      { id: 'call_1', name: 'update_character_hp', arguments: { characterId: 3, delta: -5 } },
    ]);
  });

  it('handles a mixed text + functionCall response', async () => {
    const { fetchImpl } = fakeFetch(jsonResponse(response([{ text: 'You swing. ' }, { functionCall: { name: 'roll_dice', args: {} } }])));
    const p = new GeminiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const r = await p.generate(req);
    expect(r.text).toBe('You swing. ');
    expect(r.toolCalls).toEqual([{ id: 'call_0', name: 'roll_dice', arguments: {} }]);
    expect(r.finishReason).toBe('tool_calls');
  });
});

describe('GeminiProvider — streaming (#1062)', () => {
  it('streams text deltas and finishes with no tool calls', async () => {
    const { fetchImpl } = fakeFetch(
      streamResponse([
        frame({ candidates: [{ content: { parts: [{ text: 'Hel' }] } }] }),
        frame({ candidates: [{ content: { parts: [{ text: 'lo' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 } }),
      ]),
    );
    const p = new GeminiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const events = await collect<AiStreamEvent>(p.stream(req));
    const texts = events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta);
    expect(texts).toEqual(['Hel', 'lo']);
    const done = events.find((e) => e.type === 'done') as { type: 'done'; result: { text: string; toolCalls: unknown[]; finishReason: string } };
    expect(done.result.text).toBe('Hello');
    expect(done.result.toolCalls).toEqual([]);
    expect(done.result.finishReason).toBe('stop');
  });

  it('emits a tool_call event and aggregates the call into the done result', async () => {
    const { fetchImpl } = fakeFetch(
      streamResponse([
        frame({ candidates: [{ content: { parts: [{ text: 'Rolling…' }] } }] }),
        frame({ candidates: [{ content: { parts: [{ functionCall: { name: 'roll_dice', args: { sides: 20 } } }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 9 } }),
      ]),
    );
    const p = new GeminiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const events = await collect<AiStreamEvent>(p.stream(req));

    const toolEvent = events.find((e) => e.type === 'tool_call') as { type: 'tool_call'; index: number; name: string; argumentsDelta: string };
    expect(toolEvent).toMatchObject({ index: 0, name: 'roll_dice', argumentsDelta: JSON.stringify({ sides: 20 }) });

    const done = events.find((e) => e.type === 'done') as { type: 'done'; result: { toolCalls: unknown[]; finishReason: string } };
    expect(done.result.toolCalls).toEqual([{ id: 'call_0', name: 'roll_dice', arguments: { sides: 20 } }]);
    expect(done.result.finishReason).toBe('tool_calls');
  });
});
