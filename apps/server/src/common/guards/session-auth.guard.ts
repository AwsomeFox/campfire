import { Injectable, type CanActivate, type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Role } from '@campfire/schema';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { RequestUser, TokenContext } from '../user.types';
import { looksLikeApiToken, looksLikeOAuthAccessToken } from '../crypto';
import { isDevAuthActive } from '../security-config';
import { AuthService } from '../../modules/auth/auth.service';
import { SESSION_COOKIE_NAME } from '../../modules/auth/auth.constants';
import { sessionCookieOptions } from '../../modules/auth/session-cookie';
import { TokensService } from '../../modules/tokens/tokens.service';
import { OAuthService } from '../../modules/oauth/oauth.service';

/**
 * Resolves req.user from, in order:
 *  (a) an `Authorization: Bearer cf_pat_...` PAT header, else
 *  (a2) an `Authorization: Bearer cf_mcp_...` MCP OAuth access token (issue
 *      #37) — resolves to the same RequestUser + TokenContext shape as a PAT, so
 *      every effective-role cap applies identically; lets /mcp be added as a
 *      Claude connector via OAuth without a hand-copied PAT, else
 *  (b) the session cookie (real local-auth users), else
 *  (c) if DEV_AUTH is active (DEV_AUTH=1 AND NODE_ENV!=='production'): legacy
 *      x-dev-user/x-dev-role headers — synthetic user id `dev:<name>`, keeps all
 *      pre-auth e2e tests passing. Hard-disabled in production regardless of the
 *      flag (issue #119) so a stray DEV_AUTH=1 can't open the server to anonymous
 *      admin. Else
 *  (d) unauthenticated -> 401, unless the route is @Public().
 *
 * Replaces the old header-only DevAuthGuard. Kept as a single global guard
 * (APP_GUARD) so every route (including @Public ones) gets req.user
 * populated when resolvable, harmlessly.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
    private readonly tokensService: TokensService,
    private readonly oauthService: OAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const req = context.switchToHttp().getRequest<Request & { user?: RequestUser; tokenContext?: TokenContext }>();

    const authHeader = req.headers['authorization'];
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const rawToken = authHeader.slice('Bearer '.length).trim();
      if (looksLikeApiToken(rawToken)) {
        const resolved = await this.tokensService.resolveByRawToken(rawToken);
        if (resolved) {
          req.user = { ...resolved.user, tokenContext: resolved.tokenContext };
          req.tokenContext = resolved.tokenContext;
          return true;
        }
        // Known PAT format but not found/owner disabled: fall through (won't match cookie/dev-auth either) -> 401 below unless @Public.
      } else if (looksLikeOAuthAccessToken(rawToken)) {
        const resolved = await this.oauthService.resolveAccessToken(rawToken);
        if (resolved) {
          req.user = { ...resolved.user, tokenContext: resolved.tokenContext };
          req.tokenContext = resolved.tokenContext;
          return true;
        }
        // Known OAuth access-token format but not found/expired/owner disabled: fall through -> 401 below unless @Public.
      }
    }

    const token = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
    if (token) {
      const resolved = await this.authService.resolveSessionUser(token);
      if (resolved) {
        req.user = resolved.user;
        // Re-issue the cookie when the DB session slides so browser maxAge tracks
        // idle extension (otherwise the cookie dies at login+30d while expiresAt moved).
        // Use remaining time until the (possibly absolute-capped) server expiresAt —
        // a fixed 30d Max-Age can outlive absoluteDeadline and leave the browser
        // sending a cookie the server already rejects.
        if (resolved.slid) {
          const res = context.switchToHttp().getResponse<Response>();
          const remainingMs =
            resolved.expiresAtMs !== undefined
              ? Math.max(0, resolved.expiresAtMs - Date.now())
              : undefined;
          res.cookie(
            SESSION_COOKIE_NAME,
            token,
            remainingMs !== undefined ? sessionCookieOptions(remainingMs) : sessionCookieOptions(),
          );
        }
        return true;
      }
      // Invalid/expired cookie: fall through to dev-auth (if enabled) or 401.
    }

    if (isDevAuthActive()) {
      const rawRole = (req.headers['x-dev-role'] as string | undefined)?.toLowerCase();
      const parsedRole = Role.safeParse(rawRole);
      const devRole = parsedRole.success ? parsedRole.data : 'dm';

      const rawName = (req.headers['x-dev-user'] as string | undefined)?.trim() || 'dev-user';
      req.user = {
        id: `dev:${rawName}`,
        name: rawName,
        serverRole: 'admin',
        devRole,
      };
      return true;
    }

    if (isPublic) return true;

    throw new UnauthorizedException('Authentication required');
  }
}
