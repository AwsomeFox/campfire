import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { SearchService } from './search.service';

/**
 * Campaign-wide search + @-mention link targets (issue #64). Both routes require
 * campaign membership; results are scoped to the caller's role by the underlying
 * entity services (hidden entities dropped, dmSecret redacted — see SearchService).
 */
@ApiTags('search')
@Controller('campaigns/:campaignId')
export class SearchController {
  constructor(
    private readonly search: SearchService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get('search')
  @ApiOperation({
    summary: 'Search across a campaign',
    description:
      'Free-text search over quests, NPCs, locations, characters, sessions and notes. Requires campaign membership; hidden entities and dmSecret are never returned to non-DM.',
  })
  @ApiQuery({ name: 'q', required: false, description: 'Free-text query. Empty returns no results.' })
  @ApiResponse({ status: 200, description: 'Matching results across the campaign.' })
  async searchCampaign(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Query('q') q: string | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireMember(user, campaignId);
    return this.search.search(campaignId, user, role, q ?? '');
  }

  @Get('mentions')
  @ApiOperation({
    summary: 'List @-mention link targets',
    description:
      'The named entities (quests/NPCs/locations/characters/sessions) the caller may link to — used by the @-mention picker and Markdown auto-linking. Role-filtered like every other read.',
  })
  @ApiResponse({ status: 200, description: 'Linkable entities visible to the caller.' })
  async mentions(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireMember(user, campaignId);
    return this.search.mentions(campaignId, role);
  }
}
