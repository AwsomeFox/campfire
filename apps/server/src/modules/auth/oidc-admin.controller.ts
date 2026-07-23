import { Body, Controller, Get, HttpCode, Patch, Post, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';
import type { OidcSettings, OidcTestLoginStart, OidcTestResult } from '@campfire/schema';
import { ServerRoles } from '../../common/decorators/server-roles.decorator';
import { OidcService } from './oidc.service';
import { OidcSettingsUpdateDto, OidcTestRequestDto } from './oidc-admin.dto';
import {
  OIDC_TEST_FLOW_COOKIE_MAX_AGE_MS,
  OIDC_TEST_FLOW_COOKIE_NAME,
} from './auth.constants';
import { resolveCookieSecure } from '../../common/security-config';

/**
 * Server-admin console for OIDC/SSO. Persists an in-app OIDC config in the
 * settings store and exposes diagnostic probes (issue #848). Env vars (OIDC_*)
 * still work and take precedence per-field (see oidc.config.ts) — the GET
 * response's `envKeys` lists which fields are currently pinned by the
 * environment.
 *
 * The client secret is write-only: accepted on PATCH / test drafts, never
 * returned by GET (only a `clientSecretSet` boolean).
 */
@ApiTags('settings')
@Controller('settings/oidc')
@ServerRoles('admin')
export class OidcAdminController {
  constructor(private readonly oidc: OidcService) {}

  @Get()
  @ApiOperation({ summary: 'Get OIDC configuration', description: 'Server-admin only. Client secret is never returned — only `clientSecretSet`.' })
  @ApiResponse({ status: 200, description: 'Current OIDC configuration and status.' })
  get(): Promise<OidcSettings> {
    return this.oidc.getAdminView();
  }

  @Patch()
  @ApiOperation({ summary: 'Update OIDC configuration', description: 'Server-admin only. clientSecret is write-only: omit to keep the current secret, send "" to clear it. Env vars of the same name still override stored values.' })
  @ApiResponse({ status: 200, description: 'Updated OIDC configuration and status.' })
  update(@Body() body: OidcSettingsUpdateDto): Promise<OidcSettings> {
    return this.oidc.updateStoredConfig(body);
  }

  @Post('test')
  // POST defaults to 201 in Nest; this is a probe, not a creation — return 200.
  @HttpCode(200)
  @ApiOperation({
    summary: 'Run OIDC discovery diagnostics',
    description:
      'Server-admin only. Fetches and validates the issuer discovery document (canonical issuer equality + endpoint URLs), then probes redirect/client configuration. Does not perform token exchange, claims, or group checks — use POST /settings/oidc/test-login for an end-to-end test. Provide draft fields to test before saving; omit to test effective (env-or-stored) values. Never echoes secrets.',
  })
  @ApiResponse({ status: 200, description: 'Structured diagnostic result (never a 5xx for a reachable-but-invalid IdP).' })
  test(@Body() body: OidcTestRequestDto): Promise<OidcTestResult> {
    return this.oidc.testConnection(body);
  }

  @Post('test-login')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Start an admin-only end-to-end OIDC test login',
    description:
      'Server-admin only. Starts a real authorization-code + PKCE round trip using draft or effective config. Completing the flow does NOT replace the current admin session or provision a user. Sets a short-lived diagnostic flow cookie and returns the IdP authorization URL.',
  })
  @ApiResponse({ status: 200, description: 'Authorization URL + non-secret fingerprint/sources for the values under test.' })
  async startTestLogin(
    @Body() body: OidcTestRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OidcTestLoginStart> {
    const started = await this.oidc.startTestLogin(body);
    res.cookie(OIDC_TEST_FLOW_COOKIE_NAME, started.flowToken, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/api/v1/auth/oidc',
      maxAge: OIDC_TEST_FLOW_COOKIE_MAX_AGE_MS,
      secure: resolveCookieSecure(),
    });
    return {
      authorizationUrl: started.authorizationUrl,
      fingerprint: started.fingerprint,
      fieldSources: started.fieldSources,
    };
  }

  @Get('test-login/result')
  @ApiOperation({
    summary: 'Fetch the latest end-to-end OIDC diagnostic result',
    description: 'Server-admin only. Returns the most recently completed diagnostic login result, or null if none is available.',
  })
  @ApiResponse({ status: 200, description: 'Structured diagnostic result or null.' })
  getTestLoginResult(): Promise<OidcTestResult | null> {
    return this.oidc.getTestLoginResult();
  }
}
