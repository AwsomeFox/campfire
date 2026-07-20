import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import type { Response } from 'express';
import { CharacterCreate, CharacterUpdate } from '@campfire/schema';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { ProposalRecordsService } from '../proposals/proposal-records.service';
import { isProposed } from '../../common/proposed.util';
import { CharactersService } from './characters.service';
import { CharacterCreateDto, CharacterUpdateDto, HpPatchDto, ConditionsPatchDto, SpellSlotPatchDto, XpPatchDto, XpAwardDto, LevelUpDto, DdbCharacterImportDto } from './characters.dto';

@ApiTags('characters')
@Controller('campaigns/:campaignId/characters')
export class CampaignCharactersController {
  constructor(
    private readonly characters: CharactersService,
    private readonly access: CampaignAccessService,
    private readonly proposals: ProposalRecordsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List characters in a campaign', description: 'Requires campaign membership. dmSecret is stripped for non-dm.' })
  @ApiResponse({ status: 200, description: 'Characters in the campaign.' })
  async list(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireMember(user, campaignId);
    return this.characters.listForCampaign(campaignId, role);
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
  async create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: CharacterCreateDto,
    @Query('proposed') proposed: string | undefined,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (isProposed(proposed)) {
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
      'player role required. Reads a PUBLIC D&D Beyond character sheet (unofficial, read-only — no auth, no private data) and creates a Campfire character from it. Body is `{ ddbId }` (the numeric character id) or `{ url }` (a character/share link, e.g. https://www.dndbeyond.com/characters/12345678). The sheet must have its privacy set to Public on D&D Beyond. Ownership follows the normal create rules (a player imports for themselves; a dm imports DM-managed).',
  })
  @ApiResponse({ status: 201, description: 'Created character imported from D&D Beyond.' })
  @ApiResponse({ status: 400, description: 'The sheet is private, the id/URL is malformed, or D&D Beyond was unreachable.' })
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
  @ApiOperation({ summary: 'Award XP to the party', description: 'dm role required. Adds `amount` XP to every character in the campaign, or only to `characterIds` when given.' })
  @ApiResponse({ status: 201, description: 'Updated characters.' })
  @ApiResponse({ status: 400, description: 'A characterId does not belong to this campaign, or the campaign has no characters.' })
  async awardXp(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: XpAwardDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.characters.awardXp(campaignId, body, user, role);
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
  @ApiOperation({ summary: 'Get a character', description: 'Requires campaign membership. dmSecret is stripped for non-dm.' })
  @ApiResponse({ status: 200, description: 'Character.' })
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.characters.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId);
    return this.characters.getOrThrow(id, role);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a character',
    description:
      'dm or the owning player may write; other players get 403. dmSecret is dm-writable only (silently ignored for the owning player). With `?proposed=true` any member may submit the change as a pending proposal instead of writing directly.',
  })
  @ApiQuery({ name: 'proposed', required: false, type: Boolean, description: 'If true, creates a pending proposal instead of writing directly.' })
  @ApiResponse({ status: 200, description: 'Updated character.' })
  @ApiResponse({ status: 202, description: 'Pending proposal created (proposed=true).' })
  @ApiResponse({ status: 403, description: 'Not the dm or owning player.' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: CharacterUpdateDto,
    @Query('proposed') proposed: string | undefined,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const row = await this.characters.getRowOrThrow(id);
    if (isProposed(proposed)) {
      const role = await this.access.requireMember(user, row.campaignId, { write: true });
      const validated = CharacterUpdate.parse(body);
      const proposal = await this.proposals.create(row.campaignId, 'character', id, 'update', validated, user, role);
      res.status(202);
      return { proposal };
    }
    const role = await this.access.requireRole(user, row.campaignId, 'player');
    return this.characters.update(id, body, user, role);
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
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @Query('proposed') proposed: string | undefined,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const row = await this.characters.getRowOrThrow(id);
    if (isProposed(proposed)) {
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

  @Post(':id/hp')
  @ApiOperation({ summary: 'Adjust character HP', description: 'dm or the owning player. Body is a union: { delta } (relative) or { set } (absolute); result is clamped to [0, hpMax].' })
  @ApiResponse({ status: 201, description: 'Updated character.' })
  async patchHp(@Param('id', ParseIntPipe) id: number, @Body() body: HpPatchDto, @CurrentUser() user: RequestUser) {
    const row = await this.characters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'player');
    return this.characters.patchHp(id, body, user, role);
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
}
