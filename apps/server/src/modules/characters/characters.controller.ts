import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { CharactersService } from './characters.service';
import { CharacterCreateDto, CharacterUpdateDto, HpPatchDto, ConditionsPatchDto } from './characters.dto';

@ApiTags('characters')
@Controller('campaigns/:campaignId/characters')
export class CampaignCharactersController {
  constructor(
    private readonly characters: CharactersService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List characters in a campaign', description: 'Requires campaign membership. dmSecret is stripped for non-dm.' })
  @ApiResponse({ status: 200, description: 'Characters in the campaign.' })
  async list(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireMember(user, campaignId);
    return this.characters.listForCampaign(campaignId, role);
  }

  @Post()
  @ApiOperation({ summary: 'Create a character', description: 'player role required. Players creating their own character get ownerUserId set automatically; a dm may set ownerUserId explicitly to create on behalf of another player.' })
  @ApiResponse({ status: 201, description: 'Created character.' })
  async create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: CharacterCreateDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'player');
    return this.characters.create(campaignId, body, user, role);
  }
}

@ApiTags('characters')
@Controller('characters')
export class CharactersController {
  constructor(
    private readonly characters: CharactersService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get(':id')
  @ApiOperation({ summary: 'Get a character', description: 'Requires campaign membership. dmSecret is stripped for non-dm.' })
  @ApiResponse({ status: 200, description: 'Character.' })
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.characters.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId);
    return this.characters.getOrThrow(id, role);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a character', description: 'dm or the owning player may write; other players get 403. dmSecret is dm-writable only (silently ignored for the owning player).' })
  @ApiResponse({ status: 200, description: 'Updated character.' })
  @ApiResponse({ status: 403, description: 'Not the dm or owning player.' })
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: CharacterUpdateDto, @CurrentUser() user: RequestUser) {
    const row = await this.characters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'player');
    return this.characters.update(id, body, user, role);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a character', description: 'dm role required.' })
  @ApiResponse({ status: 200, description: 'Deleted.' })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.characters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.characters.remove(id, user, role);
  }

  @Post(':id/hp')
  @ApiOperation({ summary: 'Adjust character HP', description: 'dm or the owning player. Body is a union: { delta } (relative) or { set } (absolute); result is clamped to [0, hpMax].' })
  @ApiResponse({ status: 201, description: 'Updated character.' })
  async patchHp(@Param('id', ParseIntPipe) id: number, @Body() body: HpPatchDto, @CurrentUser() user: RequestUser) {
    const row = await this.characters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'player');
    return this.characters.patchHp(id, body, user, role);
  }

  @Post(':id/conditions')
  @ApiOperation({ summary: 'Add/remove character conditions', description: 'dm or the owning player.' })
  @ApiResponse({ status: 201, description: 'Updated character.' })
  async patchConditions(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ConditionsPatchDto,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.characters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'player');
    return this.characters.patchConditions(id, body, user, role);
  }
}
