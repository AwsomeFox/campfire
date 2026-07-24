import { expect, test } from '@playwright/test';
import { audienceToHidden, type AudienceValue } from '../../src/components/AudienceField';

/**
 * Issue #754 — creation-time Audience maps to the server `hidden` flag.
 * DM-only (default) → hidden true; Visible to players → hidden false.
 */
test.describe('audienceToHidden (issue #754)', () => {
  test('DM-only maps to hidden', () => {
    const audience: AudienceValue = 'dm';
    expect(audienceToHidden(audience)).toBe(true);
  });

  test('Visible to players maps to not hidden', () => {
    expect(audienceToHidden('players')).toBe(false);
  });
});
