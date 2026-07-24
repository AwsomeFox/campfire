/**
 * Pure announcement queue + grouping helpers for the app-root live regions
 * (issue #839).
 *
 * The previous Announcer kept one shared `requestAnimationFrame` handle and
 * cancelled it on every `announce()`, so a turn change followed by HP updates in
 * the same tick silently dropped earlier messages. This module:
 *   - keeps polite and assertive channels independent,
 *   - buffers rapid messages and flushes them without dropping content,
 *   - optionally dedupes reconnect/refetch chatter via `dedupeKey`,
 *   - exports a concise grouped-message helper for bulk HP/condition updates.
 *
 * Side effects (RAF / timers / React state) are injected so the queue can be
 * exercised in a `.unit.spec.ts` without a browser.
 */

export type AnnouncementChannel = 'polite' | 'assertive';

export type AnnounceOptions = {
  assertive?: boolean;
  /**
   * When set, a second announce with the same key within {@link ANNOUNCE_DEDUPE_MS}
   * is ignored. Intentional identical re-announces (e.g. two "1d20: 15" rolls)
   * omit a key and still clear+repaint as before.
   */
  dedupeKey?: string;
};

export type AnnounceFn = (message: string, options?: AnnounceOptions) => void;

export type LiveRegionUpdater = {
  clear: (channel: AnnouncementChannel) => void;
  set: (channel: AnnouncementChannel, message: string) => void;
};

export type AnnouncerScheduler = {
  /** Schedule `fn` before the next paint; return a cancel function. */
  nextFrame: (fn: () => void) => () => void;
  /** Schedule `fn` after `ms`; return a cancel function. */
  after: (ms: number, fn: () => void) => () => void;
  now: () => number;
};

/** Gap between successive live-region flushes so SRs can finish the prior utterance. */
export const ANNOUNCE_DWELL_MS = 700;

/** Window for `dedupeKey` suppression (SSE reconnect / refetch chatter). */
export const ANNOUNCE_DEDUPE_MS = 2_000;

/** Hard cap for `recentKeys` so bursty unique keys cannot grow without bound. */
export const ANNOUNCE_RECENT_KEYS_MAX = 64;

type PendingItem = {
  message: string;
  dedupeKey?: string;
};

type ChannelState = {
  pending: PendingItem[];
  speaking: boolean;
  cancelFrame: (() => void) | null;
  cancelDwell: (() => void) | null;
};

export type AnnounceQueue = {
  announce: AnnounceFn;
  /** Wipe both channels, cancel timers, and drop dedupe memory (logout / #506). */
  clear: () => void;
  dispose: () => void;
};

function punctuate(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Join semantically distinct announcement fragments into one atomic live-region
 * message without discarding any fragment's content.
 */
export function formatGroupedAnnouncement(messages: readonly string[]): string {
  const parts = messages.map((m) => m.trim()).filter(Boolean).map(punctuate);
  if (parts.length === 0) return '';
  return parts.join(' ');
}

/**
 * Concise grouped message for bulk HP / condition updates. A single change stays
 * as-is; several are prefixed with a count so a reconnect burst stays scannable.
 */
export function formatGroupedCombatantAnnouncement(updates: readonly string[]): string {
  const parts = updates.map((u) => u.trim()).filter(Boolean).map(punctuate);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0]!;
  return `${parts.length} combatant updates. ${parts.join(' ')}`;
}

/**
 * Compact FNV-1a fingerprint for `dedupeKey` payloads so call sites need not
 * embed large joined strings (combatant update text, event-id lists, …).
 */
export function fingerprintDedupeParts(parts: readonly string[]): string {
  let h = 0x811c9dc5;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      h ^= part.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    // Separator so ["ab","c"] and ["a","bc"] do not collide.
    h ^= 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Create a dual-channel announcement queue. Empty-string announces wipe the
 * channel immediately (and drop its pending buffer) — used when mounting the
 * player cast view so exact HP text never lingers (#232).
 */
export function createAnnounceQueue(opts: {
  updater: LiveRegionUpdater;
  scheduler: AnnouncerScheduler;
  dwellMs?: number;
  dedupeMs?: number;
  recentKeysMax?: number;
}): AnnounceQueue {
  const dwellMs = opts.dwellMs ?? ANNOUNCE_DWELL_MS;
  const dedupeMs = opts.dedupeMs ?? ANNOUNCE_DEDUPE_MS;
  const recentKeysMax = opts.recentKeysMax ?? ANNOUNCE_RECENT_KEYS_MAX;
  // Insertion-ordered map: re-set moves a key to the newest position (LRU).
  const recentKeys = new Map<string, number>();
  let disposed = false;

  const channels: Record<AnnouncementChannel, ChannelState> = {
    polite: { pending: [], speaking: false, cancelFrame: null, cancelDwell: null },
    assertive: { pending: [], speaking: false, cancelFrame: null, cancelDwell: null },
  };

  function cancelChannelTimers(state: ChannelState): void {
    state.cancelFrame?.();
    state.cancelFrame = null;
    state.cancelDwell?.();
    state.cancelDwell = null;
  }

  function forgetPendingDedupeKeys(state: ChannelState): void {
    for (const item of state.pending) {
      if (item.dedupeKey) recentKeys.delete(item.dedupeKey);
    }
  }

  function wipeChannel(channel: AnnouncementChannel): void {
    const state = channels[channel];
    // Drop dedupe for never-spoken pending items so a retry is not suppressed.
    forgetPendingDedupeKeys(state);
    state.pending.length = 0;
    cancelChannelTimers(state);
    state.speaking = false;
    opts.updater.clear(channel);
  }

  function rememberKey(key: string, now: number): boolean {
    const last = recentKeys.get(key);
    if (last != null && now - last < dedupeMs) return false;
    // Refresh LRU position on accept.
    if (recentKeys.has(key)) recentKeys.delete(key);
    recentKeys.set(key, now);

    if (recentKeys.size > recentKeysMax) {
      for (const [k, at] of recentKeys) {
        if (now - at >= dedupeMs) recentKeys.delete(k);
      }
    }
    // Hard cap: delete oldest entries until bounded, even under bursty unique keys.
    while (recentKeys.size > recentKeysMax) {
      const oldest = recentKeys.keys().next().value;
      if (oldest === undefined) break;
      recentKeys.delete(oldest);
    }
    return true;
  }

  function flush(channel: AnnouncementChannel): void {
    const state = channels[channel];
    if (state.pending.length === 0) {
      state.speaking = false;
      return;
    }
    // Already waiting on a clear→set frame: leave pending in place so same-tick
    // announces (turn + HP loop) coalesce into that flush instead of racing it.
    if (state.cancelFrame != null) return;

    state.speaking = true;
    // Clear first so an identical consecutive message still triggers the SR.
    opts.updater.clear(channel);
    state.cancelFrame = opts.scheduler.nextFrame(() => {
      state.cancelFrame = null;
      const batch = state.pending.splice(0, state.pending.length);
      const message = formatGroupedAnnouncement(batch.map((item) => item.message));
      if (!message) {
        // Batch produced nothing spoken — release any dedupe keys that never aired.
        for (const item of batch) {
          if (item.dedupeKey) recentKeys.delete(item.dedupeKey);
        }
        if (state.pending.length > 0) flush(channel);
        else state.speaking = false;
        return;
      }
      opts.updater.set(channel, message);
      state.cancelDwell = opts.scheduler.after(dwellMs, () => {
        state.cancelDwell = null;
        if (state.pending.length > 0) flush(channel);
        else state.speaking = false;
      });
    });
  }

  function announce(message: string, options?: AnnounceOptions): void {
    if (disposed) return;

    const channel: AnnouncementChannel = options?.assertive ? 'assertive' : 'polite';
    const state = channels[channel];

    if (message === '') {
      // Wipe: drop pending chatter (and its never-spoken dedupe keys) and clear
      // the live region immediately.
      wipeChannel(channel);
      return;
    }

    const trimmed = message.trim();
    if (!trimmed) return;

    const dedupeKey = options?.dedupeKey;
    if (dedupeKey) {
      const now = opts.scheduler.now();
      if (!rememberKey(dedupeKey, now)) return;
    }

    state.pending.push({ message: trimmed, dedupeKey });
    // Kick a flush when idle, or when dwelling with new work already queued for
    // the next cycle (speaking && cancelDwell). Same-tick work before the RAF
    // callback is picked up by the in-flight flush via cancelFrame short-circuit.
    if (!state.speaking) flush(channel);
  }

  function clear(): void {
    if (disposed) return;
    wipeChannel('polite');
    wipeChannel('assertive');
    recentKeys.clear();
  }

  function dispose(): void {
    if (disposed) return;
    clear();
    disposed = true;
  }

  return { announce, clear, dispose };
}

/** Browser scheduler used by AnnounceProvider. */
export function createBrowserAnnouncerScheduler(): AnnouncerScheduler {
  return {
    nextFrame: (fn) => {
      const id = requestAnimationFrame(fn);
      return () => cancelAnimationFrame(id);
    },
    after: (ms, fn) => {
      const id = window.setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
    now: () => Date.now(),
  };
}
