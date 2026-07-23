/**
 * Shared abortable delay utility (issue #800) — resolves after `ms` or when the
 * signal aborts, whichever comes first. Crucially, the abort listener is REMOVED
 * after the timer completes, preventing the cumulative listener leak that occurs
 * when each failed reconnect adds a listener that outlives the delay.
 *
 * Used by both useCampaignEvents and useAiDmStream to consolidate the retry-delay
 * pattern into one tested, leak-free helper.
 */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(handle);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const handle = setTimeout(finish, ms);
    signal.addEventListener('abort', finish);
  });
}
