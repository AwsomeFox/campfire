/**
 * Debounces and serializes statblock editor saves per combatant (issue #1909 review,
 * Devin — a regression this PR introduced). `CombatantStatblockEditor` has no debounce of
 * its own: every keystroke (AC, an ability score, an action field, DM notes) calls its
 * `onChange` prop synchronously, which used to PATCH the whole statblock unconditionally.
 * The earlier fix in this PR (`withStatblockRevision`) made that PATCH carry the
 * encounter's CAS token — but every combatant write (this one included) also ADVANCES that
 * same token server-side, so the SECOND keystroke's PATCH would send the token the FIRST
 * keystroke's PATCH had already invalidated, and 409 on a client typing at normal speed.
 *
 * This module does not know anything about revisions/CAS tokens — it only guarantees two
 * structural properties the caller's `save` callback then relies on:
 *
 *   1. DEBOUNCE: rapid `enqueue()` calls for the SAME id within `debounceMs` of each other
 *      coalesce into ONE save of the LATEST draft, not one PATCH per keystroke.
 *   2. SERIALIZATION: a save for a given id never starts while a PRIOR save for that same
 *      id is still in flight — it waits for it to settle first.
 *
 * Property 2 is what actually closes the CAS race: the caller's `save` implementation reads
 * the CURRENT encounter revision from the query cache immediately before constructing its
 * request. Because saves for one id can never overlap, save N+1 always reads that revision
 * AFTER save N's write (and the cache reconciliation that follows it) has fully landed —
 * never a stale snapshot from before save N started.
 */
export interface StatblockSaveQueue<T> {
  /** Debounce a save of `draft` for `id`; coalesces with any pending un-flushed enqueue. */
  enqueue(id: number, draft: T): void;
  /** Force an immediate flush for `id`, bypassing the debounce timer (e.g. on unmount). Resolves once any in-flight and this flush's save have settled. */
  flushNow(id: number): Promise<void>;
}

export function createStatblockSaveQueue<T>(options: {
  debounceMs: number;
  save: (id: number, draft: T) => Promise<void>;
  onError?: (id: number, err: unknown) => void;
}): StatblockSaveQueue<T> {
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const inFlight = new Map<number, Promise<void>>();
  const pendingDrafts = new Map<number, T>();

  async function flush(id: number): Promise<void> {
    // Serialize: wait for whatever is already in flight for this id before starting the
    // next save. `.catch(() => {})` — a prior save's own failure is already reported via
    // `onError`; it must not also reject THIS chain and skip the pending draft it guards.
    const priorInFlight = inFlight.get(id);
    if (priorInFlight) await priorInFlight.catch(() => {});

    const draft = pendingDrafts.get(id);
    if (draft === undefined) return;
    pendingDrafts.delete(id);

    const promise = options.save(id, draft).catch((err) => {
      options.onError?.(id, err);
    });
    inFlight.set(id, promise);
    try {
      await promise;
    } finally {
      // Only clear if we're still the current in-flight entry — a newer flush may have
      // already replaced it (defensive; flush() is itself serialized per id in practice
      // since each flush awaits the prior one before reaching this point).
      if (inFlight.get(id) === promise) inFlight.delete(id);
    }
  }

  return {
    enqueue(id: number, draft: T): void {
      pendingDrafts.set(id, draft);
      const existingTimer = timers.get(id);
      if (existingTimer) clearTimeout(existingTimer);
      const timer = setTimeout(() => {
        timers.delete(id);
        void flush(id);
      }, options.debounceMs);
      timers.set(id, timer);
    },
    async flushNow(id: number): Promise<void> {
      const existingTimer = timers.get(id);
      if (existingTimer) {
        clearTimeout(existingTimer);
        timers.delete(id);
      }
      await flush(id);
    },
  };
}
