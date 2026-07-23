/**
 * Abortable sleep that never leaks AbortSignal listeners (issue #800).
 *
 * The reconnect loops in {@link startSseReconnectLoop} call this on every failed
 * attempt. The previous inline helpers added an `abort` listener per sleep and
 * only cleared the timer on abort — so a timer that fired normally left the
 * listener attached forever. Over a long-lived PWA tab that meant thousands of
 * orphaned listeners on the session AbortSignal.
 *
 * This helper removes the listener on whichever path settles first (timer or
 * abort). Injectable `clock` lets unit tests drive thousands of retries with
 * fake timers without waiting on wall-clock time.
 */

export interface DelayClock {
  setTimeout: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
}

const defaultClock: DelayClock = {
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
};

/**
 * Resolve after `ms`, or sooner if `signal` aborts. Always detaches the abort
 * listener — whether the timer wins, the abort wins, or the signal was already
 * aborted when called.
 */
export function abortableDelay(
  ms: number,
  signal?: AbortSignal,
  clock: DelayClock = defaultClock,
): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    let settled = false;
    let handle: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (handle !== undefined) clock.clearTimeout(handle);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };

    const onAbort = () => finish();
    handle = clock.setTimeout(finish, ms);
    if (signal) {
      signal.addEventListener('abort', onAbort);
      // Cover an abort that raced between the initial check and listener attach.
      if (signal.aborted) finish();
    }
  });
}
