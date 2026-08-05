import { BadRequestException, HttpException, HttpStatus, Headers, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseIntPipe, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import type { EncounterStatus } from '@campfire/schema';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { contentDispositionHeader } from '../attachments/filename';
import { DERIVATIVE_VARIANT_NAMES, isDerivativeVariantName } from '../attachments/image-derivatives';
import { EncountersService } from './encounters.service';
import { EncounterCreateDto, EncounterGenerateDto, EncounterPreviewDto, EncounterCommitDto, EncounterUpdateDto, EncounterEscalationUpdateDto, EncounterReopenDto, CombatantCreateDto, CombatantUpdateDto, CombatantRemoveRequestDto, CombatantRemoveUndoDto, CombatantResourceAdjustDto, DeathSaveRollDto, CombatantRollInitiativeDto, CombatantTurnStatePatchDto, EncounterEndTurnDto, EncounterNextTurnDto, RollRequestDto, ActionRollRequestDto, ManualRollRequestDto, MapPingDto, AoeTemplateDeclareDto, AoeTemplateUpdateDto, ActionResolveRequestDto, ActionApplyRequestDto, ActionUndoTokenDto, TokenBatchPreviewDto, TokenBatchApplyDto, TokenBatchUndoDto, SavedTokenFormationDto, QuickRollRequestDto, EncounterAftermathApplyXpInputDto, EncounterAftermathLootTransferInputDto, EncounterAftermathQuestUpdateInputDto, EncounterAftermathBeatUpdateInputDto, EncounterAftermathTimelineEventInputDto } from './encounters.dto';
import { EncounterMapService } from './encounter-map.service';
import { ActionResolverService } from './action-resolver.service';
import type { Request, Response } from 'express';
import { parseFogState } from '../../common/fog';
import { isVisibleTo } from '../../common/redact';

@ApiTags('encounters')
// Campaign-scoped list/create only. Role-safe map bytes live on
// EncountersController at GET /encounters/:id/map (not under this prefix).
@Controller('campaigns/:campaignId/encounters')
export class CampaignEncountersController {
  constructor(
    private readonly encounters: EncountersService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get('token-formations')
  @ApiOperation({ summary: 'List saved token formations', description: 'Any campaign member may list formations.' })
  async listTokenFormations(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireMember(user, campaignId); return this.encounters.listTokenFormations(campaignId, role);
  }
  @Post('token-formations')
  @ApiOperation({ summary: 'Save a token formation', description: 'dm role required. Creates a named, reusable token layout for the campaign.' })
  async createTokenFormation(@Param('campaignId', ParseIntPipe) campaignId: number, @Body() body: SavedTokenFormationDto, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireRole(user, campaignId, 'dm'); return this.encounters.createTokenFormation(campaignId, body, user, role);
  }
  @Delete('token-formations/:formationId')
  @ApiOperation({ summary: 'Delete a token formation', description: 'dm role required.' })
  async deleteTokenFormation(@Param('campaignId', ParseIntPipe) campaignId: number, @Param('formationId', ParseIntPipe) formationId: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireRole(user, campaignId, 'dm'); return this.encounters.deleteTokenFormation(campaignId, formationId, role);
  }

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
      'Assembles a balanced monster group from installed rule packs, SIZED by a 5e-shaped count/CR ' +
      'heuristic (issue #58 math) toward the target band you pass — for every rule system. The band ' +
      'is accepted and used for sizing regardless of system, but the REPORTED `difficulty` is only ' +
      'that system\'s own audited math when `difficultySupport` is `supported` (5e or an ' +
      'empty/homebrew slug). A registered non-5e system (PF2e, OSR, …) returns ' +
      '`difficultySupport: \'heuristic\'` with `difficulty.status: \'unsupported\'` and a null band — ' +
      'the ABSENCE of a rating, not a 5e-shaped one, so do not report a band for it (issue #1928). ' +
      'Deterministic — pass `seed` to reproduce, omit it to get a fresh group (the seed is ' +
      'returned so you can re-roll or reproduce). Party is inferred from the campaign\'s active PCs unless `party` ' +
      '(explicit PC levels) is given. Read-only by default (200, requires membership — any member/AI may preview): ' +
      'nothing is persisted, so commit the returned monsters via POST /encounters + add-combatant (the normal write ' +
      'path). Pass ?commit=true to run generate→create in one call — that branch requires the dm role + write mode ' +
      'and lands a hidden, `preparing` encounter (issue #262).',
  })
  @ApiQuery({ name: 'commit', required: false, type: Boolean, description: 'When true, persist the suggestion as a real (hidden, preparing) encounter — requires dm + write mode.' })
  @ApiResponse({
    status: 200,
    description:
      'Read-only suggestion (monster lines + difficulty + `difficultySupport` + `matchedBand` + seed), ' +
      'OR { encounter, suggestion } when commit=true. `matchedBand` describes the 5e-shaped SIZING ' +
      'pass only and can be true beside an `unsupported` difficulty — never report it as an achieved ' +
      'difficulty when `difficultySupport` is `heuristic`.',
  })
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

  @Post('preview')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Preview & tune a generated encounter (issue #412)',
    description:
      'NON-MUTATING. Assembles a multi-slot roster for a target difficulty and returns per-creature ' +
      'inspection (AC/HP/actions/saves/traits), an XP/difficulty EXPLANATION (not just a band), and actionable ' +
      'warnings (role duplication, action-economy mismatch, missing statblocks, unsupported-system math, ' +
      'swinginess). Pass back `roster` (the returned plan) with a `tune` op to reroll all/one slot, swap, adjust ' +
      'count, or pin — deterministic by the per-slot seeds so pinned slots survive re-rolls. Requires campaign ' +
      'membership; any member/AI may preview. Nothing is persisted — commit via POST .../encounters/commit. ' +
      'Same honesty contract as /generate (issue #1928): the target difficulty SIZES the roster for every ' +
      'system, but the REPORTED `difficulty` is that system\'s own audited math only under ' +
      '`difficultySupport: \'supported\'`. A registered non-5e system returns `\'heuristic\'` with ' +
      '`difficulty.status: \'unsupported\'` and a null band — the absence of a rating, not a 5e-shaped one.',
  })
  @ApiResponse({
    status: 200,
    description:
      'Read-only preview: roster + inspection + difficulty explanation + `difficultySupport` + ' +
      '`matchedBand` + warnings + fallbacks. `matchedBand` describes the 5e-shaped SIZING pass only and ' +
      'can be true beside an `unsupported` difficulty — never report it as an achieved difficulty when ' +
      '`difficultySupport` is `heuristic`.',
  })
  async preview(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: EncounterPreviewDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireMember(user, campaignId);
    return this.encounters.previewEncounter(campaignId, body, role);
  }

  @Post('commit')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Commit a tuned encounter roster (issue #412)',
    description:
      'dm role + write mode required. Atomically creates the encounter with its combatants and optional ' +
      'location/quest/session links, battle map/grid, and token placement in ONE transaction — never a partial ' +
      'encounter or duplicate combatants. IDEMPOTENT: a retry with the same `idempotencyKey` returns the SAME ' +
      'encounter. Created hidden + `preparing` by default (DM prep, #262). Audits source, inputs, roster, and manual edits.',
  })
  @ApiResponse({ status: 201, description: '{ encounter, idempotent }. idempotent=true when a prior commit with this key was replayed.' })
  @ApiResponse({ status: 400, description: 'A roster creature/link/map is invalid (refresh the preview).' })
  @ApiResponse({ status: 403, description: 'Requires the dm role + write mode.' })
  async commit(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: EncounterCommitDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.encounters.commitGeneratedEncounter(campaignId, body, user, role);
  }

  @Get()
  @ApiOperation({ summary: 'List encounters in a campaign', description: 'Requires campaign membership.' })
  @ApiQuery({ name: 'status', required: false, enum: ['preparing', 'running', 'ended'], description: 'Filter to a single encounter status.' })
  @ApiQuery({ name: 'q', required: false, type: String, description: 'Unicode-aware case-folded substring search over encounter name (issue #490).' })
  @ApiResponse({ status: 200, description: 'Encounters in the campaign, sorted running → preparing → ended then by updatedAt desc.' })
  async list(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Query('status') status: EncounterStatus | undefined,
    @Query('q') q: string | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    if (status !== undefined && status !== 'preparing' && status !== 'running' && status !== 'ended') {
      throw new BadRequestException("status must be one of: 'preparing', 'running', 'ended'");
    }
    // The caller's role drives entity-level secrecy (issue #262): a non-DM never sees a
    // hidden (prepared, not-yet-sprung) encounter in the list.
    const role = await this.access.requireMember(user, campaignId);
    return this.encounters.listForCampaign(campaignId, status, role, q);
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
    const role = await this.access.requireMemberOnWritableCampaign(user, campaignId);
    return this.encounters.rollDiceForCampaign(campaignId, body, user, role);
  }

  /** Native Open Legend-style action dice: attribute score -> exploding pool. */
  @Post('action')
  @ApiOperation({
    summary: 'Roll native action dice',
    description:
      'Any campaign member. For adapters with an attribute dice pool (Open Legend), sends a native attribute score; ' +
      'the server resolves the exploding pool, rolls with crypto RNG, persists one campaign-shared dice-log event, ' +
      'and returns the full pool/explosion/disadvantage breakdown.',
  })
  @ApiResponse({ status: 201, description: 'Persisted action roll with pool and explosion breakdown.' })
  @ApiResponse({ status: 400, description: 'Campaign rule system does not support action dice, or score is invalid.' })
  async rollAction(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: ActionRollRequestDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireMemberOnWritableCampaign(user, campaignId);
    return this.encounters.rollActionDiceForCampaign(campaignId, body, user, role);
  }

  /** Log a paper-table / physical roll without Campfire generating dice (issue #673). */
  @Post('manual')
  @ApiOperation({
    summary: 'Log a physical roll',
    description:
      'Any campaign member. Records the total (and optional label, actor, natural d20, DC) a player reported from off-screen dice. ' +
      'The entry is marked manual — no fabricated dice, keep/drop, or crit/fumble — and appears in the shared dice log, export, and recap source material.',
  })
  @ApiResponse({ status: 201, description: 'Persisted manual roll with honest provenance.' })
  async logPhysicalRoll(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: ManualRollRequestDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireMemberOnWritableCampaign(user, campaignId);
    return this.encounters.logPhysicalRollForCampaign(campaignId, body, user, role);
  }
}

@ApiTags('encounters')
@Controller('encounters')
export class EncountersController {
  constructor(
    private readonly encounters: EncountersService,
    private readonly access: CampaignAccessService,
    private readonly encounterMaps: EncounterMapService,
    private readonly actions: ActionResolverService,
  ) {}

  @Get(':id')
  @ApiOperation({ summary: 'Get an encounter with its combatants', description: 'Requires campaign membership.' })
  @ApiResponse({ status: 200, description: 'Encounter with combatants.' })
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    // The caller's role drives issue #43 redaction: a non-DM viewer gets monster
    // HP as a coarse band, never exact numbers.
    const role = await this.access.requireMember(user, row.campaignId);
    return this.encounters.getWithCombatantsOrThrow(id, role, user.id);
  }

  /**
   * Responsive-ladder manifest for this encounter's battle map (issue #604).
   *
   * Deliberately encounter-scoped: the run view needs each rung's real pixel width
   * to emit an accurate `srcset`, but a player must never be able to read an
   * attachment route for a fog-protected map (#463). Only dimensions/state are
   * returned — never bytes — and every URL the client mints from them still goes
   * through GET :id/map, which re-applies the role/fog rules per request.
   */
  @Get(':id/map/derivatives')
  @ApiOperation({
    summary: 'Responsive derivative status for an encounter battle map',
    description:
      'Requires campaign membership. Returns per-rung state and the real pixel dimensions of ready rungs so the client ' +
      'can build a srcset for GET :id/map?size=… . Discloses no bytes and no attachment metadata (issue #604).',
  })
  @ApiResponse({ status: 200, description: 'Derivative manifest for the encounter map.' })
  @ApiResponse({ status: 404, description: 'Encounter has no battle map, or the caller is not a member.' })
  async mapDerivatives(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId);
    return this.encounterMaps.derivativeManifest(this.encounters.encounterForMapOrThrow(row, role));
  }

  @Get(':id/map')
  @ApiOperation({
    summary: 'Get the role-safe battle-map image for an encounter',
    description:
      'Requires campaign membership. DMs receive the source map. When fog conceals pixels, non-DMs receive an ' +
      'opaque server-rendered PNG containing only revealed regions; the source attachment remains inaccessible. ' +
      'Responses are private/no-store and byte ranges are rejected so role or fog revisions cannot leak through caches.',
  })
  @ApiQuery({ name: 'size', required: false, enum: [...DERIVATIVE_VARIANT_NAMES], description: 'Omit for full resolution; `thumb` (512px), `md` (1280px) or `lg` (2560px) cap the longest edge (issue #604).' })
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
    // Issue #604: the battle map serves the same responsive ladder as every other
    // attachment, so a phone does not download a 2560px board. Validation mirrors
    // the attachment bytes route exactly.
    if (size !== undefined && !isDerivativeVariantName(size)) {
      throw new BadRequestException(
        `Unsupported size — allowed: ${DERIVATIVE_VARIANT_NAMES.map((v) => `'${v}'`).join(', ')} (or omit for the original)`,
      );
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
      size !== undefined && isDerivativeVariantName(size) ? size : 'original',
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
        // Issue #604: which responsive rung these bytes are. 'original-fallback'
        // tells the run view its derivatives are still processing (or failed), so
        // it can show that state rather than silently serving a full-size board.
        'X-Campfire-Derivative': view.derivative,
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

  @Get(':id/aftermath')
  @ApiOperation({
    summary: 'Post-encounter aftermath workflow (issue #473)',
    description:
      'DM only. Read-only hand-off for an ended encounter: outcome review, recap draft seeded from ' +
      'the combat log, adapter-aware XP guidance, and deep links to loot/treasury, quest, and recap surfaces.',
  })
  @ApiResponse({ status: 200, description: 'Aftermath read model with recap draft and hand-off links.' })
  @ApiResponse({ status: 400, description: 'Encounter is not ended.' })
  async aftermath(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.encounters.getAftermath(id, role);
  }

  @Post(':id/aftermath/dismiss')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Defer the aftermath panel (issue #473)',
    description:
      'DM only. Idempotent — records that the DM chose to skip/defer the post-encounter workflow. ' +
      'Cleared automatically when the encounter is reopened.',
  })
  @ApiResponse({ status: 200, description: '{ dismissedAt } timestamp.' })
  async dismissAftermath(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.encounters.dismissAftermath(id, user, role);
  }

  @Post(':id/aftermath/apply-xp')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Apply XP or milestone award from encounter aftermath (issue #1448)',
    description: 'DM only. Idempotent award of encounter XP or milestone progress to party characters.',
  })
  @ApiResponse({ status: 200, description: 'Updated aftermath read model with XP award status.' })
  async applyAftermathXp(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: EncounterAftermathApplyXpInputDto,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.encounters.applyAftermathXp(id, body, user, role);
  }

  @Post(':id/aftermath/transfer-loot')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Transfer loot item or currency from encounter aftermath (issue #1448)',
    description: 'DM only. Transfer aftermath loot directly to character inventory or party treasury.',
  })
  @ApiResponse({ status: 200, description: 'Updated aftermath read model with claimed loot.' })
  async transferAftermathLoot(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: EncounterAftermathLootTransferInputDto,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.encounters.transferAftermathLoot(id, body, user, role);
  }

  @Post(':id/aftermath/update-quest')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Update quest objectives or status from encounter aftermath (issue #1448)',
    description: 'DM only. Update linked or specified quest status and objective completion.',
  })
  @ApiResponse({ status: 200, description: 'Updated aftermath read model.' })
  async updateAftermathQuest(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: EncounterAftermathQuestUpdateInputDto,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.encounters.updateAftermathQuest(id, body, user, role);
  }

  @Post(':id/aftermath/update-beat')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Update or create a storyline beat from encounter aftermath (issue #1448)',
    description: 'DM only. Update existing storyline beat or create a beat linked to encounter.',
  })
  @ApiResponse({ status: 200, description: 'Updated aftermath read model.' })
  async updateAftermathBeat(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: EncounterAftermathBeatUpdateInputDto,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.encounters.updateAftermathBeat(id, body, user, role);
  }

  @Post(':id/aftermath/add-timeline-event')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Add a timeline event from encounter aftermath (issue #1448)',
    description: 'DM only. Create a campaign timeline event from aftermath details.',
  })
  @ApiResponse({ status: 200, description: 'Updated aftermath read model.' })
  async addAftermathTimelineEvent(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: EncounterAftermathTimelineEventInputDto,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.encounters.addAftermathTimelineEvent(id, body, user, role);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update an encounter',
    description:
      "dm role required. Edit the name, attach/clear a location/quest/session link (issue #126), and/or attach/clear the battle map via mapAttachmentId (issue #39). " +
      'Optionally pass `expectedUpdatedAt` (the updatedAt you last read) to opt into optimistic concurrency (issue #532): ' +
      'a stale value returns 409 Conflict instead of silently clobbering a fresher edit from another DM tab or a connected AI. ' +
      'An ended encounter rejects all field writes with 409 — reopen it first (issues #163, #470).',
  })
  @ApiResponse({ status: 200, description: 'Updated encounter with combatants.' })
  @ApiResponse({ status: 400, description: 'mapAttachmentId does not exist in this campaign.' })
  @ApiResponse({ status: 404, description: 'A linked location/quest/session id is not in this encounter\'s campaign.' })
  @ApiResponse({ status: 409, description: 'Stale expectedUpdatedAt, or the encounter has ended — reopen it before editing map/grid/fog/links (issues #163, #470).' })
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
    // prepared fight exists via ping — 404, matching roster/events/difficulty. Issue
    // #1636: this stays `requireMember` (not `requireRole('player')`) DELIBERATELY —
    // requireRole would 403 a viewer before pingMap's hidden-visibility check ever
    // runs, which would leak a hidden encounter's existence to a viewer via 403
    // instead of the 404 issue #869 requires. The "any DM or player" role floor is
    // enforced inside pingMap itself, AFTER the hidden check, so hidden stays 404 for
    // everyone non-DM while a merely-visible encounter now correctly 403s a viewer.
    const role = await this.access.requireMemberOnWritableCampaign(user, row.campaignId);
    this.encounters.pingMap(id, row.campaignId, { ...body, senderId: user.id, senderName: user.name }, role, row.hidden);
    return { ok: true };
  }

  @Post(':id/aoe-templates')
  @ApiOperation({
    summary: 'Declare an AoE template',
    description: 'Any writing DM or player may declare one template. The server records the authenticated caller as its declarer; callers cannot supply attribution.',
  })
  @ApiResponse({ status: 201, description: 'Created template.' })
  async declareAoeTemplate(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: AoeTemplateDeclareDto,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.encounters.getRowOrThrow(id);
    // As with map pings, the service checks the player floor only after hidden
    // visibility so a viewer probing hidden preparation receives a 404, not a leak.
    const role = await this.access.requireMemberOnWritableCampaign(user, row.campaignId);
    return this.encounters.declareAoeTemplate(id, body, user, role);
  }

  @Patch(':id/aoe-templates/:templateId')
  @ApiOperation({ summary: 'Update an AoE template', description: 'A player may change only their own declaration; a DM may change any template while preserving its declarer.' })
  @ApiResponse({ status: 200, description: 'Updated template.' })
  async updateAoeTemplate(
    @Param('id', ParseIntPipe) id: number,
    @Param('templateId') templateId: string,
    @Body() body: AoeTemplateUpdateDto,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireMemberOnWritableCampaign(user, row.campaignId);
    return this.encounters.updateAoeTemplate(id, templateId, body, user, role);
  }

  @Delete(':id/aoe-templates/:templateId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Remove an AoE template', description: 'A player may remove only their own declaration; a DM may remove any template.' })
  @ApiResponse({ status: 200, description: 'Removed template.' })
  async removeAoeTemplate(
    @Param('id', ParseIntPipe) id: number,
    @Param('templateId') templateId: string,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireMemberOnWritableCampaign(user, row.campaignId);
    return this.encounters.removeAoeTemplate(id, templateId, user, role);
  }

  @Get(':id/events')
  @ApiOperation({
    summary: "List an encounter's persistent combat log",
    description:
      'Requires campaign membership. Chronological per-encounter event history (damage/heal, conditions, deaths, turns) that survives reload — issue #61. Hidden encounters 404 for non-DMs; hidden NPC identities are masked via current role-aware projection (issue #869). Details record only HP deltas / name-free outcomes, never a monster’s exact HP totals. `?afterId=<id>` returns only events with an id greater than the cursor, enabling incremental log fetches.',
  })
  @ApiQuery({ name: 'afterId', required: false, type: Number, description: 'Only return events with id greater than this cursor (for incremental updates).' })
  @ApiResponse({ status: 200, description: 'Encounter events in chronological order.' })
  @ApiResponse({ status: 404, description: 'Encounter not found, or hidden from this viewer.' })
  async events(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: RequestUser,
    @Query('afterId') afterId?: string,
    @Headers('if-none-match') ifNoneMatch?: string,
  ) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId);
    if (!isVisibleTo({ hidden: row.hidden }, role)) {
      throw new NotFoundException();
    }
    if (afterId !== undefined) {
      const parsed = Number(afterId);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new BadRequestException('afterId must be a non-negative integer');
      }
      return this.encounters.listEvents(id, role, parsed);
    }
    const headId = await this.encounters.getEventsHeadId(id);
    const etag = headId === null ? '"empty"' : `"${headId}"`;
    if (ifNoneMatch === etag) {
      throw new HttpException('Not Modified', HttpStatus.NOT_MODIFIED);
    }
    const result = await this.encounters.listEvents(id, role);
    return result;
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete (trash) an encounter', description: 'dm role required. Soft-delete (issue #701) — combatants, logs, map, and links survive for restore.' })
  @ApiResponse({ status: 200, description: 'Trashed.' })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    await this.encounters.remove(id, user, role);
    return { ok: true };
  }

  @Post(':id/restore')
  @ApiOperation({ summary: 'Restore a trashed encounter', description: 'dm role required. Undo a soft-delete (issue #701) — the encounter returns with its roster and log intact.' })
  @ApiResponse({ status: 201, description: 'Restored encounter.' })
  async restore(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id, true);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.encounters.restore(id, user, role);
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

  @Post(':id/combatants/:cid/resources')
  @ApiOperation({
    summary: 'Spend or restore one combatant resource or spell-slot level (issue #1909)',
    description:
      'dm or the owning player (of a character-linked combatant); a statblock combatant (no linked character) is ' +
      'dm-only, matching PATCH .../combatants/:cid\'s statblock rule. Exactly one of `key` (feature resource) or ' +
      '`spellLevel` (1-9) plus a `delta` (default +1). `key` must name a resource that already exists on the ' +
      'combatant/character — an unknown key 400s naming it, the same as an out-of-range `spellLevel`; this never ' +
      'creates a new resource. Delta-based and transactional: unlike a whole-statblock or ' +
      'whole-character PATCH built from a stale client read, this reads the row fresh inside the write, so two ' +
      'concurrent single-pip spends on DIFFERENT resources on the SAME sheet/statblock both persist. Optional ' +
      '`expectedUsed`: the resource\'s `used` this caller last rendered — if another writer already changed it, ' +
      'the request 409s instead of silently applying `delta` on top of that new value (protects an ABSOLUTE pip ' +
      'intent converted client-side to a relative delta; omit for a purely relative intent). Records a ' +
      '`resource_changed` encounter event.',
  })
  @ApiResponse({
    status: 201,
    description:
      'The combatant. For a statblock combatant (no linked character) this reflects the committed spend/restore — ' +
      'the statblock lives on the combatant row itself. For a character-linked combatant the resource lives on the ' +
      'CHARACTER sheet instead, which this response does not re-read (a Combatant has no resources/spellSlots ' +
      'field) — read GET /characters/:id separately to confirm the committed value.',
  })
  @ApiResponse({ status: 400, description: 'Overspend/over-restore outside [0, max]; `key` names a resource that does not already exist on the combatant/character; or the combatant has no sheet/inline-statblock resources.' })
  @ApiResponse({ status: 409, description: '`expectedUsed` no longer matches the resource\'s current `used` — another writer changed it first.' })
  @ApiResponse({ status: 403, description: 'Not the dm or the owning player, or a non-dm targeting a statblock combatant.' })
  async adjustCombatantResource(
    @Param('id', ParseIntPipe) id: number,
    @Param('cid', ParseIntPipe) cid: number,
    @Body() body: CombatantResourceAdjustDto,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.encounters.getRowOrThrow(id, true);
    // Issue #1909 review (Devin): `requireRole(..., 'player')` below throws 403 for a
    // viewer BEFORE the service's own `isVisibleTo` gate is ever reached — a viewer hitting
    // a HIDDEN encounter's real id would get 403, distinguishable from the 404 a nonexistent
    // id gets (an enumeration oracle). Pre-check visibility at the VIEWER floor first, same
    // as the sibling death-save/roll-initiative routes just below, so a hidden encounter is
    // 404 for every non-DM regardless of whether they'd otherwise pass the player-role gate.
    //
    // Issue #1909 review round 2 (Codex): the ORIGINAL fix above still called
    // `requireRole(..., 'viewer')` with no `allowArchived`, so `assertWritable` 403'd EVERY
    // member on a paused/completed campaign before this line's `isVisibleTo` check could
    // ever run — reopening the same oracle, now keyed on campaign archival instead of role:
    // a hidden encounter that exists 403'd, a nonexistent id still 404'd. `allowArchived:
    // true` on both this visibility precheck and the role gate below (mirroring
    // `rollDeathSave`/`rollCombatantInitiative` exactly, including retaining a soft-deleted
    // encounter row via `getRowOrThrow(id, true)` for a same-key replay) restores the
    // archived-agnostic 404 here; the service's own transactional
    // `assertCampaignWritableInTx` (added in an earlier round of this same PR) still
    // rejects a FRESH write against an archived campaign, so archived-campaign writes stay
    // correctly blocked — just no longer distinguishably from "doesn't exist" at this gate.
    await this.access.requireMember(user, row.campaignId, { allowArchived: true });
    if (!isVisibleTo({ hidden: row.hidden }, await this.access.requireRole(user, row.campaignId, 'viewer', { allowArchived: true }))) {
      throw new NotFoundException(`Encounter ${id} not found`);
    }
    // A same-key retry only replays an already-committed response. Let the service
    // distinguish that safe read from a fresh write after membership is established.
    const role = await this.access.requireRole(user, row.campaignId, 'player', { allowArchived: true });
    return this.encounters.adjustCombatantResource(id, cid, body, user, role);
  }

  @Post(':id/combatants/:cid/death-save')
  @ApiOperation({
    summary: 'Roll a death save',
    description:
      'The server rolls exactly one d20 for a dying character combatant, applies that same face to the 5e death-save lifecycle, audits the write, and records one matching campaign-shared dice-log entry. The caller cannot provide a die result.',
  })
  @ApiResponse({ status: 201, description: 'The updated combatant and the single authoritative dice-log roll.' })
  @ApiResponse({ status: 400, description: 'Combatant is not a dying character.' })
  @ApiResponse({ status: 403, description: 'Not the DM or owning player, or campaign is archived.' })
  @ApiResponse({ status: 404, description: 'Encounter was deleted or does not exist.' })
  async rollDeathSave(
    @Param('id', ParseIntPipe) id: number,
    @Param('cid', ParseIntPipe) cid: number,
    @Body() body: DeathSaveRollDto,
    @CurrentUser() user: RequestUser,
  ) {
    // A same-key retry is a read of the stored response, so retain the soft-deleted
    // encounter long enough to establish current membership. Fresh writes are rejected
    // by the transaction-local mutable check in the service.
    const row = await this.encounters.getRowOrThrow(id, true);
    await this.access.requireMember(user, row.campaignId, { allowArchived: true });
    if (!isVisibleTo({ hidden: row.hidden }, await this.access.requireRole(user, row.campaignId, 'viewer', { allowArchived: true }))) {
      throw new NotFoundException(`Encounter ${id} not found`);
    }
    // A same-key retry only replays an already-committed response. Let the service
    // distinguish that safe read from a fresh write after membership is established.
    const role = await this.access.requireRole(user, row.campaignId, 'player', { allowArchived: true });
    return this.encounters.rollDeathSave(id, cid, body.idempotencyKey, user, role);
  }

  @Post(':id/combatants/:cid/roll-initiative')
  @ApiOperation({
    summary: 'Roll initiative for one combatant',
    description:
      'dm role required for any combatant; a player may roll only a combatant linked to a character they own. The server rolls adapter.initiativeDie + initMod, writes the breakdown, audits the write, and records one matching campaign-shared dice-log entry (skipped for a hidden encounter). 409 if initiative is already set unless the DM passes overwrite: true. 400 for a group-initiative rule system — a side shares one roll; use the bulk POST .../roll-initiative instead.',
  })
  @ApiResponse({ status: 201, description: 'The updated combatant and the dice-log roll (null when the encounter is hidden).' })
  @ApiResponse({ status: 400, description: 'The active rule system uses group initiative — roll for the whole side via the bulk endpoint instead.' })
  @ApiResponse({ status: 403, description: 'Not the DM or owning player.' })
  @ApiResponse({ status: 404, description: 'Encounter or combatant was deleted or does not exist.' })
  @ApiResponse({ status: 409, description: 'Initiative is already set for this combatant.' })
  async rollCombatantInitiative(
    @Param('id', ParseIntPipe) id: number,
    @Param('cid', ParseIntPipe) cid: number,
    @Body() body: CombatantRollInitiativeDto,
    @CurrentUser() user: RequestUser,
  ) {
    // A same-key retry is a read of the stored response, so retain the soft-deleted
    // encounter long enough to establish current membership. Fresh writes are rejected
    // by the transaction-local mutable check in the service.
    const row = await this.encounters.getRowOrThrow(id, true);
    await this.access.requireMember(user, row.campaignId, { allowArchived: true });
    if (!isVisibleTo({ hidden: row.hidden }, await this.access.requireRole(user, row.campaignId, 'viewer', { allowArchived: true }))) {
      throw new NotFoundException(`Encounter ${id} not found`);
    }
    // A same-key retry only replays an already-committed response. Let the service
    // distinguish that safe read from a fresh write after membership is established.
    const role = await this.access.requireRole(user, row.campaignId, 'player', { allowArchived: true });
    return this.encounters.rollCombatantInitiative(id, cid, body.idempotencyKey, body.overwrite, user, role);
  }

  @Post(':id/token-batches/preview') @HttpCode(200)
  @ApiOperation({ summary: 'Preview a token batch placement', description: 'dm role required. Returns the computed placements without applying them.' })
  async previewTokenBatch(@Param('id', ParseIntPipe) id: number, @Body() body: TokenBatchPreviewDto, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id); const role = await this.access.requireRole(user, row.campaignId, 'dm'); return this.encounters.previewTokenBatch(id, body, user, role);
  }
  @Post(':id/token-batches/apply')
  @ApiOperation({ summary: 'Apply a token batch placement', description: 'dm role required. Idempotently places tokens using the preview token.' })
  async applyTokenBatch(@Param('id', ParseIntPipe) id: number, @Body() body: TokenBatchApplyDto, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id); const role = await this.access.requireRole(user, row.campaignId, 'dm'); return this.encounters.applyTokenBatch(id, body, user, role);
  }
  @Post(':id/token-batches/undo')
  @ApiOperation({ summary: 'Undo a token batch placement', description: 'dm role required. Reverts the tokens placed by the matching apply call.' })
  async undoTokenBatch(@Param('id', ParseIntPipe) id: number, @Body() body: TokenBatchUndoDto, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id); const role = await this.access.requireRole(user, row.campaignId, 'dm'); return this.encounters.undoTokenBatch(id, body, user, role);
  }

  @Delete(':id/combatants/:cid')
  @ApiOperation({ summary: 'Remove a combatant', description: 'dm role required. Returns a server-issued, one-use undoToken valid for 30 seconds; reuse an optional idempotencyKey after a lost response.' })
  @ApiResponse({ status: 200, description: 'Removal receipt: undoToken, encounterId, and combatantId.' })
  async removeCombatant(@Param('id', ParseIntPipe) id: number, @Param('cid', ParseIntPipe) cid: number, @Body() body: CombatantRemoveRequestDto, @CurrentUser() user: RequestUser) {
    // A same-key retry only reads its committed receipt; keep a trashed row long
    // enough to authenticate the DM, while the service rejects fresh writes.
    const row = await this.encounters.getRowOrThrow(id, true);
    const role = await this.access.requireRole(user, row.campaignId, 'dm', { allowArchived: true });
    return this.encounters.removeCombatant(id, cid, user, role, body.idempotencyKey);
  }

  @Post(':id/combatants/undo-remove')
  @ApiOperation({ summary: 'Undo combatant removal', description: 'dm role required. Restores the exact combatant snapshot once while its undo token is valid.' })
  async undoRemoveCombatant(@Param('id', ParseIntPipe) id: number, @Body() body: CombatantRemoveUndoDto, @CurrentUser() user: RequestUser) {
    // A consumed-token retry is likewise a safe read; the service applies the
    // mutable lifecycle gate only to the first restoration.
    const row = await this.encounters.getRowOrThrow(id, true);
    const role = await this.access.requireRole(user, row.campaignId, 'dm', { allowArchived: true });
    return this.encounters.undoRemoveCombatant(id, body.undoToken, user, role);
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
  @ApiOperation({
    summary: 'Advance to the next turn',
    description:
      'dm role required. Wraps turnIndex to 0 and increments round when past the last combatant. ' +
      'Issue #580 — the body is optional but strongly recommended for interactive clients: ' +
      '`idempotencyKey` (a client-minted id for ONE logical click) makes a retry after a lost ' +
      'response replay the original result instead of advancing twice, and ' +
      '`expectedCurrentCombatantId` compare-and-swaps against the live turn pointer so a second ' +
      'device advancing simultaneously gets a 409 rather than silently skipping a combatant.',
  })
  @ApiResponse({ status: 201, description: 'Encounter with advanced round/turnIndex (or the replayed original response for a retried idempotencyKey).' })
  @ApiResponse({ status: 400, description: 'Encounter is not running.' })
  @ApiResponse({ status: 409, description: 'The turn already advanced (expectedCurrentCombatantId CAS), or the idempotencyKey was reused for a different action.' })
  async nextTurn(@Param('id', ParseIntPipe) id: number, @Body() body: EncounterNextTurnDto, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.encounters.nextTurn(id, body ?? {}, user, role);
  }

  @Post(':id/escalation')
  @ApiOperation({
    summary: 'Set 13th Age escalation die controls',
    description:
      'dm role required. For 13th Age encounters, hold automatic round-based escalation and/or set/clear a DM override (0–6). The server records structured history and combat-log entries.',
  })
  @ApiResponse({ status: 201, description: 'Encounter with updated escalation die state.' })
  @ApiResponse({ status: 400, description: 'Not a 13th Age encounter, or invalid override.' })
  async escalation(@Param('id', ParseIntPipe) id: number, @Body() body: EncounterEscalationUpdateDto, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.encounters.updateEscalationDie(id, body, user, role);
  }

  @Get(':id/turn')
  @ApiOperation({
    summary: 'Get the current-turn workspace (issue #413)',
    description:
      'Requires campaign membership. The focused "what can I do now?" view for the active combatant: prominent actor / ' +
      'round / next actor, a "your turn" flag, the adapter-defined action-economy slots with plain-language help + live ' +
      'usage, movement / reaction / concentration / active effects, suggested actions from the sheet or statblock, and ' +
      'the start/end-of-turn prompts to resolve before advancing. The detailed workspace is only populated for the DM ' +
      'or the user who owns the current combatant’s character — other viewers get identity + round only (secrecy).',
  })
  @ApiResponse({ status: 200, description: 'The current-turn workspace.' })
  async turn(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId);
    return this.encounters.getTurnWorkspace(id, user, role);
  }

  @Post(':id/end-turn')
  @ApiOperation({
    summary: 'End the current combatant’s turn (issue #413)',
    description:
      'Any campaign member with write access. The DM may always end the current turn; a PLAYER may end the turn of ' +
      'their OWN active character when the campaign allows player advancement (dmControlsTurns=false). The server ' +
      'validates ownership + that it is actually that combatant’s turn, serializes advancement, and guards against ' +
      'double-advance via the optional expectedCurrentCombatantId (a stale click after someone else advanced returns ' +
      '409). When the campaign requires DM confirmation, a player end-turn is staged (409) and the DM advances it ' +
      'directly (a DM end-turn / next-turn is the confirmation). Advancing resolves start/end-of-turn effects and logs structured combat-log events.',
  })
  @ApiResponse({ status: 201, description: 'Encounter advanced to the next turn.' })
  @ApiResponse({ status: 400, description: 'Encounter is not running / no current combatant.' })
  @ApiResponse({ status: 403, description: 'Not the DM or the owning player of the current combatant, or DM-only advancement is set.' })
  @ApiResponse({ status: 409, description: 'The turn already advanced (double-advance guard) or DM confirmation is required.' })
  async endTurn(@Param('id', ParseIntPipe) id: number, @Body() body: EncounterEndTurnDto, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'player');
    return this.encounters.endTurn(id, body, user, role);
  }

  @Post(':id/undo-turn')
  @ApiOperation({
    summary: 'Undo the last turn advance (issue #413)',
    description:
      'dm role required. Steps the turn pointer BACKWARD (decrementing the round when unwrapping past the top). ' +
      'Timed conditions and active effects ticked while advancing are restored automatically from a snapshot.',
  })
  @ApiResponse({ status: 201, description: 'Encounter turn pointer moved back.' })
  @ApiResponse({ status: 400, description: 'Encounter is not running.' })
  async undoTurn(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'dm');
    return this.encounters.undoTurn(id, user, role);
  }

  @Post(':id/combatants/:cid/turn-state')
  @ApiOperation({
    summary: 'Declare / resolve turn state on a combatant (issue #413)',
    description:
      'Track the current turn’s action economy and effects: use/release/set an action-economy slot, spend movement, ' +
      'set/clear concentration, resolve the first pending concentration save, add/remove a structured active effect, or mark a combatant ' +
      'delaying / readying an action. The DM may edit any combatant; a player only a combatant linked to a character ' +
      'they own. Changes compose atomically under concurrency.',
  })
  // 201, not 200: this is a POST with no @HttpCode, so Nest sends its POST default.
  // The annotation claimed 200 while encounters.e2e-spec.ts has always pinned 201
  // (issue #1538) — the runtime was right and the docs were wrong. Correcting the
  // runtime instead would be an observable API change for existing clients, so the
  // annotation is what moves.
  @ApiResponse({ status: 201, description: 'Updated combatant.' })
  @ApiResponse({ status: 403, description: 'Not the DM or the owning player.' })
  async turnState(
    @Param('id', ParseIntPipe) id: number,
    @Param('cid', ParseIntPipe) cid: number,
    @Body() body: CombatantTurnStatePatchDto,
    @CurrentUser() user: RequestUser,
  ) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'player');
    return this.encounters.updateCombatantTurnState(id, cid, body, user, role);
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

  // ---------- structured action resolver (issue #414) ----------

  @Get(':id/combatants/:cid/actions')
  @ApiOperation({
    summary: 'List a combatant’s usable structured actions (issue #414, #1326)',
    description:
      'Requires campaign membership. Returns the combatant’s sheet actions with their structured spec + a `resolvable` ' +
      'flag (false ⇒ the UI shows the inline statblock rather than a guided Use flow). For a character, any currently ' +
      'EQUIPPED inventory item carrying an authored action is appended after the sheet actions (issue #1326). A player ' +
      'may list only their own character’s actions; the DM may list any combatant’s.',
  })
  @ApiResponse({ status: 200, description: 'Usable actions with resolvability + preserved freeform statblock text.' })
  @ApiResponse({ status: 403, description: 'A player listing another combatant’s actions.' })
  async usableActions(@Param('id', ParseIntPipe) id: number, @Param('cid', ParseIntPipe) cid: number, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireMember(user, row.campaignId);
    return this.actions.listUsableActions(id, cid, user, role);
  }

  @Post(':id/actions/resolve')
  @ApiOperation({
    summary: 'Resolve a structured action, optionally committing atomically (issue #414)',
    description:
      'Requires at least the player role (issue #1450). Rolls the attack or the targets’ saves with the correct modifiers, compares ' +
      'against AC / DC, classifies the outcome (5e hit/miss/crit or PF2e degrees), and returns a per-target PREVIEW with ' +
      'player-safe text separated from DM-only mechanics. A player may resolve only their OWN active character’s action (a ' +
      'monster/NPC action is DM-only) but may target anyone — so a player can finish an attack against a monster ' +
      'end-to-end. Pass `commit: true` to apply atomically in the same call when the campaign policy permits (automatic); ' +
      'otherwise the result is a declaration the DM applies (dm-confirmed / player-declares). An unsupported action shape ' +
      'is a 400 (fall back to its statblock — never silent math). Every response carries ' +
      '`systemMathSupported` and `mathProfile` (issue #1928): the flag is false whenever this ' +
      'campaign’s rule system has NOT been audited end-to-end against the resolver’s maths, and it ' +
      'does NOT tell you which maths ran — OSR and Open Legend supply their own `resolveAttack` ' +
      '(descending-AC comparison, exploding dice pools) and are still reported false. Read ' +
      '`mathProfile` for what actually executed: it names the audited profile in force, or is null. ' +
      'Label, don’t block — resolution still runs and, under `commit: true`, still applies.',
  })
  @ApiResponse({
    status: 200,
    description:
      'The resolution preview (and applied result + undo token when committed), including ' +
      '`systemMathSupported` / `mathProfile` — see the operation description before presenting a ' +
      'result as system-correct.',
  })
  @ApiResponse({ status: 400, description: 'The action has no resolvable structured spec, or a target has no known AC/DC.' })
  @ApiResponse({ status: 403, description: 'A player resolving a monster/NPC action or another player’s character.' })
  @HttpCode(200)
  async resolveAction(@Param('id', ParseIntPipe) id: number, @Body() body: ActionResolveRequestDto, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    // Issue #1450: `requireMember(..., { write: true })` only asserts the CAMPAIGN is
    // writable, not that the CALLER has write authority — it returns a viewer's role
    // unchanged. This route writes HP/conditions/effects, so it needs requireRole('player').
    const role = await this.access.requireRole(user, row.campaignId, 'player');
    return this.actions.resolve(id, body, user, role);
  }

  @Post(':id/actions/apply')
  @ApiOperation({
    summary: 'Apply a resolved action chain (issue #414 confirm path)',
    description:
      'Requires at least the player role (issue #1450). Pass the `chainId` returned by /actions/resolve — a LOOKUP KEY ' +
      'only (issue #1451): the server re-reads the exact resolution it computed and persisted at resolve time, so a ' +
      'caller cannot inflate damage, alter a per-target delta, or inject a condition/effect never in the resolved spec. ' +
      'The DM may apply any resolution; a player only their own active character’s action under an automatic policy. Returns ' +
      'an undo token that reverses the whole apply.',
  })
  @ApiResponse({ status: 200, description: 'Applied; returns the undo token.' })
  @ApiResponse({ status: 400, description: 'Unknown, cross-encounter, or already-applied chainId.' })
  @ApiResponse({ status: 403, description: 'Not permitted to apply under the campaign policy.' })
  @HttpCode(200)
  async applyAction(@Param('id', ParseIntPipe) id: number, @Body() body: ActionApplyRequestDto, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    // Issue #1450: see resolveAction — write:true does not assert caller authority.
    const role = await this.access.requireRole(user, row.campaignId, 'player');
    return this.actions.apply(id, body, user, role);
  }

  @Post(':id/actions/undo')
  @ApiOperation({
    summary: 'Undo an applied action resolution (issue #414)',
    description:
      'Requires at least the player role (issue #1450). Restores every target’s HP / temp HP / death state / conditions to the ' +
      'pre-apply snapshot, removes the effects the apply added, and refunds the actor’s action-economy slot, spell slot, ' +
      'and concentration. The DM may undo any action; a player only one whose actor is their own character.',
  })
  @ApiResponse({ status: 200, description: 'Reversed.' })
  @HttpCode(200)
  async undoAction(@Param('id', ParseIntPipe) id: number, @Body() body: ActionUndoTokenDto, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    // Issue #1450: see resolveAction — write:true does not assert caller authority.
    const role = await this.access.requireRole(user, row.campaignId, 'player');
    return this.actions.undo(id, body, user, role);
  }

  @Post(':id/quick-roll')
  @ApiOperation({
    summary: 'Quick-roll an action to-hit or damage in an encounter (issue #1850)',
    description:
      'Rolls to-hit (d20+mod) or damage dice for a combatant action in one tap. Persists the roll to BOTH campaign dice_rolls feed AND encounter_events feed with character identity, roll kind, formula breakdown, nat20/nat1 status, and damage type icon.',
  })
  @ApiResponse({ status: 201, description: 'The rolled dice result and recorded encounter event.' })
  async quickRoll(@Param('id', ParseIntPipe) id: number, @Body() body: QuickRollRequestDto, @CurrentUser() user: RequestUser) {
    const row = await this.encounters.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'player');
    return this.encounters.quickRoll(id, body, user, role);
  }
}
