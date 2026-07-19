import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
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
  async list(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    await this.access.requireMember(user, campaignId);
    return this.characters.listForCampaign(campaignId);
  }

  @Post()
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
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.characters.getRowOrThrow(id);
    await this.access.requireMember(user, row.campaignId);
    return this.characters.getOrThrow(id);
  }

  @Patch(':id')
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: CharacterUpdateDto, @CurrentUser() user: RequestUser) {
    const row = await this.characters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'player');
    return this.characters.update(id, body, user, role);
  }

  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.characters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.characters.remove(id, user, role);
  }

  @Post(':id/hp')
  async patchHp(@Param('id', ParseIntPipe) id: number, @Body() body: HpPatchDto, @CurrentUser() user: RequestUser) {
    const row = await this.characters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'player');
    return this.characters.patchHp(id, body, user, role);
  }

  @Post(':id/conditions')
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
