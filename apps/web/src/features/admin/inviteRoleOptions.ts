/**
 * Invite-link role vocabulary for the members-page invite card (issue #516).
 *
 * The "Joins as" control and generated link field need stable accessible names;
 * option text must spell out what each role means so screen-reader users do not
 * pick "player" vs "viewer" without context.
 */
import type { InviteRole } from '@campfire/schema';

export interface InviteRoleOption {
  role: InviteRole;
  /** Short label (chip / table copy). */
  label: string;
  /** Select option text — must include concise consequence text. */
  description: string;
}

/** Single source of truth for invite-role order, labels, and descriptions. */
export const INVITE_ROLE_OPTIONS: ReadonlyArray<InviteRoleOption> = [
  {
    role: 'player',
    label: 'Player',
    description: 'Player — joins as a full party member',
  },
  {
    role: 'viewer',
    label: 'Viewer',
    description: 'Viewer — read-only access to the campaign',
  },
];

export const INVITE_ROLES: ReadonlyArray<InviteRole> = INVITE_ROLE_OPTIONS.map((o) => o.role);

export function inviteRoleOptions(): ReadonlyArray<InviteRoleOption> {
  return INVITE_ROLE_OPTIONS;
}

/**
 * Base "<role> invite link <id>" name shared by the field label and the copy
 * button below. Include `inviteId` so multiple active invites with the same
 * role stay distinguishable to assistive tech.
 */
function inviteLinkName(role: InviteRole, inviteId: number): string {
  const opt = INVITE_ROLE_OPTIONS.find((o) => o.role === role);
  const label = opt?.label ?? role;
  return `${label} invite link ${inviteId}`;
}

/** Accessible name for a generated invite URL field — it really is read-only. */
export function inviteLinkFieldLabel(role: InviteRole, inviteId: number): string {
  return `${inviteLinkName(role, inviteId)}, read-only`;
}

/**
 * Accessible name for the "Copy" button next to a generated invite link.
 * Deliberately omits ", read-only" — unlike the field, the button is
 * actionable, and including that text would misleadingly describe it too.
 */
export function inviteCopyButtonLabel(role: InviteRole, inviteId: number): string {
  return `Copy ${inviteLinkName(role, inviteId)}`;
}

export const INVITE_COPY_SUCCESS = 'Invite link copied to clipboard.';
export const INVITE_COPY_FAILURE =
  'Copy failed. Clipboard blocked — copy the link from the field instead.';
