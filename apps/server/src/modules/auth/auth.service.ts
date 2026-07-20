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
import { nowIso } from '../../common/time';
import { hashPassword, verifyPassword, generateSessionToken, hashSessionToken } from '../../common/crypto';
import type { RequestUser } from '../../common/user.types';
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
    const user = await this.usersService.create({
      username: input.username,
      password: input.password,
      displayName: input.displayName,
      serverRole: 'admin',
    });
    return this.issueSession(user.id);
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
   * login() so both entry points behave identically for a given username/password:
   * unknown user or bad password -> 401 (generic, no user-enumeration signal);
   * SSO-provisioned or disabled account -> 403; non-admin while local login is
   * disabled -> 403. Returns the raw users row (never leaves the service layer).
   */
  async verifyCredentials(username: string, password: string) {
    const row = await this.usersService.getRowByUsername(username);
    if (!row) {
      throw new UnauthorizedException('Invalid username or password');
    }
    if (row.passwordHash === null) {
      // SSO-provisioned user (OIDC) — no local password to check.
      throw new ForbiddenException('This account uses SSO');
    }
    if (!verifyPassword(password, row.passwordHash)) {
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

  async buildMe(userId: number): Promise<Me> {
    const user = await this.usersService.getOrThrow(userId);
    const memberships = await this.db.select().from(campaignMembers).where(eq(campaignMembers.userId, userId));
    return {
      user,
      memberships: memberships.map((m) => ({
        campaignId: m.campaignId,
        role: m.role as Me['memberships'][number]['role'],
        characterId: m.characterId,
      })),
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
