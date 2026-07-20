import { Controller, ForbiddenException, Get, Query, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { OidcService } from './oidc.service';
import { AuthService } from './auth.service';
import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_MS, OIDC_FLOW_COOKIE_NAME, OIDC_FLOW_COOKIE_MAX_AGE_MS } from './auth.constants';
import { resolveCookieSecure } from '../../common/security-config';

function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_MAX_AGE_MS,
    // See auth.controller.ts — Secure in production unless ALLOW_INSECURE_HTTP (issue #117).
    secure: resolveCookieSecure(),
  };
}

function flowCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/api/v1/auth/oidc',
    maxAge: OIDC_FLOW_COOKIE_MAX_AGE_MS,
    secure: resolveCookieSecure(),
  };
}

/** Reconstructs the externally-visible URL for this request (honors reverse-proxy headers if present, else falls back to configured redirect URI's origin). */
function currentUrlFromRequest(req: Request, redirectUri: string): URL {
  const base = new URL(redirectUri);
  const url = new URL(base.pathname, base.origin);
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value === 'string') url.searchParams.set(key, value);
  }
  return url;
}

@ApiTags('auth')
@Controller('auth/oidc')
export class OidcController {
  constructor(
    private readonly oidc: OidcService,
    private readonly auth: AuthService,
  ) {}

  @Public()
  @Get('login')
  @ApiOperation({ summary: 'Start OIDC SSO login', description: 'Redirects to the configured OIDC provider. Sets a short-lived flow cookie for the PKCE state/verifier round trip.' })
  @ApiResponse({ status: 302, description: 'Redirect to the IdP authorization endpoint.' })
  @ApiResponse({ status: 503, description: 'OIDC is not configured.' })
  async login(@Res() res: Response): Promise<void> {
    if (!(await this.oidc.isEnabled())) {
      throw new ServiceUnavailableException('OIDC is not configured');
    }
    const { url, state, codeVerifier } = await this.oidc.buildAuthorizationRequest();
    res.cookie(OIDC_FLOW_COOKIE_NAME, `${state}:${codeVerifier}`, flowCookieOptions());
    res.redirect(url.toString());
  }

  @Public()
  @Get('callback')
  @ApiOperation({ summary: 'OIDC callback (redirect target)', description: "Provider redirects here with `code`/`state` query params after the user authenticates. Verifies the flow cookie + PKCE, provisions/updates the user, and sets the session cookie." })
  @ApiResponse({ status: 302, description: 'Session cookie set; redirects to the app.' })
  @ApiResponse({ status: 403, description: 'Account disabled, or not a member of the required sign-in group (allowed-group).' })
  @ApiResponse({ status: 503, description: 'OIDC not configured, or the login flow expired / was not started here.' })
  async callback(@Req() req: Request, @Query() _query: Record<string, string>, @Res() res: Response): Promise<void> {
    if (!(await this.oidc.isEnabled())) {
      throw new ServiceUnavailableException('OIDC is not configured');
    }
    const env = await this.oidc.getEffectiveConfig();
    if (!env) throw new ServiceUnavailableException('OIDC is not configured');

    const flowCookie = req.cookies?.[OIDC_FLOW_COOKIE_NAME] as string | undefined;
    res.clearCookie(OIDC_FLOW_COOKIE_NAME, { path: '/api/v1/auth/oidc' });
    if (!flowCookie || !flowCookie.includes(':')) {
      throw new ServiceUnavailableException('OIDC login flow expired or was not started here');
    }
    const [state, codeVerifier] = flowCookie.split(':');

    const currentUrl = currentUrlFromRequest(req, env.redirectUri);
    const claims = await this.oidc.handleCallback(currentUrl, state, codeVerifier);
    const user = await this.oidc.provisionOrUpdateUser(claims);
    // Mirror local login's 403 (see AuthService.login) — a disabled account must never
    // get a session, whether it authenticates via password or SSO. Without this check,
    // OIDC was a silent bypass: local login denies disabled users with a clear 403, but
    // the OIDC callback still happily minted a working session cookie for the same user.
    if (user.disabled) {
      throw new ForbiddenException('This account is disabled');
    }
    const { token } = await this.auth.issueSessionFor(user.id);

    res.cookie(SESSION_COOKIE_NAME, token, sessionCookieOptions());
    res.redirect('/');
  }
}
