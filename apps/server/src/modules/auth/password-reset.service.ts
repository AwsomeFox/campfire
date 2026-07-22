import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { PasswordResetApproval, PasswordResetRequest } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { apiTokens, passwordResetRequests, userSessions, users } from '../../db/schema';
import { nowIso } from '../../common/time';
import { generateResetCode, hashPassword, hashResetCode } from '../../common/crypto';
import { UsersService } from '../users/users.service';
import { RESET_CODE_MAX_AGE_MS } from './auth.constants';

/**
 * better-sqlite3's tx object shares the same query API as the root db (the
 * `SyncDb` alias in users.service). Typed here so the consume+redeem
 * transaction body reads as plain synchronous code with full ORM help.
 */
type SyncTx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

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
   * @Public redemption. Unknown / expired / disabled-SSO codes throw the SAME
   * generic 400 — the code is the only credential here, so nothing else may be
   * inferred from the response. The ONE exception is a genuinely-concurrent
   * double-redemption of a real, valid code, which throws 409 conflict so the
   * losing client can tell its user "this code was just used" (issue #696).
   *
   * The read of the code, its single-use consumption, the password change, and
   * the session/PAT revocation all run inside ONE synchronous better-sqlite3
   * transaction (BEGIN IMMEDIATE). The consume is a conditional DELETE whose
   * rows-affected (`changes`) is the atomic claim: two concurrent redemptions
   * of the same code cannot both see `changes > 0`, so exactly one commits a
   * password change and the other rolls back having changed nothing — the old
   * password and session state stay intact on the losing side. A failure mid
   * transaction (throw) rolls the whole thing back: no half-consumed code, no
   * changed password with stale sessions.
   */
  async confirm(code: string, newPassword: string): Promise<void> {
    const invalid = () => new BadRequestException('Invalid or expired reset code');
    const codeHash = hashResetCode(code);

    // Pre-flight read OUTSIDE the write transaction: the no-enumeration failure
    // modes (unknown code, expired, disabled/SSO) and their housekeeping (revert
    // an expired approval back to pending so the admin can re-approve, or delete
    // a request whose account went disabled/SSO) need no write lock and must not
    // serialize against the real redemption path.
    const [row] = await this.db
      .select()
      .from(passwordResetRequests)
      .where(and(eq(passwordResetRequests.codeHash, codeHash), eq(passwordResetRequests.status, 'approved')))
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

    this.db.transaction(
      (tx) => {
        // Atomic consume: DELETE only if the row is STILL the same approved code
        // we pre-flighted. `changes === 0` means a concurrent redemption already
        // consumed it (status flipped / row gone / code rotated) — this is the
        // CAS that makes single-use hold under concurrent redemption.
        const consumed = this.consumeCodeTx(tx, row.id, codeHash);
        if (!consumed) {
          throw new ConflictException('This reset code has already been used');
        }

        // All in the same transaction: password change + session + PAT revocation
        // commit atomically with the code consumption. A failure here rolls back
        // the consume too, leaving the code reusable and the password untouched.
        this.applyPasswordResetTx(tx, user.id, newPassword);
      },
      // BEGIN IMMEDIATE takes the writer slot before the DELETE, so two
      // concurrent confirm() calls serialize: the second doesn't see the row
      // deleted by the first until the first commits, then its consume hits
      // changes === 0 and returns the 409. Mirrors AuthService.setup()'s claim.
      { behavior: 'immediate' },
    );
  }

  /**
   * The atomic single-use claim. Deletes the reset request ONLY if it still
   * carries the exact approved code hash we pre-flighted, returning whether a
   * row was removed (changes > 0). A concurrent redemption that consumed the
   * row first leaves changes === 0 here.
   */
  private consumeCodeTx(tx: SyncTx, requestId: number, codeHash: string): boolean {
    const result = tx
      .delete(passwordResetRequests)
      .where(
        and(
          eq(passwordResetRequests.id, requestId),
          eq(passwordResetRequests.codeHash, codeHash),
          eq(passwordResetRequests.status, 'approved'),
        ),
      )
      .run();
    const changes = (result as unknown as { changes?: number }).changes ?? 0;
    return changes > 0;
  }

  /**
   * Password change + every-session + every-PAT revocation, run inside the
   * caller's transaction. Mirrors UsersService.setPassword (#44: a reset is a
   * credential-compromise response, so it cuts off sessions AND PATs too) but
   * inlined so the writes commit with the code consume in one transaction
   * rather than as three separate statements across the TOCTOU window.
   */
  private applyPasswordResetTx(tx: SyncTx, userId: number, newPassword: string): void {
    const ts = nowIso();
    tx.update(users).set({ passwordHash: hashPassword(newPassword), updatedAt: ts }).where(eq(users.id, userId)).run();
    tx.delete(userSessions).where(eq(userSessions.userId, userId)).run();
    tx.delete(apiTokens).where(eq(apiTokens.userId, userId)).run();
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
