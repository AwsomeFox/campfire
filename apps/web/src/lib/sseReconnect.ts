/**
 * Shared SSE reconnect infrastructure for campaign events and AI-DM streams
 * (issue #800).
 *
 * Both hooks previously inlined nearly identical fetch + ReadableStream loops
 * with capped exponential backoff. The AI-DM copy leaked an abort listener on
 * every completed reconnect delay; consolidating here gives one place that:
 *   - sleeps via {@link abortableDelay} (listener removed on timer or abort),
 *   - cancels the active reader + in-flight request + pending delay on dispose
 *     (unmount / campaign change / `enabled: false`),
 *   - optionally tracks browser online/offline the way campaign events need,
 *   - parses frames through {@link SseParser} (#748) including stream recovery.
 */

import { abortableDelay, type DelayClock } from './abortableDelay';
import { classifyStreamConnectStatus, signalSessionExpired } from './sessionExpiry';
import { SseParser, type SseParseSignal } from './sseParse';

export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 15_000;

/** Capped exponential backoff for attempt `n` (0-based). */
export function reconnectBackoffMs(attempt: number): number {
  return Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
}

/** Extracts the concatenated `data:` payload of one SSE event block. */
export function sseBlockData(block: string): string {
  return block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart())
    .join('\n');
}

/** Auth surface shared with lib/api.ts — cookie + optional dev-role overrides. */
export function sseAuthHeaders(
  storage: Pick<Storage, 'getItem'> | null = typeof localStorage !== 'undefined' ? localStorage : null,
): Record<string, string> {
  const headers: Record<string, string> = { accept: 'text/event-stream' };
  const devRole = storage?.getItem('cf.devRole');
  const devUser = storage?.getItem('cf.devUser');
  if (devRole) headers['x-dev-role'] = devRole;
  if (devUser) headers['x-dev-user'] = devUser;
  return headers;
}

export type SseStreamStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'stopped';

export interface SseReconnectHandle {
  /** Cancel reader, in-flight fetch, and any pending delay. Idempotent. */
  dispose(): void;
  /** True after {@link dispose} (or a terminal 401/403 stop). */
  readonly disposed: boolean;
}

export interface SseReconnectOptions {
  url: string;
  /** Raw SSE `data:` payload (one event block). Keepalive empty payloads are skipped. */
  onData: (data: string) => void;
  /** Fires after a drop (or initial offline) is healed by a successful connect. */
  onReconnect?: () => void;
  /**
   * Fires when {@link SseParser} discards mid-stream bytes while the connection
   * stays up (issue #748). Distinct from {@link onReconnect}.
   */
  onStreamRecovery?: () => void;
  onStatusChange?: (status: SseStreamStatus) => void;
  /**
   * When true, the loop waits while `navigator.onLine` is false, aborts the
   * active request on `offline`, and wakes reconnect delays on `online`.
   */
  trackBrowserOnline?: boolean;
  /** Injectable seams for fake-timer / soak tests. */
  fetchFn?: typeof fetch;
  delayFn?: typeof abortableDelay;
  clock?: DelayClock;
  isOnline?: () => boolean;
  addWindowListener?: Window['addEventListener'];
  removeWindowListener?: Window['removeEventListener'];
}

/**
 * Start the reconnect loop. Call {@link SseReconnectHandle.dispose} from the
 * React effect cleanup (unmount / campaignId change / disabled).
 */
export function startSseReconnectLoop(options: SseReconnectOptions): SseReconnectHandle {
  const fetchFn = options.fetchFn ?? fetch;
  const delayFn = options.delayFn ?? abortableDelay;
  const clock = options.clock;
  const isOnline = options.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const addWindowListener: Window['addEventListener'] =
    options.addWindowListener ??
    ((...args: Parameters<Window['addEventListener']>) => {
      if (typeof window !== 'undefined') window.addEventListener(...args);
    });
  const removeWindowListener: Window['removeEventListener'] =
    options.removeWindowListener ??
    ((...args: Parameters<Window['removeEventListener']>) => {
      if (typeof window !== 'undefined') window.removeEventListener(...args);
    });
  const trackBrowserOnline = options.trackBrowserOnline ?? false;

  const session = new AbortController();
  let disposed = false;
  let activeRequest: AbortController | null = null;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let status: SseStreamStatus | null = null;
  let needsCatchUp = trackBrowserOnline ? !isOnline() : false;
  let offlineAttached = false;

  const detachOffline = () => {
    if (!offlineAttached) return;
    offlineAttached = false;
    removeWindowListener('offline', onOffline);
  };

  const handle: SseReconnectHandle = {
    get disposed() {
      return disposed;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // Drop browser listeners immediately so status cannot stick on `offline`
      // waiting for the async loop's `finally` after a custom fetch hangs.
      detachOffline();
      void activeReader?.cancel().catch(() => {
        /* already closed / aborted */
      });
      activeReader = null;
      activeRequest?.abort();
      activeRequest = null;
      session.abort();
    },
  };

  const setStatus = (next: SseStreamStatus) => {
    if (status === next || disposed) return;
    status = next;
    options.onStatusChange?.(next);
  };

  const sleep = async (ms: number) => {
    if (disposed || session.signal.aborted) return;

    if (!trackBrowserOnline) {
      await (clock ? delayFn(ms, session.signal, clock) : delayFn(ms, session.signal));
      return;
    }

    const wake = new AbortController();
    const onOnline = () => wake.abort();
    const onSessionAbort = () => wake.abort();
    addWindowListener('online', onOnline);
    session.signal.addEventListener('abort', onSessionAbort);
    try {
      await (clock ? delayFn(ms, wake.signal, clock) : delayFn(ms, wake.signal));
    } finally {
      removeWindowListener('online', onOnline);
      session.signal.removeEventListener('abort', onSessionAbort);
    }
  };

  function onOffline() {
    if (!trackBrowserOnline || disposed) return;
    needsCatchUp = true;
    setStatus('offline');
    activeRequest?.abort();
  }

  if (trackBrowserOnline) {
    addWindowListener('offline', onOffline);
    offlineAttached = true;
    setStatus(isOnline() ? 'connecting' : 'offline');
  } else {
    setStatus('connecting');
  }

  void (async () => {
    let attempt = 0;
    try {
      while (!disposed && !session.signal.aborted) {
        if (trackBrowserOnline && !isOnline()) {
          setStatus('offline');
          await sleep(RECONNECT_MAX_MS);
          continue;
        }

        try {
          activeRequest = new AbortController();
          const onSessionAbortRequest = () => activeRequest?.abort();
          session.signal.addEventListener('abort', onSessionAbortRequest);
          let res: Response;
          try {
            res = await fetchFn(options.url, {
              credentials: 'include',
              headers: sseAuthHeaders(),
              signal: activeRequest.signal,
            });
          } finally {
            session.signal.removeEventListener('abort', onSessionAbortRequest);
          }

          const auth = classifyStreamConnectStatus(res.status);
          if (auth === 'session-expired') {
            // Proven 401 — fan out so AuthProvider can show reauth; stop until
            // resumeEpoch advances after login (issue #885).
            signalSessionExpired();
            setStatus('stopped');
            disposed = true;
            return;
          }
          if (auth === 'forbidden') {
            setStatus('stopped');
            disposed = true;
            return;
          }
          if (!res.ok || !res.body) throw new Error(`SSE connect failed (${res.status})`);

          const reconnected = needsCatchUp;
          attempt = 0;
          needsCatchUp = false;
          setStatus('connected');
          if (reconnected) options.onReconnect?.();

          activeReader = res.body.getReader();
          const reader = activeReader;
          // Incremental SSE parser (#748): CRLF/CR/LF frames, heartbeats, multiline
          // data, UTF-8 chunk splits, and bounded recovery for malformed streams.
          const parser = new SseParser();
          const consume = (signals: SseParseSignal[]) => {
            for (const signal of signals) {
              if (signal.kind === 'recovered') {
                needsCatchUp = true;
                if (!disposed) options.onStreamRecovery?.();
                continue;
              }
              if (signal.kind !== 'message') continue;
              const data = signal.message.data;
              if (!data) continue;
              if (!disposed) options.onData(data);
            }
          };
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) {
                consume(parser.flush());
                break;
              }
              consume(parser.push(value));
            }
          } finally {
            if (activeReader === reader) activeReader = null;
          }

          throw new Error('SSE stream ended');
        } catch {
          if (disposed || session.signal.aborted) return;
          needsCatchUp = true;
          setStatus(trackBrowserOnline && !isOnline() ? 'offline' : 'reconnecting');
          await sleep(reconnectBackoffMs(attempt));
          attempt += 1;
        } finally {
          activeRequest = null;
        }
      }
    } finally {
      detachOffline();
    }
  })();

  return handle;
}
