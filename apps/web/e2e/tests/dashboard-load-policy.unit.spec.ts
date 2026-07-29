/**
 * Dashboard summary load policy — #581 follow-up for stuck Home skeletons.
 *
 * Run with:
 *   npx playwright test --config playwright.unit.config.ts e2e/tests/dashboard-load-policy.unit.spec.ts
 */
import { expect, test } from '@playwright/test';
import {
  dashboardCatchUpOptions,
  failureAfterCancel,
  shouldShowSkeletonRetry,
} from '../../src/features/dashboard/dashboardLoadPolicy';

test.describe('dashboard load policy (#581 follow-up)', () => {
  test('SSE/schedule catch-up is always background so it cannot abort first load', () => {
    expect(dashboardCatchUpOptions()).toEqual({ background: true });
  });

  test('cancel before projection yields a Retry-able failure', () => {
    expect(failureAfterCancel(42)).toEqual({
      campaignId: 42,
      message: 'Dashboard load cancelled.',
    });
  });

  test('stranded skeletons offer Retry only after a load was attempted', () => {
    expect(
      shouldShowSkeletonRetry({
        hasSummary: false,
        error: null,
        loadPending: false,
        loadAttempted: false,
      }),
    ).toBe(false);
    expect(
      shouldShowSkeletonRetry({
        hasSummary: false,
        error: null,
        loadPending: false,
        loadAttempted: true,
      }),
    ).toBe(true);
    expect(
      shouldShowSkeletonRetry({
        hasSummary: false,
        error: null,
        loadPending: true,
        loadAttempted: true,
      }),
    ).toBe(false);
    expect(
      shouldShowSkeletonRetry({
        hasSummary: false,
        error: 'failed',
        loadPending: false,
        loadAttempted: true,
      }),
    ).toBe(false);
    expect(
      shouldShowSkeletonRetry({
        hasSummary: true,
        error: null,
        loadPending: false,
        loadAttempted: true,
      }),
    ).toBe(false);
  });
});
