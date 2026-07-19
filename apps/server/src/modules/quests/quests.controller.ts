import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { RequestUser } from '../../common/user.types';
import { QuestsService } from './quests.service';
import {
  QuestCreateDto,
  QuestUpdateDto,
  QuestStatusPatchDto,
  ObjectiveCreateDto,
  ObjectivePatchDto,
} from './quests.dto';

@ApiTags('quests')
@Controller('campaigns/:campaignId/quests')
export class CampaignQuestsController {
  constructor(private readonly quests: QuestsService) {}

  @Get()
  list(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Query('status') status: string | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    return this.quests.listForCampaignByStatus(campaignId, status, user.role);
  }

  @Post()
  @Roles('dm')
  create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: QuestCreateDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.quests.create(campaignId, body, user);
  }
}

@ApiTags('quests')
@Controller('quests')
export class QuestsController {
  constructor(private readonly quests: QuestsService) {}

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    return this.quests.getWithObjectivesOrThrow(id, user.role);
  }

  @Patch(':id')
  @Roles('dm')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: QuestUpdateDto, @CurrentUser() user: RequestUser) {
    return this.quests.update(id, body, user);
  }

  @Delete(':id')
  @Roles('dm')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    return this.quests.remove(id, user);
  }

  @Post(':id/status')
  @Roles('dm')
  setStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: QuestStatusPatchDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.quests.setStatus(id, body, user);
  }

  @Post(':id/objectives')
  @Roles('dm')
  addObjective(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ObjectiveCreateDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.quests.addObjective(id, body, user);
  }

  @Patch(':id/objectives/:oid')
  @Roles('player')
  patchObjective(
    @Param('id', ParseIntPipe) id: number,
    @Param('oid', ParseIntPipe) oid: number,
    @Body() body: ObjectivePatchDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.quests.patchObjective(id, oid, body, user);
  }

  @Delete(':id/objectives/:oid')
  @Roles('dm')
  removeObjective(
    @Param('id', ParseIntPipe) id: number,
    @Param('oid', ParseIntPipe) oid: number,
    @CurrentUser() user: RequestUser,
  ) {
    return this.quests.removeObjective(id, oid, user);
  }
}
