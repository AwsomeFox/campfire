import { expect, test } from '@playwright/test';
import {
  BADGE_VISIBILITY_OPTIONS,
  isBadgeVisibility,
  requiresPartyShareConfirmation,
} from '../../src/features/notes/noteVisibilityChange';

test.describe('note visibility change helpers (issue #689)', () => {
  test('badge menu scopes exclude whisper', () => {
    expect(BADGE_VISIBILITY_OPTIONS).toEqual(['private', 'dm_shared', 'party_shared']);
    expect(isBadgeVisibility('whisper')).toBe(false);
    expect(isBadgeVisibility('private')).toBe(true);
  });

  test('party share confirmation only when broadening to party', () => {
    expect(requiresPartyShareConfirmation('private', 'dm_shared')).toBe(false);
    expect(requiresPartyShareConfirmation('private', 'party_shared')).toBe(true);
    expect(requiresPartyShareConfirmation('dm_shared', 'party_shared')).toBe(true);
    expect(requiresPartyShareConfirmation('party_shared', 'private')).toBe(false);
    expect(requiresPartyShareConfirmation('party_shared', 'party_shared')).toBe(false);
    expect(requiresPartyShareConfirmation('whisper', 'party_shared')).toBe(true);
  });
});
