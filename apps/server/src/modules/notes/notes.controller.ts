import { BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { NoteVisibility, NOTES_LIST_DEFAULT_LIMIT, NOTES_LIST_MAX_LIMIT } from '@campfire/schema';
import type { NoteVisibility as NoteVisibilityType } from '@campfire/schema';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { clampNotesListLimit } from './notes-pagination';
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
  @ApiOperation({
    summary: 'List notes in a campaign',
    description:
      'Requires campaign membership. private notes are only visible to their author (or a dm); ' +
      'dm_shared only to dm; party_shared to all members. Returns a paginated page ' +
      '(`items`, `total`, `hasMore`, `nextCursor` (null when exhausted)) — default page size ' +
      `${NOTES_LIST_DEFAULT_LIMIT}, max ${NOTES_LIST_MAX_LIMIT}. Newest first; continue with cursor ` +
      'from a previous nextCursor (issue #608).',
  })
  @ApiQuery({ name: 'entityType', required: false, enum: ['quest', 'npc', 'location', 'session', 'character', 'campaign'], description: 'Filter to notes attached to this entity type.' })
  @ApiQuery({ name: 'entityId', required: false, type: Number, description: 'Filter to notes attached to this specific entity id (used together with entityType).' })
  @ApiQuery({ name: 'mine', required: false, type: Boolean, description: 'If true, only notes authored by the caller.' })
  @ApiQuery({
    name: 'visibility',
    required: false,
    enum: ['private', 'dm_shared', 'party_shared', 'whisper'],
    description: 'Filter to a single visibility (still visibility-gated to what the caller can see).',
  })
  @ApiQuery({ name: 'q', required: false, type: String, description: 'Free-text search: only notes whose body contains this string (case-insensitive).' })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: `Page size (default ${NOTES_LIST_DEFAULT_LIMIT}, max ${NOTES_LIST_MAX_LIMIT}).`,
  })
  @ApiQuery({ name: 'cursor', required: false, description: "Opaque cursor from a previous page's nextCursor." })
  @ApiResponse({ status: 200, description: 'Paginated notes visible to the caller (`items`, `total`, `hasMore`, `nextCursor` (null when exhausted)).' })
  async list(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @CurrentUser() user: RequestUser,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('mine') mine?: string,
    @Query('visibility') visibility?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const role = await this.access.requireMember(user, campaignId);
    return this.notes.listForCampaign(campaignId, user, role, {
      entityType,
      entityId: entityId !== undefined ? Number(entityId) : undefined,
      mine: mine === 'true',
      visibility: parseVisibility(visibility),
      q,
      limit: parseLimit(limit),
      cursor,
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
  @ApiOperation({
    summary: 'List inbox items',
    description:
      'dm role required. Defaults to open (unresolved) items; pass resolved=true for the resolved history ' +
      '(newest resolution first), including any entity link each item was resolved into. Returns a paginated ' +
      `page (items, total, hasMore, nextCursor (null when exhausted)) — default page size ${NOTES_LIST_DEFAULT_LIMIT}, ` +
      `max ${NOTES_LIST_MAX_LIMIT}. Newest first (issue #608).`,
  })
  @ApiQuery({ name: 'resolved', required: false, type: Boolean, description: 'If true, list resolved items instead of open ones.' })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: `Page size (default ${NOTES_LIST_DEFAULT_LIMIT}, max ${NOTES_LIST_MAX_LIMIT}).`,
  })
  @ApiQuery({ name: 'cursor', required: false, description: "Opaque cursor from a previous page's nextCursor." })
  @ApiResponse({ status: 200, description: 'Paginated inbox items (`items`, `total`, `hasMore`, `nextCursor` (null when exhausted)).' })
  async listInbox(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @CurrentUser() user: RequestUser,
    @Query('resolved') resolved?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    // allowArchived: listing the inbox is a read — fine on an archived campaign.
    await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
    return this.notes.listInbox(campaignId, resolved === 'true', {
      limit: parseLimit(limit),
      cursor,
    });
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
    // Split off the optimistic-concurrency guard (#157) from the entity fields.
    const { expectedUpdatedAt, ...fields } = body;
    return this.notes.update(id, fields, user, role, { expectedUpdatedAt });
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a note', description: 'Requires campaign membership and note-visibility/ownership access.' })
  @ApiResponse({ status: 200, description: 'Deleted.' })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.notes.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId, { write: true });
    return this.notes.remove(id, user, role);
  }

  @Post(':id/restore')
  @ApiOperation({ summary: 'Restore a trashed note', description: 'Requires membership + author ownership. Undo a soft-delete (issue #116) — the note returns exactly as it was.' })
  @ApiResponse({ status: 201, description: 'Restored note.' })
  async restore(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.notes.getRowOrThrow(id, true);
    const role = await this.access.requireMember(user, row.campaignId, { write: true });
    return this.notes.restore(id, user, role);
  }

  @Post(':id/resolve')
  @ApiOperation({
    summary: 'Resolve an inbox item',
    description:
      'dm role required. Optionally link the entity the item became (entityType + entityId, provided together) — surfaced in the resolved history. The terminal payload (resolvedNote, entityType, entityId) is idempotent: an identical retry returns the existing result; a different terminal payload conflicts.',
  })
  @ApiResponse({ status: 201, description: 'Resolved inbox item, or the existing identical terminal result.' })
  @ApiResponse({ status: 409, description: 'The inbox item already has a different terminal result.' })
  async resolve(@Param('id', ParseIntPipe) id: number, @Body() body: InboxResolveDto, @CurrentUser() user: RequestUser) {
    const row = await this.notes.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.notes.resolveInbox(id, body, user, role);
  }
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new BadRequestException('`limit` must be a positive integer');
  }
  return clampNotesListLimit(n);
}

function parseVisibility(raw: string | undefined): NoteVisibilityType | undefined {
  if (raw === undefined || raw === '') return undefined;
  const parsed = NoteVisibility.safeParse(raw);
  if (!parsed.success) {
    throw new BadRequestException(
      '`visibility` must be one of private, dm_shared, party_shared, whisper',
    );
  }
  return parsed.data;
}
