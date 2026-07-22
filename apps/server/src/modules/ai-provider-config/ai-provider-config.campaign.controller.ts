import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { AiProviderConfigService } from './ai-provider-config.service';
import { AiProviderConfigUpdateDto } from './ai-provider-config.dto';

/**
 * Per-campaign AI provider override (issue #310) — DM only.
 *
 * A campaign override falls back to the server default (see
 * AiProviderConfigService.resolveEffectiveConfig). The stored API key is write-only:
 * PUT accepts it, GET returns only a redacted view. Writes are additionally capped by
 * the server admin's model allowlist (enforced in the service).
 */
@ApiTags('ai-provider')
@Controller('campaigns/:id/ai-provider')
export class AiProviderCampaignConfigController {
  constructor(
    private readonly configs: AiProviderConfigService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Get the per-campaign AI provider override',
    description: 'DM only. Redacted: the API key is never returned — only `configured` + `keyLast4`.',
  })
  @ApiResponse({ status: 200, description: 'The redacted campaign override, or null when unset.' })
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, id, 'dm', { allowArchived: true });
    return this.configs.getCampaignView(id);
  }

  @Get('effective')
  @ApiOperation({
    summary: 'Get the non-secret effective AI provider indicator for a campaign',
    description:
      'DM only. Returns which provider is in effect and whether it comes from the server default or a campaign ' +
      'override (`{ configured, providerType, model, source }`). Carries NO key material — this lets a DM (who ' +
      'cannot read the admin-only server config) render the effective-provider status line.',
  })
  @ApiResponse({ status: 200, description: 'The non-secret effective-provider view.' })
  async effective(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, id, 'dm', { allowArchived: true });
    return this.configs.getEffectiveView(id);
  }

  @Put()
  @ApiOperation({
    summary: 'Set the per-campaign AI provider override',
    description:
      'DM only. `apiKey` is write-only (omit to keep, value to set/rotate, "" to clear). If the server admin has ' +
      'restricted `allowedModels`, the chosen `model` must be one of them (else 400).',
  })
  @ApiResponse({ status: 200, description: 'The updated (redacted) override.' })
  @ApiResponse({ status: 400, description: 'Model not in the server admin allowlist.' })
  async put(@Param('id', ParseIntPipe) id: number, @Body() body: AiProviderConfigUpdateDto, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, id, 'dm');
    return this.configs.putCampaign(id, body, user);
  }

  @Delete()
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete the per-campaign AI provider override', description: 'DM only. Reverts to the server default.' })
  @ApiResponse({ status: 204, description: 'Deleted (or already absent).' })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, id, 'dm');
    await this.configs.deleteCampaign(id, user);
  }

  @Post('test')
  @ApiOperation({
    summary: 'Test the effective AI provider connection for a campaign',
    description:
      'DM only. Builds the provider from the effective (override-or-server, decrypted) config and runs a minimal probe. ' +
      'Returns ok/error only — never any credential.',
  })
  @ApiResponse({ status: 201, description: 'The connection test result.' })
  async test(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, id, 'dm', { allowArchived: true });
    const r = await this.configs.testConnection(id);
    return { scope: 'campaign' as const, ...r };
  }
}
