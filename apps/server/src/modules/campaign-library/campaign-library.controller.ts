import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CampaignLibraryMonsterCreate } from '@campfire/schema';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { CampaignLibraryService } from './campaign-library.service';
import { CampaignLibraryMonsterCreateDto, CampaignLibraryMonsterUpdateDto } from './campaign-library.dto';

@ApiTags('campaign-library')
@Controller('campaigns/:campaignId/library/monsters')
export class CampaignLibraryController {
  constructor(
    private readonly library: CampaignLibraryService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List campaign library monsters (issue #425)' })
  @ApiResponse({ status: 200, description: 'Homebrew monsters saved for reuse.' })
  async list(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    await this.access.requireMember(user, campaignId);
    return this.library.listForCampaign(campaignId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a campaign library monster (issue #425)' })
  @ApiResponse({ status: 201, description: 'Created library entry.' })
  async create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: CampaignLibraryMonsterCreateDto,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    res.status(201);
    return this.library.create(campaignId, CampaignLibraryMonsterCreate.parse(body), user, role);
  }

  @Post(':id/clone')
  @ApiOperation({ summary: 'Clone a library monster under a new name (issue #425)' })
  @ApiResponse({ status: 201, description: 'Cloned library entry.' })
  async clone(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('id', ParseIntPipe) id: number,
    @Query('name') name: string,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    res.status(201);
    return this.library.clone(id, name ?? '', user, role, campaignId);
  }
}

@ApiTags('campaign-library')
@Controller('library/monsters')
export class LibraryMonstersController {
  constructor(
    private readonly library: CampaignLibraryService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get(':id')
  @ApiOperation({ summary: 'Get a campaign library monster (issue #425)' })
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.library.getRowOrThrow(id);
    await this.access.requireMember(user, row.campaignId);
    return this.library.getOrThrow(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a campaign library monster (issue #425)' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: CampaignLibraryMonsterUpdateDto,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.library.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.library.update(id, body, user, role, row.campaignId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a campaign library monster (issue #425)' })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.library.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    await this.library.remove(id, user, role, row.campaignId);
    return { ok: true };
  }
}
