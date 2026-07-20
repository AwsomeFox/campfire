import { Body, Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import type { OidcSettings, OidcTestResult } from '@campfire/schema';
import { ServerRoles } from '../../common/decorators/server-roles.decorator';
import { OidcService } from './oidc.service';
import { OidcSettingsUpdateDto, OidcTestRequestDto } from './oidc-admin.dto';

/**
 * Server-admin console for OIDC/SSO. Persists an in-app OIDC config in the
 * settings store and exposes a test-connection action. Env vars (OIDC_*) still
 * work and take precedence per-field (see oidc.config.ts) — the GET response's
 * `envKeys` lists which fields are currently pinned by the environment.
 *
 * The client secret is write-only: accepted on PATCH, never returned by GET
 * (only a `clientSecretSet` boolean).
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
  @ApiOperation({ summary: 'Test the OIDC connection', description: 'Server-admin only. Fetches and validates the issuer discovery document. Provide `issuer` to test a value before saving; omit to test the effective (env-or-stored) issuer.' })
  @ApiResponse({ status: 200, description: 'Structured ok/error result (never a 5xx for a reachable-but-invalid IdP).' })
  test(@Body() body: OidcTestRequestDto): Promise<OidcTestResult> {
    return this.oidc.testConnection(body.issuer);
  }
}
