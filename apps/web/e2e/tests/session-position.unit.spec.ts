/**
 * Campaign session position labels (issue #841).
 *
 * Campaign cards / status chrome used to render `sessionCount` as "Session N",
 * which is wrong when recap numbering is non-contiguous (1, 7, 12 → "Session 3").
 * `formatCampaignSessionPosition` prefers `latestSessionNumber` and only surfaces
 * the recap COUNT as "N recaps" when that count itself is useful (gaps).
 *
 * Pure unit test — no backend, no browser — runs under the Playwright runner
 * alongside the other `.unit.spec.ts` files.
 */
import { expect, test } from '@playwright/test';
import { formatCampaignSessionPosition } from '../../src/lib/sessionPosition';

test.describe('formatCampaignSessionPosition (issue #841)', () => {
  test('no sessions → "No sessions yet"', () => {
    expect(formatCampaignSessionPosition({ sessionCount: 0, latestSessionNumber: 0 })).toBe('No sessions yet');
  });

  test('contiguous numbering shows Session N without a redundant recap count', () => {
    expect(formatCampaignSessionPosition({ sessionCount: 3, latestSessionNumber: 3 })).toBe('Session 3');
    expect(formatCampaignSessionPosition({ sessionCount: 1, latestSessionNumber: 1 })).toBe('Session 1');
  });

  test('non-contiguous numbering shows Session MAX · N recaps', () => {
    // Evidence example from the issue: recaps 1, 7, 12 must not read as "Session 3".
    expect(formatCampaignSessionPosition({ sessionCount: 3, latestSessionNumber: 12 })).toBe(
      'Session 12 · 3 recaps',
    );
    expect(formatCampaignSessionPosition({ sessionCount: 1, latestSessionNumber: 7 })).toBe(
      'Session 7 · 1 recap',
    );
  });

  test('defensive: count without latest still labels recaps, never "Session N"', () => {
    expect(formatCampaignSessionPosition({ sessionCount: 2, latestSessionNumber: 0 })).toBe('2 recaps');
  });

  test('defensive: latest without count still shows Session N', () => {
    expect(formatCampaignSessionPosition({ sessionCount: 0, latestSessionNumber: 5 })).toBe('Session 5');
  });

  test('defensive: missing / null fields coalesce to 0 (never Session NaN)', () => {
    expect(formatCampaignSessionPosition({})).toBe('No sessions yet');
    expect(formatCampaignSessionPosition({ sessionCount: null, latestSessionNumber: undefined })).toBe(
      'No sessions yet',
    );
    expect(formatCampaignSessionPosition({ sessionCount: 3, latestSessionNumber: undefined })).toBe('3 recaps');
  });
});
