import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { NotesService } from './notes.service';
import { NoteCreateDto, NoteUpdateDto, InboxCreateDto, InboxResolveDto } from './notes.dto';

@ApiTags('notes')
@Controller('campaigns/:campaignId')
export class CampaignNotesController {
  constructor(
    private readonly notes: NotesService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get('notes')
  async list(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @CurrentUser() user: RequestUser,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('mine') mine?: string,
  ) {
    const role = await this.access.requireMember(user, campaignId);
    return this.notes.listForCampaign(campaignId, user, role, {
      entityType,
      entityId: entityId !== undefined ? Number(entityId) : undefined,
      mine: mine === 'true',
    });
  }

  @Post('notes')
  async create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: NoteCreateDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireMember(user, campaignId);
    return this.notes.create(campaignId, body, user, role);
  }

  @Post('inbox')
  async createInbox(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: InboxCreateDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireMember(user, campaignId);
    return this.notes.createInbox(campaignId, body, user, role);
  }

  @Get('inbox')
  async listInbox(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, campaignId, 'dm');
    return this.notes.listInbox(campaignId);
  }
}

@ApiTags('notes')
@Controller('notes')
export class NotesController {
  constructor(
    private readonly notes: NotesService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.notes.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId);
    return this.notes.getOrThrow(id, user, role);
  }

  @Patch(':id')
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: NoteUpdateDto, @CurrentUser() user: RequestUser) {
    const row = await this.notes.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId);
    return this.notes.update(id, body, user, role);
  }

  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.notes.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId);
    return this.notes.remove(id, user, role);
  }

  @Post(':id/resolve')
  async resolve(@Param('id', ParseIntPipe) id: number, @Body() body: InboxResolveDto, @CurrentUser() user: RequestUser) {
    const row = await this.notes.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.notes.resolveInbox(id, body, user, role);
  }
}
