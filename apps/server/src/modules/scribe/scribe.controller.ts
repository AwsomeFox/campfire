import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { ScribeService } from './scribe.service';
import { ScribeConfigUpdateDto, ScribeRunRequestDto } from './scribe.dto';

/**
 * Automatic / scheduled AI scribe (issue #316), scoped under a campaign.
 *
 * The scribe drafts a session recap from the campaign's own material and files it as
 * a PROPOSAL for the DM to approve — it never writes canon. Reads (config + job log)
 * require campaign membership; configuring and running require the dm role, and the
 * run itself is gated by the same governance as an AI-DM turn (the server-wide
 * experimentalAiDm flag + the per-campaign seat being enabled + its token budget) —
 * enforced in ScribeService.
 */
@ApiTags('scribe')
@Controller('campaigns/:id/scribe')
export class ScribeController {
  constructor(
    private readonly scribe: ScribeService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Get the AI scribe config for a campaign',
    description: 'Requires campaign membership. Returns the per-campaign trigger toggles + per-run token cap (defaults when never configured).',
  })
  @ApiResponse({ status: 200, description: 'The scribe config.' })
  async getConfig(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    await this.access.requireMember(user, id);
    return this.scribe.getConfig(id);
  }

  @Put()
  @ApiOperation({
    summary: 'Configure the AI scribe',
    description: 'dm role required. Sets postSession / cron triggers and budgetPerRun; omitted fields are left unchanged. All triggers default off.',
  })
  @ApiResponse({ status: 200, description: 'The updated scribe config.' })
  async putConfig(@Param('id', ParseIntPipe) id: number, @Body() body: ScribeConfigUpdateDto, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, id, 'dm');
    return this.scribe.putConfig(id, body, user);
  }

  @Post('run')
  @Throttle({ ai: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: 'Run the AI scribe now (on-demand)',
    description:
      'dm role required, plus the run governance (experimentalAiDm flag on, seat enabled, budget remaining). Assembles the ' +
      'campaign material, has the configured provider write a recap, and files it as a PROPOSAL (returns its proposal id). ' +
      'Idempotent: a re-run over unchanged material, or while a scribe recap proposal is still pending, is a no-op. ' +
      '`dryRun:true` generates a preview without filing anything.',
  })
  @ApiResponse({ status: 201, description: 'The recorded job + any filed proposal ids (+ preview on a dry run).' })
  async run(@Param('id', ParseIntPipe) id: number, @Body() body: ScribeRunRequestDto, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, id, 'dm');
    return this.scribe.run(id, 'on_demand', user, { dryRun: body.dryRun });
  }

  @Get('jobs')
  @ApiOperation({
    summary: 'List recent AI scribe runs',
    description: 'Requires campaign membership. Returns the recorded scribe jobs, newest first (status, trigger, filed proposal, token cost).',
  })
  @ApiResponse({ status: 200, description: 'The recorded scribe jobs.' })
  async jobs(@Param('id', ParseIntPipe) id: number, @Query('limit') limit: string | undefined, @CurrentUser() user: RequestUser) {
    await this.access.requireMember(user, id);
    const n = limit ? Number(limit) : undefined;
    return this.scribe.listJobs(id, Number.isFinite(n) ? (n as number) : undefined);
  }
}
