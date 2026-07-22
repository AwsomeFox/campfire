import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put } from '@nestjs/common';
import { ApiBody, ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { AiProviderConfigService } from './ai-provider-config.service';
import {
  AiProviderConfigUpdateDto,
  AiProviderRemovalConfirmDto,
  AiProviderRemovalImpactDto,
  AI_PROVIDER_TEST_REQUEST_OPENAPI_SCHEMA,
  AiProviderTestRequestDto,
  AiProviderTestResultDto,
} from './ai-provider-config.dto';

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
    description:
      'DM only. Redacted: the API key is never returned — only `configured`, `keyLast4`, and non-secret credential source/readiness.',
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
      'override, plus non-secret credential source/readiness. Carries NO key material — this lets a DM (who ' +
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

  @Delete('key')
  @ApiOperation({
    summary: 'Clear the stored campaign API key',
    description:
      'DM only. Clears only this override\'s encrypted key and masked last-four indicator. Provider, model, base URL, ' +
      'and parameters are retained; the override may fall back to the server credential. Audited without key material.',
  })
  @ApiResponse({ status: 200, description: 'The retained override with updated non-secret credential source/readiness.' })
  @ApiResponse({ status: 404, description: 'No campaign provider override exists.' })
  async clearKey(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, id, 'dm');
    return this.configs.clearCampaignKey(id, user);
  }

  @Get('removal-impact')
  @ApiOperation({
    summary: 'Preview removal of a campaign AI provider override',
    description:
      'DM only. Authoritatively computes the campaign\'s exact server fallback or disabled outcome, including ' +
      'AI-seat budget/runtime implications, and returns the opaque revision required to confirm deletion. No key material.',
  })
  @ApiResponse({ status: 200, description: 'Credential-free authoritative removal preview.', type: AiProviderRemovalImpactDto })
  @ApiResponse({ status: 404, description: 'No campaign provider override exists.' })
  async removalImpact(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, id, 'dm');
    return this.configs.previewCampaignRemoval(id);
  }

  @Delete()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Confirm removal of the per-campaign AI provider override',
    description:
      'DM only. Requires the exact revision from GET removal-impact. Recomputes the fallback and atomically deletes ' +
      'plus audits; stale revisions return 409 and leave the override active.',
  })
  @ApiBody({ type: AiProviderRemovalConfirmDto })
  @ApiResponse({ status: 204, description: 'Deletion and secret-free audit committed.' })
  @ApiResponse({ status: 409, description: 'Impact changed after preview; nothing was deleted.' })
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: AiProviderRemovalConfirmDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireRole(user, id, 'dm');
    this.configs.deleteCampaign(id, body.impactRevision, user);
  }

  @Post('test')
  @Throttle({ ai: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: 'Test a campaign AI provider draft',
    description:
      'DM only. Tests the submitted provider/model/base URL and optional write-only key without saving them. A blank ' +
      'or omitted key reuses this campaign override\'s stored key when present. Otherwise it may inherit the server ' +
      'credential together with the server-owned provider/base URL (never a campaign-controlled destination). Returns ' +
      'only non-secret target/scope/credential-source metadata and the redacted result.',
  })
  @ApiBody({ schema: AI_PROVIDER_TEST_REQUEST_OPENAPI_SCHEMA })
  @ApiResponse({ status: 201, description: 'The non-persisting connection test result.', type: AiProviderTestResultDto })
  async test(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: AiProviderTestRequestDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireRole(user, id, 'dm', { allowArchived: true });
    return this.configs.testConnection(id, body);
  }
}
