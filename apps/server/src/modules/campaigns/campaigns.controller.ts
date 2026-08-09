import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiConsumes, ApiResponse } from '@nestjs/swagger';
import { THROTTLE_AUTH, AUTH_THROTTLE_LIMIT, AUTH_THROTTLE_TTL_MS } from '../../common/throttle.constants';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ServerRoles } from '../../common/decorators/server-roles.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { CampaignsService } from './campaigns.service';
import { CampaignGovernanceService } from './campaign-governance.service';
import {
  CampaignCloneDto,
  CampaignCreateDto,
  CampaignCreationRequestCreateDto,
  CampaignCreationRequestDecisionDto,
  CampaignImportDto,
  CampaignPurgeDto,
  CampaignUpdateDto,
} from './campaigns.dto';

// Express.Multer.File augments the Express namespace via @types/multer; import side-effect only.
type MulterFile = Express.Multer.File;
/** Generous cap on the uploaded archive (mirrors MAX_IMPORT_ARCHIVE_BYTES in the service). */
const MAX_IMPORT_ARCHIVE_BYTES = 128 * 1024 * 1024;

/** Query flag for atomic invite revoke alongside archive/trash (#857). */
function truthyQuery(value: string | undefined): boolean {
  if (value == null) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

/**
 * Issue #851 review — the same strict bucket the forgot-password flow uses, for the same
 * reason: a self-service request that lands in an admin's queue and writes an audit row.
 *
 * The single-pending guard in CampaignGovernanceService is not a rate limit. It clears the
 * moment an admin decides the request, so a denied user can re-file immediately, and again
 * after the next denial — each round costing the admin a queue item and the audit log a row.
 * CastController does the same thing for an authenticated route, so reusing THROTTLE_AUTH
 * here follows the established pattern rather than introducing a new bucket.
 */
const CREATION_REQUEST_THROTTLE = Throttle({
  [THROTTLE_AUTH]: { limit: AUTH_THROTTLE_LIMIT, ttl: AUTH_THROTTLE_TTL_MS },
});

@ApiTags('campaigns')
@Controller('campaigns')
export class CampaignsController {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly access: CampaignAccessService,
    private readonly governance: CampaignGovernanceService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List campaigns accessible to the caller', description: 'Everyone — server admins included — sees only campaigns they are a member of (capped further by an active token\'s campaignId, if scoped). Dev-auth users see all campaigns.' })
  @ApiResponse({ status: 200, description: 'Accessible campaigns.' })
  list(@CurrentUser() user: RequestUser) {
    return this.campaigns.listForUser(user);
  }

  @Post()
  @ApiOperation({ summary: 'Create a campaign', description: 'Any authenticated user may create a campaign; the creator becomes its dm.' })
  @ApiResponse({ status: 201, description: 'Created campaign.' })
  create(@Body() body: CampaignCreateDto, @CurrentUser() user: RequestUser) {
    return this.campaigns.create(body, user);
  }

  @Post('import/preflight')
  @ApiOperation({
    summary: 'Preflight a Campfire export for compendium dependencies (issue #584)',
    description:
      'Validates compendiumRef resolution for every combatant in an export document before import mutates anything. ' +
      'Returns the open-license dependency manifest, per-reference resolution status, and whether import can proceed ' +
      '(or proceed in detached mode when compendiumSnapshot is present). Install missing packs via POST /rules/packs/install.',
  })
  @ApiResponse({ status: 201, description: 'Compendium dependency preflight report.' })
  @ApiResponse({ status: 400, description: 'Body is not a valid Campfire export document.' })
  async preflightImport(@Body() body: CampaignImportDto, @CurrentUser() _user: RequestUser) {
    return this.campaigns.preflightImport(body);
  }

  @Post('import')
  @ApiOperation({
    summary: 'Import a campaign from a Campfire JSON export',
    description:
      "Any authenticated user may import; the caller becomes the new campaign's dm. Accepts a Campfire JSON export document (the shape GET /campaigns/:id/export?format=json produces) and recreates the campaign with fresh ids and every intra-campaign reference remapped (location nesting, npc→location, quest parent/giver, combatant→character, note entity links, currentLocationId). Imported PCs come in unowned; status starts 'active'; an unknown ruleSystem is cleared. Members, audit and proposals are not imported. NOTE: a JSON export carries attachment METADATA only, so a JSON-only import has NO maps or portraits (mapAttachmentId/portraitUrl come in null). To carry maps/portraits across installs, export with format=mdzip and import the zip via POST /campaigns/import/archive.",
  })
  @ApiResponse({ status: 201, description: 'The newly created campaign.' })
  @ApiResponse({ status: 400, description: 'Body is not a valid Campfire export document.' })
  async importCampaign(@Body() body: CampaignImportDto, @CurrentUser() user: RequestUser) {
    // Issue #725: the service returns an ImportResult (campaign + imported/skipped/
    // failed counts); the HTTP contract stays "the newly created campaign" so the
    // documented API (and existing clients) are unchanged. The counts are available
    // to internal callers (MCP) via the service method directly.
    const result = await this.campaigns.importCampaign(body, user);
    return result.campaign;
  }

  @Post('import/archive')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Import a campaign from a Campfire ZIP export',
    description:
      "Any authenticated user may import; the caller becomes the new campaign's dm. Multipart upload (field `file`) of a Campfire mdzip export (GET /campaigns/:id/export?format=mdzip). Recreates the campaign exactly like POST /campaigns/import PLUS the attachments: the zip's embedded map/portrait/image bytes are written to the new campaign's uploads dir with fresh attachment rows, and campaign.mapAttachmentId, character.portraitUrl and encounter.mapAttachmentId are remapped to those new ids (issue #236). Attachment bytes are re-sniffed (png/jpeg/webp only) and size-capped; dangling/invalid entries are skipped.",
  })
  @ApiResponse({ status: 201, description: 'The newly created campaign.' })
  @ApiResponse({ status: 400, description: 'Missing file, or the archive is not a valid Campfire zip export.' })
  @ApiResponse({ status: 413, description: 'Uploaded archive exceeds the max size.' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMPORT_ARCHIVE_BYTES } }))
  async importArchive(@UploadedFile() file: MulterFile | undefined, @CurrentUser() user: RequestUser) {
    if (!file) throw new BadRequestException('Missing file (multipart field "file")');
    // Issue #725: the service returns an ImportResult (campaign + imported/skipped/
    // failed counts); the HTTP contract stays "the newly created campaign".
    const result = await this.campaigns.importArchive(file.buffer, user);
    return result.campaign;
  }

  @Get('trash')
  @ApiOperation({
    summary: 'List trashed (soft-deleted) campaigns',
    description:
      'The caller\'s campaigns currently in the trash (issue #116), newest-trashed first. Same membership scoping as GET /campaigns — a co-DM sees campaigns any co-DM trashed. Restore one with POST /campaigns/:id/restore, or permanently remove it with DELETE /campaigns/:id/purge.',
  })
  @ApiResponse({ status: 200, description: 'Trashed campaigns.' })
  listTrash(@CurrentUser() user: RequestUser) {
    return this.campaigns.listTrashedForUser(user);
  }

  @Get('allowance')
  @ApiOperation({
    summary: "The caller's effective campaign-creation allowance (issue #851)",
    description:
      'Any authenticated user. Reports the server-wide creation policy, active/total per-user and ' +
      'server-wide campaign counts against their configured limits, the operator default storage quota ' +
      'new campaigns inherit, and whether the caller already has a pending creation request. A display aid ' +
      'ONLY — POST /campaigns, /campaigns/import, /campaigns/import/archive, and /campaigns/:id/clone re-check ' +
      'every one of these server-side regardless of what this reports.',
  })
  @ApiResponse({ status: 200, description: 'Effective allowance for the caller.' })
  allowance(@CurrentUser() user: RequestUser) {
    return this.governance.getAllowance(user);
  }

  @Post('creation-requests')
  @CREATION_REQUEST_THROTTLE
  @ApiOperation({
    summary: 'Request campaign-creation access (issue #851)',
    description:
      "Any authenticated user. Files a 'pending' request an admin can approve or deny — the safe request/approval " +
      "flow for when settings.campaignCreationPolicy is 'admins_only' or 'approved_organizers'. 409 if the caller " +
      'already has an undecided request.',
  })
  @ApiResponse({ status: 201, description: 'The filed request.' })
  @ApiResponse({ status: 409, description: 'Caller already has a pending request.' })
  createCreationRequest(@Body() body: CampaignCreationRequestCreateDto, @CurrentUser() user: RequestUser) {
    return this.governance.createRequest(user, body.note);
  }

  @Get('creation-requests')
  @ServerRoles('admin')
  @ApiOperation({ summary: 'List pending campaign-creation requests', description: 'Server-admin only.' })
  @ApiResponse({ status: 200, description: 'Pending requests, newest first.' })
  listCreationRequests() {
    return this.governance.listPendingRequests();
  }

  @Post('creation-requests/:id/approve')
  @ServerRoles('admin')
  @ApiOperation({
    summary: 'Approve a campaign-creation request',
    description: "Server-admin only. Flips the requester's canCreateCampaigns to true atomically with the decision.",
  })
  @ApiResponse({ status: 201, description: 'The decided request.' })
  @ApiResponse({ status: 409, description: 'Request was already decided.' })
  async approveCreationRequest(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: CampaignCreationRequestDecisionDto,
    @CurrentUser() actor: RequestUser,
  ) {
    return this.governance.decide(id, 'approved', actor, body.note);
  }

  @Post('creation-requests/:id/deny')
  @ServerRoles('admin')
  @ApiOperation({ summary: 'Deny a campaign-creation request', description: 'Server-admin only.' })
  @ApiResponse({ status: 201, description: 'The decided request.' })
  @ApiResponse({ status: 409, description: 'Request was already decided.' })
  async denyCreationRequest(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: CampaignCreationRequestDecisionDto,
    @CurrentUser() actor: RequestUser,
  ) {
    return this.governance.decide(id, 'denied', actor, body.note);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a campaign', description: 'Requires campaign membership.' })
  @ApiResponse({ status: 200, description: 'Campaign.' })
  @ApiResponse({ status: 403, description: 'Not a member of this campaign.' })
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    await this.access.requireMember(user, id);
    return this.campaigns.getOrThrow(id);
  }

  @Get(':id/status-transitions')
  @ApiOperation({
    summary: 'List lifecycle-status transitions (issue #846)',
    description:
      "Requires campaign membership. Returns the campaign's status-change provenance (actor, time, from→to, optional reason), newest first. " +
      "The `reason` is DM operational text and is redacted (empty) for non-DM callers — players see only who changed the status, when, and the from→to pair.",
  })
  @ApiResponse({ status: 200, description: 'Status transitions, newest first.' })
  @ApiResponse({ status: 403, description: 'Not a member of this campaign.' })
  async listStatusTransitions(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireMember(user, id);
    const transitions = await this.campaigns.listStatusTransitions(id);
    // Issue #846: the reason is DM-only. Players see actor + status + time only.
    if (role !== 'dm') {
      return transitions.map(({ reason: _reason, ...rest }) => ({ ...rest, reason: '' }));
    }
    return transitions;
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a campaign',
    description:
      'dm role required. On a paused/completed (archived, read-only) campaign only `status` may be changed — everything else requires un-archiving first. ' +
      'Pass `revokeInvites=true` when archiving (active → paused/completed) to permanently delete every invite row in the same transaction as the status change (#857) — avoids client-side revoke-before-archive data loss if the status update fails.',
  })
  @ApiResponse({ status: 200, description: 'Updated campaign.' })
  @ApiResponse({ status: 403, description: 'Campaign is archived and the patch touches more than `status`.' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: CampaignUpdateDto,
    @CurrentUser() user: RequestUser,
    @Query('revokeInvites') revokeInvites?: string,
  ) {
    // Status/invite-suspension changes alter campaign lifecycle/access and are
    // destructive-scoped for temporary guest DMs (#545). Ordinary metadata edits
    // stay available to active guest DMs.
    if (body.status !== undefined || truthyQuery(revokeInvites)) {
      await this.access.requireCampaignPermission(user, id, 'destructive', { allowArchived: true });
    } else {
      // allowArchived: this is the un-archive path (PATCH {status:'active'}) —
      // CampaignsService.update() restricts an archived campaign to status-only patches.
      await this.access.requireRole(user, id, 'dm', { allowArchived: true });
    }
    return this.campaigns.update(id, body, user, { revokeInvites: truthyQuery(revokeInvites) });
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete (trash) a campaign',
    description:
      'dm role required. Allowed even when the campaign is archived (paused/completed). SOFT-delete (issue #116): the campaign moves to the trash — every row and its on-disk uploads survive and it is restorable via POST /campaigns/:id/restore. The old irreversible hard-cascade + disk wipe is now the deliberate second step DELETE /campaigns/:id/purge. ' +
      'Pass `revokeInvites=true` to permanently delete every invite row in the same transaction as the trash stamp (#857).',
  })
  @ApiResponse({ status: 200, description: 'Trashed (soft-deleted).' })
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: RequestUser,
    @Query('revokeInvites') revokeInvites?: string,
  ) {
    // allowArchived: trashing an archived campaign must not require un-archiving it first.
    await this.access.requireCampaignPermission(user, id, 'destructive', { allowArchived: true });
    return this.campaigns.remove(id, user, { revokeInvites: truthyQuery(revokeInvites) });
  }

  @Post(':id/restore')
  @ApiOperation({
    summary: 'Restore a trashed campaign',
    description:
      'dm role required. Clears the trash flag (issue #116) so the campaign returns to normal listings with every child row + upload intact. 404 if it is not actually in the trash. ' +
      'Atomically races purge (issue #867): a concurrent purge that commits first leaves restore as 404.',
  })
  @ApiResponse({ status: 201, description: 'Restored campaign.' })
  async restore(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    // allowTrashed: this is one of the three Trash exemptions (issue #867).
    // allowArchived: writability is not required to clear deletedAt.
    await this.access.requireCampaignPermission(user, id, 'destructive', { allowArchived: true, allowTrashed: true });
    return this.campaigns.restore(id, user);
  }

  @Delete(':id/purge')
  @ApiOperation({
    summary: 'Permanently purge a trashed campaign',
    description:
      'dm role required. The deliberate, IRREVERSIBLE second step (issue #116/#867): hard-cascades every child table AND wipes the campaign\'s on-disk upload directory. ' +
      'Refused unless the campaign is already in the trash (`deletedAt IS NOT NULL`) and the body carries `{ "confirm": "PURGE" }`. ' +
      'A concurrent restore that clears deletedAt first makes purge 404. Retains a sanitized server-level tombstone + admin audit row.',
  })
  @ApiResponse({ status: 200, description: 'Metadata removed; filesystem erasure verified unless filesPending is true.' })
  @ApiResponse({ status: 400, description: 'Missing/invalid confirmation token.' })
  @ApiResponse({ status: 404, description: 'Campaign is not in the trash (or was restored concurrently).' })
  async purge(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: CampaignPurgeDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireCampaignPermission(user, id, 'destructive', { allowArchived: true, allowTrashed: true });
    const outcome = await this.campaigns.purge(id, user, body);
    return { filesPending: outcome.filesPending, pendingPaths: outcome.pendingPaths };
  }

  @Get(':id/clone/preview')
  @ApiOperation({
    summary: 'Preview what a campaign clone would copy',
    description:
      "dm role required. Returns a versioned manifest (issue #435) with per-module entity counts, what will be included or excluded for the requested mode ('full' default, or 'template'), and warnings (private notes omitted, missing attachment bytes, template play-state strip).",
  })
  @ApiResponse({ status: 200, description: 'Clone preview manifest.' })
  @ApiResponse({ status: 403, description: 'Not a dm of the source campaign.' })
  async clonePreview(
    @Param('id', ParseIntPipe) id: number,
    @Query('mode') mode: string | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireRole(user, id, 'dm');
    const parsed = mode == null ? 'full' : mode;
    if (parsed !== 'full' && parsed !== 'template') {
      throw new BadRequestException(`Unknown clone mode: ${parsed}`);
    }
    return this.campaigns.clonePreview(id, parsed, user);
  }

  @Post(':id/clone')
  @ApiOperation({ summary: 'Clone a campaign (duplicate or start from template)', description: "dm role required on the source campaign; the caller becomes the clone's dm. mode='full' (default) duplicates quests, npcs, locations, factions, characters, sessions, notes, encounters, storylines, timeline, session-zero charter, inventory/treasury, prose revisions, and map/portrait attachments with all cross-references remapped; cloned encounters reset to 'preparing' with round and turnIndex reset to 0, currentCombatantId and endedAt cleared, and combatants restored to full HP (hpCurrent = hpMax) with conditions and initiative cleared (issue #548); encounter hidden is preserved (issue #262). mode='template' copies prep only (quests reset to available, objectives unchecked, locations unexplored, storylines/timeline/session-zero retained) and strips play state. Members, audit history, proposals, and participant support preferences are never copied. Use GET /campaigns/:id/clone/preview for a manifest of counts and warnings (issue #435)." })
  @ApiResponse({ status: 201, description: 'The newly created campaign.' })
  @ApiResponse({ status: 403, description: 'Not a dm of the source campaign.' })
  async clone(@Param('id', ParseIntPipe) id: number, @Body() body: CampaignCloneDto, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, id, 'dm');
    return this.campaigns.clone(id, body, user);
  }

  @Get(':id/trash')
  @ApiOperation({
    summary: "List a campaign's trashed (soft-deleted) entities",
    description:
      'dm role required; readable when the campaign is archived. The per-campaign Trash (issue #269): this campaign\'s soft-deleted child entities (issue #116) — ' +
      'sessions, characters, quests, npcs, locations, factions, encounters, story arcs, story beats, and timeline events — newest-trashed first, as {type,id,name,deletedAt} rows. Restore any ' +
      'of them with POST /<route>/:id/restore (e.g. POST /sessions/:id/restore; timeline events use POST /timeline/:id/restore). Notes are excluded (their restore is ' +
      "author-scoped, not DM-only). This is where the delete dialog/toast's \"restore from the campaign Trash\" leads.",
  })
  @ApiResponse({ status: 200, description: 'Trashed entities in the campaign.' })
  @ApiResponse({ status: 403, description: 'Not a dm of this campaign.' })
  async trash(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, id, 'dm', { allowArchived: true });
    return this.campaigns.listTrashedEntities(id);
  }

  @Get(':id/summary')
  @ApiOperation({ summary: 'Campaign dashboard/AI-primer summary', description: 'Aggregates campaign metadata, current location, quests (with objectives), npcs, locations, characters, logged sessions, and the next scheduled session in one authoritative call — intended for dashboards and as an LLM context primer. Requires campaign membership.' })
  @ApiResponse({ status: 200, description: 'Aggregate campaign summary.' })
  async summary(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireMember(user, id);
    return this.campaigns.summary(id, user, role);
  }
}
