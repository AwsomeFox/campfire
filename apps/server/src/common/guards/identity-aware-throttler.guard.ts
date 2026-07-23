import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerRequest,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { looksLikeApiToken, looksLikeOAuthAccessToken } from '../crypto';
import { THROTTLE_AI, AI_THROTTLE_LIMIT } from '../throttle.constants';
import type { RequestUser, TokenContext } from '../user.types';
import { AuthService } from '../../modules/auth/auth.service';
import { SESSION_COOKIE_NAME } from '../../modules/auth/auth.constants';
import { sessionCookieOptions } from '../../modules/auth/session-cookie';
import { TokensService } from '../../modules/tokens/tokens.service';
import { OAuthService } from '../../modules/oauth/oauth.service';

type AuthenticatedRequest = Request & { user?: RequestUser; tokenContext?: TokenContext };

/**
 * Keeps the global throttler before auth guards, but lets strict AI buckets use
 * authenticated user identity when a valid session/PAT/OAuth token is present.
 */
@Injectable()
export class IdentityAwareThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly authService: AuthService,
    private readonly tokensService: TokensService,
    private readonly oauthService: OAuthService,
  ) {
    super(options, storageService, reflector);
  }

  protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    if (requestProps.throttler.name === THROTTLE_AI && requestProps.limit === AI_THROTTLE_LIMIT) {
      const { req, res } = this.getRequestResponse(requestProps.context) as {
        req: AuthenticatedRequest;
        res: Response;
      };
      await this.resolveUserForAiThrottle(req, res);
    }

    return super.handleRequest(requestProps);
  }

  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const request = req as unknown as AuthenticatedRequest;
    return request.user ? `user:${request.user.id}` : (request.ip ?? request.socket.remoteAddress ?? 'unknown');
  }

  private async resolveUserForAiThrottle(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (req.user) return;

    const authHeader = req.headers['authorization'];
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const rawToken = authHeader.slice('Bearer '.length).trim();
      if (looksLikeApiToken(rawToken)) {
        const resolved = await this.tokensService.resolveByRawToken(rawToken);
        if (resolved) {
          req.user = { ...resolved.user, tokenContext: resolved.tokenContext };
          req.tokenContext = resolved.tokenContext;
          return;
        }
      } else if (looksLikeOAuthAccessToken(rawToken)) {
        const resolved = await this.oauthService.resolveAccessToken(rawToken);
        if (resolved) {
          req.user = { ...resolved.user, tokenContext: resolved.tokenContext };
          req.tokenContext = resolved.tokenContext;
          return;
        }
      }
    }

    const sessionToken = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
    if (!sessionToken) return;

    const resolved = await this.authService.resolveSessionUser(sessionToken);
    if (!resolved) return;

    req.user = resolved.user;
    if (resolved.slid) {
      const remainingMs =
        resolved.expiresAtMs !== undefined ? Math.max(0, resolved.expiresAtMs - Date.now()) : undefined;
      res.cookie(
        SESSION_COOKIE_NAME,
        sessionToken,
        remainingMs !== undefined ? sessionCookieOptions(remainingMs) : sessionCookieOptions(),
      );
    }
  }
}
