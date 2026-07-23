/**
 * When the run-session action-error banner should clear (issue #430).
 *
 * Stale banners used to linger after ordinary Refresh and after unrelated
 * successful recovery — only the banner's Retry path cleared `actionError`.
 * Passive poll/SSE refetches must NOT erase an error while the failed action
 * is still the user's actionable context.
 */

export type ActionErrorClearEvent =
  | 'refresh'
  | 'navigate'
  | 'dismiss'
  | 'retry'
  | 'mutation-start'
  | 'successful-action'
  | 'passive-refetch';

/** True when `event` should clear a surfaced action error. */
export function clearsActionErrorOn(event: ActionErrorClearEvent): boolean {
  return event !== 'passive-refetch';
}

export type ActionErrorState = {
  message: string;
  /** Epoch ms when the error was recorded — shown as light context on the banner. */
  at: number;
} | null;

export function makeActionError(message: string, at = Date.now()): NonNullable<ActionErrorState> {
  return { message, at };
}
