/**
 * Dashboard summary load policy (issue #581 follow-up).
 *
 * After bounded read budgets landed, SSE reconnect / stream-recovery / schedule
 * catch-up called foreground `load()`, which aborted the in-flight first summary
 * fetch. On flaky mobile proxies that flap the event stream, Home stayed on
 * skeletons forever. Catch-up must use background mode so it never cancels a
 * first load, and Cancel with no projection must surface Retry instead of bare
 * skeletons.
 */

/** Options for SSE/schedule catch-up — never abort an in-flight first load. */
export function dashboardCatchUpOptions(): { background: true } {
  return { background: true };
}

/** Failure shown when the user cancels before any projection arrives. */
export function failureAfterCancel(campaignId: number): { campaignId: number; message: string } {
  return {
    campaignId,
    message: 'Dashboard load cancelled.',
  };
}

/**
 * True when skeletons are on screen after a load attempt finished with no
 * projection and no error — a stranded state that must offer Retry.
 *
 * `loadAttempted` prevents a first-paint flash before the mount effect runs
 * `load()` (loadPending still false on the initial render).
 */
export function shouldShowSkeletonRetry(input: {
  hasSummary: boolean;
  error: string | null;
  loadPending: boolean;
  loadAttempted: boolean;
}): boolean {
  return (
    input.loadAttempted
    && !input.hasSummary
    && input.error == null
    && !input.loadPending
  );
}
