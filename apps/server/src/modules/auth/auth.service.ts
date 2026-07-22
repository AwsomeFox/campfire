import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  OnApplicationBootstrap,
  UnauthorizedException,
} from '@nestjs/common';
import { eq, lt } from 'drizzle-orm';
import type { z } from 'zod';
import { SetupRequest, LoginRequest, SignupRequest } from '@campfire/schema';
import type { Me } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { users, userSessions, campaignMembers } from '../../db/schema';
import { randomBytes } from 'node:crypto';
import { nowIso } from '../../common/time';
import { hashPassword, verifyPassword, generateSessionToken, hashSessionToken } from '../../common/crypto';
import { minRole, type RequestUser, type TokenContext } from '../../common/user.types';
import { UsersService } from '../users/users.service';
import { SettingsService } from '../settings/settings.service';
import { SESSION_MAX_AGE_MS, SESSION_SLIDING_UPDATE_INTERVAL_MS } from './auth.constants';

type SetupInput = z.infer<typeof SetupRequest>;
type LoginInput = z.infer<typeof LoginRequest>;
type SignupInput = z.infer<typeof SignupRequest>;

export interface SessionIssueResult {
  token: string;
  me: Me;
}

/** Sweep expired sessions once an hour — see AuthService.onApplicationBootstrap(). */
const SESSION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Fixed decoy hash used by verifyCredentials() to spend one scrypt round even
 * when there is no real password to check (unknown username, or an SSO-only
 * account with no local hash). Verifying against this — instead of skipping
 * scrypt — keeps failure timing indistinguishable from a genuine wrong-password
 * attempt, closing the timing side channel that would otherwise confirm whether
 * a username exists / is SSO-only. It is produced by hashPassword() so it uses
 * the exact same scrypt cost parameters as real hashes; the input is random and
 * discarded, so no real password ever matches it. See issue #89.
 */
const DUMMY_PASSWORD_HASH = hashPassword(randomBytes(32).toString('hex'));

@Injectable()
export class AuthService implements OnApplicationBootstrap {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly usersService: UsersService,
    private readonly settingsService: SettingsService,
  ) {}

  /**
   * purgeExpiredSessions() previously existed with zero call sites — expired
   * user_sessions rows just accumulated forever. Sweep once at boot (catches
   * whatever piled up while the server was down) and then hourly.
   *
   * The boot-time sweep is `await`ed — Nest's ModulesContainer runs
   * `onApplicationBootstrap()` hooks as part of `app.init()` and awaits
   * whatever they return (see `@nestjs/core/hooks/on-app-bootstrap.hook.js`),
   * so returning a Promise here means the purge is guaranteed to finish
   * before `app.init()` resolves. That matters most in tests: `.close()`
   * (called right after `app.init()` returns, e.g. `test/test-app.ts`'s
   * `closeTestApp()`) can otherwise race a still-in-flight fire-and-forget
   * DB write against a temp-dir deletion, occasionally tripping Jest's
   * "Test environment has been torn down" error in a LATER, unrelated test
   * file — reproduced during this fix's own test run before `await` was added.
   *
   * The hourly re-sweep is intentionally NOT awaited here (this method
   * returns once boot's purge settles, not once every future interval tick
   * settles) and its timer is `.unref()`d so it never keeps the Node process
   * alive on its own — a background tick failing or running long has no
   * flakiness implication for `app.init()`/`app.close()` timing the way the
   * boot-time purge did.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.purgeExpiredSessions();
    const timer = setInterval(() => {
      void this.purgeExpiredSessions();
    }, SESSION_SWEEP_INTERVAL_MS);
    timer.unref();
  }

  async setupRequired(): Promise<boolean> {
    return (await this.usersService.count()) === 0;
  }

  async setup(input: SetupInput): Promise<SessionIssueResult> {
    if (!(await this.setupRequired())) {
      throw new ConflictException('Setup already completed');
    }

    // scrypt is intentionally completed before opening the transaction. It is
    // CPU-expensive and synchronous, so doing it while holding SQLite's write
    // lock would needlessly delay every other writer. The setupRequired() check
    // above is only a fast path for already-configured servers; the count below
    // is the authoritative claim and MUST remain inside this synchronous
    // better-sqlite3 transaction (no await in the callback).
    const passwordHash = hashPassword(input.password);
    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);
    const ts = nowIso();
    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS).toISOString();

    const userId = this.db.transaction(
      (tx) => {
        const [existing] = tx.select({ id: users.id }).from(users).limit(1).all();
        if (existing) {
          throw new ConflictException('Setup already completed');
        }

        const [user] = tx
          .insert(users)
          .values({
            username: input.username,
            displayName: input.displayName ?? '',
            passwordHash,
            serverRole: 'admin',
            disabled: false,
            createdAt: ts,
            updatedAt: ts,
          })
          .returning({ id: users.id })
          .all();

        // The initial session is part of the same atomic claim: setup cannot
        // commit an admin while failing to mint the winner's login session.
        tx.insert(userSessions)
          .values({
            tokenHash,
            userId: user.id,
            createdAt: ts,
            expiresAt,
            lastSeenAt: ts,
          })
          .run();

        return user.id;
      },
      // BEGIN IMMEDIATE reserves the writer slot before reading users. Besides
      // serialising requests in this process, this keeps the claim correct if
      // two Campfire processes point at the same SQLite file during startup.
      { behavior: 'immediate' },
    );

    return { token, me: await this.buildMe(userId) };
  }

  /**
   * Self-service signup (POST /auth/signup) — gated on the admin-controlled
   * allowSignup server setting (default OFF). Always creates a serverRole
   * 'user' account (never admin; the request shape has no role field at all)
   * and starts a session, mirroring setup()'s create-then-issueSession flow.
   *
   * Also gated on allowLocalLogin: a non-admin account minted while local
   * login is disabled would be locally unusable the moment its signup session
   * expires (verifyCredentials() 403s non-admins in that state), so refusing
   * up front keeps the two settings consistent. Same reasoning blocks signup
   * before first-run setup: POST /auth/setup is the only way to create the
   * first (admin) account.
   */
  async signup(input: SignupInput): Promise<SessionIssueResult> {
    if (await this.setupRequired()) {
      throw new ConflictException('Server setup is not complete');
    }
    const [allowSignup, allowLocalLogin] = await Promise.all([
      this.settingsService.getAllowSignup(),
      this.settingsService.getAllowLocalLogin(),
    ]);
    if (!allowSignup || !allowLocalLogin) {
      throw new ForbiddenException('Self-service signup is disabled');
    }
    const user = await this.usersService.create({
      username: input.username,
      password: input.password,
      displayName: input.displayName,
      serverRole: 'user',
    });
    return this.issueSession(user.id);
  }

  async login(input: LoginInput): Promise<SessionIssueResult> {
    const row = await this.verifyCredentials(input.username, input.password);
    return this.issueSession(row.id);
  }

  /**
   * Shared credential-check path for both cookie login (login() above) and the
   * headless PAT bootstrap (POST /auth/token — see AuthController.token() /
   * TokensService.mintFor()). Same checks, same order, same exception types as
   * login() so both entry points behave identically for a given username/password.
   *
   * Anti-enumeration (issue #89): every "these credentials don't grant access"
   * outcome — unknown username, wrong password, or an SSO-provisioned account
   * with no local password — collapses to ONE identical 401 with an identical
   * body, so the response never reveals whether a username exists or is SSO-only.
   * To match on timing too, we ALWAYS run exactly one scrypt verification: when
   * there is no real hash to check (absent user / SSO-only) we verify against a
   * fixed decoy hash (DUMMY_PASSWORD_HASH) and discard the result, so the absent
   * and SSO cases cost the same CPU as a real wrong-password attempt.
   *
   * The remaining 403s (account disabled; non-admin while local login is
   * disabled) are NOT enumeration oracles: they are only ever reached AFTER a
   * correct password, i.e. by someone who already possesses valid credentials
   * and therefore already knows the account exists. They stay distinct so a
   * legitimately-authenticating user gets an accurate reason. Returns the raw
   * users row (never leaves the service layer).
   */
  async verifyCredentials(username: string, password: string) {
    const row = await this.usersService.getRowByUsername(username);

    // Constant-work password check: spend one scrypt round regardless of whether
    // the account exists or has a local hash, so failure timing can't be used as
    // an existence/type oracle. For absent or SSO-only accounts the decoy hash
    // never matches, so passwordOk is false in exactly the cases we reject below.
    const passwordOk = verifyPassword(password, row?.passwordHash ?? DUMMY_PASSWORD_HASH);

    if (!row || row.passwordHash === null || !passwordOk) {
      throw new UnauthorizedException('Invalid username or password');
    }
    if (row.disabled) {
      throw new ForbiddenException('This account is disabled');
    }
    if (row.serverRole !== 'admin') {
      const allowLocalLogin = await this.settingsService.getAllowLocalLogin();
      if (!allowLocalLogin) {
        throw new ForbiddenException('Local login is currently disabled');
      }
    }
    return row;
  }

  /** Public entry point for other auth flows (e.g. OidcService) that need to mint a session after their own credential check. */
  async issueSessionFor(userId: number): Promise<SessionIssueResult> {
    return this.issueSession(userId);
  }

  private async issueSession(userId: number): Promise<SessionIssueResult> {
    const token = generateSessionToken();
    const ts = nowIso();
    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS).toISOString();
    await this.db.insert(userSessions).values({
      tokenHash: hashSessionToken(token),
      userId,
      createdAt: ts,
      expiresAt,
      lastSeenAt: ts,
    });
    const me = await this.buildMe(userId);
    return { token, me };
  }

  async logout(token: string): Promise<void> {
    await this.db.delete(userSessions).where(eq(userSessions.tokenHash, hashSessionToken(token)));
  }

  /** Resolves a session cookie token to a RequestUser, applying sliding lastSeenAt (at most once/hour). */
  async resolveSessionUser(token: string): Promise<RequestUser | null> {
    const tokenHash = hashSessionToken(token);
    const [session] = await this.db.select().from(userSessions).where(eq(userSessions.tokenHash, tokenHash)).limit(1);
    if (!session) return null;

    if (new Date(session.expiresAt).getTime() < Date.now()) {
      await this.db.delete(userSessions).where(eq(userSessions.id, session.id));
      return null;
    }

    const [user] = await this.db.select().from(users).where(eq(users.id, session.userId)).limit(1);
    if (!user || user.disabled) return null;

    const now = Date.now();
    if (now - new Date(session.lastSeenAt).getTime() > SESSION_SLIDING_UPDATE_INTERVAL_MS) {
      await this.db.update(userSessions).set({ lastSeenAt: new Date(now).toISOString() }).where(eq(userSessions.id, session.id));
    }

    return {
      id: String(user.id),
      name: user.displayName || user.username,
      serverRole: user.serverRole as RequestUser['serverRole'],
    };
  }

  /**
   * When `tokenContext` is set (PAT auth), /me must report the TOKEN's
   * effective view, not the owner's raw memberships (issue #55): a
   * campaign-bound token only lists its campaign, every role is capped to
   * min(token scope, membership role) — mirroring RoleResolver.effectiveRole()
   * exactly — and a `token` block describes the token itself, including its
   * effective server-admin power (same rule as hasServerAdminPower()).
   * Cookie sessions (no tokenContext) are unchanged: raw roles, no `token`.
   */
  async buildMe(userId: number, tokenContext?: TokenContext): Promise<Me> {
    const user = await this.usersService.getOrThrow(userId);
    const rows = await this.db.select().from(campaignMembers).where(eq(campaignMembers.userId, userId));
    let memberships = rows.map((m) => ({
      campaignId: m.campaignId,
      role: m.role as Me['memberships'][number]['role'],
      characterId: m.characterId,
    }));
    if (!tokenContext) {
      return { user, memberships };
    }

    if (tokenContext.campaignId !== null) {
      memberships = memberships.filter((m) => m.campaignId === tokenContext.campaignId);
    }
    memberships = memberships.map((m) => ({ ...m, role: minRole(tokenContext.scope, m.role) }));

    return {
      user,
      memberships,
      token: {
        tokenId: tokenContext.tokenId,
        name: tokenContext.name,
        scope: tokenContext.scope,
        writeScope: tokenContext.writeScope,
        campaignId: tokenContext.campaignId,
        adminEnabled: tokenContext.adminEnabled,
        serverAdmin: user.serverRole === 'admin' && tokenContext.adminEnabled === true,
      },
    };
  }

  /** Self-service password change: verifies currentPassword, rehashes, kills OTHER sessions. */
  async changeOwnPassword(userId: number, currentPassword: string | undefined, newPassword: string, currentTokenHash: string): Promise<void> {
    const row = await this.usersService.getRowOrThrow(userId);
    if (row.passwordHash === null) {
      throw new ForbiddenException('This account uses SSO');
    }
    if (!currentPassword || !verifyPassword(currentPassword, row.passwordHash)) {
      throw new ForbiddenException('Current password is incorrect');
    }
    await this.db.update(users).set({ passwordHash: hashPassword(newPassword), updatedAt: nowIso() }).where(eq(users.id, userId));
    await this.usersService.killOtherSessions(userId, currentTokenHash);
  }

  /** Housekeeping: purge expired sessions (not scheduled anywhere yet, but handy for tests/manual use). */
  async purgeExpiredSessions(): Promise<void> {
    await this.db.delete(userSessions).where(lt(userSessions.expiresAt, nowIso()));
  }

  async tokenHashFor(token: string): Promise<string> {
    return hashSessionToken(token);
  }
}
