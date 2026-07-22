import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Put, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { ParticipantSupportPreferenceUpsertDto } from './support-preferences.dto';
import { SupportPreferencesService } from './support-preferences.service';

@ApiTags('session-zero')
@Controller('campaigns/:campaignId/session-zero/support-preferences')
export class SupportPreferencesController {
  constructor(
    private readonly supports: SupportPreferencesService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List participant support preferences visible to the caller',
    description:
      'Members see table-shared preferences and their own submission. DMs see table-shared and facilitator-only ' +
      'submissions. AI consent does not change human visibility.',
  })
  async list(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireMember(user, campaignId);
    return this.supports.listForHuman(campaignId, user, role);
  }

  @Get('me')
  @ApiOperation({ summary: 'Get your own support preference', description: 'Returns null when you have not submitted one.' })
  async own(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @CurrentUser() user: RequestUser,
    @Res() response: Response,
  ): Promise<void> {
    await this.access.requireMember(user, campaignId);
    response.status(200).json(await this.supports.getOwn(campaignId, user.id));
  }

  @Get('summary')
  @ApiOperation({
    summary: 'Get the concise facilitator prep/live support summary',
    description: 'DM only. Contains table-shared and facilitator-only submissions; human visibility never implies AI consent.',
  })
  async summary(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
    return this.supports.facilitatorSummary(campaignId);
  }

  @Put('me')
  @ApiOperation({
    summary: 'Create or replace your own practical support preference',
    description:
      'Any campaign member may manage only their own submission. Visibility and AI-use consent are required, independent choices.',
  })
  @ApiResponse({ status: 200, description: 'Saved preference.' })
  async upsert(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: ParticipantSupportPreferenceUpsertDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireMember(user, campaignId, { write: true });
    return this.supports.upsert(campaignId, body, user, role);
  }

  @Delete('me')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete your own support preference' })
  async remove(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser): Promise<void> {
    const role = await this.access.requireMember(user, campaignId, { write: true });
    await this.supports.removeOwn(campaignId, user, role);
  }
}
