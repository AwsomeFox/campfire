import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { CampaignsService } from './campaigns.service';
import { CampaignCreateDto, CampaignUpdateDto } from './campaigns.dto';

@ApiTags('campaigns')
@Controller('campaigns')
export class CampaignsController {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List campaigns accessible to the caller', description: 'Server admins and dev-auth users see all campaigns; everyone else sees campaigns they are a member of (capped further by an active token\'s campaignId, if scoped).' })
  @ApiResponse({ status: 200, description: 'Accessible campaigns.' })
  list(@CurrentUser() user: RequestUser) {
    return this.campaigns.listForUser(user);
  }

  @Post()
  @ApiOperation({ summary: 'Create a campaign', description: 'Any authenticated user may create a campaign; the creator becomes its dm.' })
  @ApiResponse({ status: 201, description: 'Created campaign.' })
  create(@Body() body: CampaignCreateDto, @CurrentUser() user: RequestUser) {
    return this.campaigns.create(body, user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a campaign', description: 'Requires campaign membership.' })
  @ApiResponse({ status: 200, description: 'Campaign.' })
  @ApiResponse({ status: 403, description: 'Not a member of this campaign.' })
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    await this.access.requireMember(user, id);
    return this.campaigns.getOrThrow(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a campaign', description: 'dm role required.' })
  @ApiResponse({ status: 200, description: 'Updated campaign.' })
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: CampaignUpdateDto, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, id, 'dm');
    return this.campaigns.update(id, body, user);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a campaign', description: 'dm role required.' })
  @ApiResponse({ status: 200, description: 'Deleted.' })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, id, 'dm');
    return this.campaigns.remove(id, user);
  }

  @Get(':id/summary')
  @ApiOperation({ summary: 'Campaign dashboard/AI-primer summary', description: 'Aggregates campaign metadata, current location, quests (with objectives), npcs, locations, characters, and sessions in one call — intended for dashboards and as an LLM context primer. Requires campaign membership.' })
  @ApiResponse({ status: 200, description: 'Aggregate campaign summary.' })
  async summary(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireMember(user, id);
    return this.campaigns.summary(id, role);
  }
}
