import { Body, Controller, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { CoDmService } from './co-dm.service';
import { CoDmDraftRequestDto } from './ai-dm.dto';

/**
 * Co-DM authoring (issue #313), scoped under a campaign's AI DM seat.
 *
 * The AI drafts content ("make a tavern NPC", "build a level-3 ambush") and files it as
 * PENDING PROPOSALS — never a direct write. dm role required (the AI holds the DM seat),
 * plus the server-wide experimental flag AND an enabled, budgeted seat (enforced in
 * CoDmService). The human DM reviews the resulting proposals in the normal approval queue.
 */
@ApiTags('ai-dm')
@Controller('campaigns/:id/ai-dm')
export class CoDmController {
  constructor(
    private readonly coDm: CoDmService,
    private readonly access: CampaignAccessService,
  ) {}

  @Post('draft')
  @Throttle({ ai: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: 'Co-DM: draft content for the approval queue',
    description:
      'dm role required, the server-wide experimental flag must be on, and the seat must be enabled with remaining ' +
      'budget. Asks the configured provider to draft the requested content (NPC / location / story beat / recap / ' +
      'encounter / map) and files it as PENDING PROPOSAL(S) — nothing is written to canon directly. Encounters/maps ' +
      'reuse the deterministic generators (#304/#306). Returns the created proposal ids; the DM approves/rejects them ' +
      'via the normal proposal endpoints. Metered against the seat budget; the proposer is the AI seat + model.',
  })
  @ApiResponse({ status: 201, description: 'The pending proposal(s) drafted by the co-DM.' })
  @ApiResponse({ status: 403, description: 'Not a dm, feature disabled, seat not enabled, or token budget exhausted.' })
  @ApiResponse({ status: 422, description: 'The provider did not return a usable structured draft.' })
  async draft(@Param('id', ParseIntPipe) id: number, @Body() body: CoDmDraftRequestDto, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireRole(user, id, 'dm');
    return this.coDm.draft(id, body, user, role);
  }
}
