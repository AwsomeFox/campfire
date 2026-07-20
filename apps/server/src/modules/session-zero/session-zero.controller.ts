import { Body, Controller, Get, Param, ParseIntPipe, Put } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { SessionZeroService } from './session-zero.service';
import { SessionZeroUpdateDto } from './session-zero.dto';

@ApiTags('session-zero')
@Controller('campaigns/:campaignId/session-zero')
export class SessionZeroController {
  constructor(
    private readonly sessionZero: SessionZeroService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "Get a campaign's session-zero charter (lines & veils, safety tools, house rules, tone)",
    description:
      'Requires campaign membership. The whole table can read the charter (no dmSecret). A campaign that has ' +
      'never run session zero returns an empty default rather than 404.',
  })
  @ApiResponse({ status: 200, description: 'The session-zero / table charter.' })
  async get(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    await this.access.requireMember(user, campaignId);
    return this.sessionZero.get(campaignId);
  }

  @Put()
  @ApiOperation({
    summary: "Set a campaign's session-zero charter",
    description: 'dm role required. Upserts the single per-campaign row; a partial body patches only the sent fields.',
  })
  @ApiResponse({ status: 200, description: 'The updated session-zero charter.' })
  async update(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: SessionZeroUpdateDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.sessionZero.update(campaignId, body, user, role);
  }
}
