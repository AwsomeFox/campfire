import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, count, eq, like, ne, or } from 'drizzle-orm';
import type { z } from 'zod';
import { CampaignDmRepair, UserCreate, UserUpdate, PreferencesUpdate } from '@campfire/schema';
import type { MembershipIntegrityCampaign, MembershipIntegrityReport, User } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import {
  users,
  userSessions,
  apiTokens,
  campaignMembers,
  campaigns,
  passwordResetRequests,
  characters,
  membershipIntegrityRepairs,
} from '../../db/schema';
import { nowIso } from '../../common/time';
import { hashPassword } from '../../common/crypto';
import { AuditService } from '../audit/audit.service';
import { auditActor, type RequestUser } from '../../common/user.types';

type UserCreateInput = z.infer<typeof UserCreate>;
type UserUpdateInput = z.infer<typeof UserUpdate>;
type PreferencesUpdateInput = z.infer<typeof PreferencesUpdate>;
type CampaignDmRepairInput = z.infer<typeof CampaignDmRepair>;
type SyncDb = DrizzleDb | Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

function toDomain(row: typeof users.$inferSelect): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    serverRole: row.serverRole as User['serverRole'],
    disabled: row.disabled,
    accentColor: row.accentColor,
    textSize: row.textSize as User['textSize'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
  ) {}

  async count(): Promise<number> {
    const rows = await this.db.select().from(users);
    return rows.length;
  }

  async list(): Promise<User[]> {
    const rows = await this.db.select().from(users);
    return rows.map(toDomain);
  }

  async getRowOrThrow(id: number) {
    const [row] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!row) throw new NotFoundException(`User ${id} not found`);
    return row;
  }

  async getOrThrow(id: number): Promise<User> {
    return toDomain(await this.getRowOrThrow(id));
  }

  async getRowByUsername(username: string) {
    const [row] = await this.db.select().from(users).where(eq(users.username, username)).limit(1);
    return row ?? null;
  }

  async getRowByOidcSub(sub: string) {
    const [row] = await this.db.select().from(users).where(eq(users.oidcSub, sub)).limit(1);
    return row ?? null;
  }

  async lookup(query: string, limit = 10): Promise<Array<{ id: number; username: string; displayName: string }>> {
    const pattern = `%${query}%`;
    const rows = await this.db
      .select()
      .from(users)
      .where(
        and(
          eq(users.disabled, false),
          or(like(users.username, pattern), like(users.displayName, pattern)),
        ),
      );
    return rows.slice(0, limit).map((r) => ({ id: r.id, username: r.username, displayName: r.displayName }));
  }

  private enabledAdminCountTx(tx: SyncDb, excludeId?: number): number {
    const conditions = [eq(users.serverRole, 'admin'), eq(users.disabled, false)];
    if (excludeId !== undefined) conditions.push(ne(users.id, excludeId));
    return tx
      .select({ value: count() })
      .from(users)
      .where(and(...conditions))
      .get()?.value ?? 0;
  }

  private usableDmCountTx(tx: SyncDb, campaignId: number, excludeUserId?: number): number {
    const conditions = [
      eq(campaignMembers.campaignId, campaignId),
      eq(campaignMembers.role, 'dm'),
      eq(users.disabled, false),
    ];
    if (excludeUserId !== undefined) conditions.push(ne(campaignMembers.userId, excludeUserId));
    return tx
      .select({ value: count() })
      .from(campaignMembers)
      .innerJoin(users, eq(campaignMembers.userId, users.id))
      .where(and(...conditions))
      .get()?.value ?? 0;
  }

  /** Campaign names for which making this enabled DM unusable would remove all authority. */
  private orphanedCampaignNamesTx(tx: SyncDb, userId: number): string[] {
    const dmMemberships = tx
      .select({ campaignId: campaignMembers.campaignId, campaignName: campaigns.name })
      .from(campaignMembers)
      .innerJoin(campaigns, eq(campaignMembers.campaignId, campaigns.id))
      .where(and(eq(campaignMembers.userId, userId), eq(campaignMembers.role, 'dm')))
      .all();
    return dmMemberships
      .filter((membership) => this.usableDmCountTx(tx, membership.campaignId, userId) === 0)
      .map((membership) => membership.campaignName);
  }

  /** Public wrapper — used by OidcService to decide whether a group-based demotion is safe. */
  async countEnabledAdmins(excludeId?: number): Promise<number> {
    const rows = await this.db
      .select()
      .from(users)
      .where(and(eq(users.serverRole, 'admin'), eq(users.disabled, false)));
    return rows.filter((r) => r.id !== excludeId).length;
  }

  /** Creates a user. Used both by setup (first admin) and by admin user-management. */
  async create(input: UserCreateInput): Promise<User> {
    const existing = await this.getRowByUsername(input.username);
    if (existing) throw new ConflictException('Username already taken');

    const ts = nowIso();
    const [row] = await this.db
      .insert(users)
      .values({
        username: input.username,
        displayName: input.displayName ?? '',
        passwordHash: hashPassword(input.password),
        serverRole: input.serverRole ?? 'user',
        disabled: false,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();
    return toDomain(row);
  }

  /**
   * Auto-provisions a passwordless SSO user (OIDC first login). Caller
   * (OidcService) is responsible for producing a unique, regex-valid
   * username (slugify + collision-suffix) before calling this.
   */
  async createSso(input: { username: string; displayName: string; oidcSub: string; serverRole: 'admin' | 'user' }): Promise<User> {
    const ts = nowIso();
    const [row] = await this.db
      .insert(users)
      .values({
        username: input.username,
        displayName: input.displayName,
        passwordHash: null,
        serverRole: input.serverRole,
        disabled: false,
        oidcSub: input.oidcSub,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();
    return toDomain(row);
  }

  /**
   * Syncs serverRole from the OIDC admin-group claim on every login (up AND
   * down). Refuses to demote the last enabled admin — logs a warn and
   * leaves the role untouched rather than throwing, since this runs inline
   * in the login flow and must not block the user from signing in.
   */
  async syncOidcServerRole(id: number, desiredRole: 'admin' | 'user'): Promise<User> {
    const existing = await this.getRowOrThrow(id);
    if (existing.serverRole === desiredRole) return toDomain(existing);

    if (desiredRole === 'user' && existing.serverRole === 'admin') {
      const remaining = await this.countEnabledAdmins(id);
      if (remaining === 0) {
        // eslint-disable-next-line no-console
        console.warn(`[oidc] refusing to demote last enabled admin (user ${id}) via group sync`);
        return toDomain(existing);
      }
    }

    const [row] = await this.db
      .update(users)
      .set({ serverRole: desiredRole, updatedAt: nowIso() })
      .where(eq(users.id, id))
      .returning();
    return toDomain(row);
  }

  async update(id: number, input: UserUpdateInput): Promise<User> {
    return this.db.transaction((tx) => {
      const existing = tx.select().from(users).where(eq(users.id, id)).limit(1).get();
      if (!existing) throw new NotFoundException(`User ${id} not found`);

      const demotingAdmin = input.serverRole !== undefined && input.serverRole !== 'admin' && existing.serverRole === 'admin';
      const disablingAdmin = input.disabled === true && existing.serverRole === 'admin' && !existing.disabled;
      if ((demotingAdmin || disablingAdmin) && this.enabledAdminCountTx(tx, id) === 0) {
        throw new ConflictException('Cannot demote or disable the last enabled admin');
      }

      if (input.disabled === true && !existing.disabled) {
        const orphanedCampaignNames = this.orphanedCampaignNamesTx(tx, id);
        if (orphanedCampaignNames.length > 0) {
          throw new ConflictException(
            `Cannot disable: assign an enabled DM first for: ${orphanedCampaignNames.join(', ')}`,
          );
        }
      }

      const update: Partial<typeof users.$inferInsert> = { updatedAt: nowIso() };
      if (input.displayName !== undefined) update.displayName = input.displayName;
      if (input.serverRole !== undefined) update.serverRole = input.serverRole;
      if (input.disabled !== undefined) update.disabled = input.disabled;

      const row = tx.update(users).set(update).where(eq(users.id, id)).returning().get();
      return toDomain(row);
    });
  }

  /** Self-service preferences (display name + accent color + text size) — PATCH /me/preferences. */
  async updatePreferences(id: number, input: PreferencesUpdateInput): Promise<User> {
    await this.getRowOrThrow(id);

    const update: Partial<typeof users.$inferInsert> = { updatedAt: nowIso() };
    if (input.displayName !== undefined) update.displayName = input.displayName;
    if (input.accentColor !== undefined) update.accentColor = input.accentColor;
    if (input.textSize !== undefined) update.textSize = input.textSize;

    const [row] = await this.db.update(users).set(update).where(eq(users.id, id)).returning();
    return toDomain(row);
  }

  async remove(id: number): Promise<void> {
    this.db.transaction((tx) => {
      const existing = tx.select().from(users).where(eq(users.id, id)).limit(1).get();
      if (!existing) throw new NotFoundException(`User ${id} not found`);
      if (existing.serverRole === 'admin' && !existing.disabled && this.enabledAdminCountTx(tx, id) === 0) {
        throw new ConflictException('Cannot delete the last enabled admin');
      }

      if (!existing.disabled) {
        const orphanedCampaignNames = this.orphanedCampaignNamesTx(tx, id);
        if (orphanedCampaignNames.length > 0) {
          throw new ConflictException(
            `Cannot delete: assign an enabled DM first for: ${orphanedCampaignNames.join(', ')}`,
          );
        }
      }

      // Keep every invariant-dependent read and all account/membership writes in
      // this synchronous transaction so delete races serialize with #654 paths.
      tx.delete(userSessions).where(eq(userSessions.userId, id)).run();
      tx.delete(apiTokens).where(eq(apiTokens.userId, id)).run();
      tx.delete(passwordResetRequests).where(eq(passwordResetRequests.userId, id)).run();
      tx.delete(campaignMembers).where(eq(campaignMembers.userId, id)).run();
      tx.update(characters)
        .set({ ownerUserId: null, updatedAt: nowIso() })
        .where(eq(characters.ownerUserId, String(id)))
        .run();
      tx.delete(users).where(eq(users.id, id)).run();
    });
  }

  /** Server-admin-only, secret-free authority diagnostics (#849). */
  async membershipIntegrity(): Promise<MembershipIntegrityReport> {
    const [campaignRows, dmRows, repairRows] = await Promise.all([
      this.db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns),
      this.db
        .select({ campaignId: campaignMembers.campaignId, userId: campaignMembers.userId, disabled: users.disabled })
        .from(campaignMembers)
        .innerJoin(users, eq(campaignMembers.userId, users.id))
        .where(eq(campaignMembers.role, 'dm')),
      this.db
        .select({ repair: membershipIntegrityRepairs, campaignName: campaigns.name })
        .from(membershipIntegrityRepairs)
        .leftJoin(campaigns, eq(membershipIntegrityRepairs.campaignId, campaigns.id)),
    ]);

    const usableByCampaign = new Map<number, number>();
    const disabledByCampaign = new Map<number, number[]>();
    for (const dm of dmRows) {
      if (dm.disabled) {
        disabledByCampaign.set(dm.campaignId, [...(disabledByCampaign.get(dm.campaignId) ?? []), dm.userId]);
      } else {
        usableByCampaign.set(dm.campaignId, (usableByCampaign.get(dm.campaignId) ?? 0) + 1);
      }
    }
    const ghostsByCampaign = new Map<number, number>();
    for (const row of repairRows) {
      if (row.repair.reason === 'missing_user' && row.repair.action === 'removed_membership') {
        ghostsByCampaign.set(row.repair.campaignId, (ghostsByCampaign.get(row.repair.campaignId) ?? 0) + 1);
      }
    }

    const affectedCampaigns: MembershipIntegrityCampaign[] = campaignRows
      .map((campaign) => {
        const usableDmCount = usableByCampaign.get(campaign.id) ?? 0;
        const disabledDmUserIds = disabledByCampaign.get(campaign.id) ?? [];
        const removedGhostMembershipCount = ghostsByCampaign.get(campaign.id) ?? 0;
        return {
          campaignId: campaign.id,
          campaignName: campaign.name,
          usableDmCount,
          disabledDmUserIds,
          removedGhostMembershipCount,
          repairRequired: usableDmCount === 0,
        };
      })
      .filter(
        (campaign) =>
          campaign.repairRequired ||
          campaign.disabledDmUserIds.length > 0 ||
          campaign.removedGhostMembershipCount > 0,
      )
      .sort((a, b) => Number(b.repairRequired) - Number(a.repairRequired) || a.campaignId - b.campaignId);

    return {
      generatedAt: nowIso(),
      campaigns: affectedCampaigns,
      repairs: repairRows.map(({ repair, campaignName }) => ({
        id: repair.id,
        campaignId: repair.campaignId,
        campaignName,
        memberId: repair.memberId,
        userId: repair.userId,
        role: repair.role as 'dm' | 'player' | 'viewer',
        reason: repair.reason as 'missing_user' | 'missing_campaign' | 'missing_character',
        action: repair.action as 'removed_membership' | 'cleared_character',
        invalidReferenceId: repair.invalidReferenceId,
        createdAt: repair.createdAt,
      })),
    };
  }

  /**
   * Restore authority only when a campaign currently has zero enabled DMs.
   * This narrow operation does not read/return campaign content and does not make
   * the calling server admin a member unless they explicitly select themselves.
   */
  async repairCampaignDm(input: CampaignDmRepairInput, actor: RequestUser): Promise<MembershipIntegrityCampaign> {
    this.db.transaction((tx) => {
      const campaign = tx.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, input.campaignId)).limit(1).get();
      if (!campaign) throw new NotFoundException(`Campaign ${input.campaignId} not found`);
      const user = tx.select().from(users).where(eq(users.id, input.userId)).limit(1).get();
      if (!user) throw new NotFoundException(`User ${input.userId} not found`);
      if (user.disabled) throw new BadRequestException(`User ${input.userId} is disabled and cannot be assigned as dm`);
      if (this.usableDmCountTx(tx, input.campaignId) > 0) {
        throw new ConflictException('Campaign already has an enabled dm; use normal campaign membership controls');
      }

      const ts = nowIso();
      const existing = tx
        .select({ id: campaignMembers.id })
        .from(campaignMembers)
        .where(and(eq(campaignMembers.campaignId, input.campaignId), eq(campaignMembers.userId, input.userId)))
        .limit(1)
        .get();
      if (existing) {
        tx.update(campaignMembers)
          .set({ role: 'dm', updatedAt: ts })
          .where(eq(campaignMembers.id, existing.id))
          .run();
      } else {
        tx.insert(campaignMembers)
          .values({
            campaignId: input.campaignId,
            userId: input.userId,
            role: 'dm',
            characterId: null,
            createdAt: ts,
            updatedAt: ts,
          })
          .run();
      }
    });

    await this.audit.log({
      actor: auditActor(actor),
      actorRole: 'dm',
      action: 'membership.integrity_repair',
      entityType: 'campaign_member',
      campaignId: input.campaignId,
      detail: `assigned enabled user ${input.userId} as recovery dm`,
    });

    const report = await this.membershipIntegrity();
    const campaign = await this.db
      .select({ name: campaigns.name })
      .from(campaigns)
      .where(eq(campaigns.id, input.campaignId))
      .limit(1);
    return (
      report.campaigns.find((campaign) => campaign.campaignId === input.campaignId) ?? {
        campaignId: input.campaignId,
        campaignName: campaign[0]?.name ?? `campaign ${input.campaignId}`,
        usableDmCount: 1,
        disabledDmUserIds: [],
        removedGhostMembershipCount: 0,
        repairRequired: false,
      }
    );
  }

  /**
   * Admin password reset (POST /users/:id/password). A reset is a
   * credential-compromise response — "this account's credentials may have
   * leaked" — so it must cut off everything already issued, not just future
   * logins: every session AND every personal access token is revoked
   * alongside the hash update. (Previously only passwordHash changed, so a
   * leaked `cf_pat_…` token or stolen cookie survived the reset — issue #44.)
   * Self-service change (POST /me/password, AuthService.changeOwnPassword)
   * deliberately differs: it keeps the CURRENT session and leaves PATs alone,
   * since the user proves the old password and manages their own tokens.
   */
  async setPassword(id: number, newPassword: string): Promise<void> {
    await this.getRowOrThrow(id);
    await this.db
      .update(users)
      .set({ passwordHash: hashPassword(newPassword), updatedAt: nowIso() })
      .where(eq(users.id, id));
    await this.db.delete(userSessions).where(eq(userSessions.userId, id));
    await this.db.delete(apiTokens).where(eq(apiTokens.userId, id));
  }

  /** Kill every session for this user except `keepTokenHash` (if provided). */
  async killOtherSessions(userId: number, keepTokenHash?: string): Promise<void> {
    if (keepTokenHash) {
      await this.db.delete(userSessions).where(and(eq(userSessions.userId, userId), ne(userSessions.tokenHash, keepTokenHash)));
    } else {
      await this.db.delete(userSessions).where(eq(userSessions.userId, userId));
    }
  }
}
