import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { GuestDmGrantScope, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { campaigns } from '../../db/schema';
import { roleAtLeast, type RequestUser } from '../../common/user.types';
import { RoleResolver } from './role-resolver.service';

export type CampaignAccessOpts = {
  /**
   * Role-gated READS and campaign-management writes that must still work on an
   * archived campaign (un-archive PATCH, soft-delete, invite list for archive
   * confirmations). Does NOT exempt trashed campaigns — use `allowTrashed`.
   */
  allowArchived?: boolean;
  /**
   * Issue #867: only authorized Trash restore / purge may pass this. Normal
   * reads, writes, streams, MCP, and AI paths must omit it so a trashed
   * campaign is indistinguishable from missing for former members (404) and
   * from a never-joined id for everyone else (403).
   */
  allowTrashed?: boolean;
};

export type CampaignPermission = Extract<GuestDmGrantScope, 'membership_admin' | 'destructive'>;

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
 *  - requireMember() is the plain membership READ gate: it asserts NEITHER a
 *    minimum role NOR that the campaign is writable. Use it for plain reads
 *    (every list/get), and for the few member writes that are personal
 *    read-state rather than shared campaign content — notably the catch-up
 *    read cursor (POST /campaigns/:id/catch-up/mark), which is exempt from the
 *    archive gate so a member can clear the dashboard banner on a
 *    paused/completed campaign. Shared member-level WRITES — notes, inbox
 *    items, RSVP, proposal withdraw/revise, `?proposed=true` proposal
 *    submissions, attachment deletes, dice rolls — use
 *    requireMemberOnWritableCampaign(), which adds the archive gate. (Issue
 *    #1480: the old `requireMember(..., { write: true })` option was removed —
 *    its name read as a caller-authority check even though it only asserted
 *    the CAMPAIGN was writable and returned a `viewer` role unchanged.)
 *
 * TRASH BOUNDARY (issue #867): `deletedAt` is part of the same authoritative
 * lifecycle gate. A trashed campaign rejects normal reads/writes/streams/
 * integrations with no existence leak; only Trash list + restore + purge
 * (via `{ allowTrashed: true }`) may proceed.
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
   * Authoritative lifecycle snapshot for a campaign: `status` + `deletedAt`.
   * A missing row returns null — callers keep their own 404 path for existence.
   */
  async getLifecycle(
    campaignId: number,
  ): Promise<{ status: string; deletedAt: string | null } | null> {
    const [row] = await this.db
      .select({ status: campaigns.status, deletedAt: campaigns.deletedAt })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);
    return row ?? null;
  }

  /**
   * Issue #867: reject missing/trashed campaigns before membership/token binding.
   * Unlike assertLifecycleAccess this does not distinguish member vs outsider — both
   * get the same 404 so trashed ids cannot be probed through binding endpoints.
   */
  async assertCampaignActive(campaignId: number): Promise<void> {
    const row = await this.getLifecycle(campaignId);
    if (!row || row.deletedAt != null) {
      throw new NotFoundException('Campaign not found');
    }
  }

  /**
   * 403 if the campaign is paused/completed (archived => read-only). A missing
   * campaign row is NOT an error here — the caller's own 404 path (getOrThrow /
   * FK checks) stays the source of truth for existence. A trashed campaign is
   * 404 (issue #867) so write helpers never quietly mutate a frozen row.
   */
  async assertWritable(campaignId: number): Promise<void> {
    const row = await this.getLifecycle(campaignId);
    if (!row) return;
    if (row.deletedAt != null) {
      throw new NotFoundException('Campaign not found');
    }
    if (row.status !== 'active') {
      throw new ForbiddenException(
        `Campaign is ${row.status} (read-only) — set its status back to 'active' to make changes`,
      );
    }
  }

  /**
   * Apply the trash / archive lifecycle gate after membership is known.
   * Trashed + non-member → same 403 as a missing/foreign id (no existence leak).
   * Trashed + member → 404, matching GET /campaigns/:id.
   */
  private async assertLifecycleAccess(
    campaignId: number,
    role: Role | null,
    opts?: CampaignAccessOpts,
  ): Promise<void> {
    const row = await this.getLifecycle(campaignId);
    if (row?.deletedAt != null && !opts?.allowTrashed) {
      if (!role) throw new ForbiddenException('Not a member of this campaign');
      throw new NotFoundException('Campaign not found');
    }
  }

  /**
   * Membership READ gate: 403 if the user is not a member of this campaign at
   * all. This asserts NEITHER a minimum role NOR that the campaign is writable
   * — use it only for plain reads (every list/get). For member-level WRITES use
   * requireMemberOnWritableCampaign(); for role-gated writes use requireRole().
   * Trashed campaigns are rejected unless `{ allowTrashed: true }` (issue #867).
   */
  async requireMember(user: RequestUser, campaignId: number, opts?: CampaignAccessOpts): Promise<Role> {
    const role = await this.roleResolver.effectiveRole(user, campaignId);
    await this.assertLifecycleAccess(campaignId, role, opts);
    if (!role) throw new ForbiddenException('Not a member of this campaign');
    return role;
  }

  /**
   * Member-level WRITE gate (issue #1480): plain membership PLUS the campaign
   * must be writable (not paused/completed/trashed). Use this for member-level
   * mutations — notes, inbox, RSVP, proposal withdraw/revise, dice rolls,
   * `?proposed=true` submissions, attachment deletes — where the gate is
   * membership + campaign-writable, NOT a specific role. For role-gated writes
   * use requireRole() (it asserts writable by default).
   *
   * The archive gate here is unconditional, so `opts` is narrowed to
   * `Pick<CampaignAccessOpts, 'allowTrashed'>` — unlike requireRole() /
   * requireCampaignPermission(), this gate has NO `allowArchived` escape and a
   * caller passing one would be silently ignored (a latent contract trap).
   * A member write that must work on an archived campaign is NOT a shared
   * mutation (e.g. the catch-up read cursor, which is personal read-state) and
   * belongs on requireMember() instead, with a documented exemption.
   *
   * This is the renamed, intent-revealing successor to the old
   * `requireMember(..., { write: true })` option, whose name read as a
   * caller-authority check even though it only asserted the CAMPAIGN was
   * writable and returned a `viewer` role unchanged.
   */
  async requireMemberOnWritableCampaign(
    user: RequestUser,
    campaignId: number,
    opts?: Pick<CampaignAccessOpts, 'allowTrashed'>,
  ): Promise<Role> {
    const role = await this.requireMember(user, campaignId, opts);
    await this.assertWritable(campaignId);
    return role;
  }

  /**
   * 403 if the user is not at least `min` in this campaign (also covers
   * non-membership), or — by default — if the campaign is archived. Role-gated
   * READS (and campaign un-archive/delete) pass `{ allowArchived: true }`.
   * Trash restore/purge pass `{ allowTrashed: true }` (issue #867).
   */
  async requireRole(
    user: RequestUser,
    campaignId: number,
    min: Role,
    opts?: CampaignAccessOpts,
  ): Promise<Role> {
    const role = await this.requireMember(user, campaignId, {
      allowTrashed: opts?.allowTrashed,
      // writability is handled below via allowArchived — don't double-assert
      // through requireMember's write path.
    });
    if (!roleAtLeast(role, min)) {
      throw new ForbiddenException(`Requires role: ${min}`);
    }
    if (!opts?.allowArchived) await this.assertWritable(campaignId);
    return role;
  }

  /**
   * Scoped campaign authority for issue #545. A permanent DM keeps the existing
   * broad powers. A temporary guest/co-DM may pass only when their active grant
   * explicitly carries the requested scope; the default grant scope intentionally
   * omits membership administration and destructive campaign lifecycle actions.
   */
  async requireCampaignPermission(
    user: RequestUser,
    campaignId: number,
    permission: CampaignPermission,
    opts?: CampaignAccessOpts,
  ): Promise<Role> {
    const memberRole = await this.requireMember(user, campaignId, {
      allowTrashed: opts?.allowTrashed,
    });
    const permanentRole = await this.roleResolver.permanentEffectiveRole(user, campaignId);
    const allowedByPermanentDm = permanentRole != null && roleAtLeast(permanentRole, 'dm');
    const allowedByGrant = await this.roleResolver.activeGrantHasScope(user, campaignId, permission);
    if (!allowedByPermanentDm && !allowedByGrant) {
      throw new ForbiddenException(`Requires campaign permission: ${permission}`);
    }
    if (!opts?.allowArchived) await this.assertWritable(campaignId);
    return memberRole;
  }
}
