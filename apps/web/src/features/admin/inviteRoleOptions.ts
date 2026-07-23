/**
 * Invite-link role vocabulary for the members-page invite card (issue #516).
 *
 * The "Joins as" control and generated link field need stable accessible names;
 * option text must spell out what each role means so screen-reader users do not
 * pick "player" vs "viewer" without context.
 */
import type { InviteRole } from '@campfire/schema';

export const INVITE_ROLES: ReadonlyArray<InviteRole> = ['player', 'viewer'];

export interface InviteRoleOption {
  role: InviteRole;
  /** Short label (chip / table copy). */
  label: string;
  /** Select option text — must include concise consequence text. */
  description: string;
}

export function inviteRoleOptions(): ReadonlyArray<InviteRoleOption> {
  return [
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
}

/** Accessible name for a generated invite URL field. */
export function inviteLinkFieldLabel(role: InviteRole): string {
  const opt = inviteRoleOptions().find((o) => o.role === role);
  const label = opt?.label ?? role;
  return `${label} invite link, read-only`;
}

export const INVITE_COPY_SUCCESS = 'Invite link copied to clipboard.';
export const INVITE_COPY_FAILURE =
  'Copy failed. Clipboard blocked — copy the link from the field instead.';
