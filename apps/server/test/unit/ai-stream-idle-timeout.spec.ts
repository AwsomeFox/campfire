import {
  DEFAULT_IDLE_TIMEOUT_MS,
  parseSse,
  raceRead,
} from '../../src/modules/ai-dm/providers/http';
import { AiProviderError } from '../../src/modules/ai-dm/providers/errors';
import { sseStream } from './ai-provider-fixtures';

/**
 * Issue #1063 — streaming reads enforce an idle/read timeout so a stalled provider
 * body cannot hang forever after headers arrive.
 */

describe('raceRead — idle timeout (#1063)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it(`rejects with AiProviderError(timeout) after ${DEFAULT_IDLE_TIMEOUT_MS}ms of silence`, async () => {
    const hanging = new Promise<never>(() => {
      /* never settles */
    });
    const resultPromise = raceRead(hanging, {
      idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
      provider: 'openai',
      onIdle: () => undefined,
    });

    let settled = false;
    void resultPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await jest.advanceTimersByTimeAsync(DEFAULT_IDLE_TIMEOUT_MS - 1);
    await Promise.resolve();
    expect(settled).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    await expect(resultPromise).rejects.toMatchObject({
      name: 'AiProviderError',
      kind: 'timeout',
      message: expect.stringContaining('stream idle'),
    });
  });

  it('resolves when the read wins the race (idle timer cleared)', async () => {
    const read = Promise.resolve({ value: new Uint8Array([1]), done: false as const });
    const resultPromise = raceRead(read, {
      idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
      provider: 'openai',
      onIdle: () => undefined,
    });
    await expect(resultPromise).resolves.toEqual({ value: new Uint8Array([1]), done: false });

    // Advancing past the idle window must not reject a settled read.
    await jest.advanceTimersByTimeAsync(DEFAULT_IDLE_TIMEOUT_MS + 1_000);
  });

  it('rejects immediately when the caller signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const hanging = new Promise<never>(() => {
      /* never settles */
    });
    await expect(
      raceRead(hanging, {
        signal: ac.signal,
        idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
        provider: 'openai',
        onIdle: () => undefined,
      }),
    ).rejects.toBeInstanceOf(AiProviderError);
  });
});

describe('parseSse — idle timeout mid-body (#1063)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('aborts when the byte stream stalls after the first chunk', async () => {
    const encoder = new TextEncoder();
    let pullCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        if (pullCount === 1) {
          controller.enqueue(encoder.encode('data: {"x":1}\n\n'));
          return;
        }
        // Second read never enqueues — simulates a stalled provider body.
      },
    });

    const iter = parseSse(stream, { idleTimeoutMs: 100, provider: 'openai' });
    // First event arrives immediately.
    const first = await iter.next();
    expect(first.value).toEqual({ event: null, data: '{"x":1}' });

    const nextPromise = iter.next();
    let settled = false;
    void nextPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await jest.advanceTimersByTimeAsync(99);
    await Promise.resolve();
    expect(settled).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    await expect(nextPromise).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('completes normally when chunks keep arriving within the idle window', async () => {
    const frames = ['data: one\n\n', 'data: two\n\n'];
    const out: { event: string | null; data: string }[] = [];
    for await (const rec of parseSse(sseStream(frames), { idleTimeoutMs: 1_000, provider: 'openai' })) {
      out.push(rec);
    }
    expect(out).toEqual([
      { event: null, data: 'one' },
      { event: null, data: 'two' },
    ]);
  });
});
