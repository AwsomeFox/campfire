import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { ProposalsService } from './proposals.service';
import { ProposalResolveDto } from './proposals.dto';

@ApiTags('proposals')
@Controller('campaigns/:campaignId/proposals')
export class CampaignProposalsController {
  constructor(
    private readonly proposals: ProposalsService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  async list(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Query('status') status: string | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireRole(user, campaignId, 'dm');
    return this.proposals.listForCampaign(campaignId, status);
  }
}

@ApiTags('proposals')
@Controller('proposals')
export class ProposalsController {
  constructor(
    private readonly proposals: ProposalsService,
    private readonly access: CampaignAccessService,
  ) {}

  @Post(':id/approve')
  async approve(@Param('id', ParseIntPipe) id: number, @Body() body: ProposalResolveDto, @CurrentUser() user: RequestUser) {
    const row = await this.proposals.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.proposals.approve(id, body, user, role);
  }

  @Post(':id/reject')
  async reject(@Param('id', ParseIntPipe) id: number, @Body() body: ProposalResolveDto, @CurrentUser() user: RequestUser) {
    const row = await this.proposals.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.proposals.reject(id, body, user, role);
  }
}
