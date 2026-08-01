/**
 * Stale action-error banner clearing (issue #430).
 *
 * Failure → Refresh / dismiss / successful recovery must remove the banner.
 * Passive poll/SSE refetch must leave an still-actionable error visible.
 */
import { expect, test } from '@playwright/test';
import {
  clearsActionErrorOn,
  makeActionError,
} from '../../src/features/encounters/encounterActionError';

test.describe('encounter action-error clearing (issue #430)', () => {
  test('clears on refresh, navigate, dismiss, retry, mutation-start, and successful action', () => {
    for (const event of [
      'refresh',
      'navigate',
      'dismiss',
      'retry',
      'mutation-start',
      'successful-action',
    ] as const) {
      expect(clearsActionErrorOn(event), event).toBe(true);
    }
  });

  test('does not erase an error on passive poll/SSE refetch', () => {
    expect(clearsActionErrorOn('passive-refetch')).toBe(false);
  });

  test('makeActionError records message + timestamp context', () => {
    const err = makeActionError('That action failed.', 1_700_000_000_000);
    expect(err.message).toBe('That action failed.');
    expect(err.at).toBe(1_700_000_000_000);
  });

  test('clears action error on user actions via clearsActionErrorOn helper', () => {
    expect(clearsActionErrorOn('refresh')).toBe(true);
    expect(clearsActionErrorOn('dismiss')).toBe(true);
    expect(clearsActionErrorOn('retry')).toBe(true);
  });
});
