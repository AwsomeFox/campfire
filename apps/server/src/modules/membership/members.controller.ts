import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
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
  @ApiOperation({ summary: 'List campaign members', description: 'Requires campaign membership.' })
  @ApiResponse({ status: 200, description: 'Members with denormalized username/displayName.' })
  async list(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    await this.access.requireMember(user, campaignId);
    return this.members.listForCampaign(campaignId);
  }

  @Post()
  @ApiOperation({ summary: 'Add a member to a campaign', description: 'dm role required.' })
  @ApiResponse({ status: 201, description: 'Created membership.' })
  async create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: MemberCreateDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireRole(user, campaignId, 'dm');
    return this.members.create(campaignId, body, user);
  }

  @Patch(':memberId')
  @ApiOperation({ summary: "Update a member's role/character link", description: 'dm role required.' })
  @ApiResponse({ status: 200, description: 'Updated membership.' })
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
  @ApiOperation({ summary: 'Remove a member from a campaign', description: 'dm role required. Refuses to remove the last dm.' })
  @ApiResponse({ status: 204, description: 'Removed.' })
  @ApiResponse({ status: 409, description: 'Would remove the last dm of the campaign.' })
  async remove(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('memberId', ParseIntPipe) memberId: number,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireRole(user, campaignId, 'dm');
    await this.members.remove(campaignId, memberId, user);
  }
}
