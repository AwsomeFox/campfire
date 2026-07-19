import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from './campaign-access.service';
import { MembersService } from './members.service';
import { MemberCreateDto, MemberUpdateDto } from './members.dto';

@ApiTags('members')
@Controller('campaigns/:campaignId/members')
export class MembersController {
  constructor(
    private readonly members: MembersService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  async list(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    await this.access.requireMember(user, campaignId);
    return this.members.listForCampaign(campaignId);
  }

  @Post()
  async create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: MemberCreateDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireRole(user, campaignId, 'dm');
    return this.members.create(campaignId, body, user);
  }

  @Patch(':memberId')
  async update(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('memberId', ParseIntPipe) memberId: number,
    @Body() body: MemberUpdateDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireRole(user, campaignId, 'dm');
    return this.members.update(campaignId, memberId, body, user);
  }

  @Delete(':memberId')
  @HttpCode(204)
  async remove(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('memberId', ParseIntPipe) memberId: number,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireRole(user, campaignId, 'dm');
    await this.members.remove(campaignId, memberId, user);
  }
}
