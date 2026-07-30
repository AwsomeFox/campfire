import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import {
  COMMENTS_REPLY_MAX_LIMIT,
  COMMENTS_THREAD_DEFAULT_LIMIT,
  COMMENTS_THREAD_MAX_LIMIT,
  EntityType,
} from '@campfire/schema';
import type { EntityType as EntityTypeValue } from '@campfire/schema';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { CommentsService } from './comments.service';
import { CommentCreateDto, CommentDto, CommentReplyPageDto, CommentThreadPageDto, CommentUpdateDto } from './comments.dto';
import { parseCommentsLimit } from './comments-pagination';

@ApiTags('comments')
@Controller('campaigns/:campaignId/comments')
export class CampaignCommentsController {
  constructor(
    private readonly comments: CommentsService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List discussion threads on an entity',
    description:
      'Requires campaign membership AND visibility of the anchored entity: a thread on a hidden quest/npc/faction or an unexplored location 404s for a non-DM, exactly as the entity itself does (issue #230). Returns a paginated page of root threads (issue #609) — each root includes a bounded reply preview so flat row paging cannot orphan replies. Oldest-first; continue with `cursor` from a previous `nextCursor`.',
  })
  @ApiQuery({ name: 'entityType', required: true, enum: EntityType.options, description: 'The entity type the thread is anchored to.' })
  @ApiQuery({ name: 'entityId', required: true, type: Number, description: 'The entity id the thread is anchored to.' })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: `Max root threads per page (default ${COMMENTS_THREAD_DEFAULT_LIMIT}, max ${COMMENTS_THREAD_MAX_LIMIT}).`,
  })
  @ApiQuery({ name: 'cursor', required: false, type: String, description: "Opaque cursor from a previous page's nextCursor." })
  @ApiResponse({ status: 200, description: 'Paginated root-thread page (`items`, `total`, `totalComments`, `hasMore`, `nextCursor`).', type: CommentThreadPageDto })
  async list(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @CurrentUser() user: RequestUser,
    @Query('entityType') entityType: string,
    @Query('entityId') entityId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const role = await this.access.requireMember(user, campaignId);
    const type = EntityType.parse(entityType) as EntityTypeValue;
    return this.comments.listThreadsForEntity(campaignId, type, Number(entityId), role, {
      limit: parseCommentsLimit(limit),
      cursor,
    });
  }

  @Get(':rootId/replies')
  @ApiOperation({
    summary: 'List additional replies for a root thread',
    description:
      'Requires campaign membership AND visibility of the anchored entity (issue #230). Returns oldest-first replies for one root thread; continue with `cursor` from a previous `nextCursor` or the inline `replyNextCursor` on a thread preview (issue #609). `entityType` + `entityId` must match the root anchor.',
  })
  @ApiQuery({ name: 'entityType', required: true, enum: EntityType.options, description: 'The entity type the thread is anchored to.' })
  @ApiQuery({ name: 'entityId', required: true, type: Number, description: 'The entity id the thread is anchored to.' })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: `Max replies per page (default ${COMMENTS_REPLY_MAX_LIMIT}, max ${COMMENTS_REPLY_MAX_LIMIT}).`,
  })
  @ApiQuery({ name: 'cursor', required: false, type: String, description: "Opaque cursor from a previous page's nextCursor." })
  @ApiResponse({ status: 200, description: 'Paginated reply page for one root (`items`, `replyCount`, `hasMore`, `nextCursor`).', type: CommentReplyPageDto })
  async listReplies(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('rootId', ParseIntPipe) rootId: number,
    @CurrentUser() user: RequestUser,
    @Query('entityType') entityType: string,
    @Query('entityId') entityId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const role = await this.access.requireMember(user, campaignId);
    const type = EntityType.parse(entityType) as EntityTypeValue;
    return this.comments.listRepliesForRoot(
      campaignId,
      type,
      Number(entityId),
      rootId,
      role,
      { limit: parseCommentsLimit(limit), cursor },
    );
  }

  @Post()
  @ApiOperation({
    summary: 'Post a comment',
    description:
      'Requires an INTERACTIVE campaign seat (issue #597) AND visibility of the anchored entity — posting on a hidden/secret entity 404s for a non-DM (issue #230). A viewer seat is read-only and is refused with 403 unless a DM has granted it the interactive-guest capability. Anchored to an entity (entityType/entityId). Optional parentId for a threaded reply. An in-character post must select characterId for a live character owned by the authenticated account; the server snapshots its safe name/avatar while preserving account author provenance (issue #787).',
  })
  @ApiResponse({ status: 201, description: 'Created comment.', type: CommentDto })
  @ApiResponse({ status: 403, description: 'Read-only (viewer) seat without the interactive-guest capability.' })
  async create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: CommentCreateDto,
    @CurrentUser() user: RequestUser,
  ) {
    // Issue #597: the read-only gate itself lives in CommentsService.create, not here.
    // requireMemberOnWritableCampaign only asserts the CAMPAIGN is writable and returns
    // a viewer unchanged — which is precisely how a documented read-only seat ended up
    // able to comment on every thread it could see. Putting the capability check in the
    // service means the MCP `post_comment` tool passes through the same gate; a
    // controller-only check would have left the agent surface open.
    const role = await this.access.requireMemberOnWritableCampaign(user, campaignId);
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
  @ApiResponse({ status: 200, description: 'Comment (body redacted if tombstoned).', type: CommentDto })
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.comments.getRowOrThrow(id, true);
    const role = await this.access.requireMember(user, row.campaignId);
    return this.comments.getOrThrow(id, role);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edit a comment',
    description:
      'Author or DM only. Requires campaign membership (write). ' +
      'A DM editing another member\'s comment is allowed (moderation) but attributed honestly (issue #783): ' +
      'the original author is preserved and the editor is recorded (editedAt/editedBy) so the body is never ' +
      'rewritten under a player who didn\'t write it. Character attribution is immutable after posting. A self-edit just bumps updatedAt.',
  })
  @ApiResponse({ status: 200, description: 'Updated comment.', type: CommentDto })
  @ApiResponse({ status: 409, description: 'STALE_WRITE with the current revision token.' })
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: CommentUpdateDto, @CurrentUser() user: RequestUser) {
    const row = await this.comments.getRowOrThrow(id);
    const role = await this.access.requireMemberOnWritableCampaign(user, row.campaignId);
    const { expectedUpdatedAt, ...fields } = body;
    return this.comments.update(id, fields, user, role, { expectedUpdatedAt });
  }

  @Get(':id/revisions')
  @ApiOperation({ summary: 'List comment edit history', description: 'Author or DM only, with normal anchor visibility checks.' })
  @ApiResponse({ status: 200, description: 'Prior comment-body snapshots, newest first.' })
  async revisions(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.comments.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId);
    return this.comments.listRevisions(id, user, role);
  }

  @Post(':id/revisions/:revisionId/restore')
  @ApiOperation({ summary: 'Restore a prior comment body', description: 'Author or DM only. The current body is first recorded, so restore is reversible.' })
  @ApiResponse({ status: 201, description: 'Restored; returns refreshed revision history.' })
  async restoreRevision(
    @Param('id', ParseIntPipe) id: number,
    @Param('revisionId', ParseIntPipe) revisionId: number,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.comments.getRowOrThrow(id);
    // Restoring a prior body is an edit by another name (issue #597) — the capability
    // gate is applied inside CommentsService.restoreRevision's update path.
    const role = await this.access.requireMemberOnWritableCampaign(user, row.campaignId);
    return this.comments.restoreRevision(id, revisionId, user, role);
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
  @ApiResponse({ status: 200, description: 'Tombstoned.', type: CommentDto })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.comments.getRowOrThrow(id, true);
    const role = await this.access.requireMemberOnWritableCampaign(user, row.campaignId);
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
  @ApiResponse({ status: 201, description: 'Restored comment.', type: CommentDto })
  async restore(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.comments.getRowOrThrow(id, true);
    const role = await this.access.requireMemberOnWritableCampaign(user, row.campaignId);
    return this.comments.restore(id, user, role);
  }
}
