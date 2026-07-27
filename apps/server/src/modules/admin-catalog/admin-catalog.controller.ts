import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CAMPAIGN_CATALOG_DEFAULT_LIMIT, CAMPAIGN_CATALOG_MAX_LIMIT } from '@campfire/schema';
import { ServerRoles } from '../../common/decorators/server-roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { auditActor, auditActorRole, type RequestUser } from '../../common/user.types';
import { AdminCatalogService } from './admin-catalog.service';
import {
  CampaignCatalogBulkRequestDto,
  CampaignCatalogBulkResultDto,
  CampaignCatalogEntryDto,
  CampaignCatalogPageDto,
  CampaignCatalogPrivacyPolicyDto,
  CampaignCatalogPrivacyPolicyUpdateDto,
  CampaignExportRequestPageDto,
} from './admin-catalog.dto';
import { intQuery, nonNegativeIntQuery, parseCatalogQuery } from './catalog-query';

/**
 * Server-admin campaign catalog: a card index, not a key ring (issue #587).
 *
 * WHAT THIS FIXES
 * ---------------
 * A server admin currently lists only campaigns they are a MEMBER of, so a coordinator
 * running dozens of tables has to join a campaign — acquiring full content visibility —
 * just to find it, check its storage, or archive it at the end of a season. That is a
 * privilege escalation dressed up as an administrative convenience, and it is the only
 * option the product currently offers.
 *
 * WHAT KEEPS IT A CATALOG RATHER THAN A BACK DOOR
 * -----------------------------------------------
 *  - Every response is built from ONE enumerated projection (catalog-projection.ts).
 *    Nothing here selects `campaigns.*`, so a column added next month — the next
 *    `ics_token` — cannot ship to operators without somebody deciding it should.
 *  - There is no route that returns quests, notes, comments, attachment bytes or
 *    filenames, session-zero, or any `dm_secret`. Not filtered out: never read.
 *    `admin-catalog.isolation.e2e-spec.ts` seeds markers into all of them and asserts
 *    no marker appears in ANY response from ANY route on this controller.
 *  - "Request export" creates an ASK addressed to the campaign's DMs. It does not
 *    return a bundle, and approving it does not hand one to the requester — producing
 *    an export stays on the existing DM-gated route. A campaign export carries every
 *    secret there is, so a one-call admin path to it would defeat the entire feature.
 *  - Names and descriptions are privacy-gated, defaulting to visible/redacted
 *    respectively, and a campaign can tighten further. Search and sort respect that
 *    gating too — see catalog-projection.ts for why an unrestricted `?q=` over redacted
 *    names is a substring oracle and an unrestricted name sort is a binary search.
 *  - Browsing is audited, not just mutating. Bullet 5 of the issue says "audit catalog
 *    ACCESS and operations", and a privileged read that leaves no trace is how a
 *    catalog quietly becomes surveillance.
 *  - @ServerRoles('admin') routes through ServerRolesGuard + hasServerAdminPower, so a
 *    scope-capped PAT owned by an admin cannot reach any of this.
 *
 * ROUTE ORDER MATTERS: `privacy` and `export-requests` are declared BEFORE `:campaignId`
 * so Nest does not match them as a campaign id.
 */
@ApiTags('campaigns')
@Controller('admin/campaigns')
@ServerRoles('admin')
export class AdminCatalogController {
  constructor(private readonly catalog: AdminCatalogService) {}

  @Get('privacy')
  @ApiOperation({
    summary: 'Read the server-wide catalog disclosure policy',
    description:
      'Server-admin only. Whether campaign NAMES and DESCRIPTIONS are disclosed in the catalog by default. ' +
      'Names default to `visible` (an operator needs a handle to talk to a DM about their table at all) and ' +
      'descriptions to `redacted` (free prose that routinely carries premise and content warnings). `source` says ' +
      'whether an operator override is stored or the built-in default is in force. Individual campaigns may tighten ' +
      'further, and never loosen.',
  })
  @ApiResponse({ status: 200, description: 'Effective catalog privacy policy.', type: CampaignCatalogPrivacyPolicyDto })
  getPrivacyPolicy() {
    return this.catalog.getPrivacyPolicy();
  }

  @Put('privacy')
  @ApiOperation({
    summary: 'Update the server-wide catalog disclosure policy',
    description:
      'Server-admin only. Records `campaign.catalog.privacy.update` in the server-admin audit trail. This changes what ' +
      'every operator can see about every campaign that has not opted out, so it is deliberately a server-scoped, ' +
      'audited act. It cannot override a campaign that set its own privacy to `redacted`.',
  })
  @ApiResponse({ status: 200, description: 'Updated policy.', type: CampaignCatalogPrivacyPolicyDto })
  updatePrivacyPolicy(@Body() body: CampaignCatalogPrivacyPolicyUpdateDto, @CurrentUser() user: RequestUser) {
    return this.catalog.updatePrivacyPolicy(body, { actor: auditActor(user), actorRole: auditActorRole(user) });
  }

  @Get('export-requests')
  @ApiOperation({
    summary: 'List export requests raised from the catalog',
    description:
      'Server-admin only. Status and timestamps for asks addressed to campaign DMs. Returns no exported content and ' +
      'no artifact — approval is recorded here, but producing a bundle remains the DM-gated campaign export route. ' +
      'Paged with a real `total`, so the cross-campaign queue can actually be enumerated rather than silently ' +
      'truncated at the cap. Records `campaign.catalog.export_requests.list` in the server-admin trail: this read ' +
      'discloses requester justifications and DM decision notes, so it is audited like every other catalog read.',
  })
  @ApiQuery({ name: 'campaignId', required: false, type: Number, description: 'Restrict to one campaign.' })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: `Page size (default ${CAMPAIGN_CATALOG_DEFAULT_LIMIT}, max ${CAMPAIGN_CATALOG_MAX_LIMIT}).`,
  })
  @ApiQuery({ name: 'offset', required: false, type: Number, description: 'Rows to skip.' })
  @ApiResponse({
    status: 200,
    description: 'A page of export requests, newest first, with a real total.',
    type: CampaignExportRequestPageDto,
  })
  listExportRequests(
    @CurrentUser() user: RequestUser,
    @Query('campaignId') campaignId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.catalog.listExportRequests(user, {
      campaignId: intQuery(campaignId, 'campaignId'),
      // Same parser the catalog listing uses. These were `intQuery`, so `?offset=-5`
      // 400'd on /campaigns and was silently clamped to 0 here — one console, two
      // answers to the same malformed request, and the silent one hides a client bug.
      limit: nonNegativeIntQuery(limit, 'limit'),
      offset: nonNegativeIntQuery(offset, 'offset'),
    });
  }

  @Post('bulk')
  @ApiOperation({
    summary: 'Bulk lifecycle operations across campaigns (dry run by default)',
    description:
      'Server-admin only. Archive, pause, activate, reassign ownership, set storage quota, set invite/AI policy, ' +
      'update the rule module, or raise an export request across up to 200 campaigns. `dryRun` DEFAULTS TO TRUE: a ' +
      'lifecycle change across campaigns the operator cannot read should require typing `"dryRun": false`, not merely ' +
      'remembering a flag. Each campaign is applied in its OWN transaction and reported individually, so a batch never ' +
      'half-applies behind a 500 — the response always carries a per-item verdict of ' +
      '`would_apply` / `applied` / `skipped` / `failed`. Real runs record one audit row per changed campaign plus a ' +
      'batch summary; dry runs record the summary only.',
  })
  @ApiResponse({ status: 201, description: 'Per-item outcomes and tallies.', type: CampaignCatalogBulkResultDto })
  @ApiResponse({ status: 400, description: 'Operation is missing a required argument.' })
  bulk(@Body() body: CampaignCatalogBulkRequestDto, @CurrentUser() user: RequestUser) {
    return this.catalog.bulk(user, body);
  }

  @Get()
  @ApiOperation({
    summary: 'Page the campaign metadata catalog (audited)',
    description:
      'Server-admin only, and INCLUDES campaigns the caller is not a member of — that is the point. Returns operational ' +
      'metadata only: counts, bytes, dates, module, primary DM, policy flags, and privacy-gated name/description. It ' +
      'returns no quests, notes, comments, attachment names or contents, session-zero records, or DM secrets, because ' +
      'no query behind it reads those tables. Pagination, search, every filter and every sort key are SQL predicates ' +
      'over the campaigns table — the catalog does not inherit the load-everything-and-filter-in-JS cost this issue ' +
      'was raised about. The listing itself is recorded as `campaign.catalog.list`, with the exact slice and filters, ' +
      'so a reviewer can reconstruct what an operator actually saw.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size (default 25, max 100).' })
  @ApiQuery({ name: 'offset', required: false, type: Number, description: 'Rows to skip (default 0).' })
  @ApiQuery({
    name: 'sort',
    required: false,
    type: String,
    description: 'name | status | storage | activity | nextSession | created | id. Default activity.',
  })
  @ApiQuery({ name: 'order', required: false, type: String, description: 'asc | desc.' })
  @ApiQuery({
    name: 'q',
    required: false,
    type: String,
    description:
      'Free text over name, description and rule system — but ONLY over fields the caller is allowed to read, so a ' +
      'redacted name cannot be recovered by probing substrings. A numeric query also matches the campaign id exactly.',
  })
  @ApiQuery({ name: 'status', required: false, type: String, description: 'active | paused | completed.' })
  @ApiQuery({ name: 'ruleSystem', required: false, type: String, description: 'Exact rule-pack slug ("" finds unset).' })
  @ApiQuery({ name: 'packageVersion', required: false, type: String, description: 'Exact installed pack version.' })
  @ApiQuery({
    name: 'moduleInstalled',
    required: false,
    type: Boolean,
    description: 'false finds campaigns pinned to a rule pack this server does not have installed.',
  })
  @ApiQuery({ name: 'primaryDmUserId', required: false, type: Number, description: 'Campaigns with this user as a DM.' })
  @ApiQuery({ name: 'nextSessionAfter', required: false, type: String, description: 'ISO bound on the next session.' })
  @ApiQuery({ name: 'nextSessionBefore', required: false, type: String, description: 'ISO bound on the next session.' })
  @ApiQuery({ name: 'activityAfter', required: false, type: String, description: 'ISO bound on last activity.' })
  @ApiQuery({ name: 'activityBefore', required: false, type: String, description: 'ISO bound on last activity.' })
  @ApiQuery({ name: 'minStorageBytes', required: false, type: Number, description: 'Committed attachment bytes floor.' })
  @ApiQuery({
    name: 'overQuota',
    required: false,
    type: Boolean,
    description:
      'Only campaigns past their quota, measured as committed + reserved bytes so it agrees with upload ' +
      'enforcement. Note this is a wider sum than the `storageBytes` column, which is committed bytes only.',
  })
  @ApiQuery({ name: 'trashed', required: false, type: Boolean, description: 'Show soft-deleted campaigns instead.' })
  @ApiResponse({ status: 200, description: 'One page of catalog entries.', type: CampaignCatalogPageDto })
  list(
    @CurrentUser() user: RequestUser,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: string,
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('ruleSystem') ruleSystem?: string,
    @Query('packageVersion') packageVersion?: string,
    @Query('moduleInstalled') moduleInstalled?: string,
    @Query('primaryDmUserId') primaryDmUserId?: string,
    @Query('nextSessionAfter') nextSessionAfter?: string,
    @Query('nextSessionBefore') nextSessionBefore?: string,
    @Query('activityAfter') activityAfter?: string,
    @Query('activityBefore') activityBefore?: string,
    @Query('minStorageBytes') minStorageBytes?: string,
    @Query('overQuota') overQuota?: string,
    @Query('trashed') trashed?: string,
  ) {
    return this.catalog.listCatalog(
      user,
      parseCatalogQuery({
        limit,
        offset,
        sort,
        order,
        q,
        status,
        ruleSystem,
        packageVersion,
        moduleInstalled,
        primaryDmUserId,
        nextSessionAfter,
        nextSessionBefore,
        activityAfter,
        activityBefore,
        minStorageBytes,
        overQuota,
        trashed,
      }),
    );
  }

  @Get(':campaignId')
  @ApiOperation({
    summary: 'Read one catalog entry (audited twice)',
    description:
      'Server-admin only. The same metadata-only projection as the list, for a single campaign. Records ' +
      '`campaign.catalog.read` in BOTH the campaign\'s own trail — so a campaign can see that an outsider looked at ' +
      'it — and the server-admin trail, which excludes campaign rows and would otherwise never show it.',
  })
  @ApiResponse({ status: 200, description: 'One catalog entry.', type: CampaignCatalogEntryDto })
  @ApiResponse({ status: 404, description: 'No such campaign.' })
  get(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    return this.catalog.getCatalogEntry(user, campaignId);
  }
}
