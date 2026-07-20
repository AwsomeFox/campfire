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
 *  2. serverRole === 'admin' -> always 'dm' (admins have full DM rights everywhere).
 *  3. campaign_members lookup (userId must be numeric — dev:* users never reach here).
 *  4. null — not a member of this campaign.
 *
 * PAT token cap (applied last, whenever user.tokenContext is set): if the
 * token is bound to a specific campaignId and this isn't it, the caller is
 * treated as a non-member (null) regardless of their real role — including
 * admins acting through a scoped token. Otherwise the effective role is
 * capped to `min(tokenContext.scope, real effective role)` — admin serverRole
 * does NOT bypass this cap when acting via token.
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
   * membership row, devRole, or admin server-role. Used anywhere a token's
   * own campaignId/scope must never be trusted on its own, e.g. minting a
   * new token (TokensService.create) or scoping GET /campaigns
   * (accessibleCampaignIds below): both must fall back to what the CALLER
   * actually has, never the token's self-reported campaignId.
   */
  async baseEffectiveRole(user: RequestUser, campaignId: number): Promise<Role | null> {
    if (user.devRole) return user.devRole;
    if (user.serverRole === 'admin') return 'dm';

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
   * Campaign ids this user may access at all (for GET /campaigns scoping).
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
    if (user.serverRole === 'admin') return 'all';

    const numericId = Number(user.id);
    if (!Number.isInteger(numericId)) return [];

    const rows = await this.db.select().from(campaignMembers).where(eq(campaignMembers.userId, numericId));
    return rows.map((r) => r.campaignId);
  }
}
