import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { InviteCreate } from '@campfire/schema';
import type { CampaignInvite, InvitePreview, InviteRole, Me } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { campaignInvites, campaignMembers, campaigns, users } from '../../db/schema';
import { nowIso } from '../../common/time';
import { generateInviteCode } from '../../common/crypto';
import { auditActor, type RequestUser } from '../../common/user.types';
import { AuditService } from '../audit/audit.service';
import { AuthService, type SessionIssueResult } from '../auth/auth.service';
import { UsersService } from '../users/users.service';
import { SettingsService } from '../settings/settings.service';

type InviteCreateInput = z.infer<typeof InviteCreate>;
type InviteAcceptInput = { username: string; password: string; displayName?: string };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Uniform 404 for spent/expired/exhausted/missing invites — never leak which state. */
const INVITE_NO_LONGER_ACTIVE = 'This invite link is invalid or no longer active';

/**
 * DM invite links / join codes (issue #7): a DM generates a shareable
 * /join/<code> link so players onboard themselves — no server admin needed to
 * hand-create each account.
 *
 * Token security: codes are 128-bit random (generateInviteCode), ALWAYS carry
 * an expiry (InviteCreate.expiresInDays, default 7, max 365), may be use-capped
 * (maxUses), and are revocable (row delete). The invite role is capped to
 * player|viewer by the InviteRole schema — a leaked link can never grant dm.
 * Invalid, expired and exhausted codes all surface as the same 404 so a probing
 * caller learns nothing about which codes exist(ed); the public endpoints are
 * additionally rate-limited (see invites.controller.ts).
 */
@Injectable()
export class InvitesService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly settings: SettingsService,
  ) {}

  private toDomain(row: typeof campaignInvites.$inferSelect): CampaignInvite {
    return {
      id: row.id,
      campaignId: row.campaignId,
      code: row.code,
      role: row.role as InviteRole,
      createdByUserId: row.createdByUserId,
      expiresAt: row.expiresAt,
      maxUses: row.maxUses,
      useCount: row.useCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private isSpent(row: typeof campaignInvites.$inferSelect): boolean {
    if (new Date(row.expiresAt).getTime() < Date.now()) return true;
    if (row.maxUses !== null && row.useCount >= row.maxUses) return true;
    return false;
  }

  /**
   * Lists a campaign's live invites without mutating retained invite history.
   * Expired/exhausted rows remain available to whole-server backups and direct
   * operator diagnostics until an explicit revoke or campaign deletion removes them.
   * Campaign exports intentionally omit invite codes altogether.
   */
  async listForCampaign(campaignId: number): Promise<CampaignInvite[]> {
    const rows = await this.db
      .select()
      .from(campaignInvites)
      .where(eq(campaignInvites.campaignId, campaignId))
      .orderBy(asc(campaignInvites.id));
    return rows.filter((row) => !this.isSpent(row)).map((row) => this.toDomain(row));
  }

  async create(campaignId: number, input: InviteCreateInput, actor: RequestUser): Promise<CampaignInvite> {
    const ts = nowIso();
    const actorId = Number(actor.id);
    const [row] = await this.db
      .insert(campaignInvites)
      .values({
        campaignId,
        code: generateInviteCode(),
        role: input.role,
        createdByUserId: Number.isInteger(actorId) ? actorId : null, // dev:* header users have no DB row
        expiresAt: new Date(Date.now() + input.expiresInDays * DAY_MS).toISOString(),
        maxUses: input.maxUses ?? null,
        useCount: 0,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();

    await this.audit.log({
      actor: auditActor(actor),
      actorRole: 'dm',
      action: 'invite.create',
      entityType: 'campaign_invite',
      entityId: row.id,
      campaignId,
      detail: `role=${input.role} expires=${row.expiresAt}${row.maxUses ? ` maxUses=${row.maxUses}` : ''}`,
    });

    return this.toDomain(row);
  }

  async revoke(campaignId: number, inviteId: number, actor: RequestUser): Promise<void> {
    const [row] = await this.db
      .select()
      .from(campaignInvites)
      .where(and(eq(campaignInvites.id, inviteId), eq(campaignInvites.campaignId, campaignId)))
      .limit(1);
    if (!row) throw new NotFoundException(`Invite ${inviteId} not found`);

    await this.db.delete(campaignInvites).where(eq(campaignInvites.id, row.id));

    await this.audit.log({
      actor: auditActor(actor),
      actorRole: 'dm',
      action: 'invite.revoke',
      entityType: 'campaign_invite',
      entityId: row.id,
      campaignId,
    });
  }

  /**
   * Resolves a code to a live invite + its campaign, or a uniform 404.
   * Deliberately does NOT distinguish unknown/expired/exhausted/campaign-gone —
   * the public join endpoints must not leak which codes exist(ed).
   */
  private async getValidInvite(code: string) {
    const [row] = await this.db.select().from(campaignInvites).where(eq(campaignInvites.code, code)).limit(1);
    if (!row || this.isSpent(row)) {
      throw new NotFoundException(INVITE_NO_LONGER_ACTIVE);
    }
    const [campaign] = await this.db.select().from(campaigns).where(eq(campaigns.id, row.campaignId)).limit(1);
    if (!campaign) {
      throw new NotFoundException(INVITE_NO_LONGER_ACTIVE);
    }
    return { invite: row, campaign };
  }

  /** Public preview for the join page: what campaign, joining as what, until when. */
  async preview(code: string): Promise<InvitePreview> {
    const { invite, campaign } = await this.getValidInvite(code);
    return {
      campaignId: campaign.id,
      campaignName: campaign.name,
      role: invite.role as InviteRole,
      expiresAt: invite.expiresAt,
    };
  }

  /**
   * Accept as a brand-new user: creates the account (serverRole 'user'), the
   * membership, and a session — one call from link to seat at the table.
   * Gated on allowLocalLogin: when the admin has disabled local (non-admin)
   * login, invite links must not mint accounts that could never sign in — and
   * must not become a backdoor around that server policy.
   */
  async accept(code: string, input: InviteAcceptInput): Promise<SessionIssueResult & { campaignId: number }> {
    const { invite, campaign } = await this.getValidInvite(code);

    if (!(await this.settings.getAllowLocalLogin())) {
      throw new ForbiddenException('Local sign-in is disabled on this server — ask the admin for an account');
    }

    const user = await this.users.create({
      username: input.username,
      password: input.password,
      displayName: input.displayName,
      serverRole: 'user',
    }); // 409 if the username is taken

    this.addMembership(invite, user.id);

    await this.audit.log({
      actor: String(user.id),
      actorRole: invite.role as InviteRole,
      action: 'invite.accept',
      entityType: 'campaign_invite',
      entityId: invite.id,
      campaignId: campaign.id,
      detail: `user=${user.id} role=${invite.role} (new account)`,
    });

    const session = await this.auth.issueSessionFor(user.id);
    return { ...session, campaignId: campaign.id };
  }

  /** Accept as an already-authenticated user: just adds the membership. */
  async join(code: string, user: RequestUser): Promise<Me & { campaignId: number }> {
    const userId = Number(user.id);
    if (!Number.isInteger(userId)) {
      // dev:* header users have no DB row to attach a membership to.
      throw new ForbiddenException('Joining via invite requires a real user account');
    }

    const { invite, campaign } = await this.getValidInvite(code);

    // The already-a-member check is folded into addMembership's transaction so a
    // concurrent accept/join can't slip a membership in between this read and the
    // insert below (the UNIQUE(campaign_id, user_id) index is the final backstop,
    // but surfacing a clean 409 here avoids relying on a raw constraint error).
    await this.addMembership(invite, userId, { rejectIfMember: true });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: invite.role as InviteRole,
      action: 'invite.accept',
      entityType: 'campaign_invite',
      entityId: invite.id,
      campaignId: campaign.id,
      detail: `user=${userId} role=${invite.role}`,
    });

    const me = await this.auth.buildMe(userId);
    return { ...me, campaignId: campaign.id };
  }

  /**
   * Atomically seats a user against an invite: re-reads the (locked) invite row,
   * re-checks the cap + expiry, inserts the membership, and conditionally
   * increments useCount — all inside ONE synchronous better-sqlite3 transaction
   * (BEGIN IMMEDIATE). This closes the issue #655 TOCTOU: the prior code read the
   * invite in getValidInvite, returned it to the caller, and only then inserted
   * the membership + bumped useCount as two separate awaits, so two concurrent
   * accepts both passed `useCount < maxUses` before either insert committed and
   * both seated.
   *
   * BEGIN IMMEDIATE reserves the writer slot before the invite read, so concurrent
   * in-process acceptors (and a second Campfire process on the same SQLite file)
   * serialize on the same invariant — mirroring the first-run admin claim in
   * auth.service. The conditional UPDATE (`WHERE useCount < maxUses`) is the
   * belt-and-suspenders guard inside the lock: if 0 rows updated, another
   * acceptor consumed the last seat first and this transaction rolls back with
   * the same uniform 404 a sequential latecomer would see (so the response never
   * leaks whether the invite exists, expired, or was just exhausted by a race).
   * Unlimited invites (maxUses NULL) always pass the guard.
   */
  private addMembership(
    invite: typeof campaignInvites.$inferSelect,
    userId: number,
    opts: { rejectIfMember?: boolean } = {},
  ): void {
    const ts = nowIso();
    this.db.transaction(
      (tx) => {
        // Re-read the invite INSIDE the transaction: BEGIN IMMEDIATE has already
        // acquired the write lock, so this row is stable for the duration of the
        // callback. The outer getValidInvite read could be stale by now (another
        // acceptor exhausted the cap, the DM revoked the row, or the clock crossed
        // the expiry) — re-check here and fail closed with the uniform 404.
        const current = tx
          .select()
          .from(campaignInvites)
          .where(eq(campaignInvites.id, invite.id))
          .limit(1)
          .get();
        if (!current || this.isSpent(current)) {
          throw new NotFoundException(INVITE_NO_LONGER_ACTIVE);
        }

        // Authenticated invite acceptance normally guarantees the user exists, but
        // keep the direct membership insert honest too: a stale/concurrent caller
        // may not attach a disabled or missing account (#849). The database FK is
        // the final missing-user backstop.
        const target = tx.select().from(users).where(eq(users.id, userId)).limit(1).get();
        if (!target) throw new NotFoundException(`User ${userId} not found`);
        if (target.disabled) throw new ForbiddenException('This account is disabled');

        if (opts.rejectIfMember) {
          const existing = tx
            .select({ id: campaignMembers.id })
            .from(campaignMembers)
            .where(
              and(eq(campaignMembers.campaignId, invite.campaignId), eq(campaignMembers.userId, userId)),
            )
            .limit(1)
            .get();
          if (existing) throw new ConflictException('You are already a member of this campaign');
        }

        tx.insert(campaignMembers)
          .values({
            campaignId: invite.campaignId,
            userId,
            role: invite.role,
            characterId: null,
            createdAt: ts,
            updatedAt: ts,
          })
          .run();

        // Conditional increment: only consumes a seat if one is still available.
        // 0 rows updated means another acceptor (serialized ahead of us by BEGIN
        // IMMEDIATE) took the last seat between our isSpent re-check and this
        // UPDATE — roll back. The 404 here is deliberate: a concurrent loser must
        // see the SAME response as a sequential latecomer (see the existing
        // maxUses=1 test — second accept is 404), so the response never leaks
        // whether the invite exists, expired, or was just exhausted by a race.
        // maxUses NULL (unlimited) always matches the guard.
        const consumed = tx
          .update(campaignInvites)
          .set({ useCount: sql`${campaignInvites.useCount} + 1`, updatedAt: ts })
          .where(
            and(
              eq(campaignInvites.id, invite.id),
              sql`${campaignInvites.maxUses} IS NULL OR ${campaignInvites.useCount} < ${campaignInvites.maxUses}`,
            ),
          )
          .run();
        if (consumed.changes === 0) {
          throw new NotFoundException(INVITE_NO_LONGER_ACTIVE);
        }
      },
      // BEGIN IMMEDIATE reserves the writer slot before the invite read, so
      // concurrent accepts serialize on the same invariant instead of racing
      // through the read-then-write window the issue #655 repro exploited.
      { behavior: 'immediate' },
    );
  }
}
