import { expect, test } from '@playwright/test';
import {
  ADD_MEMBER_CANCEL_LABEL,
  ADD_MEMBER_ROLE_HELP,
  ADD_MEMBER_ROLE_LABEL,
  ADD_MEMBER_SEARCH_LABEL,
  MEMBER_CHARACTER_LINK_HELP,
  memberAddedAnnouncement,
  memberCharacterControlLabel,
  memberCharacterSavedAnnouncement,
  memberDisplayName,
  memberRemoveLabel,
  memberRoleControlLabel,
  memberRoleSavedAnnouncement,
} from '../../src/features/admin/memberControlsA11y';

/**
 * Issue #451 — member-specific accessible-name vocabulary.
 */

test.describe('member control a11y vocabulary (issue #451)', () => {
  test('role and character labels include the member name and purpose', () => {
    expect(memberRoleControlLabel('Aria')).toBe('Role for Aria');
    expect(memberCharacterControlLabel('Aria')).toBe('Linked character for Aria');
    expect(memberRoleControlLabel('Aria')).not.toBe(memberRoleControlLabel('Borin'));
    expect(memberRemoveLabel('Aria')).toMatch(/Remove Aria/);
  });

  test('character linkage help distinguishes ownership from seat closure', () => {
    expect(MEMBER_CHARACTER_LINK_HELP).toMatch(/owner/i);
    expect(MEMBER_CHARACTER_LINK_HELP).toMatch(/seat/i);
    expect(MEMBER_CHARACTER_LINK_HELP).toMatch(/keeps their character/i);
  });

  test('add-member dialog exposes search, role, and cancel names', () => {
    expect(ADD_MEMBER_SEARCH_LABEL).toMatch(/search/i);
    expect(ADD_MEMBER_ROLE_LABEL).toBe('Role for new member');
    expect(ADD_MEMBER_ROLE_HELP).toMatch(/DM|Player|Viewer/);
    expect(ADD_MEMBER_CANCEL_LABEL).toMatch(/Cancel adding member/i);
  });

  test('memberDisplayName prefers display name then username', () => {
    expect(memberDisplayName({ displayName: 'Aria', username: 'aria' })).toBe('Aria');
    expect(memberDisplayName({ displayName: '', username: 'player' })).toBe('player');
  });

  test('save and add announcements name the member', () => {
    expect(memberRoleSavedAnnouncement('Aria', 'Player')).toMatch(/Role for Aria.*Player/);
    expect(memberCharacterSavedAnnouncement('Aria', 'Torch')).toMatch(/Linked character for Aria.*Torch/);
    expect(memberCharacterSavedAnnouncement('Aria', null)).toMatch(/cleared/i);
    expect(memberAddedAnnouncement('Aria', 'Player')).toMatch(/Added Aria as Player/);
  });
});
