import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ServerRoles } from '../../common/decorators/server-roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { AiConsoleService } from './ai-console.service';
import { AiCapsUpdateDto, AiKillSwitchUpdateDto, AiAllowlistUpdateDto, AiPricingUpdateDto } from './ai-console.dto';

/**
 * Admin AI console (issue #315) — the server-admin cockpit for the AI program
 * (epic #308). ADMIN only (@ServerRoles('admin')); every route is server-wide.
 *
 * Routes under `/settings/ai/*`:
 *   GET  /settings/ai            → one-shot overview (kill switch, caps, allowlist, usage)
 *   GET  /settings/ai/usage      → the usage rollup (tokens/turns by campaign & model)
 *   GET  /settings/ai/caps       → current caps (server + per-campaign) via the overview
 *   PUT  /settings/ai/caps       → set the server token cap and/or per-campaign budgets
 *   POST /settings/ai/kill       → the kill switch (enabled:false pauses all AI)
 *   GET  /settings/ai/allowlist  → the model allowlist
 *   PUT  /settings/ai/allowlist  → replace the model allowlist (drives #310)
 *   POST /settings/ai/health     → "test all" provider health probe
 *   GET  /settings/ai/pricing    → server-wide model pricing + reference figures (#1065)
 *   PUT  /settings/ai/pricing    → replace the model price list
 *
 * No API key or raw prompt is ever surfaced by any route here.
 */
@ApiTags('ai-console')
@Controller('settings/ai')
@ServerRoles('admin')
export class AiConsoleController {
  constructor(private readonly console: AiConsoleService) {}

  @Get()
  @ApiOperation({ summary: 'AI console overview', description: 'Server-admin only. Kill switch, caps, allowlist, and usage rollup in one shot.' })
  @ApiResponse({ status: 200, description: 'The console overview.' })
  overview() {
    return this.console.getOverview();
  }

  @Get('usage')
  @ApiOperation({ summary: 'AI usage rollup', description: 'Server-admin only. Tokens + turns aggregated by campaign and by model from the per-seat metering.' })
  @ApiResponse({ status: 200, description: 'The usage rollup.' })
  usage() {
    return this.console.getUsage();
  }

  @Put('caps')
  @ApiOperation({
    summary: 'Set AI budgets & caps',
    description: 'Server-admin only. Sets the server-wide token cap (0 = unlimited) and/or per-campaign seat budgets. Omitted fields are unchanged.',
  })
  @ApiResponse({ status: 200, description: 'The updated overview.' })
  setCaps(@Body() body: AiCapsUpdateDto, @CurrentUser() user: RequestUser) {
    return this.console.setCaps(body, user);
  }

  @Post('kill')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Kill switch / global opt-in',
    description: 'Server-admin only. `enabled:false` pauses ALL AI immediately (no new turn can start); `enabled:true` re-enables the program.',
  })
  @ApiResponse({ status: 200, description: 'The updated overview.' })
  kill(@Body() body: AiKillSwitchUpdateDto, @CurrentUser() user: RequestUser) {
    return this.console.setKillSwitch(body.enabled, user);
  }

  @Put('allowlist')
  @ApiOperation({
    summary: 'Set the model allowlist',
    description: 'Server-admin only. Replaces the server model allowlist ([] = unrestricted). Requires a configured server-default provider.',
  })
  @ApiResponse({ status: 200, description: 'The updated overview.' })
  @ApiResponse({ status: 400, description: 'No server-default provider is configured yet.' })
  setAllowlist(@Body() body: AiAllowlistUpdateDto, @CurrentUser() user: RequestUser) {
    return this.console.setAllowlist(body.allowedModels, user);
  }

  @Post('health')
  @Throttle({ ai: { limit: 10, ttl: 60000 } })
  @HttpCode(200)
  @ApiOperation({
    summary: 'Test all AI providers',
    description: 'Server-admin only. Probes the server-default provider and every per-campaign override. Returns ok/error only — never a credential.',
  })
  @ApiResponse({ status: 200, description: 'Per-provider health results.' })
  health() {
    return this.console.testAll();
  }

  @Get('pricing')
  @ApiOperation({
    summary: 'Get the AI model price list',
    description:
      'Server-admin only. The server-wide per-model pricing that turns token budgets into dollar estimates (#1065), ' +
      'plus Campfire’s shipped reference figures offered for prefill. The reference figures are a DATA-ENTRY AID: ' +
      'nothing estimates against them until an admin has reviewed and saved them.',
  })
  @ApiResponse({ status: 200, description: 'The stored price list and the reference figures.' })
  pricing() {
    return this.console.getPricing();
  }

  @Put('pricing')
  @ApiOperation({
    summary: 'Set the AI model price list',
    description:
      'Server-admin only. Replaces the server-wide price list. Prices are keyed by (providerType, model, baseUrl) — ' +
      'a price entered for a provider’s own endpoint is never applied to a custom endpoint, because a model name ' +
      'behind a proxy does not imply the vendor’s rate. A model with no entry shows the cannot-estimate disclosure.',
  })
  @ApiResponse({ status: 200, description: 'The updated price list.' })
  setPricing(@Body() body: AiPricingUpdateDto, @CurrentUser() user: RequestUser) {
    return this.console.setPricing(body.entries, user);
  }
}
