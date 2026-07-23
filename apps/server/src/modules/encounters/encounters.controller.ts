import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import type { EncounterStatus } from '@campfire/schema';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { contentDispositionHeader } from '../attachments/filename';
import { EncountersService } from './encounters.service';
import { EncounterCreateDto, EncounterGenerateDto, EncounterUpdateDto, EncounterReopenDto, CombatantCreateDto, CombatantUpdateDto, RollRequestDto, MapPingDto } from './encounters.dto';
import { EncounterMapService } from './encounter-map.service';
import type { Request, Response } from 'express';
import { parseFogState } from '../../common/fog';

@ApiTags('encounters')
// Campaign-scoped list/create only. Role-safe map bytes live on
// EncountersController at GET /encounters/:id/map (not under this prefix).
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

  @Post('generate')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Generate an encounter from the compendium (issue #304)',
    description:
      'Assembles a balanced monster group from installed rule packs to hit a target 5e difficulty band for the ' +
      'party (issue #58 math). Deterministic — pass `seed` to reproduce, omit it to get a fresh group (the seed is ' +
      'returned so you can re-roll or reproduce). Party is inferred from the campaign\'s active PCs unless `party` ' +
      '(explicit PC levels) is given. Read-only by default (200, requires membership — any member/AI may preview): ' +
      'nothing is persisted, so commit the returned monsters via POST /encounters + add-combatant (the normal write ' +
      'path). Pass ?commit=true to run generate→create in one call — that branch requires the dm role + write mode ' +
      'and lands a hidden, `preparing` encounter (issue #262).',
  })
  @ApiQuery({ name: 'commit', required: false, type: Boolean, description: 'When true, persist the suggestion as a real (hidden, preparing) encounter — requires dm + write mode.' })
  @ApiResponse({ status: 200, description: 'Read-only suggestion (monster lines + difficulty + seed), OR { encounter, suggestion } when commit=true.' })
  @ApiResponse({ status: 403, description: 'commit=true requires the dm role.' })
  async generate(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Query('commit') commit: string | undefined,
    @Body() body: EncounterGenerateDto,
    @CurrentUser() user: RequestUser,
  ) {
    // Commit runs generate→create through the write path: dm role + write mode, exactly
    // like POST /encounters. The read-only preview requires only membership, so any member
    // or AI can generate + reroll before committing (issue #304).
    if (commit === 'true' || commit === '1') {
      // requireRole asserts writability by default (it IS the write gate) — an archived
      // campaign takes no new encounters, exactly like POST /encounters.
      const role = await this.access.requireRole(user, campaignId, 'dm');
      return this.encounters.generateAndCreateEncounter(campaignId, body, user, role);
    }
    const role = await this.access.requireMember(user, campaignId);
    return this.encounters.generateEncounter(campaignId, body, role);
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
    private readonly encounterMaps: EncounterMapService,
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

  @Get(':id/map')
  @ApiOperation({
    summary: 'Get the role-safe battle-map image for an encounter',
    description:
      'Requires campaign membership. DMs receive the source map. When fog conceals pixels, non-DMs receive an ' +
      'opaque server-rendered PNG containing only revealed regions; the source attachment remains inaccessible. ' +
      'Responses are private/no-store and byte ranges are rejected so role or fog revisions cannot leak through caches.',
  })
  @ApiQuery({ name: 'size', required: false, enum: ['thumb'], description: 'Omit for full resolution; `thumb` caps the longest edge at 512px.' })
  @ApiQuery({ name: 'revision', required: false, type: String, description: 'Opaque client cache-buster derived from encounter.updatedAt; ignored by the server.' })
  @ApiResponse({ status: 200, description: 'Role-safe image bytes.' })
  @ApiResponse({ status: 404, description: 'Encounter/map is absent, hidden from the caller, or its bytes are missing.' })
  @ApiResponse({ status: 416, description: 'Range requests are not supported on role-specific map views.' })
  @ApiResponse({ status: 422, description: 'The source image could not be safely rasterized while fog is active.' })
  async map(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: RequestUser,
    @Req() req: Request,
    @Res() res: Response,
    @Query('size') size?: string,
  ): Promise<void> {
    if (size !== undefined && size !== 'thumb') {
      throw new BadRequestException("Unsupported size — allowed: 'thumb' (or omit for the original)");
    }
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId);

    // A range response would add a second cache/validator path and is unnecessary
    // for <=8MB image uploads. Reject it explicitly after authorization instead of
    // ever slicing the raw source attachment.
    if (req.headers.range !== undefined) {
      // RFC 9110: 416 should advertise the valid range space even when we refuse ranges.
      res
        .status(416)
        .set({
          'Accept-Ranges': 'none',
          'Cache-Control': 'private, no-store',
          'Content-Range': 'bytes */0',
          // Keep Vary identical to the 200 map response so intermediaries cannot
          // key 416/200 differently across auth/cookie/dev-role variants.
          Vary: 'Cookie, Authorization, x-dev-role, x-dev-user',
        })
        .end();
      return;
    }

    // Map bytes only need the encounter row (map/fog/visibility) — skip the combatant join.
    const encounter = this.encounters.encounterForMapOrThrow(row, role);

    // Ordinary encounter JSON tolerates malformed legacy fog data, but map pixels
    // must fail closed: a non-null invalid value renders an all-concealed view.
    const persistedFogInvalid = row.fog !== null && parseFogState(row.fog) === null;
    const view = await this.encounterMaps.resolve(
      encounter,
      role,
      size === 'thumb' ? 'thumb' : 'original',
      persistedFogInvalid,
    );
    res
      .status(200)
      .set({
        'Content-Type': view.mime,
        'Content-Length': String(view.bytes.length),
        // Issue #630: ASCII fallback + RFC 5987 filename* (not percent-encoding
        // the Unicode name into the legacy filename= slot).
        'Content-Disposition': contentDispositionHeader(view.filename, 'inline'),
        ETag: view.etag,
        'Cache-Control': 'private, no-store, max-age=0',
        Pragma: 'no-cache',
        Expires: '0',
        'Accept-Ranges': 'none',
        Vary: 'Cookie, Authorization, x-dev-role, x-dev-user',
        'X-Campfire-Map-View': view.protected ? 'fog-protected' : 'fully-revealed',
      })
      .end(view.bytes);
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
    description:
      "dm role required. Edit the name, attach/clear a location/quest/session link (issue #126), and/or attach/clear the battle map via mapAttachmentId (issue #39). " +
      'Optionally pass `expectedUpdatedAt` (the updatedAt you last read) to opt into optimistic concurrency (issue #532): ' +
      'a stale value returns 409 Conflict instead of silently clobbering a fresher edit from another DM tab or a connected AI.',
  })
  @ApiResponse({ status: 200, description: 'Updated encounter with combatants.' })
  @ApiResponse({ status: 400, description: 'mapAttachmentId does not exist in this campaign.' })
  @ApiResponse({ status: 404, description: 'A linked location/quest/session id is not in this encounter\'s campaign.' })
  @ApiResponse({ status: 409, description: 'Stale expectedUpdatedAt — another DM or the AI saved this encounter since you loaded it. Reload the latest before reapplying.' })
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: EncounterUpdateDto, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    // Split off the optimistic-concurrency guard (#532) from the entity fields, mirroring
    // npcs.controller.ts / quests.controller.ts.
    const { expectedUpdatedAt, ...fields } = body;
    return this.encounters.updateEncounter(id, fields, user, role, { expectedUpdatedAt });
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
    // Role drives hidden-encounter secrecy (issue #869): a non-DM must not learn a
    // prepared fight exists via ping — 404, matching roster/events/difficulty.
    const role = await this.access.requireMember(user, row.campaignId, { write: true });
    this.encounters.pingMap(id, row.campaignId, body, role, row.hidden);
    return { ok: true };
  }

  @Get(':id/events')
  @ApiOperation({
    summary: "List an encounter's persistent combat log",
    description:
      'Requires campaign membership. Chronological per-encounter event history (damage/heal, conditions, deaths, turns) that survives reload — issue #61. Hidden encounters 404 for non-DMs; hidden NPC identities are masked via current role-aware projection (issue #869). Details record only HP deltas / name-free outcomes, never a monster’s exact HP totals.',
  })
  @ApiResponse({ status: 200, description: 'Encounter events in chronological order.' })
  @ApiResponse({ status: 404, description: 'Encounter not found, or hidden from this viewer.' })
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
  @ApiOperation({
    summary: 'Roll initiative for all combatants missing one',
    description:
      'dm role required. Only fills null initiatives — already-set values are untouched. ' +
      'Returns rolledCount of how many were filled this call; a fully-rolled roster is a no-op (no write, no audit, no broadcast).',
  })
  @ApiResponse({ status: 201, description: 'Encounter with combatants plus rolledCount.' })
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
  @ApiOperation({
    summary: 'Reopen an ended encounter',
    description:
      "dm role required. Flips an 'ended' encounter back to 'running', preserving round/turn state. " +
      'When character sheets advanced after the previous End (heal/rest/another fight), pass `hpResync` ' +
      'decisions for each conflict listed on GET (issue #466) — never silently overwrite newer sheet HP.',
  })
  @ApiResponse({ status: 201, description: 'Reopened (running) encounter.' })
  @ApiResponse({ status: 400, description: 'Encounter is not ended.' })
  @ApiResponse({ status: 409, description: 'HP sync conflicts require hpResync decisions (issue #466).' })
  async reopen(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: EncounterReopenDto,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.encounters.reopen(id, user, role, body);
  }
}
