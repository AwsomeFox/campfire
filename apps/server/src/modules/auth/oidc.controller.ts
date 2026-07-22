import { Controller, Get, Logger, Req, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Public } from '../../common/decorators/public.decorator';
import { OidcService } from './oidc.service';
import { AuthService } from './auth.service';
import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_MS, OIDC_FLOW_COOKIE_NAME, OIDC_FLOW_COOKIE_MAX_AGE_MS } from './auth.constants';
import { resolveCookieSecure } from '../../common/security-config';
import {
  classifyOidcRecovery,
  OidcRecoveryFailure,
  type OidcRecoveryStage,
} from './oidc-recovery';

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

function flowParts(raw: string | undefined): { state: string; codeVerifier: string } | null {
  if (!raw) return null;
  const parts = raw.split(':');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { state: parts[0], codeVerifier: parts[1] };
}

/** Constant-work comparison avoids making the expected state observable. */
function stateMatches(expected: string, actual: string | undefined): boolean {
  if (!actual) return false;
  const expectedDigest = createHash('sha256').update(expected).digest();
  const actualDigest = createHash('sha256').update(actual).digest();
  return timingSafeEqual(expectedDigest, actualDigest);
}

@ApiTags('auth')
@Controller('auth/oidc')
export class OidcController {
  private readonly logger = new Logger(OidcController.name);

  constructor(
    private readonly oidc: OidcService,
    private readonly auth: AuthService,
  ) {}

  @Public()
  @Get('login')
  @ApiOperation({ summary: 'Start OIDC SSO login', description: 'Redirects to the configured OIDC provider. Sets a short-lived flow cookie for the PKCE state/verifier round trip.' })
  @ApiResponse({ status: 302, description: 'Redirect to the IdP authorization endpoint, or same-origin `/login/sso-error` with only a safe category and support reference when the flow cannot start.' })
  async login(@Res() res: Response): Promise<void> {
    // Discard any abandoned flow before creating a fresh state/verifier pair.
    res.clearCookie(OIDC_FLOW_COOKIE_NAME, { path: '/api/v1/auth/oidc' });
    try {
      if (!(await this.oidc.isEnabled())) {
        throw new OidcRecoveryFailure('provider_unavailable', 'oidc_not_configured');
      }
      const { url, state, codeVerifier } = await this.oidc.buildAuthorizationRequest();
      res.cookie(OIDC_FLOW_COOKIE_NAME, `${state}:${codeVerifier}`, flowCookieOptions());
      res.redirect(url.toString());
    } catch (error) {
      this.redirectToRecovery(res, 'start', error);
    }
  }

  @Public()
  @Get('callback')
  @ApiOperation({ summary: 'OIDC callback (redirect target)', description: 'Provider redirects here after authentication. Campfire verifies state + PKCE, provisions/updates the user, and sets the session cookie. Success redirects to `/`; expected failures redirect same-origin to `/login/sso-error` with only a safe category and random support reference.' })
  @ApiResponse({ status: 302, description: 'Session cookie set and redirect to `/` on success; safe same-origin recovery redirect on expected failure. Provider payloads, code, state, tokens, claims, and secrets are never included in the recovery location.' })
  async callback(@Req() req: Request, @Res() res: Response): Promise<void> {
    const flowCookie = req.cookies?.[OIDC_FLOW_COOKIE_NAME] as string | undefined;
    res.clearCookie(OIDC_FLOW_COOKIE_NAME, { path: '/api/v1/auth/oidc' });
    try {
      if (!(await this.oidc.isEnabled())) {
        throw new OidcRecoveryFailure('provider_unavailable', 'oidc_not_configured');
      }
      const env = await this.oidc.getEffectiveConfig();
      if (!env) throw new OidcRecoveryFailure('provider_unavailable', 'oidc_not_configured');

      const flow = flowParts(flowCookie);
      if (!flow) {
        throw new OidcRecoveryFailure('flow_expired', 'flow_cookie_missing_or_invalid');
      }
      const callbackState = typeof req.query.state === 'string' ? req.query.state : undefined;
      if (!stateMatches(flow.state, callbackState)) {
        throw new OidcRecoveryFailure('state_pkce_mismatch', 'state_verification_failed');
      }

      const currentUrl = currentUrlFromRequest(req, env.redirectUri);
      const claims = await this.oidc.handleCallback(currentUrl, flow.state, flow.codeVerifier);
      const user = await this.oidc.provisionOrUpdateUser(claims);
      if (user.disabled) {
        throw new OidcRecoveryFailure('account_disabled', 'account_disabled');
      }
      const { token } = await this.auth.issueSessionFor(user.id);

      res.cookie(SESSION_COOKIE_NAME, token, sessionCookieOptions());
      res.redirect('/');
    } catch (error) {
      this.redirectToRecovery(res, 'callback', error);
    }
  }

  private redirectToRecovery(res: Response, stage: OidcRecoveryStage, error: unknown): void {
    const reference = randomBytes(8).toString('hex').toUpperCase();
    const classification = classifyOidcRecovery(error, stage);
    // Redacted by construction: all values except the random reference are
    // fixed server-authored literals. Never log the exception message/cause,
    // callback URL/query, cookie, provider response, claims, or configuration.
    this.logger.warn(
      `OIDC_RECOVERY reference=${reference} stage=${stage} category=${classification.category} diagnostic=${classification.diagnosticCode} errorType=${classification.errorType}`,
    );
    const query = new URLSearchParams({
      category: classification.category,
      ref: reference,
    });
    res.redirect(302, `/login/sso-error?${query.toString()}`);
  }
}
