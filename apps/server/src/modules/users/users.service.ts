import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, like, ne, or } from 'drizzle-orm';
import type { z } from 'zod';
import { UserCreate, UserUpdate, PreferencesUpdate } from '@campfire/schema';
import type { User } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { users, userSessions, apiTokens, campaignMembers, campaigns } from '../../db/schema';
import { nowIso } from '../../common/time';
import { hashPassword } from '../../common/crypto';

type UserCreateInput = z.infer<typeof UserCreate>;
type UserUpdateInput = z.infer<typeof UserUpdate>;
type PreferencesUpdateInput = z.infer<typeof PreferencesUpdate>;

function toDomain(row: typeof users.$inferSelect): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    serverRole: row.serverRole as User['serverRole'],
    disabled: row.disabled,
    accentColor: row.accentColor,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class UsersService {
  constructor(@Inject(DB) private readonly db: DrizzleDb) {}

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
      .where(or(like(users.username, pattern), like(users.displayName, pattern)));
    return rows.slice(0, limit).map((r) => ({ id: r.id, username: r.username, displayName: r.displayName }));
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
    const existing = await this.getRowOrThrow(id);

    const demotingAdmin = input.serverRole !== undefined && input.serverRole !== 'admin' && existing.serverRole === 'admin';
    const disablingAdmin = input.disabled === true && existing.serverRole === 'admin' && !existing.disabled;
    if (demotingAdmin || disablingAdmin) {
      const remaining = await this.countEnabledAdmins(id);
      if (remaining === 0) {
        throw new ConflictException('Cannot demote or disable the last enabled admin');
      }
    }

    const update: Partial<typeof users.$inferInsert> = { updatedAt: nowIso() };
    if (input.displayName !== undefined) update.displayName = input.displayName;
    if (input.serverRole !== undefined) update.serverRole = input.serverRole;
    if (input.disabled !== undefined) update.disabled = input.disabled;

    const [row] = await this.db.update(users).set(update).where(eq(users.id, id)).returning();
    return toDomain(row);
  }

  /** Self-service preferences (display name + accent color) — PATCH /me/preferences. */
  async updatePreferences(id: number, input: PreferencesUpdateInput): Promise<User> {
    await this.getRowOrThrow(id);

    const update: Partial<typeof users.$inferInsert> = { updatedAt: nowIso() };
    if (input.displayName !== undefined) update.displayName = input.displayName;
    if (input.accentColor !== undefined) update.accentColor = input.accentColor;

    const [row] = await this.db.update(users).set(update).where(eq(users.id, id)).returning();
    return toDomain(row);
  }

  async remove(id: number): Promise<void> {
    const existing = await this.getRowOrThrow(id);
    if (existing.serverRole === 'admin') {
      const remaining = await this.countEnabledAdmins(id);
      if (remaining === 0) {
        throw new ConflictException('Cannot delete the last enabled admin');
      }
    }

    // Last-dm guard: deleting a user cascades their campaign_members rows, which
    // silently orphans any campaign where they're the ONLY dm — MembersService's
    // own DELETE endpoint already refuses this (see members.service.ts `remove()`),
    // but that guard is bypassed entirely when the user row itself is deleted
    // instead. Mirror the same check here: for every campaign this user dms,
    // count OTHER dms; if any campaign would be left with zero, 409 listing them
    // by name so the admin can reassign a dm first instead of losing the campaign.
    const dmMemberships = await this.db
      .select()
      .from(campaignMembers)
      .where(and(eq(campaignMembers.userId, id), eq(campaignMembers.role, 'dm')));

    if (dmMemberships.length > 0) {
      const orphanedCampaignNames: string[] = [];
      for (const membership of dmMemberships) {
        const otherDms = await this.db
          .select()
          .from(campaignMembers)
          .where(and(eq(campaignMembers.campaignId, membership.campaignId), eq(campaignMembers.role, 'dm')));
        const remainingDms = otherDms.filter((m) => m.userId !== id);
        if (remainingDms.length === 0) {
          const [campaign] = await this.db.select().from(campaigns).where(eq(campaigns.id, membership.campaignId)).limit(1);
          orphanedCampaignNames.push(campaign?.name ?? `campaign ${membership.campaignId}`);
        }
      }
      if (orphanedCampaignNames.length > 0) {
        throw new ConflictException(
          `Cannot delete: reassign DM first for: ${orphanedCampaignNames.join(', ')}`,
        );
      }
    }

    // Cascade: sessions + api_tokens + campaign_members. Leave notes/characters —
    // characters keep ownerUserId string. (Orphaned api_tokens rows would be dead
    // anyway — resolveByRawToken() refuses tokens whose owner row is gone — but
    // deleting them keeps hashes of once-live credentials out of the DB.)
    await this.db.delete(userSessions).where(eq(userSessions.userId, id));
    await this.db.delete(apiTokens).where(eq(apiTokens.userId, id));
    await this.db.delete(campaignMembers).where(eq(campaignMembers.userId, id));
    await this.db.delete(users).where(eq(users.id, id));
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
