import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CAMPAIGN_CATALOG_DEFAULT_LIMIT, CAMPAIGN_CATALOG_MAX_LIMIT } from '@campfire/schema';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { AdminCatalogService } from './admin-catalog.service';
import {
  CampaignCatalogPrivacySettingDto,
  CampaignCatalogPrivacyUpdateDto,
  CampaignExportRequestDecisionDto,
  CampaignExportRequestDto,
  CampaignExportRequestPageDto,
} from './admin-catalog.dto';
import { nonNegativeIntQuery } from './catalog-query';

/**
 * The campaign's own side of the catalog (issue #587) — the half that makes the
 * operator-facing half legitimate.
 *
 * Two things live here, and both belong to the DM rather than to the server operator:
 *
 *  1. THE OPT-OUT. "Configurable privacy for campaign names/descriptions" only means
 *     something if the party being protected controls it. A campaign name can itself be
 *     sensitive — a support or therapy-adjacent table's name may disclose more than its
 *     description ever would. So a DM can set `catalogPrivacy: 'redacted'` and the
 *     operator then sees `Campaign #<id>` and no description. Crucially there is NO
 *     admin route that writes this column and `set_policy` in the bulk enum cannot
 *     reach it: an opt-out that a server admin can clear is decorative. It is also
 *     tighten-only — `redacted` overrides a permissive server default, but `inherit`
 *     can never force disclosure past a restrictive one.
 *
 *  2. EXPORT-REQUEST DECISIONS. An operator can ASK for an export; only a DM can answer.
 *     Approving records consent — it does not deliver a bundle to the requester, and
 *     there is no admin route that returns one. Producing the export remains the
 *     existing DM-gated `GET /campaigns/:id/export`. That split is deliberate: an
 *     export contains every quest, note, session-zero line and dmSecret in the
 *     campaign, so an admin-triggered export that landed in the admin's hands would
 *     undo the catalog's entire premise in a single call.
 */
@ApiTags('campaigns')
@Controller('campaigns/:campaignId/catalog')
export class CampaignCatalogController {
  constructor(
    private readonly catalog: AdminCatalogService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get('privacy')
  @ApiOperation({
    summary: "Read this campaign's catalog privacy setting",
    description:
      'Any member may read it — knowing whether your table is listed to server operators is not privileged. Returns ' +
      "the campaign's own setting, the server-wide default in force (so `inherit` has a visible meaning), and the " +
      'resulting effective visibility of the name and description.',
  })
  @ApiResponse({ status: 200, description: 'Effective catalog privacy for this campaign.', type: CampaignCatalogPrivacySettingDto })
  async getPrivacy(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    await this.access.requireMember(user, campaignId);
    return this.catalog.getCampaignPrivacy(campaignId);
  }

  @Put('privacy')
  @ApiOperation({
    summary: "Set this campaign's catalog privacy (DM only)",
    description:
      'DM only, and deliberately unreachable from any server-admin route. `redacted` withholds the name and ' +
      'description from the server-admin catalog; the operator then sees a non-identifying `Campaign #<id>` ' +
      'placeholder, which is derived only from the id the row already discloses. `inherit` follows the server default ' +
      'and can never force disclosure when that default is restrictive. Allowed while the campaign is archived — a ' +
      'read-only campaign must still be able to tighten its own privacy.',
  })
  @ApiResponse({ status: 200, description: 'Updated setting.', type: CampaignCatalogPrivacySettingDto })
  @ApiResponse({ status: 403, description: 'Caller is not a DM of this campaign.' })
  async setPrivacy(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: CampaignCatalogPrivacyUpdateDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
    return this.catalog.setCampaignPrivacy(campaignId, body.catalogPrivacy, user);
  }

  @Get('export-requests')
  @ApiOperation({
    summary: 'List export requests a server operator has raised for this campaign (DM only)',
    description:
      "DM only. The inbox side of the catalog's `request_export` operation: who asked, which profile, why, and what " +
      'was decided. A DM who never answers has denied by default — nothing is produced without an explicit approval ' +
      'followed by an explicit DM-run export. Paged with a real `total`, and ordered pending-first so the requests ' +
      'still waiting on this DM can never be pushed off page one by decided history.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: `Page size (default ${CAMPAIGN_CATALOG_DEFAULT_LIMIT}, max ${CAMPAIGN_CATALOG_MAX_LIMIT}).`,
  })
  @ApiQuery({ name: 'offset', required: false, type: Number, description: 'Rows to skip (default 0).' })
  @ApiResponse({
    status: 200,
    description: 'A page of export requests for this campaign, pending first then newest first.',
    type: CampaignExportRequestPageDto,
  })
  async listRequests(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @CurrentUser() user: RequestUser,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
    return this.catalog.listExportRequestsForCampaign(campaignId, {
      limit: nonNegativeIntQuery(limit, 'limit'),
      offset: nonNegativeIntQuery(offset, 'offset'),
    });
  }

  @Post('export-requests/:requestId/decision')
  @ApiOperation({
    summary: 'Approve or deny an export request (DM only)',
    description:
      'DM only. Records the decision and a note. Approving grants CONSENT, not an artifact — no server-admin route ' +
      'returns an export, and the bundle is still produced by a DM through the existing DM-gated campaign export ' +
      'route. Recorded in both the campaign trail and the server-admin trail so the operator who asked can see the ' +
      'answer without being able to read the campaign.',
  })
  @ApiResponse({ status: 201, description: 'The decided request.', type: CampaignExportRequestDto })
  @ApiResponse({ status: 400, description: 'Request has already been decided.' })
  async decide(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('requestId', ParseIntPipe) requestId: number,
    @Body() body: CampaignExportRequestDecisionDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
    return this.catalog.decideExportRequest(requestId, body, user, campaignId);
  }
}
