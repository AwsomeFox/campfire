import { Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { InboxSweepService } from './inbox-sweep.service';

/**
 * Inbox sweep (issue #1644), scoped under a campaign.
 *
 * Reads the campaign's OPEN inbox items, infers create/update/dismiss per capture,
 * files PENDING PROPOSALS ONLY, and resolves swept items. dm role required — the
 * route reads campaign context broadly (bootstraps every quest/NPC/location/character
 * id+name, including DM-hidden ones) via `CampaignAccessService.requireRole`, which
 * ALSO enforces the archived-campaign read-only gate. Never `requireMember({write:true})`,
 * which only asserts the campaign is writable, not that the caller holds DM authority
 * (the exact gap #1450 was).
 */
@ApiTags('inbox-sweep')
@Controller('campaigns/:id/inbox')
export class InboxSweepController {
  constructor(
    private readonly sweep: InboxSweepService,
    private readonly access: CampaignAccessService,
  ) {}

  @Post('sweep')
  @Throttle({ ai: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: 'Start a sweep of the campaign inbox',
    description:
      'dm role required. Returns immediately with a running job; the sweep continues server-side. Poll ' +
      '`GET /campaigns/:id/inbox/sweep/:jobId` until `job.status` is no longer `running`.' +
      'Reads every OPEN inbox item, infers create/update/dismiss (unsupported cases — objective ticks, ' +
      'HP/combat writes — always skip with a stated reason), files each inferred change as a PENDING PROPOSAL (never a ' +
      'direct canon write), and resolves swept items. Safe to re-run: an item already swept is never re-proposed.',
  })
  @ApiResponse({ status: 201, description: 'The recorded sweep job (initially running) + an empty items list; poll GET to receive outcomes.' })
  async run(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireRole(user, id, 'dm');
    return this.sweep.startInboxSweep(id, user, role);
  }

  @Get('sweep/:jobId')
  @Throttle({ ai: { limit: 120, ttl: 60000 } })
  @ApiOperation({
    summary: 'Get the current result of a sweep job',
    description:
      'dm role required. Returns the job status and the per-item outcomes recorded so far. ' +
      'Poll repeatedly while `job.status` is `running`.',
  })
  @ApiResponse({ status: 200, description: 'The sweep job + per-item outcomes recorded so far.' })
  async getResult(
    @Param('id', ParseIntPipe) id: number,
    @Param('jobId', ParseIntPipe) jobId: number,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireRole(user, id, 'dm');
    return this.sweep.getInboxSweepResult(id, jobId);
  }
}
