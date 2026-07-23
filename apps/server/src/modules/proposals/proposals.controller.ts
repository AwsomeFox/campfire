import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { ProposalsService } from './proposals.service';
import { ProposalResolveDto, ProposalApproveDto, ProposalBatchResolveDto, ProposalReviseDto } from './proposals.dto';

@ApiTags('proposals')
@Controller('campaigns/:campaignId/proposals')
export class CampaignProposalsController {
  constructor(
    private readonly proposals: ProposalsService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List proposals for a campaign',
    description:
      'Any member may call this. The DM sees ALL proposals for the campaign; a non-DM member sees only their OWN submissions (the proposer self-view — issue #124). Proposals are create/update/delete writes submitted via `?proposed=true` on the underlying entity route, pending dm approval. Non-DM responses project redacted snapshots (dmSecret stripped; hidden/unexplored targets omitted — issue #817); the DM review queue retains the full persisted snapshot.',
  })
  @ApiQuery({ name: 'status', required: false, enum: ['pending', 'approved', 'rejected', 'withdrawn'], description: 'Filter to a single proposal status.' })
  @ApiResponse({ status: 200, description: 'Proposals for the campaign (all for a DM; the caller\'s own for a non-DM member).' })
  async list(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Query('status') status: string | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    // Any member may list (a read — fine on an archived campaign; approve/reject stay
    // blocked while archived). Self-view scoping: a DM sees everyone's proposals; a
    // non-DM member sees only their own (filter by their user id).
    const role = await this.access.requireMember(user, campaignId);
    const opts = role === 'dm' ? undefined : { proposerUserId: user.id };
    return this.proposals.listForCampaign(campaignId, status, role, opts);
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

  @Post(':id/withdraw')
  @ApiOperation({
    summary: 'Withdraw your own pending proposal',
    description:
      'The PROPOSER (not the DM) pulls their own still-pending proposal before it is reviewed (issue #124). Must be a member of the proposal\'s campaign AND the original proposer; 403 otherwise. No entity write is applied. 409 if already resolved.',
  })
  @ApiResponse({ status: 201, description: 'Withdrawn proposal.' })
  async withdraw(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.proposals.getRowOrThrow(id);
    // Any member may reach this; withdraw() enforces that the caller is the proposer.
    const role = await this.access.requireMember(user, row.campaignId);
    return this.proposals.withdraw(id, user, role);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Revise your own pending proposal',
    description:
      'The PROPOSER amends their own still-pending proposal\'s create/update `payload` before the DM acts (issue #124). Must be the original proposer; 403 otherwise. The payload is re-validated against the entity schema (400 if invalid). Delete proposals cannot be revised. 409 if already resolved.',
  })
  @ApiResponse({ status: 200, description: 'Revised proposal.' })
  async revise(@Param('id', ParseIntPipe) id: number, @Body() body: ProposalReviseDto, @CurrentUser() user: RequestUser) {
    const row = await this.proposals.getRowOrThrow(id);
    // Any member may reach this; revise() enforces that the caller is the proposer.
    const role = await this.access.requireMember(user, row.campaignId);
    return this.proposals.revise(id, body, user, role);
  }
}
