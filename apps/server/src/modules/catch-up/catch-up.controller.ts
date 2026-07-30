import { BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { CatchUpService } from './catch-up.service';
import { CatchUpMarkDto } from './catch-up.dto';

function numericUserId(id: string | number): number | null {
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

@ApiTags('catch-up')
@Controller('campaigns/:campaignId/catch-up')
export class CatchUpController {
  constructor(
    private readonly catchUp: CatchUpService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "Since you were last here — grouped campaign changes",
    description:
      'Requires campaign membership. Returns quests, session recaps, timeline events, and schedule changes whose updatedAt (or createdAt) is at/after the reference instant. `since` defaults to the member\'s stored catch-up cursor, then falls back to the latest session date. Pass `?since=<ISO>` to reopen an earlier period. Hidden entities are excluded and dmSecret stripped for non-dm.',
  })
  @ApiQuery({ name: 'since', required: false, type: String, description: 'ISO-8601 instant to diff against. Overrides the stored cursor.' })
  @ApiResponse({ status: 200, description: 'Grouped catch-up diff.' })
  async get(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Query('since') since: string | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireMember(user, campaignId);
    return this.catchUp.getCatchUp(campaignId, user, role, since);
  }

  @Post('mark')
  @ApiOperation({
    summary: 'Mark campaign catch-up as read',
    description:
      'Bumps the per-user, per-campaign catch-up cursor so the next GET defaults to changes after this instant. Optional body `{ at }` pins the cursor to a specific ISO instant.',
  })
  @ApiResponse({ status: 201, description: 'Updated cursor.' })
  async mark(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: CatchUpMarkDto,
    @CurrentUser() user: RequestUser,
  ) {
    // DELIBERATE archive exemption (issue #1480): marking catch-up bumps only
    // the caller's OWN per-user, per-campaign read cursor (consumed by
    // GET /catch-up) — personal read-state like a notification read marker, not
    // shared campaign content another member can observe. So the membership
    // gate still applies, but the archive read-only gate does NOT: a member of
    // a paused/completed campaign must be able to clear the dashboard banner
    // (the web client only dismisses it on a successful POST). Other member
    // writes (RSVP, proposal withdraw/revise) DO mutate shared table state and
    // stay archive-gated via requireMemberOnWritableCampaign().
    await this.access.requireMember(user, campaignId);
    const userId = numericUserId(user.id);
    if (userId === null) {
      throw new BadRequestException('Catch-up cursor requires a real user account.');
    }
    return this.catchUp.markCaughtUp(userId, campaignId, body.at);
  }
}
