import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { EncounterStatus } from '@campfire/schema';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { EncountersService } from './encounters.service';
import { EncounterCreateDto, CombatantCreateDto, CombatantUpdateDto, RollRequestDto } from './encounters.dto';

@ApiTags('encounters')
@Controller('campaigns/:campaignId/encounters')
export class CampaignEncountersController {
  constructor(
    private readonly encounters: EncountersService,
    private readonly access: CampaignAccessService,
  ) {}

  @Post()
  async create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: EncounterCreateDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.encounters.create(campaignId, body, user, role);
  }

  @Get()
  async list(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Query('status') status: EncounterStatus | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireMember(user, campaignId);
    return this.encounters.listForCampaign(campaignId, status);
  }
}

@ApiTags('encounters')
@Controller('campaigns/:campaignId/roll')
export class CampaignRollController {
  constructor(
    private readonly encounters: EncountersService,
    private readonly access: CampaignAccessService,
  ) {}

  /** Any campaign member may roll dice — not gated by dm role. */
  @Post()
  async roll(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: RollRequestDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireMember(user, campaignId);
    return this.encounters.rollDiceForCampaign(campaignId, body, user, role);
  }
}

@ApiTags('encounters')
@Controller('encounters')
export class EncountersController {
  constructor(
    private readonly encounters: EncountersService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    await this.access.requireMember(user, row.campaignId);
    return this.encounters.getWithCombatantsOrThrow(id);
  }

  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    await this.encounters.remove(id, user, role);
    return { ok: true };
  }

  @Post(':id/combatants')
  async addCombatant(@Param('id', ParseIntPipe) id: number, @Body() body: CombatantCreateDto, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.encounters.addCombatant(id, body, user, role);
  }

  @Patch(':id/combatants/:cid')
  async updateCombatant(
    @Param('id', ParseIntPipe) id: number,
    @Param('cid', ParseIntPipe) cid: number,
    @Body() body: CombatantUpdateDto,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'player');
    return this.encounters.updateCombatant(id, cid, body, user, role);
  }

  @Delete(':id/combatants/:cid')
  async removeCombatant(@Param('id', ParseIntPipe) id: number, @Param('cid', ParseIntPipe) cid: number, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    await this.encounters.removeCombatant(id, cid, user, role);
    return { ok: true };
  }

  @Post(':id/roll-initiative')
  async rollInitiative(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.encounters.rollInitiative(id, user, role);
  }

  @Post(':id/start')
  async start(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.encounters.start(id, user, role);
  }

  @Post(':id/next-turn')
  async nextTurn(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.encounters.nextTurn(id, user, role);
  }

  @Post(':id/end')
  async end(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.encounters.end(id, user, role);
  }
}
