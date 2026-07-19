import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { RequestUser } from '../../common/user.types';
import { NpcsService } from './npcs.service';
import { NpcCreateDto, NpcUpdateDto } from './npcs.dto';

@ApiTags('npcs')
@Controller('campaigns/:campaignId/npcs')
export class CampaignNpcsController {
  constructor(private readonly npcs: NpcsService) {}

  @Get()
  list(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    return this.npcs.listForCampaign(campaignId, user.role);
  }

  @Post()
  @Roles('dm')
  create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: NpcCreateDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.npcs.create(campaignId, body, user);
  }
}

@ApiTags('npcs')
@Controller('npcs')
export class NpcsController {
  constructor(private readonly npcs: NpcsService) {}

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    return this.npcs.getOrThrow(id, user.role);
  }

  @Patch(':id')
  @Roles('dm')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: NpcUpdateDto, @CurrentUser() user: RequestUser) {
    return this.npcs.update(id, body, user);
  }

  @Delete(':id')
  @Roles('dm')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    return this.npcs.remove(id, user);
  }
}
