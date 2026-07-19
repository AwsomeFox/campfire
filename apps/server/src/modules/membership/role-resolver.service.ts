import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { campaignMembers } from '../../db/schema';
import type { RequestUser } from '../../common/user.types';

/**
 * Resolves a user's effective role within a specific campaign.
 *
 * Order:
 *  1. user.devRole (DEV_AUTH header path) — short-circuits everything else.
 *  2. serverRole === 'admin' -> always 'dm' (admins have full DM rights everywhere).
 *  3. campaign_members lookup (userId must be numeric — dev:* users never reach here).
 *  4. null — not a member of this campaign.
 */
@Injectable()
export class RoleResolver {
  constructor(@Inject(DB) private readonly db: DrizzleDb) {}

  async effectiveRole(user: RequestUser, campaignId: number): Promise<Role | null> {
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

  /** Campaign ids this user may access at all (for GET /campaigns scoping). */
  async accessibleCampaignIds(user: RequestUser): Promise<number[] | 'all'> {
    if (user.devRole) return 'all';
    if (user.serverRole === 'admin') return 'all';

    const numericId = Number(user.id);
    if (!Number.isInteger(numericId)) return [];

    const rows = await this.db.select().from(campaignMembers).where(eq(campaignMembers.userId, numericId));
    return rows.map((r) => r.campaignId);
  }
}
