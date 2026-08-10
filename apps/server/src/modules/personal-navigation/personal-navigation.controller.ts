import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { BookmarksResponse, RecentHistoryResponse } from '@campfire/schema';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { PersonalNavigationService } from './personal-navigation.service';
import { PersonalNavigationTargetDto } from './personal-navigation.dto';

/**
 * Personal navigation metadata is keyed on a real account row (FK user_id),
 * exactly like the catch-up cursor — so a dev-auth identity (`dev:<name>`, no
 * numeric id) cannot own bookmarks/recent history. Real session/PAT auth only.
 */
function numericUserId(id: string | number): number {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) {
    throw new BadRequestException('Personal navigation requires a real user account.');
  }
  return n;
}

/**
 * Parse the optional `?campaignId=` scope. Absent → undefined (no scope). A
 * present-but-invalid value is a 400 rather than silently behaving like "no
 * scope" (which would hide client bugs behind an empty list / no-op clear).
 */
function optionalCampaignId(raw: string | undefined): number | undefined {
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new BadRequestException('campaignId must be a positive integer.');
  }
  return n;
}

@ApiTags('personal-navigation')
@Controller('me/bookmarks')
export class BookmarksController {
  constructor(private readonly nav: PersonalNavigationService) {}

  @Get()
  @ApiOperation({
    summary: 'List your bookmarks',
    description:
      'Returns the authenticated user\'s private bookmarks, each with a fresh display label. ' +
      'Targets that are hidden, deleted, or no longer accessible (lost membership / cross-campaign) are filtered out at read time. ' +
      'Optional `?campaignId=` scopes the list to one campaign.',
  })
  @ApiQuery({ name: 'campaignId', required: false, type: Number, description: 'Scope to one campaign.' })
  @ApiResponse({ status: 200, description: 'Filtered bookmark list.' })
  async list(@Query('campaignId') campaignId: string | undefined, @CurrentUser() user: RequestUser): Promise<BookmarksResponse> {
    return this.nav.listBookmarks(numericUserId(user.id), user, optionalCampaignId(campaignId));
  }

  @Post()
  @ApiOperation({
    summary: 'Bookmark a campaign entity',
    description:
      'Adds a private bookmark for one supported campaign entity (quest, npc, faction, location, character, session, encounter). ' +
      'Requires campaign membership and the target must be visible to the caller\'s current role — you cannot bookmark a hidden, deleted, or cross-campaign entity. Idempotent.',
  })
  @ApiResponse({ status: 201, description: 'Bookmarked entity.' })
  @ApiResponse({ status: 403, description: 'Not a member of this campaign.' })
  @ApiResponse({ status: 404, description: 'Target entity is hidden, deleted, or not visible to your role.' })
  async add(@Body() body: PersonalNavigationTargetDto, @CurrentUser() user: RequestUser) {
    return this.nav.addBookmark(
      numericUserId(user.id),
      { campaignId: body.campaignId, entityType: body.entityType, entityId: body.entityId },
      user,
    );
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a bookmark', description: 'Deletes one of the authenticated user\'s own bookmarks.' })
  @ApiResponse({ status: 204, description: 'Bookmark removed.' })
  @ApiResponse({ status: 404, description: 'Bookmark not found (or not owned by you).' })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser): Promise<void> {
    await this.nav.removeBookmark(numericUserId(user.id), id, user);
  }
}

@ApiTags('personal-navigation')
@Controller('me/recent')
export class RecentHistoryController {
  constructor(private readonly nav: PersonalNavigationService) {}

  @Get()
  @ApiOperation({
    summary: 'List your recent history',
    description:
      'Returns the authenticated user\'s bounded recent-history (most-recent first). Targets that are hidden, deleted, or no longer accessible (lost membership / cross-campaign) are filtered out at read time. Optional `?campaignId=` scopes the list to one campaign.',
  })
  @ApiQuery({ name: 'campaignId', required: false, type: Number, description: 'Scope to one campaign.' })
  @ApiResponse({ status: 200, description: 'Filtered, bounded recent-history list.' })
  async list(@Query('campaignId') campaignId: string | undefined, @CurrentUser() user: RequestUser): Promise<RecentHistoryResponse> {
    return this.nav.listRecent(numericUserId(user.id), user, optionalCampaignId(campaignId));
  }

  @Post()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Record a recent visit',
    description:
      'Records (or refreshes) a bounded recent-history entry for one supported campaign entity. Requires membership and current visibility — never logs a visit to an inaccessible entity.',
  })
  @ApiResponse({ status: 204, description: 'Visit recorded.' })
  @ApiResponse({ status: 403, description: 'Not a member of this campaign.' })
  @ApiResponse({ status: 404, description: 'Target entity is hidden, deleted, or not visible to your role.' })
  async record(@Body() body: PersonalNavigationTargetDto, @CurrentUser() user: RequestUser): Promise<void> {
    await this.nav.recordVisit(
      numericUserId(user.id),
      { campaignId: body.campaignId, entityType: body.entityType, entityId: body.entityId },
      user,
    );
  }

  @Delete()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Clear your recent history',
    description: 'Deletes every recent-history entry for the authenticated user, or only those in one campaign when `?campaignId=` is supplied.',
  })
  @ApiQuery({ name: 'campaignId', required: false, type: Number, description: 'Scope the clear to one campaign.' })
  @ApiResponse({ status: 204, description: 'Recent history cleared.' })
  async clear(@Query('campaignId') campaignId: string | undefined, @CurrentUser() user: RequestUser): Promise<void> {
    await this.nav.clearRecent(numericUserId(user.id), user, optionalCampaignId(campaignId));
  }
}
