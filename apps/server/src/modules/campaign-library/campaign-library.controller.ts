import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CampaignLibraryMonsterCreate, CampaignLibraryCollectionCreate, CampaignLibraryTagCreate, LibraryEntityType } from '@campfire/schema';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { CampaignLibraryService } from './campaign-library.service';
import { CampaignLibraryCollectionCreateDto, CampaignLibraryCollectionUpdateDto, CampaignLibraryMonsterCreateDto, CampaignLibraryMonsterUpdateDto, CampaignLibraryTagCreateDto, CampaignLibraryTagUpdateDto, LibrarySearchQueryDto } from './campaign-library.dto';

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
@Controller('campaigns/:campaignId/library')
export class CampaignLibraryTaxonomyController {
  constructor(private readonly library: CampaignLibraryService, private readonly access: CampaignAccessService) {}

  @Get('tags')
  async listTags(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    await this.access.requireMember(user, campaignId);
    return this.library.listTags(campaignId);
  }

  @Post('tags')
  async createTag(@Param('campaignId', ParseIntPipe) campaignId: number, @Body() body: CampaignLibraryTagCreateDto, @CurrentUser() user: RequestUser, @Res({ passthrough: true }) res: Response) {
    const role = await this.access.requireRole(user, campaignId, 'dm'); res.status(201);
    return this.library.createTag(campaignId, CampaignLibraryTagCreate.parse(body), user, role);
  }

  @Patch('tags/:id')
  async updateTag(@Param('campaignId', ParseIntPipe) campaignId: number, @Param('id', ParseIntPipe) id: number, @Body() body: CampaignLibraryTagUpdateDto, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.library.updateTag(campaignId, id, body, user, role);
  }

  @Delete('tags/:id')
  async removeTag(@Param('campaignId', ParseIntPipe) campaignId: number, @Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireRole(user, campaignId, 'dm'); await this.library.removeTag(campaignId, id, user, role); return { ok: true };
  }

  @Get('collections')
  async listCollections(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    await this.access.requireMember(user, campaignId);
    return this.library.listCollections(campaignId);
  }

  @Post('collections')
  async createCollection(@Param('campaignId', ParseIntPipe) campaignId: number, @Body() body: CampaignLibraryCollectionCreateDto, @CurrentUser() user: RequestUser, @Res({ passthrough: true }) res: Response) {
    const role = await this.access.requireRole(user, campaignId, 'dm'); res.status(201);
    return this.library.createCollection(campaignId, CampaignLibraryCollectionCreate.parse(body), user, role);
  }

  @Patch('collections/:id')
  async updateCollection(@Param('campaignId', ParseIntPipe) campaignId: number, @Param('id', ParseIntPipe) id: number, @Body() body: CampaignLibraryCollectionUpdateDto, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.library.updateCollection(campaignId, id, body, user, role);
  }

  @Delete('collections/:id')
  async removeCollection(@Param('campaignId', ParseIntPipe) campaignId: number, @Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireRole(user, campaignId, 'dm'); await this.library.removeCollection(campaignId, id, user, role); return { ok: true };
  }
}

@ApiTags('campaign-library')
@Controller('campaigns/:campaignId/library')
export class CampaignLibrarySearchController {
  constructor(private readonly library: CampaignLibraryService, private readonly access: CampaignAccessService) {}

  @Get('search')
  @ApiOperation({ summary: 'Search and filter the role-safe campaign library (issue #742)' })
  async search(@Param('campaignId', ParseIntPipe) campaignId: number, @Query() query: LibrarySearchQueryDto, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireMember(user, campaignId);
    return this.library.search(campaignId, role, query);
  }

  @Post('bulk')
  async bulk(@Param('campaignId', ParseIntPipe) campaignId: number, @Body() body: unknown, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.library.bulk(campaignId, body, user, role);
  }

  @Post('bulk/:operationId/undo')
  async undo(@Param('campaignId', ParseIntPipe) campaignId: number, @Param('operationId', ParseIntPipe) operationId: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.library.undoBulk(campaignId, operationId, user, role);
  }

  @Get('templates')
  async listTemplates(@Param('campaignId', ParseIntPipe) campaignId: number, @Query('archived') archived: string | undefined, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, campaignId, 'dm');
    return this.library.listTemplates(campaignId, archived === 'true');
  }

  @Post('templates')
  async saveTemplate(@Param('campaignId', ParseIntPipe) campaignId: number, @Body() body: unknown, @CurrentUser() user: RequestUser, @Res({ passthrough: true }) res: Response) {
    const role = await this.access.requireRole(user, campaignId, 'dm'); res.status(201);
    return this.library.saveTemplate(campaignId, body, user, role);
  }

  @Post('templates/:templateId/instantiate')
  async instantiateTemplate(@Param('campaignId', ParseIntPipe) campaignId: number, @Param('templateId', ParseIntPipe) templateId: number, @Body() body: unknown, @CurrentUser() user: RequestUser, @Res({ passthrough: true }) res: Response) {
    const role = await this.access.requireRole(user, campaignId, 'dm'); res.status(201);
    return this.library.instantiateTemplate(campaignId, templateId, body, user, role);
  }

  @Post('templates/:templateId/archive')
  async archiveTemplate(@Param('campaignId', ParseIntPipe) campaignId: number, @Param('templateId', ParseIntPipe) templateId: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.library.archiveTemplate(campaignId, templateId, user, role);
  }

  @Post('entities/:entityType/:entityId/duplicate')
  async duplicate(@Param('campaignId', ParseIntPipe) campaignId: number, @Param('entityType') entityType: string, @Param('entityId', ParseIntPipe) entityId: number, @Body() body: unknown, @CurrentUser() user: RequestUser, @Res({ passthrough: true }) res: Response) {
    const role = await this.access.requireRole(user, campaignId, 'dm'); res.status(201);
    return this.library.duplicateEntity(campaignId, LibraryEntityType.parse(entityType), entityId, body, user, role);
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
