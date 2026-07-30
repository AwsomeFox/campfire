import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import type { Response } from 'express';
import { CharacterCreate, CharacterUpdate, CheckRequestStatus } from '@campfire/schema';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { ProposalRecordsService } from '../proposals/proposal-records.service';
import { requireWriteMode } from '../../common/proposed.util';
import { Proposable } from '../../common/decorators/proposable.decorator';
import { CharactersService } from './characters.service';
import { CharacterCreateDto, CharacterUpdateDto, HpPatchDto, ConditionsPatchDto, ConditionLevelPatchDto, SpellSlotPatchDto, ResourcePatchDto, XpPatchDto, XpAwardDto, LevelUpDto, DdbCharacterImportDto, CheckRollRequestDto, CheckRequestCreateDto, RestPatchDto, PartyRecoveryPreviewDto, PartyRecoveryApplyDto, PartyRecoveryUndoDto } from './characters.dto';

@ApiTags('characters')
@Controller('campaigns/:campaignId/characters')
export class CampaignCharactersController {
  constructor(
    private readonly characters: CharactersService,
    private readonly access: CampaignAccessService,
    private readonly proposals: ProposalRecordsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List characters in a campaign', description: 'DMs receive party sheets; other members receive only sheets they own. dmSecret is stripped for non-dm.' })
  @ApiResponse({ status: 200, description: 'Characters in the campaign.' })
  async list(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireMember(user, campaignId);
    return this.characters.listForCampaign(campaignId, user, role);
  }

  @Get('roster')
  @ApiOperation({ summary: 'List the table-safe party roster', description: 'Every campaign member receives a minimal display roster. Full sheets remain available only through the caller-scoped character list and direct character read endpoints.' })
  @ApiResponse({ status: 200, description: 'Table-safe party roster for the campaign.' })
  async roster(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    await this.access.requireMember(user, campaignId);
    return this.characters.partyRosterForCampaign(campaignId);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a character',
    description:
      'player role required. Players creating their own character get ownerUserId set automatically; a dm may set ownerUserId explicitly to create on behalf of another player. With `?proposed=true` any member (incl. an AI scribe) may submit it as a pending proposal instead of writing directly.',
  })
  @ApiQuery({ name: 'proposed', required: false, type: Boolean, description: 'If true, creates a pending proposal instead of writing directly.' })
  @ApiResponse({ status: 201, description: 'Created character (direct write).' })
  @ApiResponse({ status: 202, description: 'Pending proposal created (proposed=true).' })
  @Proposable()
  async create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: CharacterCreateDto,
    @Query('proposed') proposed: string | undefined,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (requireWriteMode(user, proposed)) {
      const role = await this.access.requireMember(user, campaignId, { write: true });
      const validated = CharacterCreate.parse(body);
      const proposal = await this.proposals.create(campaignId, 'character', null, 'create', validated, user, role);
      res.status(202);
      return { proposal };
    }
    const role = await this.access.requireRole(user, campaignId, 'player');
    res.status(201);
    return this.characters.create(campaignId, body, user, role);
  }

  @Post('import-ddb')
  @ApiOperation({
    summary: 'Import a character from a public D&D Beyond sheet',
    description:
      'player role required. Reads a PUBLIC D&D Beyond character sheet (unofficial, read-only — no auth, no private data) and creates a Campfire character from it. Body is `{ ddbId }` (the numeric character id) or `{ url }` (a character/share link, e.g. https://www.dndbeyond.com/characters/12345678). The sheet must have its privacy set to Public on D&D Beyond. Ownership follows the normal create rules (a player imports for themselves; a dm imports DM-managed). Only available for D&D 5e campaigns (issue #714): a DDB sheet is a 5e character, so the import is rejected with 400 for any other (or no) rule system rather than silently producing a character whose numbers belong to another game.',
  })
  @ApiResponse({ status: 201, description: 'Created character imported from D&D Beyond.' })
  @ApiResponse({ status: 400, description: 'The sheet is private, the id/URL is malformed, D&D Beyond was unreachable, or the campaign is not a D&D 5e campaign.' })
  @ApiResponse({ status: 404, description: 'No such D&D Beyond character.' })
  async importDdb(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: DdbCharacterImportDto,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'player');
    res.status(201);
    return this.characters.importFromDdb(campaignId, body, user, role);
  }

  @Post('xp')
  @ApiOperation({
    summary: 'Award XP to party recipients',
    description:
      'dm role required. With no `characterIds`, adds `amount` XP to active characters only. An explicit recipient list is enforced exactly. Selecting an inactive, retired, or dead character additionally requires `includeNonActive: true`, and that opt-in is invalid without explicit `characterIds`, so historical corrections are deliberate.',
  })
  @ApiResponse({ status: 201, description: 'Updated characters.' })
  @ApiResponse({ status: 400, description: 'A recipient is outside the campaign, a non-active recipient lacks explicit opt-in, or there are no eligible recipients.' })
  async awardXp(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: XpAwardDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.characters.awardXp(campaignId, body, user, role);
  }

  @Post('rest/preview')
  @ApiOperation({ summary: 'Preview party recovery', description: 'DM only. Rolls short-rest dice once and persists the exact recovery plan for a later atomic apply.' })
  @ApiResponse({ status: 201, description: 'Recovery preview, including every planned delta and any ineligible participant.' })
  @ApiResponse({ status: 400, description: 'Invalid participant or recovery options.' })
  @ApiResponse({ status: 403, description: 'DM role required or campaign is not writable.' })
  async previewPartyRecovery(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: PartyRecoveryPreviewDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.characters.previewPartyRecovery(campaignId, body, user, role);
  }

  @Post('rest/apply')
  @ApiOperation({ summary: 'Apply a previewed party recovery', description: 'DM only. Applies the persisted plan once, with idempotent retry and stale-sheet rejection.' })
  @ApiResponse({ status: 201, description: 'Applied party recovery result.' })
  @ApiResponse({ status: 409, description: 'Preview is stale, already used for another intent, or combat acknowledgement is required.' })
  async applyPartyRecovery(@Param('campaignId', ParseIntPipe) campaignId: number, @Body() body: PartyRecoveryApplyDto, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.characters.applyPartyRecovery(campaignId, body, user, role);
  }

  @Post('rest/:batchId/undo')
  @ApiOperation({ summary: 'Undo an applied party recovery', description: 'DM only. Refuses to overwrite later sheet edits.' })
  @ApiResponse({ status: 201, description: 'Party recovery batch undone.' })
  @ApiResponse({ status: 409, description: 'Batch was already undone or a participant changed after the rest.' })
  async undoPartyRecovery(@Param('campaignId', ParseIntPipe) campaignId: number, @Param('batchId', ParseIntPipe) batchId: number, @Body() body: PartyRecoveryUndoDto, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.characters.undoPartyRecovery(campaignId, batchId, body.idempotencyKey, user, role);
  }
}

@ApiTags('characters')
@Controller('characters')
export class CharactersController {
  constructor(
    private readonly characters: CharactersService,
    private readonly access: CampaignAccessService,
    private readonly proposals: ProposalRecordsService,
  ) {}

  @Get(':id')
  @ApiOperation({ summary: 'Get a character', description: 'DMs may read any party sheet; other members may read only sheets they own. dmSecret is stripped for non-dm.' })
  @ApiResponse({ status: 200, description: 'Character.' })
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.characters.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId);
    return this.characters.getOrThrow(id, user, role);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a character',
    description:
      'dm or the owning player may write; other players get 403. dmSecret is dm-writable only (silently ignored for the owning player). With `?proposed=true` any member may submit the change as a pending proposal instead of writing directly. ' +
      'Optionally pass `expectedUpdatedAt` (the updatedAt you last read) to opt into optimistic concurrency (issue #746): ' +
      'a stale value returns 409 Conflict instead of silently clobbering a fresher edit (a live HP/level change, a DM-secret edit) from another tab or a connected AI.',
  })
  @ApiQuery({ name: 'proposed', required: false, type: Boolean, description: 'If true, creates a pending proposal instead of writing directly.' })
  @ApiResponse({ status: 200, description: 'Updated character.' })
  @ApiResponse({ status: 202, description: 'Pending proposal created (proposed=true).' })
  @ApiResponse({ status: 403, description: 'Not the dm or owning player.' })
  @ApiResponse({ status: 409, description: 'Stale expectedUpdatedAt — another tab/device or a connected AI saved this character since you loaded it. Reload the latest before reapplying.' })
  @Proposable()
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: CharacterUpdateDto,
    @Query('proposed') proposed: string | undefined,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const row = await this.characters.getRowOrThrow(id);
    // Split off the optimistic-concurrency guard (#746) from the entity fields, mirroring
    // npcs.controller.ts / quests.controller.ts / encounters.controller.ts. The proposal
    // path intentionally never forwards the guard: a queued/proposed edit is applied later
    // by the DM, so the caller's `expectedUpdatedAt` would be stale-by-design.
    const { expectedUpdatedAt, ...fields } = body;
    if (requireWriteMode(user, proposed)) {
      const role = await this.access.requireMember(user, row.campaignId, { write: true });
      const validated = CharacterUpdate.parse(fields);
      const proposal = await this.proposals.create(row.campaignId, 'character', id, 'update', validated, user, role);
      res.status(202);
      return { proposal };
    }
    const role = await this.access.requireRole(user, row.campaignId, 'player');
    return this.characters.update(id, fields, user, role, { expectedUpdatedAt });
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a character',
    description:
      'dm or the owning player may delete (mirrors PATCH) — a player may remove their own character (e.g. a backup PC or companion they created); other players get 403. With `?proposed=true` any member may submit a deletion as a pending proposal instead.',
  })
  @ApiQuery({ name: 'proposed', required: false, type: Boolean, description: 'If true, creates a pending delete proposal instead of deleting directly.' })
  @ApiResponse({ status: 200, description: 'Deleted (direct write).' })
  @ApiResponse({ status: 202, description: 'Pending delete proposal created (proposed=true).' })
  @ApiResponse({ status: 403, description: 'Not the dm or owning player.' })
  @Proposable()
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @Query('proposed') proposed: string | undefined,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const row = await this.characters.getRowOrThrow(id);
    if (requireWriteMode(user, proposed)) {
      const role = await this.access.requireMember(user, row.campaignId, { write: true });
      const proposal = await this.proposals.create(row.campaignId, 'character', id, 'delete', {}, user, role);
      res.status(202);
      return { proposal };
    }
    // Player-level membership gate at the controller; the service's assertCanWrite
    // narrows to dm-or-owner (same two-step pattern as PATCH / hp / conditions).
    const role = await this.access.requireRole(user, row.campaignId, 'player');
    return this.characters.remove(id, user, role);
  }

  @Post(':id/restore')
  @ApiOperation({ summary: 'Restore a trashed character', description: 'dm or the owning player. Undo a soft-delete (issue #116) — the character returns exactly as it was.' })
  @ApiResponse({ status: 201, description: 'Restored character.' })
  async restore(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.characters.getRowOrThrow(id, true);
    const role = await this.access.requireRole(user, row.campaignId, 'player');
    return this.characters.restore(id, user, role);
  }

  @Post(':id/hp')
  @ApiOperation({ summary: 'Adjust character HP', description: 'dm or the owning player. Body is a union: { delta } (relative) or { set } (absolute); result is clamped to [0, hpMax].' })
  @ApiResponse({ status: 201, description: 'Updated character.' })
  async patchHp(@Param('id', ParseIntPipe) id: number, @Body() body: HpPatchDto, @CurrentUser() user: RequestUser) {
    const row = await this.characters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'player');
    return this.characters.patchHp(id, body, user, role);
  }

  @Post(':id/rest')
  @ApiOperation({ summary: 'Character Rest (Stamina or Night)', description: 'dm or the owning player. Restores SP/HP/RP based on rest type.' })
  @ApiResponse({ status: 201, description: 'Rested character.' })
  async rest(@Param('id', ParseIntPipe) id: number, @Body() body: RestPatchDto, @CurrentUser() user: RequestUser) {
    const row = await this.characters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'player');
    return this.characters.rest(id, body.type, user, role);
  }

  @Post(':id/xp')
  @ApiOperation({ summary: 'Adjust character XP', description: 'dm or the owning player. Body is a union: { delta } (relative) or { set } (absolute); XP never goes below 0.' })
  @ApiResponse({ status: 201, description: 'Updated character.' })
  async patchXp(@Param('id', ParseIntPipe) id: number, @Body() body: XpPatchDto, @CurrentUser() user: RequestUser) {
    const row = await this.characters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'player');
    return this.characters.patchXp(id, body, user, role);
  }

  @Post(':id/level-up')
  @ApiOperation({
    summary: 'Level a character up',
    description:
      'dm or the owning player. Raises level by 1 (400 at level 20). Optionally pass the new hpMax — the hit points gained are added to hpCurrent too (damage taken is kept). Not gated on XP thresholds, so milestone campaigns work.',
  })
  @ApiResponse({ status: 201, description: 'Updated character.' })
  @ApiResponse({ status: 400, description: 'Already at level 20.' })
  async levelUp(@Param('id', ParseIntPipe) id: number, @Body() body: LevelUpDto, @CurrentUser() user: RequestUser) {
    const row = await this.characters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'player');
    return this.characters.levelUp(id, body, user, role);
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

  @Post(':id/conditions/level')
  @ApiOperation({
    summary: "Raise or lower a leveled condition track's level (issue #1643)",
    description:
      "dm or the owning player. For the ONE condition the campaign's rule system tracks as an escalating level " +
      "(5e Exhaustion, 1-6) rather than a plain present/absent flag — see GET :id/resource-vocabulary's sibling " +
      "concept for resources. Body is { name, delta?, level? }: delta adjusts relative to the current level, level " +
      'sets it absolutely (applied first when both are sent). Resulting level outside [0, the track\'s max] is a ' +
      "400, never a silent clamp. Level 0 removes the condition entirely. A `name` that is not this campaign's " +
      "leveled track (including every name on a system with none, e.g. PF2e) is also a 400 — unlike POST " +
      ':id/conditions, this endpoint does not create an arbitrary custom condition.',
  })
  @ApiResponse({ status: 201, description: 'Updated character.' })
  @ApiResponse({ status: 400, description: "Not this system's leveled condition, or the result is outside [0, max]." })
  async patchConditionLevel(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ConditionLevelPatchDto,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.characters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'player');
    return this.characters.adjustConditionLevel(id, body, user, role);
  }

  @Get(':id/checks')
  @ApiOperation({
    summary: 'List a character\'s rollable checks (roll catalog)',
    description:
      'DM or owning player. Returns the adapter-owned roll catalog for the character (issue #415): every rollable check — ability checks, skills (proficient AND unproficient), saves/defenses, and initiative — each with an authoritative modifier and a transparent breakdown ("DEX +3, proficient +2 = +5"), favorites (trained/proficient) first. The character sheet and the encounter card render this identical list; the modifier math is computed by the campaign\'s rule system, so no client reinvents proficiency math.',
  })
  @ApiResponse({ status: 200, description: 'The character\'s roll catalog, favorites first.' })
  async listChecks(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    await this.characters.assertCharacterReadable(id, user);
    return this.characters.listChecks(id);
  }

  @Post(':id/checks/roll')
  @ApiOperation({
    summary: 'Roll a catalog check for a character',
    description:
      'dm or the owning player (issue #1479 — previously any campaign member with campaign-level write access, which let a member roll as a character they did not own). Rolls a check from the character\'s roll catalog (issue #415): the SERVER resolves the authoritative modifier + dice expression from the rule-system adapter (the client only names a `checkId` and roll `mode`), rolls with the shared crypto roller, records the result to the campaign dice log with a transparent breakdown label, and — for a system that reports degrees of success (PF2e) with a DC — returns the degree/outcome. Advantage/disadvantage apply only where the system supports them.',
  })
  @ApiResponse({ status: 201, description: 'The resolved check + persisted roll (with breakdown and, for PF2e, degree of success).' })
  @ApiResponse({ status: 403, description: 'Not the dm or the owning player.' })
  @ApiResponse({ status: 404, description: 'No such check id in the character\'s catalog.' })
  async rollCheck(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: CheckRollRequestDto,
    @CurrentUser() user: RequestUser,
  ) {
    // Issue #1479: `requireMember(..., { write: true })` alone only asserted the CAMPAIGN
    // accepts writes, not that THIS caller may write as THIS character — a viewer, or a
    // player who does not own the target character, could roll (and attach arbitrary
    // `consequence` text) as any character in the campaign. `assertCharacterWritable` is
    // the shared seam (also used by the MCP `roll_check`/`saving_throw` tools) that
    // requires player-or-above membership AND dm-or-owner in one call; `rollCheck` itself
    // repeats the dm-or-owner half as defense in depth.
    const { role } = await this.characters.assertCharacterWritable(id, user);
    return this.characters.rollCheck(id, body, user, role);
  }

  @Post(':id/spell-slots')
  @ApiOperation({ summary: 'Spend or restore spell slots', description: 'dm or the owning player. Body is { level, delta }: delta +1 spends a slot, -1 restores; `used` is clamped to [0, max]. 400 if the character has no slots at that level (set maxima via PATCH spellSlots).' })
  @ApiResponse({ status: 201, description: 'Updated character.' })
  @ApiResponse({ status: 400, description: 'No spell slots at that level.' })
  async patchSpellSlots(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: SpellSlotPatchDto,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.characters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'player');
    return this.characters.patchSpellSlots(id, body, user, role);
  }

  @Get(':id/resource-vocabulary')
  @ApiOperation({
    summary: "List a character's available resource vocabulary",
    description:
      'DM or owning player. Returns the campaign rule system\'s STANDARD resource pools (issue #422) — ' +
      '5e hitDice/rage/actionSurge/kiPoints/inspiration, PF2e focusPoints/hitDice/heroPoints, and so on — plus any ' +
      'CUSTOM resource already on this character\'s sheet, sourced from the campaign\'s RuleSystemAdapter so no ' +
      'client hardcodes one system\'s resource names. `key` from an entry is what POST :id/resources expects; the ' +
      'write endpoint itself still accepts a key outside this list (a homebrew resource is never blocked), this is ' +
      'only for discovering the adapter-declared ones ahead of time.',
  })
  @ApiResponse({ status: 200, description: "The character's resource vocabulary." })
  async listResourceVocabulary(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    await this.characters.assertCharacterReadable(id, user);
    return this.characters.listResourceVocabulary(id);
  }

  @Post(':id/resources')
  @ApiOperation({
    summary: 'Spend, restore, or configure a bounded character resource',
    description:
      'dm or the owning player (issue #422) — same authority as spell slots. Body is { key, delta?, used?, max?, ' +
      'name?, recharge? }: `delta` adjusts relative to the resource\'s current `used`, `used` sets it absolutely ' +
      '(applied first when both are sent). Spending past 0 or restoring past `max` is a 400, never a silent clamp — ' +
      'an AI narrating a reroll it did not pay for is exactly the failure this refuses. `key` is not restricted to ' +
      'GET :id/resource-vocabulary\'s list: a key the adapter does not declare creates a custom resource using ' +
      '`max`/`name`/`recharge` from this request (or their defaults) the first time it is touched.',
  })
  @ApiResponse({ status: 201, description: 'Updated character.' })
  @ApiResponse({ status: 400, description: 'Resulting used would fall outside [0, max].' })
  async patchResource(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ResourcePatchDto,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.characters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'player');
    return this.characters.adjustResource(id, body, user, role);
  }
}

/**
 * DM-initiated check requests (issue #415) — the interactive "DM asks selected players to roll
 * a check/save with a DC + consequence" loop. Create is DM-only; list is member-scoped (the DM
 * sees all, a player sees only requests for a character they own — the targeted player). The
 * actual roll is submitted through CheckRequestsController below and reuses the catalog-roll path.
 */
@ApiTags('characters')
@Controller('campaigns/:campaignId/check-requests')
export class CampaignCheckRequestsController {
  constructor(
    private readonly characters: CharactersService,
    private readonly access: CampaignAccessService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Request a check/save from one or more characters',
    description:
      'dm role required (issue #415). Names a `checkId` (e.g. "save:DEX") and one or more target `characterIds`, plus an optional `dc` and `consequence` text. One pending request is persisted per character; each targeted player receives a thin real-time signal and reads the request back over the list endpoint to roll it once. The check must exist in each target character\'s catalog (404 otherwise).',
  })
  @ApiResponse({ status: 201, description: 'The created check request(s), one per target character.' })
  @ApiResponse({ status: 400, description: 'A target character is outside this campaign.' })
  @ApiResponse({ status: 404, description: 'The checkId is not in a target character\'s catalog.' })
  async create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: CheckRequestCreateDto,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    res.status(201);
    return this.characters.requestChecks(campaignId, body, user, role);
  }

  @Get()
  @ApiOperation({
    summary: 'List check requests visible to the caller',
    description:
      'Requires campaign membership (issue #415). The DM sees every request in the campaign; a player sees only requests targeting a character they own (the targeted player). Optional `?status=pending|resolved` filter. Newest first.',
  })
  @ApiQuery({ name: 'status', required: false, enum: ['pending', 'resolved'], description: 'Filter by request status.' })
  @ApiResponse({ status: 200, description: 'Visible check requests, newest first.' })
  async list(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Query('status') status: string | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireMember(user, campaignId);
    const parsed = status ? CheckRequestStatus.parse(status) : undefined;
    return this.characters.listCheckRequests(campaignId, user, role, { status: parsed });
  }
}

@ApiTags('characters')
@Controller('check-requests')
export class CheckRequestsController {
  constructor(
    private readonly characters: CharactersService,
    private readonly access: CampaignAccessService,
  ) {}

  @Post(':id/roll')
  @ApiOperation({
    summary: 'Answer a check request by rolling once',
    description:
      'The targeted player (owner of the character) or the DM (issue #415). Rolls the requested check ONCE via the same server-resolved catalog-roll path (records to the shared dice log with a transparent breakdown, audits, and returns the PF2e degree of success where applicable). The DM\'s DC + consequence text ride through to the roll and are returned with the resolved request. A request that was already answered is a 400.',
  })
  @ApiResponse({ status: 201, description: 'The resolved request plus the roll result (breakdown + persisted roll + optional degree).' })
  @ApiResponse({ status: 400, description: 'This check request has already been answered.' })
  @ApiResponse({ status: 403, description: 'Not the dm or the owning player.' })
  @ApiResponse({ status: 404, description: 'No such check request.' })
  async roll(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const campaignId = await this.characters.campaignIdForCheckRequest(id);
    // Issue #1636: `requireMember(..., { write: true })` only asserts the CAMPAIGN is
    // writable, not that the CALLER has write authority — it returns a viewer's role
    // unchanged. Downstream, `assertCanWrite` checks dm-or-owner, and `ownerUserId` is
    // untouched by a role change, so a member demoted from player to viewer who owns the
    // character could still roll (and thereby resolve) a pending check request.
    // requireRole('player') closes that; assertCanWrite's dm-or-owner check still applies.
    const role = await this.access.requireRole(user, campaignId, 'player');
    return this.characters.resolveCheckRequest(id, user, role);
  }
}
