import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { PasswordResetApproval, PasswordResetRequest } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { passwordResetRequests, users } from '../../db/schema';
import { nowIso } from '../../common/time';
import { generateResetCode, hashResetCode } from '../../common/crypto';
import { UsersService } from '../users/users.service';
import { RESET_CODE_MAX_AGE_MS } from './auth.constants';

/**
 * Forgot-password flow (issue #10). This server may have no mail transport,
 * so the reset path is ADMIN-APPROVED rather than email-based:
 *
 *   1. User files a request from the login screen — POST /auth/reset-request
 *      (@Public, auth-throttled). Always answered identically whether or not
 *      the username exists (no user-enumeration signal); a 'pending' row is
 *      created only for a real, enabled, local-password account.
 *   2. A server admin approves it (POST /users/reset-requests/:id/approve) and
 *      receives a one-time reset code ONCE — the DB stores sha256(code) plus a
 *      1-hour expiry. The admin relays the code to the user out-of-band
 *      (table talk, DM, etc). Unlike the existing admin set-password route,
 *      the admin never learns the user's new password.
 *   3. The user redeems it — POST /auth/reset-confirm (@Public, auth-throttled)
 *      with code + newPassword. Single-use: the row is deleted on success and
 *      EVERY session for that user is killed.
 */
@Injectable()
export class PasswordResetService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly usersService: UsersService,
  ) {}

  /**
   * @Public entry point. Deliberately returns void in every case — the caller
   * (AuthController) answers 202 with the same body whether the username
   * exists, is disabled, is SSO-only, or already has an open request, so this
   * endpoint leaks nothing about which accounts exist.
   */
  async request(username: string): Promise<void> {
    const row = await this.usersService.getRowByUsername(username);
    if (!row || row.disabled || row.passwordHash === null) return; // silent — no enumeration signal
    const [existing] = await this.db
      .select()
      .from(passwordResetRequests)
      .where(eq(passwordResetRequests.userId, row.id))
      .limit(1);
    // Idempotent: an open request (pending or approved) is left untouched so a
    // re-submit can't invalidate a code the admin already handed out.
    if (existing) return;
    await this.db.insert(passwordResetRequests).values({
      userId: row.id,
      status: 'pending',
      requestedAt: nowIso(),
    });
  }

  /** Admin list. Expired approved rows revert to pending first so the admin can simply re-approve. */
  async list(): Promise<PasswordResetRequest[]> {
    await this.expireStaleApprovals();
    const rows = await this.db
      .select({
        id: passwordResetRequests.id,
        userId: passwordResetRequests.userId,
        status: passwordResetRequests.status,
        requestedAt: passwordResetRequests.requestedAt,
        approvedAt: passwordResetRequests.approvedAt,
        expiresAt: passwordResetRequests.expiresAt,
        username: users.username,
        displayName: users.displayName,
      })
      .from(passwordResetRequests)
      .innerJoin(users, eq(passwordResetRequests.userId, users.id));
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      username: r.username,
      displayName: r.displayName,
      status: r.status as PasswordResetRequest['status'],
      requestedAt: r.requestedAt,
      approvedAt: r.approvedAt,
      expiresAt: r.expiresAt,
    }));
  }

  /**
   * Admin approval — mints the one-time code. Re-approving an already-approved
   * request regenerates the code (old one dies with the overwritten hash).
   */
  async approve(id: number, approvedBy: string): Promise<PasswordResetApproval> {
    const [row] = await this.db.select().from(passwordResetRequests).where(eq(passwordResetRequests.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Reset request ${id} not found`);

    const user = await this.usersService.getRowOrThrow(row.userId);
    if (user.disabled) throw new ConflictException('This account is disabled — enable it before approving a reset');
    if (user.passwordHash === null) throw new ConflictException('This account uses SSO and has no local password');

    const code = generateResetCode();
    const ts = nowIso();
    const expiresAt = new Date(Date.now() + RESET_CODE_MAX_AGE_MS).toISOString();
    await this.db
      .update(passwordResetRequests)
      .set({ status: 'approved', codeHash: hashResetCode(code), approvedAt: ts, approvedBy, expiresAt })
      .where(eq(passwordResetRequests.id, id));

    return {
      code,
      expiresAt,
      request: {
        id: row.id,
        userId: row.userId,
        username: user.username,
        displayName: user.displayName,
        status: 'approved',
        requestedAt: row.requestedAt,
        approvedAt: ts,
        expiresAt,
      },
    };
  }

  /** Admin dismissal — also how an admin revokes an already-issued (approved) code. */
  async deny(id: number): Promise<void> {
    const [row] = await this.db.select().from(passwordResetRequests).where(eq(passwordResetRequests.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Reset request ${id} not found`);
    await this.db.delete(passwordResetRequests).where(eq(passwordResetRequests.id, id));
  }

  /**
   * @Public redemption. Every failure mode (unknown code, expired, account
   * disabled/SSO since approval) throws the SAME generic 400 — the code is the
   * only credential here, so nothing else may be inferred from the response.
   */
  async confirm(code: string, newPassword: string): Promise<void> {
    const invalid = () => new BadRequestException('Invalid or expired reset code');

    const [row] = await this.db
      .select()
      .from(passwordResetRequests)
      .where(and(eq(passwordResetRequests.codeHash, hashResetCode(code)), eq(passwordResetRequests.status, 'approved')))
      .limit(1);
    if (!row) throw invalid();

    if (!row.expiresAt || new Date(row.expiresAt).getTime() < Date.now()) {
      // Revert (don't delete) so the admin sees it back as pending and can re-approve.
      await this.revertToPending(row.id);
      throw invalid();
    }

    const [user] = await this.db.select().from(users).where(eq(users.id, row.userId)).limit(1);
    if (!user || user.disabled || user.passwordHash === null) {
      await this.db.delete(passwordResetRequests).where(eq(passwordResetRequests.id, row.id));
      throw invalid();
    }

    await this.usersService.setPassword(user.id, newPassword);
    // Single-use: the request is gone, and every existing session dies — whoever
    // holds the OLD password (the reason for the reset) is logged out everywhere.
    await this.db.delete(passwordResetRequests).where(eq(passwordResetRequests.id, row.id));
    await this.usersService.killOtherSessions(user.id);
  }

  private async expireStaleApprovals(): Promise<void> {
    const rows = await this.db
      .select()
      .from(passwordResetRequests)
      .where(eq(passwordResetRequests.status, 'approved'));
    const now = Date.now();
    for (const row of rows) {
      if (!row.expiresAt || new Date(row.expiresAt).getTime() < now) {
        await this.revertToPending(row.id);
      }
    }
  }

  private async revertToPending(id: number): Promise<void> {
    await this.db
      .update(passwordResetRequests)
      .set({ status: 'pending', codeHash: null, approvedAt: null, approvedBy: '', expiresAt: null })
      .where(eq(passwordResetRequests.id, id));
  }
}
