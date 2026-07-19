import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { RequestUser } from '../../common/user.types';
import { NotesService } from './notes.service';
import { NoteCreateDto, NoteUpdateDto, InboxCreateDto, InboxResolveDto } from './notes.dto';

@ApiTags('notes')
@Controller('campaigns/:campaignId')
export class CampaignNotesController {
  constructor(private readonly notes: NotesService) {}

  @Get('notes')
  list(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @CurrentUser() user: RequestUser,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('mine') mine?: string,
  ) {
    return this.notes.listForCampaign(campaignId, user, {
      entityType,
      entityId: entityId !== undefined ? Number(entityId) : undefined,
      mine: mine === 'true',
    });
  }

  @Post('notes')
  create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: NoteCreateDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.notes.create(campaignId, body, user);
  }

  @Post('inbox')
  createInbox(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: InboxCreateDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.notes.createInbox(campaignId, body, user);
  }

  @Get('inbox')
  @Roles('dm')
  listInbox(@Param('campaignId', ParseIntPipe) campaignId: number) {
    return this.notes.listInbox(campaignId);
  }
}

@ApiTags('notes')
@Controller('notes')
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    return this.notes.getOrThrow(id, user);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: NoteUpdateDto, @CurrentUser() user: RequestUser) {
    return this.notes.update(id, body, user);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    return this.notes.remove(id, user);
  }

  @Post(':id/resolve')
  @Roles('dm')
  resolve(@Param('id', ParseIntPipe) id: number, @Body() body: InboxResolveDto, @CurrentUser() user: RequestUser) {
    return this.notes.resolveInbox(id, body, user);
  }
}
