import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { CampaignModulesService } from './campaign-modules.service';
import {
  ModuleBulkPreviewDto,
  ModuleForkDto,
  ModuleInstallDto,
  ModuleUpdateDto,
} from './campaign-modules.dto';

/**
 * Campaign module routes (issue #585). Every route here is dm-only: a module install
 * rewrites campaign prep wholesale, and the plan bodies expose DM secrets.
 *
 * Backward compatibility: a campaign with no installs simply lists none. Nothing in the
 * clone / import / export paths consults these tables, so a campaign that predates modules
 * behaves exactly as it did before.
 */
@ApiTags('campaign-modules')
@Controller('campaigns/:campaignId/modules')
export class CampaignModulesController {
  constructor(
    private readonly modules: CampaignModulesService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List modules installed in a campaign',
    description:
      'dm role required. Returns each install\'s package identity (UUID, semver, authors, license, source), its persisted lineage (install origin, fork ancestry, detached flag), and live counts of locally edited artifacts and retained overlays.',
  })
  @ApiResponse({ status: 200, description: 'Installed modules.' })
  async list(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
    return this.modules.list(campaignId);
  }

  @Get(':installId')
  @ApiOperation({ summary: 'Read one installed module', description: 'dm role required.' })
  @ApiResponse({ status: 200, description: 'The install, with identity and lineage.' })
  @ApiResponse({ status: 404, description: 'No such install in this campaign.' })
  async get(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('installId', ParseIntPipe) installId: number,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
    return this.modules.get(campaignId, installId);
  }

  @Get(':installId/overlays')
  @ApiOperation({
    summary: "List an install's retained local edits (overlays)",
    description:
      "dm role required. Per artifact: the installed baseline, the overlay patch of fields the table changed, and the effective content (baseline + overlay). This is the durable record that local edits were preserved rather than overwritten by an update.",
  })
  @ApiResponse({ status: 200, description: 'Overlay patches, one per diverged artifact.' })
  async overlays(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('installId', ParseIntPipe) installId: number,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
    return this.modules.overlays(campaignId, installId);
  }

  @Get(':installId/snapshots')
  @ApiOperation({
    summary: "List an install's rollback points",
    description: 'dm role required. Newest last. A snapshot with rolledBackAt=null is what POST /rollback would restore.',
  })
  @ApiResponse({ status: 200, description: 'Rollback points.' })
  async snapshots(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('installId', ParseIntPipe) installId: number,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
    return this.modules.snapshots(campaignId, installId);
  }

  @Post()
  @ApiOperation({
    summary: 'Install a campaign module',
    description:
      "dm role required. The body is a module package: a versioned manifest (UUID, semver, authors, license, source URL, compatibility range, dependency contract, per-artifact content hashes) plus the artifact payloads it declares. Every declared hash is verified against the payload before anything is written — a mismatched or undeclared artifact is a 400. Artifacts are materialized as campaign locations/npcs/quests/factions with cross-references resolved by stable artifact key, and the content installed is recorded as the BASELINE that future update previews diff against. 409 if this module UUID is already installed here.",
  })
  @ApiResponse({ status: 201, description: 'The install, with identity and lineage.' })
  @ApiResponse({ status: 400, description: 'Invalid manifest, bad semver, or an artifact hash mismatch.' })
  @ApiResponse({ status: 409, description: 'That module UUID is already installed in this campaign.' })
  async install(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: ModuleInstallDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.modules.install(campaignId, body, user, role);
  }

  @Post(':installId/update/preview')
  @ApiOperation({
    summary: 'Dry-run an update against an installed module',
    description:
      "dm role required. Writes nothing. Classifies every artifact by comparing three versions — the BASELINE recorded at install time, the LOCAL content in the campaign right now, and the UPSTREAM content in the submitted package: unchanged / upstream_changed / locally_edited / both_changed / conflict / deleted_upstream / added_upstream / deleted_locally. Conflicts are reported down to the field, so a DM sees exactly which fields both they and the publisher changed. Also reports compatibility (app semver range, rule system) and per-dependency resolution status. canApply is false when any blocking finding is present (detached install, module UUID mismatch, incompatible, unsatisfied required dependency).",
  })
  @ApiResponse({ status: 200, description: 'The update plan.' })
  @ApiResponse({ status: 400, description: 'Invalid package or artifact hash mismatch.' })
  async previewUpdate(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('installId', ParseIntPipe) installId: number,
    @Body() body: ModuleUpdateDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
    return this.modules.previewUpdate(campaignId, installId, body);
  }

  @Post(':installId/update')
  @ApiOperation({
    summary: 'Apply an update to an installed module',
    description:
      "dm role required. Snapshots the current state (see POST /rollback), then applies the plan field by field: a field the publisher did not touch keeps the table's value, a field the table did not touch takes the publisher's, and a field both changed is a conflict. Conflicts are NEVER silently overwritten — onConflict defaults to 'skip', which leaves both the entity and its baseline untouched so the conflict resurfaces on the next preview; per-artifact overrides go in resolutions, keyed '<kind>:<key>'. Local edits that survive are re-recorded as overlays against the new baseline. onUpstreamDelete controls what happens to artifacts the publisher removed (a locally edited one is always kept). Pass dryRun=true for the preview without writing.",
  })
  @ApiResponse({ status: 200, description: 'Apply result with post-apply plan.' })
  @ApiResponse({ status: 400, description: 'Invalid package or artifact hash mismatch.' })
  @ApiResponse({ status: 409, description: 'Blocked — detached install, module UUID mismatch, incompatible, or a missing required dependency.' })
  async update(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('installId', ParseIntPipe) installId: number,
    @Body() body: ModuleUpdateDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.modules.applyUpdate(campaignId, installId, body, user, role);
  }

  @Post(':installId/rollback')
  @ApiOperation({
    summary: 'Roll back the most recent module change',
    description:
      'dm role required. Restores the newest un-rolled-back snapshot in one transaction: artifact baselines and entity content go back verbatim, rows the update trashed are un-trashed, and rows the update created are trashed. Also undoes a fork (restoring the pre-fork module identity) when the newest snapshot is a fork point.',
  })
  @ApiResponse({ status: 200, description: 'Rollback result.' })
  @ApiResponse({ status: 404, description: 'Nothing to roll back.' })
  async rollback(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('installId', ParseIntPipe) installId: number,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.modules.rollback(campaignId, installId, user, role);
  }

  @Post(':installId/fork')
  @ApiOperation({
    summary: 'Fork an installed module',
    description:
      "dm role required. The campaign's copy becomes an independently identified module with a fresh UUID, while its ancestry is retained in upstreamModuleId/upstreamVersion/forkedAt. A fork can still preview and merge upstream corrections — submitting the UPSTREAM package to the update routes is accepted and advances upstreamVersion without touching the fork's own identity or version.",
  })
  @ApiResponse({ status: 201, description: 'The forked install.' })
  @ApiResponse({ status: 409, description: 'The install is detached; there is no upstream identity to fork from.' })
  async fork(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('installId', ParseIntPipe) installId: number,
    @Body() body: ModuleForkDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.modules.fork(campaignId, installId, body, user, role);
  }

  @Post(':installId/detach')
  @ApiOperation({
    summary: 'Detach an install from its source',
    description:
      'dm role required. Permanently stops upstream updates for this install (they become a blocking finding on any future plan). Lineage is deliberately retained as history — the table still knows where the content came from.',
  })
  @ApiResponse({ status: 201, description: 'The detached install.' })
  async detach(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('installId', ParseIntPipe) installId: number,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.modules.detach(campaignId, installId, user, role);
  }
}

/**
 * Cross-campaign bulk dry run (issue #585). Mounted on its own path rather than under
 * `campaigns/…` so it cannot collide with the `:campaignId` parameter route.
 */
@ApiTags('campaign-modules')
@Controller('module-updates')
export class ModuleUpdatesController {
  constructor(
    private readonly modules: CampaignModulesService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get(':moduleId/installs')
  @ApiOperation({
    summary: 'Find which of the caller\'s tables have a module installed',
    description:
      'Discovery for the bulk dry run: every campaign the caller is a dm of that has this module UUID installed, directly or as the upstream of a fork. Campaigns the caller cannot see are omitted entirely (this route must not leak the existence of other tables).',
  })
  @ApiResponse({ status: 200, description: 'Installs visible to the caller.' })
  async installs(@Param('moduleId') moduleId: string, @CurrentUser() user: RequestUser) {
    const rows = await this.modules.campaignsWithModule(moduleId);
    const visible = [];
    for (const row of rows) {
      try {
        await this.access.requireRole(user, row.campaignId, 'dm', { allowArchived: true });
        visible.push(row);
      } catch {
        // Not the caller's table — omitted, not reported, so this cannot be used to probe
        // for the existence of campaigns the caller has no access to.
      }
    }
    return visible;
  }

  @Post('preview')
  @ApiOperation({
    summary: 'Bulk dry-run one module update across selected tables',
    description:
      'Writes nothing. For each requested campaign the caller is a dm of, returns the same three-way update plan the single-campaign preview returns; campaigns that do not exist, are not the caller\'s, do not have the module installed, or whose install is detached are reported in `skipped` with a reason rather than silently omitted. Tables that forked the module are included, matched on their recorded upstream. Roll-ups (cleanCount / conflictedCount / blockedCount) let a coordinator see at a glance which tables can take the correction unattended.',
  })
  @ApiResponse({ status: 200, description: 'Bulk preview.' })
  @ApiResponse({ status: 400, description: 'Invalid package or artifact hash mismatch.' })
  async preview(@Body() body: ModuleBulkPreviewDto, @CurrentUser() user: RequestUser) {
    const allowed = new Set<number>();
    for (const campaignId of body.campaignIds) {
      try {
        await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
        allowed.add(campaignId);
      } catch {
        // Not a dm (or the campaign is gone) — reported as a skip by the service, so a
        // coordinator sees the full requested set rather than a silently shortened list.
      }
    }
    return this.modules.bulkPreview(body, allowed);
  }
}
