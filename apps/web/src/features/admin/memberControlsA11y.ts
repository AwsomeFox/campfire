/**
 * Campaign member control accessible names (issue #451).
 *
 * Role and character selects repeat once per row — each must include the member
 * name and purpose so assistive tech can tell which seat is being changed.
 * Character linkage also needs ownership-vs-seat guidance.
 */

/** Display label for a member row (display name preferred, then username). */
export function memberDisplayName(member: {
  displayName?: string | null;
  username?: string | null;
}): string {
  return (member.displayName || member.username || 'Member').trim() || 'Member';
}

/** Accessible name for an existing member's role combobox. */
export function memberRoleControlLabel(memberName: string): string {
  return `Role for ${memberName}`;
}

/**
 * Accessible name for an existing member's character linkage combobox.
 * "Linked character" names the seat pointer (campaignMembers.characterId).
 */
export function memberCharacterControlLabel(memberName: string): string {
  return `Linked character for ${memberName}`;
}

/**
 * Explains ownership vs seat linkage: linking sets sheet ownership; removing a
 * membership keeps the character and only closes the seat.
 */
export const MEMBER_CHARACTER_LINK_HELP =
  'Linking a character makes that player its owner so they can edit its sheet. Removing a member keeps their character and notes — only the campaign seat closes.';

/** Accessible name for the add-member dialog role selector. */
export const ADD_MEMBER_ROLE_LABEL = 'Role for new member';

export const ADD_MEMBER_ROLE_HELP =
  'DM runs the table; Player is a full party member; Viewer is read-only.';

export const ADD_MEMBER_SEARCH_LABEL = 'Search for a user to add';

export const ADD_MEMBER_DIALOG_TITLE = 'Add member';

export const ADD_MEMBER_CANCEL_LABEL = 'Cancel adding member';

export function memberRemoveLabel(memberName: string): string {
  return `Remove ${memberName} from campaign`;
}

export function memberRoleSavedAnnouncement(memberName: string, role: string): string {
  return `Role for ${memberName} saved as ${role}.`;
}

export function memberCharacterSavedAnnouncement(
  memberName: string,
  characterName: string | null,
): string {
  return characterName
    ? `Linked character for ${memberName} set to ${characterName}.`
    : `Linked character for ${memberName} cleared.`;
}

export function memberAddedAnnouncement(memberName: string, role: string): string {
  return `Added ${memberName} as ${role}.`;
}
