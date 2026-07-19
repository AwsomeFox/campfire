import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { RequestUser } from '../../common/user.types';
import { CharactersService } from './characters.service';
import { CharacterCreateDto, CharacterUpdateDto, HpPatchDto, ConditionsPatchDto } from './characters.dto';

@ApiTags('characters')
@Controller('campaigns/:campaignId/characters')
export class CampaignCharactersController {
  constructor(private readonly characters: CharactersService) {}

  @Get()
  list(@Param('campaignId', ParseIntPipe) campaignId: number) {
    return this.characters.listForCampaign(campaignId);
  }

  @Post()
  @Roles('player')
  create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: CharacterCreateDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.characters.create(campaignId, body, user);
  }
}

@ApiTags('characters')
@Controller('characters')
export class CharactersController {
  constructor(private readonly characters: CharactersService) {}

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.characters.getOrThrow(id);
  }

  @Patch(':id')
  @Roles('player')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: CharacterUpdateDto, @CurrentUser() user: RequestUser) {
    return this.characters.update(id, body, user);
  }

  @Delete(':id')
  @Roles('dm')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    return this.characters.remove(id, user);
  }

  @Post(':id/hp')
  @Roles('player')
  patchHp(@Param('id', ParseIntPipe) id: number, @Body() body: HpPatchDto, @CurrentUser() user: RequestUser) {
    return this.characters.patchHp(id, body, user);
  }

  @Post(':id/conditions')
  @Roles('player')
  patchConditions(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ConditionsPatchDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.characters.patchConditions(id, body, user);
  }
}
