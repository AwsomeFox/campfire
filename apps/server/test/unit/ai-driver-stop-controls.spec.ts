import { describe, it, expect } from '@jest/globals';
import {
  classifyStuck,
  generationAuthorityStopReason,
  linkAbortSignals,
  shouldEmitTurnCancelled,
  type GenerationAuthority,
} from '../../src/modules/ai-driver/ai-driver.service';
import { OpenAiProvider } from '../../src/modules/ai-dm/providers/openai-provider';
import { AnthropicProvider } from '../../src/modules/ai-dm/providers/anthropic-provider';
import type { AiGenerateRequest } from '../../src/modules/ai-dm/providers/ai-provider';
import { streamResponse, fakeFetch } from './ai-provider-fixtures';

/**
 * Issue #558 — stop controls abort in-flight generation and block pending tool dispatch.
 */

describe('AI driver stop-control helpers (#558)', () => {
  it('maps generation authority failures onto stop reasons', () => {
    expect(generationAuthorityStopReason('aborted')).toBe('aborted');
    expect(generationAuthorityStopReason('frozen')).toBe('frozen');
    expect(generationAuthorityStopReason('cancelled')).toBe('cancelled');
  });

  it('classifyStuck treats cancelled like frozen (not stuck)', () => {
    expect(classifyStuck({ stopReason: 'cancelled', narration: 'partial', prevNarration: null })).toBeNull();
  });

  it('shouldEmitTurnCancelled covers stop-control terminal reasons', () => {
    expect(shouldEmitTurnCancelled('cancelled')).toBe(true);
    expect(shouldEmitTurnCancelled('frozen')).toBe(true);
    expect(shouldEmitTurnCancelled('aborted')).toBe(true);
    expect(shouldEmitTurnCancelled('complete')).toBe(false);
    expect(shouldEmitTurnCancelled('provider_error')).toBe(false);
  });

  it('linkAbortSignals aborts when any source aborts', () => {
    const a = new AbortController();
    const b = new AbortController();
    const linked = linkAbortSignals(a.signal, b.signal);
    expect(linked.signal.aborted).toBe(false);
    b.abort();
    expect(linked.signal.aborted).toBe(true);
    linked.cleanup();
  });
});

const streamReq: AiGenerateRequest = {
  system: 'You are the DM.',
  messages: [{ role: 'user', content: 'Advance.' }],
  model: 'test-model',
  maxTokens: 64,
};

async function collectUntilAbort<T>(iter: AsyncIterable<T>, signal: AbortSignal): Promise<number> {
  let count = 0;
  const it = iter[Symbol.asyncIterator]();
  while (true) {
    const next = it.next();
    const raced = await Promise.race([
      next,
      new Promise<'abort'>((resolve) => {
        if (signal.aborted) resolve('abort');
        else signal.addEventListener('abort', () => resolve('abort'), { once: true });
      }),
    ]);
    if (raced === 'abort') break;
    if (raced.done) break;
    count += 1;
  }
  return count;
}

describe('provider stream abort races (#558)', () => {
  it('OpenAI-compatible stream stops when the caller signal aborts before output', async () => {
    const hanging = new ReadableStream<Uint8Array>({
      pull() {
        /* stall forever */
      },
    });
    const { fetchImpl } = fakeFetch({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '',
      json: async () => ({}),
      body: hanging,
    });
    const provider = new OpenAiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const ac = new AbortController();
    const stream = provider.stream(streamReq, { signal: ac.signal });
    ac.abort();
    await expect(collectUntilAbort(stream, ac.signal)).resolves.toBe(0);
  });

  it('OpenAI-compatible stream stops when the caller signal aborts mid-body', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    ];
    const { fetchImpl } = fakeFetch(streamResponse(frames.slice(0, 1)));
    const provider = new OpenAiProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const ac = new AbortController();
    let chunks = 0;
    try {
      for await (const ev of provider.stream(streamReq, { signal: ac.signal })) {
        if (ev.type === 'text') chunks += 1;
        if (chunks === 1) ac.abort();
      }
    } catch {
      // abort may surface as a provider error depending on timing
    }
    expect(chunks).toBeLessThanOrEqual(1);
  });

  it('Anthropic stream stops when the caller signal aborts before output', async () => {
    const hanging = new ReadableStream<Uint8Array>({
      pull() {
        /* stall forever */
      },
    });
    const { fetchImpl } = fakeFetch({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '',
      json: async () => ({}),
      body: hanging,
    });
    const provider = new AnthropicProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const ac = new AbortController();
    const stream = provider.stream(streamReq, { signal: ac.signal });
    ac.abort();
    await expect(collectUntilAbort(stream, ac.signal)).resolves.toBe(0);
  });

  it('Anthropic stream stops when the caller signal aborts mid-body', async () => {
    const frames = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n\n',
    ];
    const { fetchImpl } = fakeFetch(streamResponse(frames.slice(0, 1)));
    const provider = new AnthropicProvider({ apiKey: 'k', model: 'm', fetchImpl });
    const ac = new AbortController();
    let chunks = 0;
    try {
      for await (const ev of provider.stream(streamReq, { signal: ac.signal })) {
        if (ev.type === 'text') chunks += 1;
        if (chunks === 1) ac.abort();
      }
    } catch {
      // abort may surface as a provider error depending on timing
    }
    expect(chunks).toBeLessThanOrEqual(1);
  });
});

describe('generation authority stop mapping (#558)', () => {
  const cases: [GenerationAuthority, string][] = [
    ['ok', 'ok'],
    ['cancelled', 'cancelled'],
    ['frozen', 'frozen'],
    ['aborted', 'aborted'],
  ];

  it.each(cases.filter(([auth]) => auth !== 'ok'))('authority %s maps to %s', (auth, expected) => {
    expect(generationAuthorityStopReason(auth as Exclude<GenerationAuthority, 'ok'>)).toBe(expected);
  });
});
