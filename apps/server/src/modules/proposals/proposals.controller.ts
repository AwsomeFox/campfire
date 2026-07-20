import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { ProposalsService } from './proposals.service';
import { ProposalResolveDto, ProposalApproveDto, ProposalBatchResolveDto } from './proposals.dto';

@ApiTags('proposals')
@Controller('campaigns/:campaignId/proposals')
export class CampaignProposalsController {
  constructor(
    private readonly proposals: ProposalsService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List proposals for a campaign', description: 'dm role required. Proposals are AI/collaborator writes (create/update) submitted via `?proposed=true` on the underlying entity route, pending dm approval.' })
  @ApiQuery({ name: 'status', required: false, enum: ['pending', 'approved', 'rejected'], description: 'Filter to a single proposal status.' })
  @ApiResponse({ status: 200, description: 'Proposals for the campaign.' })
  async list(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Query('status') status: string | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    // allowArchived: listing proposals is a read — fine on an archived campaign
    // (approve/reject below stay blocked while archived).
    await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
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

  @Post('batch/approve')
  @ApiOperation({
    summary: 'Approve many proposals at once',
    description:
      'dm role required (checked per proposal\'s campaign). Each id is applied through the same atomic approve path; one failure does not abort the rest. Returns a per-id result array.',
  })
  @ApiResponse({ status: 201, description: 'Per-id batch results ({ results: [{ id, ok, ... }] }).' })
  async batchApprove(@Body() body: ProposalBatchResolveDto, @CurrentUser() user: RequestUser) {
    const results = await this.proposals.resolveBatch(body.ids, 'approve', body.note, user, (campaignId) =>
      this.access.requireRole(user, campaignId, 'dm'),
    );
    return { results };
  }

  @Post('batch/reject')
  @ApiOperation({
    summary: 'Reject many proposals at once',
    description: 'dm role required (checked per proposal\'s campaign). No writes are applied. Returns a per-id result array.',
  })
  @ApiResponse({ status: 201, description: 'Per-id batch results ({ results: [{ id, ok, ... }] }).' })
  async batchReject(@Body() body: ProposalBatchResolveDto, @CurrentUser() user: RequestUser) {
    const results = await this.proposals.resolveBatch(body.ids, 'reject', body.note, user, (campaignId) =>
      this.access.requireRole(user, campaignId, 'dm'),
    );
    return { results };
  }

  @Post(':id/approve')
  @ApiOperation({
    summary: 'Approve a proposal',
    description:
      'dm role required. Applies the pending create/update/delete to the underlying entity. Optionally pass an amended `payload` to edit the proposed create/update body before it is applied (edit-before-approve).',
  })
  @ApiResponse({ status: 201, description: 'Approved proposal (with the write applied).' })
  async approve(@Param('id', ParseIntPipe) id: number, @Body() body: ProposalApproveDto, @CurrentUser() user: RequestUser) {
    const row = await this.proposals.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.proposals.approve(id, body, user, role);
  }

  @Post(':id/reject')
  @ApiOperation({ summary: 'Reject a proposal', description: 'dm role required. No write is applied.' })
  @ApiResponse({ status: 201, description: 'Rejected proposal.' })
  async reject(@Param('id', ParseIntPipe) id: number, @Body() body: ProposalResolveDto, @CurrentUser() user: RequestUser) {
    const row = await this.proposals.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.proposals.reject(id, body, user, role);
  }
}
