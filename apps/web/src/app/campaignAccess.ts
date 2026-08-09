/**
 * Campaign writability helpers (issue #704).
 *
 * Server-side, paused/completed campaigns reject writes via CampaignAccessService
 * (issue #16). The web mirrors that here so users don't fill forms only to hit
 * 403 on Save — prefer hiding mutation affordances; when a control must stay
 * visible but inactive, use `archivedWriteBlockedReason`.
 */
import type { Campaign, Role } from '@campfire/schema';

export function isCampaignWritable(campaign: Pick<Campaign, 'status'> | null | undefined): boolean {
  return campaign?.status === 'active';
}

export interface CampaignAccessFlags {
  role: Role | null;
  isDm: boolean;
  isPlayer: boolean;
  isViewer: boolean;
  /** Campaign status is `active` — the server accepts writes. */
  writable: boolean;
  /** DM-only mutations (create NPCs, edit encounters, approve proposals, …). */
  canDmWrite: boolean;
  /** Player-or-DM mutations (inventory, own character, quest objective ticks, …). */
  canPlayerWrite: boolean;
  /** Any non-viewer member write (notes, inbox, dice rolls, …). */
  canMemberWrite: boolean;
  /**
   * EVERY member — viewers included — on a writable campaign.
   *
   * This is the client-side mirror of the server's `requireMemberOnWritableCampaign`, which
   * asserts membership and writability and nothing about role. `canMemberWrite` deliberately
   * excludes viewers and is the right gate for surfaces the product reserves for
   * participants; it is the WRONG gate for an endpoint that accepts viewers, because a
   * viewer who owns a character can read their own sheet (`getOrThrow` checks ownership, not
   * a role floor) and the server would accept the roll a stricter flag had hidden.
   */
  canAnyMemberWrite: boolean;
}

export function deriveCampaignAccess(
  role: Role | null,
  campaign: Pick<Campaign, 'status'> | null | undefined,
): CampaignAccessFlags {
  const writable = isCampaignWritable(campaign);
  const isDm = role === 'dm';
  const isPlayer = role === 'player';
  const isViewer = role === 'viewer';
  const isMember = role !== null;
  return {
    role,
    isDm,
    isPlayer,
    isViewer,
    writable,
    canDmWrite: isDm && writable,
    canPlayerWrite: (isDm || isPlayer) && writable,
    canMemberWrite: isMember && !isViewer && writable,
    canAnyMemberWrite: isMember && writable,
  };
}

/** Short label for disabled controls that must stay visible. */
export function archivedWriteBlockedReason(
  campaign: Pick<Campaign, 'status'> | null | undefined,
): string | null {
  if (!campaign || isCampaignWritable(campaign)) return null;
  return `This campaign is ${campaign.status} (archived, read-only).`;
}
