import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { RequestUser } from '../../common/user.types';
import { SessionsService } from './sessions.service';
import { SessionCreateDto, SessionUpdateDto } from './sessions.dto';

@ApiTags('sessions')
@Controller('campaigns/:campaignId/sessions')
export class CampaignSessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  list(@Param('campaignId', ParseIntPipe) campaignId: number) {
    return this.sessions.listForCampaign(campaignId);
  }

  @Post()
  @Roles('dm')
  create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: SessionCreateDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.sessions.create(campaignId, body, user);
  }
}

@ApiTags('sessions')
@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.sessions.getOrThrow(id);
  }

  @Patch(':id')
  @Roles('dm')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: SessionUpdateDto, @CurrentUser() user: RequestUser) {
    return this.sessions.update(id, body, user);
  }

  @Delete(':id')
  @Roles('dm')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    return this.sessions.remove(id, user);
  }
}
