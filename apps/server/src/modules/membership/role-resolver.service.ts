import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { campaignMembers } from '../../db/schema';
import { minRole, type RequestUser } from '../../common/user.types';

/**
 * Resolves a user's effective role within a specific campaign.
 *
 * Order (before the token cap below is applied):
 *  1. user.devRole (DEV_AUTH header path) — short-circuits everything else.
 *  2. campaign_members lookup (userId must be numeric — dev:* users never reach here).
 *  3. null — not a member of this campaign.
 *
 * serverRole is deliberately NOT consulted (issue #9, admin ≠ auto-DM): a
 * server admin manages users/settings/packs but holds NO implicit role in any
 * campaign — they see campaign content (including DM secrets) only through a
 * real campaign_members row, exactly like everyone else. Server power must not
 * equal story access.
 *
 * PAT token cap (applied last, whenever user.tokenContext is set): if the
 * token is bound to a specific campaignId and this isn't it, the caller is
 * treated as a non-member (null) regardless of their real role. Otherwise the
 * effective role is capped to `min(tokenContext.scope, real effective role)`.
 * A token's adminEnabled flag only unlocks SERVER-admin gates (see
 * hasServerAdminPower()) — it never grants campaign access here.
 */
@Injectable()
export class RoleResolver {
  constructor(@Inject(DB) private readonly db: DrizzleDb) {}

  async effectiveRole(user: RequestUser, campaignId: number): Promise<Role | null> {
    const role = await this.baseEffectiveRole(user, campaignId);
    if (!role) return null;

    const tokenContext = user.tokenContext;
    if (!tokenContext) return role;

    if (tokenContext.campaignId !== null && tokenContext.campaignId !== campaignId) return null;
    return minRole(tokenContext.scope, role);
  }

  /**
   * The user's real (untapped-by-token) effective role on a campaign —
   * membership row or devRole (never serverRole — see the class doc above).
   * Used anywhere a token's own campaignId/scope must never be trusted on
   * its own, e.g. minting a new token (TokensService.create) or scoping
   * GET /campaigns (accessibleCampaignIds below): both must fall back to
   * what the CALLER actually has, never the token's self-reported campaignId.
   */
  async baseEffectiveRole(user: RequestUser, campaignId: number): Promise<Role | null> {
    if (user.devRole) return user.devRole;

    const numericId = Number(user.id);
    if (!Number.isInteger(numericId)) return null;

    const [row] = await this.db
      .select()
      .from(campaignMembers)
      .where(and(eq(campaignMembers.campaignId, campaignId), eq(campaignMembers.userId, numericId)))
      .limit(1);

    return row ? (row.role as Role) : null;
  }

  /**
   * Whether this caller is the dm of at least one campaign — the only
   * non-admin context that legitimately needs the server-wide user directory
   * (`GET /users/lookup` powers the DM's add-member picker, which must resolve
   * usernames of people not yet in any shared campaign). Gating the lookup on
   * this (issue #88) stops a plain player/viewer from enumerating every account
   * on the server.
   *
   * Token scope is honoured exactly like effectiveRole(): a token scoped below
   * dm can never act as a dm, so it never qualifies; a campaign-bound token
   * only qualifies if it is bound to a campaign this user actually dms.
   */
  async isDmOfAnyCampaign(user: RequestUser): Promise<boolean> {
    const tokenContext = user.tokenContext;
    // A token scoped below dm can never act as a dm — min(scope, dm) must still be dm.
    if (tokenContext && minRole(tokenContext.scope, 'dm') !== 'dm') return false;

    if (user.devRole) return user.devRole === 'dm';

    const numericId = Number(user.id);
    if (!Number.isInteger(numericId)) return false;

    const rows = await this.db
      .select({ campaignId: campaignMembers.campaignId })
      .from(campaignMembers)
      .where(and(eq(campaignMembers.userId, numericId), eq(campaignMembers.role, 'dm')));

    if (tokenContext?.campaignId != null) {
      return rows.some((r) => r.campaignId === tokenContext.campaignId);
    }
    return rows.length > 0;
  }

  /**
   * Campaign ids this user may access at all (for GET /campaigns scoping).
   *
   * Server admins get no special treatment here either (issue #9): the
   * campaign list itself is campaign data (names/descriptions can spoil the
   * story), so an admin sees only campaigns they are actually a member of.
   *
   * A campaign-scoped token's campaignId is NEVER trusted on its own — it
   * must be intersected with the caller's real base accessible set
   * (membership/admin/devRole), exactly like effectiveRole() caps via
   * baseEffectiveRole() rather than trusting the token wholesale. Without
   * this, a token minted for a campaign the caller isn't a member of would
   * leak that campaign's metadata through this list (see TokensService.create,
   * which now also refuses to mint such a token — this is belt-and-suspenders
   * for any token that predates that fix or is otherwise inconsistent).
   */
  async accessibleCampaignIds(user: RequestUser): Promise<number[] | 'all'> {
    const tokenCampaignId = user.tokenContext?.campaignId;
    if (tokenCampaignId != null) {
      const base = await this.baseEffectiveRole(user, tokenCampaignId);
      return base ? [tokenCampaignId] : [];
    }

    if (user.devRole) return 'all';

    const numericId = Number(user.id);
    if (!Number.isInteger(numericId)) return [];

    const rows = await this.db.select().from(campaignMembers).where(eq(campaignMembers.userId, numericId));
    return rows.map((r) => r.campaignId);
  }
}
