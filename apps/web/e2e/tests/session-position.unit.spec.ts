import { expect, test } from '@playwright/test';
import { formatCampaignSessionPosition } from '../../src/lib/sessionPosition';

/**
 * `formatCampaignSessionPosition` prefers `latestSessionNumber` and only surfaces
 * `sessionCount` as a recap count when the two diverge (gaps, deletes, imports).
 */
test.describe('formatCampaignSessionPosition', () => {
  test('shows "No sessions yet" when there are no live recaps', () => {
    expect(formatCampaignSessionPosition({ sessionCount: 0, latestSessionNumber: 0 })).toBe('No sessions yet');
  });

  test('shows "Session N" when count equals the latest number (contiguous)', () => {
    expect(formatCampaignSessionPosition({ sessionCount: 3, latestSessionNumber: 3 })).toBe('Session 3');
    expect(formatCampaignSessionPosition({ sessionCount: 1, latestSessionNumber: 1 })).toBe('Session 1');
  });

  test('shows "Session N · M recaps" when non-contiguous numbering creates a gap', () => {
    expect(formatCampaignSessionPosition({ sessionCount: 3, latestSessionNumber: 12 })).toBe(
      'Session 12 · 3 recaps',
    );
    expect(formatCampaignSessionPosition({ sessionCount: 1, latestSessionNumber: 7 })).toBe(
      'Session 7 · 1 recap',
    );
  });

  test('falls back to recap count when only count is present', () => {
    expect(formatCampaignSessionPosition({ sessionCount: 2, latestSessionNumber: 0 })).toBe('2 recaps');
    expect(formatCampaignSessionPosition({ sessionCount: 0, latestSessionNumber: 5 })).toBe('Session 5');
  });

  test('coalesces nullish / malformed fields defensively', () => {
    expect(formatCampaignSessionPosition({ sessionCount: null, latestSessionNumber: undefined })).toBe(
      'No sessions yet',
    );
    expect(formatCampaignSessionPosition({ sessionCount: 3, latestSessionNumber: undefined })).toBe('3 recaps');
    expect(formatCampaignSessionPosition({ sessionCount: Number.NaN, latestSessionNumber: Number.NaN })).toBe(
      'No sessions yet',
    );
    expect(
      formatCampaignSessionPosition({ sessionCount: Number.POSITIVE_INFINITY, latestSessionNumber: 4 }),
    ).toBe('Session 4');
  });
});
