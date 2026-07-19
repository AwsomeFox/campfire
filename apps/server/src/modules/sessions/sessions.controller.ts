import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { SessionsService } from './sessions.service';
import { SessionCreateDto, SessionUpdateDto } from './sessions.dto';

@ApiTags('sessions')
@Controller('campaigns/:campaignId/sessions')
export class CampaignSessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  async list(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    await this.access.requireMember(user, campaignId);
    return this.sessions.listForCampaign(campaignId);
  }

  @Post()
  async create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: SessionCreateDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.sessions.create(campaignId, body, user, role);
  }
}

@ApiTags('sessions')
@Controller('sessions')
export class SessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.sessions.getRowOrThrow(id);
    await this.access.requireMember(user, row.campaignId);
    return this.sessions.getOrThrow(id);
  }

  @Patch(':id')
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: SessionUpdateDto, @CurrentUser() user: RequestUser) {
    const row = await this.sessions.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.sessions.update(id, body, user, role);
  }

  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.sessions.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.sessions.remove(id, user, role);
  }
}
