import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { campaigns } from '../../db/schema';
import { roleAtLeast, type RequestUser } from '../../common/user.types';
import { RoleResolver } from './role-resolver.service';

/**
 * Thin convenience wrapper around RoleResolver for domain services: resolve
 * the effective role for (user, campaignId), 403 if not a member, optionally
 * assert a minimum rank (dm > player > viewer).
 *
 * ARCHIVE ENFORCEMENT (issue #16): a paused/completed campaign is read-only.
 * `campaign.status` used to be cosmetic; now every write path must refuse
 * unless status === 'active'. The gate lives here — not scattered across
 * domain services — via two rules:
 *
 *  - requireRole() asserts writability BY DEFAULT. In practice requireRole is
 *    the write gate (dm-/player-gated mutations); the handful of role-gated
 *    READS (audit log, export, dm inbox list, proposal list) opt out with
 *    `{ allowArchived: true }`, as do the two campaign-management writes that
 *    must still work on an archived campaign (PATCH /campaigns/:id to
 *    un-archive — field-restricted in CampaignsService.update — and DELETE
 *    /campaigns/:id so a dead campaign can still be removed).
 *
 *  - requireMember() does NOT assert writability by default (it gates plain
 *    reads for every list/get). Member-level writes — notes, inbox items,
 *    `?proposed=true` proposal submissions, attachment deletes, dice rolls —
 *    opt in with `{ write: true }`.
 */
@Injectable()
export class CampaignAccessService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly roleResolver: RoleResolver,
  ) {}

  async effectiveRole(user: RequestUser, campaignId: number): Promise<Role | null> {
    return this.roleResolver.effectiveRole(user, campaignId);
  }

  /**
   * 403 if the campaign is paused/completed (archived => read-only). A missing
   * campaign row is NOT an error here — the caller's own 404 path (getOrThrow /
   * FK checks) stays the source of truth for existence.
   */
  async assertWritable(campaignId: number): Promise<void> {
    const [row] = await this.db
      .select({ status: campaigns.status })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);
    if (row && row.status !== 'active') {
      throw new ForbiddenException(
        `Campaign is ${row.status} (read-only) — set its status back to 'active' to make changes`,
      );
    }
  }

  /**
   * 403 if the user is not a member of this campaign at all. Pass
   * `{ write: true }` on member-level WRITE endpoints so archived
   * (paused/completed) campaigns reject them.
   */
  async requireMember(user: RequestUser, campaignId: number, opts?: { write?: boolean }): Promise<Role> {
    const role = await this.roleResolver.effectiveRole(user, campaignId);
    if (!role) throw new ForbiddenException('Not a member of this campaign');
    if (opts?.write) await this.assertWritable(campaignId);
    return role;
  }

  /**
   * 403 if the user is not at least `min` in this campaign (also covers
   * non-membership), or — by default — if the campaign is archived. Role-gated
   * READS (and campaign un-archive/delete) pass `{ allowArchived: true }`.
   */
  async requireRole(
    user: RequestUser,
    campaignId: number,
    min: Role,
    opts?: { allowArchived?: boolean },
  ): Promise<Role> {
    const role = await this.requireMember(user, campaignId);
    if (!roleAtLeast(role, min)) {
      throw new ForbiddenException(`Requires role: ${min}`);
    }
    if (!opts?.allowArchived) await this.assertWritable(campaignId);
    return role;
  }
}
