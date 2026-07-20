import { BadRequestException, Body, Controller, Get, HttpCode, Patch, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiCookieAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { AuthStatus, Me, User, ApiTokenCreated } from '@campfire/schema';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { AuthService } from './auth.service';
import { OidcService } from './oidc.service';
import { SettingsService } from '../settings/settings.service';
import { UsersService } from '../users/users.service';
import { TokensService } from '../tokens/tokens.service';
import { SetupRequestDto, LoginRequestDto, SignupRequestDto, PasswordChangeDto, AuthTokenRequestDto } from './auth.dto';
import { PreferencesUpdateDto } from '../users/users.dto';
import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_MS, VERSION } from './auth.constants';
import { THROTTLE_AUTH, AUTH_THROTTLE_LIMIT, AUTH_THROTTLE_TTL_MS } from '../../common/throttle.constants';

/**
 * P2 DoS fix: these three @Public routes each run a full scrypt password
 * hash/verify (~30ms CPU) against unauthenticated, un-rate-limited input —
 * setup() and login() on a wrong-but-well-formed password, token() the same
 * plus a token mint on success. Strict per-IP cap; see throttle.constants.ts.
 */
const AUTH_THROTTLE = Throttle({ [THROTTLE_AUTH]: { limit: AUTH_THROTTLE_LIMIT, ttl: AUTH_THROTTLE_TTL_MS } });

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_MAX_AGE_MS,
    secure: process.env.NODE_ENV === 'production',
  };
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly settings: SettingsService,
    private readonly oidc: OidcService,
    private readonly tokens: TokensService,
  ) {}

  @Public()
  @Get('status')
  @ApiOperation({ summary: 'Server auth status', description: 'Whether first-run setup is required, whether local (non-admin) login is enabled, and whether OIDC SSO is configured. Unauthenticated.' })
  @ApiResponse({ status: 200, description: 'Current auth status.' })
  async status(): Promise<AuthStatus> {
    const [setupRequired, allowLocalLogin, allowSignup] = await Promise.all([
      this.auth.setupRequired(),
      this.settings.getAllowLocalLogin(),
      this.settings.getAllowSignup(),
    ]);
    return {
      setupRequired,
      localLoginEnabled: allowLocalLogin,
      // Effective flag (mirrors AuthService.signup()'s gates) so the login page
      // only advertises signup when POST /auth/signup would actually accept it.
      signupEnabled: allowSignup && allowLocalLogin && !setupRequired,
      oidcEnabled: this.oidc.isEnabled(),
      version: VERSION,
    };
  }

  @Public()
  @AUTH_THROTTLE
  @Post('setup')
  @ApiOperation({ summary: 'First-run setup', description: 'Creates the first (admin) user and starts a session. Only available while no users exist yet — 409 afterward.' })
  @ApiResponse({ status: 201, description: 'Admin user created; session cookie set.' })
  @ApiResponse({ status: 409, description: 'Setup already completed.' })
  async setup(@Body() body: SetupRequestDto, @Res({ passthrough: true }) res: Response): Promise<Me> {
    const { token, me } = await this.auth.setup(body);
    res.cookie(SESSION_COOKIE_NAME, token, cookieOptions());
    return me;
  }

  /**
   * Same scrypt-DoS surface as setup()/login() (hashPassword on an
   * unauthenticated route), so it carries the same strict AUTH_THROTTLE.
   */
  @Public()
  @AUTH_THROTTLE
  @Post('signup')
  @ApiOperation({ summary: 'Self-service signup', description: 'Creates a regular (non-admin) user account and starts a session. Only available when the server-admin allowSignup setting is on (and local login is enabled) — 403 otherwise. Check GET /auth/status `signupEnabled` first.' })
  @ApiResponse({ status: 201, description: 'Account created; session cookie set.' })
  @ApiResponse({ status: 403, description: 'Self-service signup is disabled.' })
  @ApiResponse({ status: 409, description: 'Username already taken, or first-run setup not completed yet.' })
  async signup(@Body() body: SignupRequestDto, @Res({ passthrough: true }) res: Response): Promise<Me> {
    const { token, me } = await this.auth.signup(body);
    res.cookie(SESSION_COOKIE_NAME, token, cookieOptions());
    return me;
  }

  @Public()
  @AUTH_THROTTLE
  @Post('login')
  @ApiOperation({ summary: 'Log in (cookie session)', description: 'Verifies username/password and starts an httpOnly cookie session. Browser/interactive flow — for headless/agent auth without a cookie jar, use POST /auth/token instead.' })
  @ApiResponse({ status: 201, description: 'Authenticated; session cookie set.' })
  @ApiResponse({ status: 401, description: 'Invalid username or password.' })
  @ApiResponse({ status: 403, description: 'Account disabled, SSO-only, or local login currently disabled for non-admins.' })
  async login(@Body() body: LoginRequestDto, @Res({ passthrough: true }) res: Response): Promise<Me> {
    const { token, me } = await this.auth.login(body);
    res.cookie(SESSION_COOKIE_NAME, token, cookieOptions());
    return me;
  }

  /**
   * Headless PAT bootstrap for AI agents / scripts: verifies credentials via the
   * exact same path as POST /auth/login (same checks, same order, same exception
   * types — see AuthService.verifyCredentials()) and, on success, mints a personal
   * access token in the SAME call. No cookie jar, no second round trip — the
   * returned `token` is immediately usable as `Authorization: Bearer <token>` on
   * any REST route or the MCP endpoint.
   *
   * Scope/campaign access is enforced identically to POST /tokens (self-service
   * token minting): TokensService.mintFor() -> TokensService.create() checks the
   * CALLER's (here: the just-verified user's own) base effective role on
   * `campaignId` when scoped, so this cannot be used to mint a token for a
   * campaign the credentials' owner has no access to (403).
   */
  @Public()
  @AUTH_THROTTLE
  @Post('token')
  @ApiOperation({
    summary: 'Headless PAT bootstrap',
    description:
      'Verifies username/password (identical checks to POST /auth/login, including disabled-account and local-login-enabled gates) and mints a personal access token in one call — no session cookie needed. ' +
      'Intended for AI agents and scripts: use the returned `token` as `Authorization: Bearer <token>` on REST routes and /mcp. ' +
      'Scope/campaignId are validated against the authenticating user\'s own access, exactly like POST /tokens.',
  })
  @ApiResponse({ status: 201, description: 'Credentials verified; PAT minted. `token` is shown once — store it now.' })
  @ApiResponse({ status: 401, description: 'Invalid username or password.' })
  @ApiResponse({ status: 403, description: 'Account disabled/SSO-only/local-login-disabled, or no access to the requested campaignId.' })
  async token(@Body() body: AuthTokenRequestDto): Promise<ApiTokenCreated> {
    const row = await this.auth.verifyCredentials(body.username, body.password);
    const owner: RequestUser = { id: String(row.id), name: row.displayName || row.username, serverRole: row.serverRole as RequestUser['serverRole'] };
    return this.tokens.mintFor(owner, row.id, body);
  }

  @Post('logout')
  @HttpCode(204)
  @ApiCookieAuth('campfire_session')
  @ApiOperation({ summary: 'Log out', description: 'Clears the current session cookie and revokes the underlying session server-side.' })
  @ApiResponse({ status: 204, description: 'Logged out (idempotent even with no active session).' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
    if (token) {
      await this.auth.logout(token);
    }
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  }
}

@ApiTags('auth')
@Controller('me')
export class MeController {
  constructor(
    private readonly auth: AuthService,
    private readonly usersService: UsersService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Current user + campaign memberships', description: 'Resolves the authenticated identity (cookie session or Bearer PAT) to a user profile and their campaign memberships/roles.' })
  @ApiResponse({ status: 200, description: 'Current user and memberships.' })
  @ApiResponse({ status: 401, description: 'Not authenticated.' })
  async me(@CurrentUser() user: RequestUser): Promise<Me> {
    // dev:* header users have no DB row; synthesize a Me shape for them.
    if (user.id.startsWith('dev:')) {
      return {
        user: {
          id: 0,
          username: user.name,
          displayName: user.name,
          serverRole: user.serverRole,
          disabled: false,
          accentColor: null,
          textSize: 'default',
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
        memberships: [],
      };
    }
    return this.auth.buildMe(Number(user.id));
  }

  @Post('password')
  @HttpCode(204)
  @ApiOperation({ summary: 'Change own password', description: 'Self-service password change. Requires currentPassword; kills every OTHER session for this user on success.' })
  @ApiResponse({ status: 204, description: 'Password changed.' })
  @ApiResponse({ status: 400, description: 'currentPassword missing.' })
  @ApiResponse({ status: 403, description: 'Wrong currentPassword, or SSO-provisioned account (no local password).' })
  async changePassword(
    @Body() body: PasswordChangeDto,
    @CurrentUser() user: RequestUser,
    @Req() req: Request,
  ): Promise<void> {
    if (user.id.startsWith('dev:')) {
      throw new UnauthorizedException('Password change is not available for dev-auth users');
    }
    if (!body.currentPassword) {
      throw new BadRequestException('currentPassword is required');
    }
    const token = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
    const currentTokenHash = token ? await this.auth.tokenHashFor(token) : '';
    await this.auth.changeOwnPassword(Number(user.id), body.currentPassword, body.newPassword, currentTokenHash);
  }

  @Patch('preferences')
  @ApiOperation({ summary: 'Update own preferences', description: 'Self-service display name / accent color / text size update.' })
  @ApiResponse({ status: 200, description: 'Updated user profile.' })
  async updatePreferences(@Body() body: PreferencesUpdateDto, @CurrentUser() user: RequestUser): Promise<User> {
    if (user.id.startsWith('dev:')) {
      throw new UnauthorizedException('Preferences are not available for dev-auth users');
    }
    return this.usersService.updatePreferences(Number(user.id), body);
  }
}
