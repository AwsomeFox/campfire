import fs from 'node:fs';
import { ConflictException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { openDatabase } from '../../src/db/db.module';
import { passwordResetRequests, users, userSessions, apiTokens } from '../../src/db/schema';
import { AuditService } from '../../src/modules/audit/audit.service';
import { UsersService } from '../../src/modules/users/users.service';
import { PasswordResetService } from '../../src/modules/auth/password-reset.service';
import { generateResetCode, hashResetCode, hashPassword, verifyPassword } from '../../src/common/crypto';
import { RESET_CODE_MAX_AGE_MS } from '../../src/modules/auth/auth.constants';
import { makeTempDataDir } from './fixtures';

/**
 * Issue #696, service-layer: confirm() must consume a reset code + change the
 * password + revoke sessions/PATs in ONE synchronous better-sqlite3
 * transaction, so two concurrent confirm() calls on the same code cannot both
 * redeem it.
 *
 * The HTTP e2e suite can't reliably reproduce the TOCTOU window — supertest
 * dispatches each request onto the Nest handler and better-sqlite3 is
 * synchronous, so the two requests tend to run one-after-the-other rather than
 * interleaving at the drizzle `await` boundaries. This spec drives the SERVICE
 * directly, where `Promise.all([confirm(), confirm()])` DOES interleave at the
 * awaits: each drizzle better-sqlite3 query returns a sync value wrapped in a
 * resolved promise, so `await` yields to the microtask queue and the two calls
 * interleave between statements. Against the pre-fix code (read-then-mutate as
 * separate statements) both calls passed the validity SELECT and both ran the
 * mutations — a double-redemption. The transactional consume must prevent that.
 *
 * No Nest bootstrap: a real SQLite file + the three services constructed by
 * hand, so it lives beside the other real-SQLite integration specs.
 */
describe('password reset concurrency (real SQLite, service layer)', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** Build the three services against a fresh temp SQLite DB. */
  function build() {
    const { orm } = openDatabase(dataDir);
    const audit = new AuditService(orm);
    const usersService = new UsersService(orm, audit);
    const passwordReset = new PasswordResetService(orm, usersService);
    return { orm, audit, usersService, passwordReset };
  }

  /** Insert a user with a local password, returning the row. */
  function seedUser(orm: ReturnType<typeof build>['orm'], username: string, password: string) {
    const ts = new Date().toISOString();
    const [user] = orm
      .insert(users)
      .values({
        username,
        displayName: username,
        passwordHash: hashPassword(password),
        serverRole: 'user',
        disabled: false,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .all();
    return user;
  }

  /** Insert an APPROVED reset request with a known code, returning the raw code. */
  function seedApprovedCode(
    orm: ReturnType<typeof build>['orm'],
    userId: number,
  ): string {
    const code = generateResetCode();
    const ts = new Date().toISOString();
    orm
      .insert(passwordResetRequests)
      .values({
        userId,
        status: 'approved',
        codeHash: hashResetCode(code),
        requestedAt: ts,
        approvedAt: ts,
        approvedBy: 'admin',
        expiresAt: new Date(Date.now() + RESET_CODE_MAX_AGE_MS).toISOString(),
      })
      .run();
    return code;
  }

  /** Insert a live session + PAT for the user so the revocation writes are observable. */
  function seedSessionAndToken(orm: ReturnType<typeof build>['orm'], userId: number) {
    const ts = new Date().toISOString();
    orm
      .insert(userSessions)
      .values({
        tokenHash: hashResetCode('session-' + userId),
        userId,
        createdAt: ts,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        lastSeenAt: ts,
      })
      .run();
    orm
      .insert(apiTokens)
      .values({
        userId,
        name: 'token-' + userId,
        scope: 'user',
        writeScope: 'direct',
        adminEnabled: false,
        tokenHash: hashResetCode('pat-' + userId),
        tokenPrefix: 'cf_pat_xxxx',
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
  }

  it('two interleaved confirm() calls on the same code: exactly one redeems', async () => {
    dataDir = makeTempDataDir();
    const { orm, passwordReset } = build();
    const user = seedUser(orm, 'race', 'old-password-1');
    seedSessionAndToken(orm, user.id);
    const code = seedApprovedCode(orm, user.id);

    // Drive both redemptions concurrently at the SERVICE layer. Each await in
    // confirm() yields to the microtask queue, so the two calls interleave
    // between statements — the exact TOCTOU window the pre-fix code had.
    const newPassword = 'brand-new-password-1';
    const results = await Promise.allSettled([
      passwordReset.confirm(code, newPassword),
      passwordReset.confirm(code, newPassword),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    // Exactly one success. Against the pre-fix code BOTH fulfilled (both passed
    // the validity SELECT, both ran the mutations) — that is the regression.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The loser is a clear conflict (not a silent no-op and not a generic 400
    // that an unknown-code prober would also see — though both are non-success,
    // a 409 specifically signals "this valid code was just used").
    const loser = rejected[0];
    if (loser.status === 'rejected') {
      expect(loser.reason).toBeInstanceOf(ConflictException);
    }

    // The code row is gone (consumed exactly once — never retained, never
    // double-deleted into an error).
    const remaining = orm.select().from(passwordResetRequests).where(eq(passwordResetRequests.userId, user.id)).all();
    expect(remaining).toHaveLength(0);
  });

  it('the losing redemption does NOT change the password — the transaction rolled back', async () => {
    dataDir = makeTempDataDir();
    const { orm, passwordReset } = build();
    const user = seedUser(orm, 'rollback', 'keep-me-1');
    const code = seedApprovedCode(orm, user.id);

    // Winner uses newPasswordA; the loser tries newPasswordB. Even though both
    // would write a password, only the winner's may stick — and crucially the
    // consume + password change are atomic, so the loser cannot consume the
    // code without also committing its password (it must do NEITHER).
    const [a, b] = await Promise.allSettled([
      passwordReset.confirm(code, 'winner-password-1'),
      passwordReset.confirm(code, 'loser-password-1'),
    ]);
    expect(a.status).not.toEqual(b.status); // exactly one fulfilled

    // Reload the user row and prove exactly one of the two passwords matches.
    const [final] = orm.select().from(users).where(eq(users.id, user.id)).limit(1).all();
    const hash = final.passwordHash ?? '';
    const isWinner = verifyPassword('winner-password-1', hash);
    const isLoser = verifyPassword('loser-password-1', hash);
    expect(isWinner || isLoser).toBe(true);
    expect(isWinner && isLoser).toBe(false); // never both (no double-write)
    // The original password is gone regardless of which side won.
    expect(verifyPassword('keep-me-1', hash)).toBe(false);
  });

  it('the winner revokes sessions AND PATs atomically with the consume', async () => {
    dataDir = makeTempDataDir();
    const { orm, passwordReset } = build();
    const user = seedUser(orm, 'revoke', 'old-password-1');
    seedSessionAndToken(orm, user.id);
    const code = seedApprovedCode(orm, user.id);

    await passwordReset.confirm(code, 'new-password-1');

    // A reset is a credential-compromise response — both sessions AND PATs must
    // be revoked in the same transaction as the password change (#44 semantics,
    // now atomic). No surviving session or token.
    const sessions = orm.select().from(userSessions).where(eq(userSessions.userId, user.id)).all();
    const tokens = orm.select().from(apiTokens).where(eq(apiTokens.userId, user.id)).all();
    expect(sessions).toHaveLength(0);
    expect(tokens).toHaveLength(0);
  });
});
