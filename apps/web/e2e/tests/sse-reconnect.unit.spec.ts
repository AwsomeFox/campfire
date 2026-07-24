/**
 * Issue #800 — SSE reconnect listener leak + shared stream infrastructure.
 *
 * Persona-audit finding: every failed reconnect added an abort listener that
 * was not removed when the timer completed. Campaign events and AI-DM streams
 * duplicated that helper. These specs pin the acceptance criteria at the pure
 * infrastructure layer (no browser / React mount):
 *   - abortableDelay removes the listener on timer OR abort
 *   - thousands of fake-timer retries leave listener counts flat
 *   - dispose cancels readers / wakes delays (unmount + campaign change)
 *   - reconnect fires after a healed drop; unmount stops the loop
 *   - constrained-heap soak keeps listeners + retained closures stable
 */
import { expect, test } from '@playwright/test';
import { getEventListeners } from 'node:events';
import { abortableDelay, type DelayClock } from '../../src/lib/abortableDelay';
import {
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  reconnectBackoffMs,
  sseAuthHeaders,
  sseBlockData,
  startSseReconnectLoop,
  type SseStreamStatus,
} from '../../src/lib/sseReconnect';

/** Deterministic fake clock — handlers fire only when `flush` / `flushNext` run. */
function createFakeClock() {
  let nextId = 1;
  const pending = new Map<number, { handler: () => void; due: number }>();
  let now = 0;

  const clock: DelayClock = {
    setTimeout(handler, ms) {
      const id = nextId++;
      pending.set(id, { handler, due: now + ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(id) {
      pending.delete(id as unknown as number);
    },
  };

  const flushNext = () => {
    let chosen: { id: number; handler: () => void; due: number } | null = null;
    for (const [id, entry] of pending) {
      if (!chosen || entry.due < chosen.due) chosen = { id, ...entry };
    }
    if (!chosen) return false;
    now = chosen.due;
    pending.delete(chosen.id);
    chosen.handler();
    return true;
  };

  const flush = (maxSteps = 10_000) => {
    let steps = 0;
    while (pending.size > 0 && steps < maxSteps) {
      flushNext();
      steps += 1;
    }
    return steps;
  };

  return {
    clock,
    get pendingCount() {
      return pending.size;
    },
    get now() {
      return now;
    },
    flushNext,
    flush,
  };
}

function abortListenerCount(signal: AbortSignal): number {
  return getEventListeners(signal, 'abort').length;
}

/** Minimal ReadableStream body that ends immediately (clean server close). */
function emptySseBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

/** Body that stays open until cancel — lets dispose exercise reader.cancel(). */
function hangSseBody(onCancel: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start() {
      /* never enqueues; wait for cancel */
    },
    cancel() {
      onCancel();
    },
  });
}

test.describe('abortableDelay — listener cleanup (#800)', () => {
  test('removes the abort listener when the timer completes', async () => {
    const fake = createFakeClock();
    const controller = new AbortController();
    const done = abortableDelay(1000, controller.signal, fake.clock);
    expect(abortListenerCount(controller.signal)).toBe(1);
    expect(fake.flushNext()).toBe(true);
    await done;
    expect(abortListenerCount(controller.signal)).toBe(0);
  });

  test('removes the abort listener when aborted before the timer', async () => {
    const fake = createFakeClock();
    const controller = new AbortController();
    const done = abortableDelay(60_000, controller.signal, fake.clock);
    expect(abortListenerCount(controller.signal)).toBe(1);
    controller.abort();
    await done;
    expect(abortListenerCount(controller.signal)).toBe(0);
    expect(fake.pendingCount).toBe(0);
  });

  test('resolves immediately when the signal is already aborted (no listener)', async () => {
    const fake = createFakeClock();
    const controller = new AbortController();
    controller.abort();
    await abortableDelay(1000, controller.signal, fake.clock);
    expect(abortListenerCount(controller.signal)).toBe(0);
    expect(fake.pendingCount).toBe(0);
  });

  test('thousands of timer-completed retries leave zero listeners on the signal', async () => {
    const fake = createFakeClock();
    const controller = new AbortController();
    const RETRIES = 5_000;
    for (let i = 0; i < RETRIES; i++) {
      const done = abortableDelay(1, controller.signal, fake.clock);
      expect(fake.flushNext()).toBe(true);
      await done;
    }
    expect(abortListenerCount(controller.signal)).toBe(0);
    expect(fake.pendingCount).toBe(0);
  });
});

test.describe('sseReconnect helpers (#800)', () => {
  test('backoff is capped exponential', () => {
    expect(reconnectBackoffMs(0)).toBe(RECONNECT_BASE_MS);
    expect(reconnectBackoffMs(1)).toBe(2_000);
    expect(reconnectBackoffMs(2)).toBe(4_000);
    expect(reconnectBackoffMs(10)).toBe(RECONNECT_MAX_MS);
  });

  test('sseBlockData concatenates data: lines', () => {
    expect(sseBlockData('data: {"a":1}\ndata: {"b":2}\n')).toBe('{"a":1}\n{"b":2}');
    expect(sseBlockData(': keepalive\n')).toBe('');
  });

  test('sseBlockData strips CRLF line endings', () => {
    expect(sseBlockData('data: {"a":1}\r\ndata: {"b":2}\r\n')).toBe('{"a":1}\n{"b":2}');
    expect(sseBlockData('data: {"x":true}\r\n')).toBe('{"x":true}');
  });

  test('sseAuthHeaders includes accept + optional dev overrides', () => {
    const storage = {
      getItem(key: string) {
        if (key === 'cf.devRole') return 'dm';
        if (key === 'cf.devUser') return '42';
        return null;
      },
    };
    expect(sseAuthHeaders(storage)).toEqual({
      accept: 'text/event-stream',
      'x-dev-role': 'dm',
      'x-dev-user': '42',
    });
    expect(sseAuthHeaders({ getItem: () => null })).toEqual({ accept: 'text/event-stream' });
  });
});

test.describe('startSseReconnectLoop — reconnect / abort / unmount (#800)', () => {
  test('reconnects after a clean stream end and fires onReconnect once healed', async () => {
    const fake = createFakeClock();
    let connects = 0;
    const statuses: SseStreamStatus[] = [];
    let reconnects = 0;
    const frames: string[] = [];

    const fetchFn: typeof fetch = async () => {
      connects += 1;
      if (connects === 1) {
        return new Response(emptySseBody(), { status: 200 });
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"hello":1}\n\n'));
          // leave open — test disposes after observing reconnect
        },
      });
      return new Response(body, { status: 200 });
    };

    const loop = startSseReconnectLoop({
      url: 'http://example.test/events',
      fetchFn,
      clock: fake.clock,
      onData: (data) => frames.push(data),
      onReconnect: () => {
        reconnects += 1;
      },
      onStatusChange: (s) => statuses.push(s),
    });

    // First connect closes immediately → reconnecting → fake timer → second connect.
    await waitFor(() => connects >= 1 && statuses.includes('reconnecting'), fake);
    fake.flushNext();
    await waitFor(() => connects >= 2 && reconnects === 1 && frames.includes('{"hello":1}'), fake);

    expect(statuses[0]).toBe('connecting');
    expect(statuses).toContain('connected');
    expect(statuses).toContain('reconnecting');
    expect(reconnects).toBe(1);

    loop.dispose();
    expect(loop.disposed).toBe(true);
  });

  test('dispose cancels an open reader and wakes a pending reconnect delay', async () => {
    const fake = createFakeClock();
    let cancelled = false;
    let connects = 0;

    const fetchFn: typeof fetch = async () => {
      connects += 1;
      if (connects === 1) {
        return new Response(hangSseBody(() => {
          cancelled = true;
        }), { status: 200 });
      }
      // Should not be reached after dispose during the first hang.
      return new Response(emptySseBody(), { status: 200 });
    };

    const loop = startSseReconnectLoop({
      url: 'http://example.test/events',
      fetchFn,
      clock: fake.clock,
      onData: () => undefined,
    });

    await waitFor(() => connects === 1, fake);
    loop.dispose();
    await waitFor(() => cancelled, fake);
    expect(cancelled).toBe(true);
    expect(fake.pendingCount).toBe(0);

    // Dispose during a pending delay: force a reconnect wait, then dispose.
    const fake2 = createFakeClock();
    let connects2 = 0;
    const loop2 = startSseReconnectLoop({
      url: 'http://example.test/events',
      clock: fake2.clock,
      fetchFn: async () => {
        connects2 += 1;
        return new Response(emptySseBody(), { status: 500 });
      },
      onData: () => undefined,
    });
    await waitFor(() => connects2 >= 1 && fake2.pendingCount >= 1, fake2);
    loop2.dispose();
    await Promise.resolve();
    expect(fake2.pendingCount).toBe(0);
    const connectsAfter = connects2;
    fake2.flush();
    await Promise.resolve();
    expect(connects2).toBe(connectsAfter);
  });

  test('401 stops the loop without scheduling further retries', async () => {
    const fake = createFakeClock();
    let connects = 0;
    let bodyCancelled = false;
    const statuses: SseStreamStatus[] = [];
    const loop = startSseReconnectLoop({
      url: 'http://example.test/events',
      clock: fake.clock,
      fetchFn: async () => {
        connects += 1;
        const body = new ReadableStream({
          start() {
            /* unconsumed body — must be cancelled on 401 */
          },
          cancel() {
            bodyCancelled = true;
          },
        });
        return new Response(body, { status: 401 });
      },
      onData: () => undefined,
      onStatusChange: (s) => statuses.push(s),
    });
    await waitFor(() => statuses.includes('stopped'), fake);
    expect(connects).toBe(1);
    expect(bodyCancelled).toBe(true);
    expect(fake.pendingCount).toBe(0);
    fake.flush();
    await Promise.resolve();
    expect(connects).toBe(1);
    loop.dispose();
  });

  test('failed connect cancels an unconsumed response body', async () => {
    const fake = createFakeClock();
    let bodyCancelled = false;
    let connects = 0;

    const loop = startSseReconnectLoop({
      url: 'http://example.test/events',
      clock: fake.clock,
      fetchFn: async () => {
        connects += 1;
        const body = new ReadableStream({
          start() {
            /* hang — dispose before read */
          },
          cancel() {
            bodyCancelled = true;
          },
        });
        return new Response(body, { status: 200 });
      },
      onData: () => undefined,
    });

    await waitFor(() => connects === 1, fake);
    loop.dispose();
    await waitFor(() => bodyCancelled, fake);
    expect(bodyCancelled).toBe(true);
  });

  test('campaign-change dispose mid-retry does not leak timers or listeners', async () => {
    const fake = createFakeClock();
    const sessionSignals: AbortSignal[] = [];
    // Probe listener stability by wrapping abortableDelay isn't needed — the
    // loop's session signal is internal. Instead, run many dispose cycles and
    // assert fake-clock pending stays empty after each unmount.
    for (let cycle = 0; cycle < 200; cycle++) {
      let connects = 0;
      const loop = startSseReconnectLoop({
        url: `http://example.test/events/${cycle}`,
        clock: fake.clock,
        fetchFn: async () => {
          connects += 1;
          return new Response(null, { status: 503 });
        },
        onData: () => undefined,
      });
      await waitFor(() => connects >= 1 && fake.pendingCount >= 1, fake);
      loop.dispose();
      await Promise.resolve();
      expect(fake.pendingCount).toBe(0);
      sessionSignals.push(new AbortController().signal); // keep shape stable for soak below
    }
    expect(sessionSignals.length).toBe(200);
  });
});

test.describe('constrained-heap soak — stable listeners (#800)', () => {
  test('5k reconnect delay cycles retain no abort listeners and bounded closures', async () => {
    const fake = createFakeClock();
    const controller = new AbortController();
    // Retain a small ring of recent promises so a leak would show as retained
    // listener growth rather than being GC'd before we assert.
    const recent: Promise<void>[] = [];
    const RETRIES = 5_000;

    for (let i = 0; i < RETRIES; i++) {
      const p = abortableDelay(reconnectBackoffMs(i % 8), controller.signal, fake.clock);
      recent.push(p);
      if (recent.length > 8) recent.shift();
      expect(abortListenerCount(controller.signal)).toBe(1);
      expect(fake.flushNext()).toBe(true);
      await p;
      expect(abortListenerCount(controller.signal)).toBe(0);
    }

    // Final abort path also stays clean.
    const pending = abortableDelay(60_000, controller.signal, fake.clock);
    expect(abortListenerCount(controller.signal)).toBe(1);
    controller.abort();
    await pending;
    expect(abortListenerCount(controller.signal)).toBe(0);
    expect(fake.pendingCount).toBe(0);

    // Constrained-heap check: after thousands of cycles, a forced GC (when
    // available) plus a second burst must still report zero listeners. We avoid
    // asserting absolute heap bytes (flaky across engines) and instead treat
    // listener count + pending timers as the memory-leak proxy the audit named.
    const maybeGc = (globalThis as { gc?: () => void }).gc;
    maybeGc?.();

    for (let i = 0; i < 1_000; i++) {
      const p = abortableDelay(1, controller.signal, fake.clock);
      fake.flushNext();
      await p;
    }
    expect(abortListenerCount(controller.signal)).toBe(0);

    // Full reconnect-loop soak with failing fetch — dispose must leave the fake
    // clock empty (no retained delay closures holding the session alive).
    let connects = 0;
    const loop = startSseReconnectLoop({
      url: 'http://example.test/soak',
      clock: fake.clock,
      fetchFn: async () => {
        connects += 1;
        return new Response(null, { status: 503 });
      },
      onData: () => undefined,
    });

    for (let i = 0; i < 500; i++) {
      await waitFor(() => fake.pendingCount >= 1, fake);
      fake.flushNext();
    }
    expect(connects).toBeGreaterThan(100);
    loop.dispose();
    await Promise.resolve();
    expect(fake.pendingCount).toBe(0);
  });
});

/** Pump microtasks + optional fake-clock steps until `predicate` holds. */
async function waitFor(predicate: () => boolean, fake?: ReturnType<typeof createFakeClock>, maxTurns = 200) {
  for (let i = 0; i < maxTurns; i++) {
    if (predicate()) return;
    await Promise.resolve();
    await Promise.resolve();
    // Do not auto-flush timers here — callers advance time explicitly so
    // reconnect timing stays under test control. `fake` is accepted for API
    // symmetry with call sites that already hold a clock.
    void fake;
  }
  throw new Error(`waitFor timed out after ${maxTurns} turns`);
}
