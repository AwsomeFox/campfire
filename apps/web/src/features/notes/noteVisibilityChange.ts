/**
 * Note badge visibility change helpers (issue #689).
 *
 * The My Notes list badge exposes private / DM / party scopes via an explicit
 * menu (not tap-to-cycle). Party share is a deliberate broadening step that
 * requires confirmation; whisper stays out of the badge menu.
 */
import type { Note } from '@campfire/schema';

/** Visibility scopes selectable from a note card badge (whisper excluded). */
export const BADGE_VISIBILITY_OPTIONS = ['private', 'dm_shared', 'party_shared'] as const;

export type BadgeVisibility = (typeof BADGE_VISIBILITY_OPTIONS)[number];

export function isBadgeVisibility(visibility: Note['visibility']): visibility is BadgeVisibility {
  return (BADGE_VISIBILITY_OPTIONS as readonly string[]).includes(visibility);
}

/** Broadening to party_shared from a narrower scope needs an explicit confirm. */
export function requiresPartyShareConfirmation(
  from: Note['visibility'],
  to: Note['visibility'],
): boolean {
  return to === 'party_shared' && from !== 'party_shared';
}

export type VisibilityChangeRequest = {
  noteId: number;
  from: Note['visibility'];
  to: Note['visibility'];
};
