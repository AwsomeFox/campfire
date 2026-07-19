import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, like, ne, or } from 'drizzle-orm';
import type { z } from 'zod';
import { UserCreate, UserUpdate, PasswordChange } from '@campfire/schema';
import type { User } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { users, userSessions, campaignMembers } from '../../db/schema';
import { nowIso } from '../../common/time';
import { hashPassword } from '../../common/crypto';

type UserCreateInput = z.infer<typeof UserCreate>;
type UserUpdateInput = z.infer<typeof UserUpdate>;
type PasswordChangeInput = z.infer<typeof PasswordChange>;

function toDomain(row: typeof users.$inferSelect): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    serverRole: row.serverRole as User['serverRole'],
    disabled: row.disabled,
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

  async remove(id: number): Promise<void> {
    const existing = await this.getRowOrThrow(id);
    if (existing.serverRole === 'admin') {
      const remaining = await this.countEnabledAdmins(id);
      if (remaining === 0) {
        throw new ConflictException('Cannot delete the last enabled admin');
      }
    }

    // Cascade: sessions + campaign_members. Leave notes/characters — characters keep ownerUserId string.
    await this.db.delete(userSessions).where(eq(userSessions.userId, id));
    await this.db.delete(campaignMembers).where(eq(campaignMembers.userId, id));
    await this.db.delete(users).where(eq(users.id, id));
  }

  async setPassword(id: number, newPassword: string): Promise<void> {
    await this.getRowOrThrow(id);
    await this.db
      .update(users)
      .set({ passwordHash: hashPassword(newPassword), updatedAt: nowIso() })
      .where(eq(users.id, id));
  }

  /** Self-service password change: requires + verifies currentPassword (checked by caller). */
  async changeOwnPassword(id: number, input: PasswordChangeInput): Promise<void> {
    await this.setPassword(id, input.newPassword);
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
