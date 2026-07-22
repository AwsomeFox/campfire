import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { EntityType } from '@campfire/schema';
import type { EntityType as EntityTypeValue } from '@campfire/schema';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { parsePageParams } from '../../common/pagination';
import { CommentsService } from './comments.service';
import { CommentCreateDto, CommentUpdateDto } from './comments.dto';

/** Upper bound for `?limit` on the comment thread list. */
const COMMENTS_LIST_MAX_LIMIT = 500;

@ApiTags('comments')
@Controller('campaigns/:campaignId/comments')
export class CampaignCommentsController {
  constructor(
    private readonly comments: CommentsService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List comments on an entity',
    description:
      'Requires campaign membership AND visibility of the anchored entity: a thread on a hidden quest/npc/faction or an unexplored location 404s for a non-DM, exactly as the entity itself does (issue #230). Returns the discussion thread for one entity (entityType + entityId), oldest-first; comments are then visible to every member who can see the entity.',
  })
  @ApiQuery({ name: 'entityType', required: true, enum: ['quest', 'npc', 'location', 'session', 'character', 'campaign'], description: 'The entity type the thread is anchored to.' })
  @ApiQuery({ name: 'entityId', required: true, type: Number, description: 'The entity id the thread is anchored to.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max comments to return (default: all, capped at 500).' })
  @ApiQuery({ name: 'offset', required: false, type: Number, description: 'Comments to skip, for paging (default 0).' })
  @ApiResponse({ status: 200, description: 'The comment thread for the entity.' })
  async list(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @CurrentUser() user: RequestUser,
    @Query('entityType') entityType: string,
    @Query('entityId') entityId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const role = await this.access.requireMember(user, campaignId);
    const type = EntityType.parse(entityType) as EntityTypeValue;
    const page = parsePageParams({ limit, offset }, COMMENTS_LIST_MAX_LIMIT);
    return this.comments.listForEntity(campaignId, type, Number(entityId), role, page);
  }

  @Post()
  @ApiOperation({
    summary: 'Post a comment',
    description:
      'Requires campaign membership (write) AND visibility of the anchored entity — posting on a hidden/secret entity 404s for a non-DM (issue #230). Anchored to an entity (entityType/entityId). Optional parentId for a threaded reply and inCharacter flag for a play-by-post scene.',
  })
  @ApiResponse({ status: 201, description: 'Created comment.' })
  async create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: CommentCreateDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireMember(user, campaignId, { write: true });
    return this.comments.create(campaignId, body, user, role);
  }
}

@ApiTags('comments')
@Controller('comments')
export class CommentsController {
  constructor(
    private readonly comments: CommentsService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get(':id')
  @ApiOperation({
    summary: 'Get a comment',
    description:
      'Requires campaign membership. A tombstoned comment (issue #503) is returned as a redacted "[deleted]" ' +
      'placeholder rather than 404 — the row stays so replies keep their parent. Requires membership.',
  })
  @ApiResponse({ status: 200, description: 'Comment (body redacted if tombstoned).' })
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.comments.getRowOrThrow(id, true);
    const role = await this.access.requireMember(user, row.campaignId);
    return this.comments.getOrThrow(id, role);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit a comment', description: 'Author or DM only. Requires campaign membership (write).' })
  @ApiResponse({ status: 200, description: 'Updated comment.' })
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: CommentUpdateDto, @CurrentUser() user: RequestUser) {
    const row = await this.comments.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId, { write: true });
    return this.comments.update(id, body, user, role);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a comment (tombstone)',
    description:
      'Author or DM only. Requires campaign membership (write). Soft-deletes (tombstones) the comment: ' +
      'its body is redacted to "[deleted]" but the row remains, so replies keep their parent and the thread ' +
      'topology is preserved (issue #503 — a root author must not destroy other members\' replies). ' +
      'Reversible via POST /comments/:id/restore. The deletedAt/deletedBy fields are set on the returned shape.',
  })
  @ApiResponse({ status: 200, description: 'Tombstoned.' })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.comments.getRowOrThrow(id, true);
    const role = await this.access.requireMember(user, row.campaignId, { write: true });
    return this.comments.remove(id, user, role);
  }

  @Post(':id/restore')
  @ApiOperation({
    summary: 'Restore a tombstoned comment',
    description:
      'Author or DM only. Requires campaign membership (write). Undoes a soft-delete (issue #503): clears ' +
      'deletedAt/deletedBy and returns the comment with its original body. 404 if the comment is not currently ' +
      'tombstoned. Mirrors the notes restore() authorization so a DM can reverse a moderation and the author ' +
      'can reverse their own soft-delete.',
  })
  @ApiResponse({ status: 201, description: 'Restored comment.' })
  async restore(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.comments.getRowOrThrow(id, true);
    const role = await this.access.requireMember(user, row.campaignId, { write: true });
    return this.comments.restore(id, user, role);
  }
}
