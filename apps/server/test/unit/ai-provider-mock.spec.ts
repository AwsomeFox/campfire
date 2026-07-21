import { MockAiProvider, mockTokenCount } from '../../src/modules/ai-dm/providers/mock-provider';
import type { AiGenerateRequest, AiStreamEvent } from '../../src/modules/ai-dm/providers/ai-provider';
import { collect } from './ai-provider-fixtures';

/**
 * Deterministic mock/echo provider (#309, unblocks #318 evals). No network. Asserts the
 * canned-response queue, the echo fallback, prompt recording, deterministic usage, and a
 * streaming path that reassembles to the same result as `generate`.
 */

const req = (prompt: string): AiGenerateRequest => ({ system: 'sys', messages: [{ role: 'user', content: prompt }], model: 'm' });

describe('MockAiProvider — echo fallback', () => {
  it('echoes the last user message and records every request', async () => {
    const p = new MockAiProvider();
    const r1 = await p.generate(req('hello'));
    const r2 = await p.generate(req('again'));
    expect(r1.text).toBe('echo: hello');
    expect(r2.text).toBe('echo: again');
    expect(p.received).toHaveLength(2);
    expect(p.received[0].messages[0].content).toBe('hello');
  });

  it('derives deterministic, reproducible usage from prompt + reply length', async () => {
    const p = new MockAiProvider();
    const r = await p.generate(req('hello'));
    const promptText = 'sys' + 'hello';
    expect(r.usage.promptTokens).toBe(mockTokenCount(promptText));
    expect(r.usage.completionTokens).toBe(mockTokenCount('echo: hello'));
    expect(r.usage.totalTokens).toBe(r.usage.promptTokens + r.usage.completionTokens);
  });
});

describe('MockAiProvider — canned responses', () => {
  it('consumes queued responses in order, then falls back to echo', async () => {
    const p = new MockAiProvider({ responses: [{ text: 'first' }, { text: 'second' }] });
    expect((await p.generate(req('a'))).text).toBe('first');
    expect((await p.generate(req('b'))).text).toBe('second');
    expect((await p.generate(req('c'))).text).toBe('echo: c'); // queue exhausted
  });

  it('returns canned tool calls and marks finishReason tool_calls', async () => {
    const p = new MockAiProvider({
      responses: [{ text: '', toolCalls: [{ id: 'call_1', name: 'roll_dice', arguments: { sides: 20 } }] }],
    });
    const r = await p.generate(req('roll'));
    expect(r.toolCalls).toEqual([{ id: 'call_1', name: 'roll_dice', arguments: { sides: 20 } }]);
    expect(r.finishReason).toBe('tool_calls');
  });

  it('honours an explicit usage override', async () => {
    const p = new MockAiProvider({ responses: [{ text: 'x', usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } }] });
    expect((await p.generate(req('y'))).usage).toEqual({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
  });
});

describe('MockAiProvider — streaming', () => {
  it('chunks text, emits tool-call + usage + done, and the done result matches the text', async () => {
    const p = new MockAiProvider({ responses: [{ text: 'abcdef', streamChunks: 3, toolCalls: [{ id: 'c1', name: 't', arguments: { a: 1 } }] }] });
    const events = await collect(p.stream(req('go')));

    const text = events.filter((e): e is Extract<AiStreamEvent, { type: 'text' }> => e.type === 'text').map((e) => e.delta).join('');
    expect(text).toBe('abcdef');
    expect(events.filter((e) => e.type === 'text')).toHaveLength(3);
    expect(events.some((e) => e.type === 'tool_call')).toBe(true);
    expect(events.some((e) => e.type === 'usage')).toBe(true);

    const done = events.at(-1);
    expect(done?.type).toBe('done');
    expect(done && done.type === 'done' && done.result.text).toBe('abcdef');
    expect(p.received).toHaveLength(1);
  });
});
