/**
 * Stale action-error banner clearing (issue #430).
 *
 * Failure → Refresh / dismiss / successful recovery must remove the banner.
 * Passive poll/SSE refetch must leave an still-actionable error visible.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  clearsActionErrorOn,
  makeActionError,
} from '../../src/features/encounters/encounterActionError';

const RUN_SESSION_PAGE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');
const ERROR_NOTE = resolve(__dirname, '../../src/components/ui.tsx');

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

  test('RunSessionPage Refresh and Dismiss clear actionError; ErrorNote supports dismiss', () => {
    const page = readFileSync(RUN_SESSION_PAGE, 'utf8');
    const ui = readFileSync(ERROR_NOTE, 'utf8');

    expect(page).toMatch(/refreshEncounter/);
    expect(page).toMatch(/setActionError\(null\)/);
    expect(page).toMatch(/onDismiss=\{actionError \? \(\) => setActionError\(null\) : undefined\}/);
    expect(page).toMatch(/onClick=\{refreshEncounter\}/);
    // Passive invalidate path stays separate from the Refresh clear.
    expect(page).toMatch(/const refetchEncounter = useCallback\(\(\) => invalidateEncounter/);

    expect(ui).toMatch(/onDismiss\?:/);
    expect(ui).toMatch(/\bDismiss\b/);
  });
});
