import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { parsePageParams } from '../../common/pagination';
import { NotesService } from './notes.service';
import { NoteCreateDto, NoteUpdateDto, InboxCreateDto, InboxResolveDto } from './notes.dto';

/** Upper bound for `?limit` on the notes and inbox lists (issue #71). */
const NOTES_LIST_MAX_LIMIT = 200;

@ApiTags('notes')
@Controller('campaigns/:campaignId')
export class CampaignNotesController {
  constructor(
    private readonly notes: NotesService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get('notes')
  @ApiOperation({ summary: 'List notes in a campaign', description: 'Requires campaign membership. private notes are only visible to their author (or a dm); dm_shared only to dm; party_shared to all members.' })
  @ApiQuery({ name: 'entityType', required: false, enum: ['quest', 'npc', 'location', 'session', 'character', 'campaign'], description: 'Filter to notes attached to this entity type.' })
  @ApiQuery({ name: 'entityId', required: false, type: Number, description: 'Filter to notes attached to this specific entity id (used together with entityType).' })
  @ApiQuery({ name: 'mine', required: false, type: Boolean, description: 'If true, only notes authored by the caller.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max notes to return (default: all, capped at 200).' })
  @ApiQuery({ name: 'offset', required: false, type: Number, description: 'Notes to skip, for paging (default 0).' })
  @ApiResponse({ status: 200, description: 'Notes visible to the caller, per the visibility rules above.' })
  async list(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @CurrentUser() user: RequestUser,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('mine') mine?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const role = await this.access.requireMember(user, campaignId);
    const page = parsePageParams({ limit, offset }, NOTES_LIST_MAX_LIMIT);
    return this.notes.listForCampaign(campaignId, user, role, {
      entityType,
      entityId: entityId !== undefined ? Number(entityId) : undefined,
      mine: mine === 'true',
      limit: page.limit,
      offset: page.offset,
    });
  }

  @Post('notes')
  @ApiOperation({ summary: 'Create a note', description: 'Requires campaign membership. Optionally attached to an entity (entityType/entityId) with a visibility (private/dm_shared/party_shared).' })
  @ApiResponse({ status: 201, description: 'Created note.' })
  async create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: NoteCreateDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireMember(user, campaignId, { write: true });
    return this.notes.create(campaignId, body, user, role);
  }

  @Post('inbox')
  @ApiOperation({ summary: 'Submit an inbox item', description: 'Requires campaign membership. Inbox items are dm-facing suggestions/questions, distinct from regular notes.' })
  @ApiResponse({ status: 201, description: 'Created inbox item.' })
  async createInbox(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: InboxCreateDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireMember(user, campaignId, { write: true });
    return this.notes.createInbox(campaignId, body, user, role);
  }

  @Get('inbox')
  @ApiOperation({ summary: 'List inbox items', description: 'dm role required. Defaults to open (unresolved) items; pass resolved=true for the resolved history (newest resolution first), including any entity link each item was resolved into.' })
  @ApiQuery({ name: 'resolved', required: false, type: Boolean, description: 'If true, list resolved items instead of open ones.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max inbox items to return (default: all, capped at 200).' })
  @ApiQuery({ name: 'offset', required: false, type: Number, description: 'Inbox items to skip, for paging (default 0).' })
  @ApiResponse({ status: 200, description: 'Inbox items.' })
  async listInbox(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @CurrentUser() user: RequestUser,
    @Query('resolved') resolved?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    // allowArchived: listing the inbox is a read — fine on an archived campaign.
    await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
    return this.notes.listInbox(campaignId, resolved === 'true', parsePageParams({ limit, offset }, NOTES_LIST_MAX_LIMIT));
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
  @ApiOperation({ summary: 'Get a note', description: 'Requires campaign membership and note-visibility access.' })
  @ApiResponse({ status: 200, description: 'Note.' })
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.notes.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId);
    return this.notes.getOrThrow(id, user, role);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a note', description: 'Requires campaign membership and note-visibility/ownership access.' })
  @ApiResponse({ status: 200, description: 'Updated note.' })
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: NoteUpdateDto, @CurrentUser() user: RequestUser) {
    const row = await this.notes.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId, { write: true });
    return this.notes.update(id, body, user, role);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a note', description: 'Requires campaign membership and note-visibility/ownership access.' })
  @ApiResponse({ status: 200, description: 'Deleted.' })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.notes.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId, { write: true });
    return this.notes.remove(id, user, role);
  }

  @Post(':id/resolve')
  @ApiOperation({ summary: 'Resolve an inbox item', description: 'dm role required. Optionally link the entity the item became (entityType + entityId, provided together) — surfaced in the resolved history.' })
  @ApiResponse({ status: 201, description: 'Resolved inbox item.' })
  async resolve(@Param('id', ParseIntPipe) id: number, @Body() body: InboxResolveDto, @CurrentUser() user: RequestUser) {
    const row = await this.notes.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.notes.resolveInbox(id, body, user, role);
  }
}
