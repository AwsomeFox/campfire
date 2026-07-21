import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import type { EncounterStatus } from '@campfire/schema';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { EncountersService } from './encounters.service';
import { EncounterCreateDto, EncounterUpdateDto, CombatantCreateDto, CombatantUpdateDto, RollRequestDto, MapPingDto } from './encounters.dto';

@ApiTags('encounters')
@Controller('campaigns/:campaignId/encounters')
export class CampaignEncountersController {
  constructor(
    private readonly encounters: EncountersService,
    private readonly access: CampaignAccessService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create an encounter', description: 'dm role required. Auto-adds the campaign party as combatants, with initMod derived from each character\'s DEX.' })
  @ApiResponse({ status: 201, description: 'Created encounter, with initial combatants.' })
  async create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: EncounterCreateDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.encounters.create(campaignId, body, user, role);
  }

  @Get()
  @ApiOperation({ summary: 'List encounters in a campaign', description: 'Requires campaign membership.' })
  @ApiQuery({ name: 'status', required: false, enum: ['preparing', 'running', 'ended'], description: 'Filter to a single encounter status.' })
  @ApiResponse({ status: 200, description: 'Encounters in the campaign.' })
  async list(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Query('status') status: EncounterStatus | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    // The caller's role drives entity-level secrecy (issue #262): a non-DM never sees a
    // hidden (prepared, not-yet-sprung) encounter in the list.
    const role = await this.access.requireMember(user, campaignId);
    return this.encounters.listForCampaign(campaignId, status, role);
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
  @ApiOperation({
    summary: 'Roll dice',
    description:
      'Any campaign member. `expr` is a restricted NdM(+/-K) expression, e.g. "1d20+3". The roll is persisted to the campaign-shared dice log (see GET /campaigns/:id/rolls).',
  })
  @ApiResponse({ status: 201, description: 'Persisted roll (individual dice + total + roller identity).' })
  @ApiResponse({ status: 400, description: 'Malformed dice expression.' })
  async roll(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: RollRequestDto,
    @CurrentUser() user: RequestUser,
  ) {
    // write: rolls are audited activity — an archived (read-only) campaign takes no new rolls.
    const role = await this.access.requireMember(user, campaignId, { write: true });
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
  @ApiOperation({ summary: 'Get an encounter with its combatants', description: 'Requires campaign membership.' })
  @ApiResponse({ status: 200, description: 'Encounter with combatants.' })
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    // The caller's role drives issue #43 redaction: a non-DM viewer gets monster
    // HP as a coarse band, never exact numbers.
    const role = await this.access.requireMember(user, row.campaignId);
    return this.encounters.getWithCombatantsOrThrow(id, role);
  }

  @Get(':id/difficulty')
  @ApiOperation({
    summary: 'Estimate encounter difficulty (5e XP budget)',
    description:
      'Requires campaign membership. Read-only: computes an Easy/Medium/Hard/Deadly band from the party PCs\' levels vs the combatant monsters\' CRs (issue #58). No state change.',
  })
  @ApiResponse({ status: 200, description: 'Difficulty band with the party thresholds and adjusted monster XP.' })
  async difficulty(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    // The caller's role gates entity-level secrecy (issue #262): a hidden encounter's
    // difficulty is DM-only prep, denied (404) to a non-DM like its roster.
    const role = await this.access.requireMember(user, row.campaignId);
    return this.encounters.getDifficulty(id, role);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update an encounter',
    description: "dm role required. Edit the name, attach/clear a location/quest/session link (issue #126), and/or attach/clear the battle map via mapAttachmentId (issue #39).",
  })
  @ApiResponse({ status: 200, description: 'Updated encounter with combatants.' })
  @ApiResponse({ status: 400, description: 'mapAttachmentId does not exist in this campaign.' })
  @ApiResponse({ status: 404, description: 'A linked location/quest/session id is not in this encounter\'s campaign.' })
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: EncounterUpdateDto, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.encounters.updateEncounter(id, body, user, role);
  }

  @Post(':id/ping')
  @ApiOperation({
    summary: 'Broadcast a transient battle-map ping (issue #238)',
    description:
      'Requires campaign write membership (any DM or player — a live table gesture, not DM-gated ' +
      'like fog). Emits a one-shot `encounter.ping` SSE signal carrying the click location so every ' +
      'open client can flash a marker; nothing is persisted. x/y are 0–100 percent of the map surface.',
  })
  @ApiResponse({ status: 201, description: 'Ping broadcast.' })
  async ping(@Param('id', ParseIntPipe) id: number, @Body() body: MapPingDto, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    await this.access.requireMember(user, row.campaignId, { write: true });
    this.encounters.pingMap(id, row.campaignId, body);
    return { ok: true };
  }

  @Get(':id/events')
  @ApiOperation({
    summary: "List an encounter's persistent combat log",
    description:
      'Requires campaign membership. Chronological per-encounter event history (damage/heal, conditions, deaths, turns) that survives reload — issue #61. Member-visible; details record only HP deltas, never a monster’s exact HP totals.',
  })
  @ApiResponse({ status: 200, description: 'Encounter events in chronological order.' })
  async events(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId);
    return this.encounters.listEvents(id, role);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an encounter', description: 'dm role required.' })
  @ApiResponse({ status: 200, description: 'Deleted.' })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    await this.encounters.remove(id, user, role);
    return { ok: true };
  }

  @Post(':id/combatants')
  @ApiOperation({ summary: 'Add a combatant', description: 'dm role required. Name/HP may be resolved from a linked ruleEntryId (monster) or an existing characterId, or supplied directly.' })
  @ApiResponse({ status: 201, description: 'Created combatant.' })
  @ApiResponse({ status: 400, description: 'Combatant is unresolvable (no name, no ruleEntryId, no hpMax), or references a dangling ruleEntryId.' })
  @ApiResponse({ status: 409, description: 'That character is already a combatant in this encounter.' })
  async addCombatant(@Param('id', ParseIntPipe) id: number, @Body() body: CombatantCreateDto, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.encounters.addCombatant(id, body, user, role);
  }

  @Patch(':id/combatants/:cid')
  @ApiOperation({ summary: 'Update a combatant', description: "dm may modify any combatant, including initiative; the owning player (of a character-linked combatant) may adjust their own hp/conditions but not initiative." })
  @ApiResponse({ status: 200, description: 'Updated combatant.' })
  @ApiResponse({ status: 403, description: 'Not the dm or the owning player, or a player attempting to set initiative.' })
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
  @ApiOperation({ summary: 'Remove a combatant', description: 'dm role required.' })
  @ApiResponse({ status: 200, description: 'Deleted.' })
  async removeCombatant(@Param('id', ParseIntPipe) id: number, @Param('cid', ParseIntPipe) cid: number, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    await this.encounters.removeCombatant(id, cid, user, role);
    return { ok: true };
  }

  @Post(':id/roll-initiative')
  @ApiOperation({ summary: 'Roll initiative for all combatants missing one', description: 'dm role required. Only fills null initiatives — already-set values are untouched.' })
  @ApiResponse({ status: 201, description: 'Encounter with updated combatants.' })
  async rollInitiative(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.encounters.rollInitiative(id, user, role);
  }

  @Post(':id/start')
  @ApiOperation({ summary: 'Start the encounter', description: 'dm role required. Requires initiative to have been rolled for all combatants; sorts by initiative desc, sets round=1, turnIndex=0.' })
  @ApiResponse({ status: 201, description: 'Started encounter.' })
  @ApiResponse({ status: 400, description: 'Initiative not yet rolled for all combatants.' })
  async start(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.encounters.start(id, user, role);
  }

  @Post(':id/next-turn')
  @ApiOperation({ summary: 'Advance to the next turn', description: 'dm role required. Wraps turnIndex to 0 and increments round when past the last combatant.' })
  @ApiResponse({ status: 201, description: 'Encounter with advanced round/turnIndex.' })
  @ApiResponse({ status: 400, description: 'Encounter is not running.' })
  async nextTurn(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.encounters.nextTurn(id, user, role);
  }

  @Post(':id/end')
  @ApiOperation({ summary: 'End the encounter', description: 'dm role required. Writes combatant hp back to their linked characters.' })
  @ApiResponse({ status: 201, description: 'Ended encounter.' })
  @ApiResponse({ status: 400, description: 'Encounter is not running (or already ended).' })
  async end(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.encounters.end(id, user, role);
  }

  @Post(':id/reopen')
  @ApiOperation({ summary: 'Reopen an ended encounter', description: "dm role required. Flips an 'ended' encounter back to 'running', preserving round/turn state — recovers an accidental End. HP was already written back on End; the same write-back caveat applies on the next End." })
  @ApiResponse({ status: 201, description: 'Reopened (running) encounter.' })
  @ApiResponse({ status: 400, description: 'Encounter is not ended.' })
  async reopen(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.encounters.reopen(id, user, role);
  }
}
