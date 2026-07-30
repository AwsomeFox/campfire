import { BadRequestException, Controller, Get, Inject, Param, ParseIntPipe, Query, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { ExportService } from './export.service';
import {
  DEFAULT_EXPORT_PROFILE,
  EXPORT_PROFILES,
  isExportProfile,
  type ExportProfile,
  type ExportProfileOptions,
} from './export-profiles';

/** `?flag=1|true|yes` — absent or anything else is false (the redaction-safe default). */
function boolQuery(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

function parseProfile(value: string | undefined): ExportProfile {
  if (value == null || value === '') return DEFAULT_EXPORT_PROFILE;
  if (!isExportProfile(value)) {
    throw new BadRequestException(`Unknown export profile '${value}'. Expected one of: ${EXPORT_PROFILES.join(', ')}.`);
  }
  return value;
}

@ApiTags('export')
@Controller('campaigns/:campaignId/export')
export class ExportController {
  // Issue #1527: narrowed to exactly the methods this controller calls (verified by
  // deliberately narrowing further and letting `tsc` name every call site that broke —
  // see the PR discussion) rather than the full concrete classes. A hand-rolled test
  // double can then be assigned here WITHOUT any unsafe cast, which is what makes this
  // different from `Pick`-typing only the double: if this controller starts calling a
  // method outside this list, compilation fails HERE, forcing the list to widen; once
  // widened, every double assigned without a cast fails until it supplies the new
  // method too. `@Inject(...)` supplies the runtime DI token explicitly because the
  // erased `Pick<...>` type carries no `design:paramtypes` metadata for Nest to resolve.
  constructor(
    @Inject(ExportService)
    private readonly exportService: Pick<
      ExportService,
      'exportFilename' | 'streamMarkdownZip' | 'buildExportInventory' | 'buildProfileExport' | 'buildMemberExport' | 'memberExportFilename'
    >,
    @Inject(CampaignAccessService)
    private readonly access: Pick<CampaignAccessService, 'requireRole' | 'requireMember'>,
    @Inject(CampaignsService)
    private readonly campaigns: Pick<CampaignsService, 'getOrThrow'>,
  ) {}

  /**
   * Pre-export inventory (issue #586). A DM must be able to see WHAT WILL BE IN THE
   * FILE before the file exists — which modules travel, how many rows each profile
   * drops, which fields the allowlist withholds, what happens to attachments, and
   * what the redaction explicitly does not protect against.
   */
  @Get('preview')
  @ApiOperation({
    summary: 'Preview what an export profile would include and redact',
    description:
      'dm role required. Returns the pre-export inventory for the selected profile: per-module included/redacted row ' +
      'counts, the fields the allowlist withholds, attachment handling (filename neutralization, metadata stripping, ' +
      'withheld bytes), the identifier scan result, and the honest limitations of the redaction. No campaign content is ' +
      'returned — only counts and policy.',
  })
  @ApiQuery({ name: 'profile', required: false, enum: EXPORT_PROFILES })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'mdzip'] })
  @ApiQuery({ name: 'dmSecrets', required: false, description: 'publish profile only — include dmSecret prose and the unrevealed staging flag.' })
  @ApiQuery({ name: 'playedState', required: false, description: 'publish profile only — include recaps, played dates and live combat state.' })
  @ApiQuery({ name: 'playerContent', required: false, description: 'publish profile only — include characters, comments, party notes and inventory.' })
  @ApiResponse({ status: 200, description: 'Pre-export inventory (application/json).' })
  async preview(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Query('profile') profile: string | undefined,
    @Query('format') format: string | undefined,
    @Query('dmSecrets') dmSecrets: string | undefined,
    @Query('playedState') playedState: string | undefined,
    @Query('playerContent') playerContent: string | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
    const options: ExportProfileOptions = {
      includeDmSecrets: boolQuery(dmSecrets),
      includePlayedState: boolQuery(playedState),
      includePlayerContent: boolQuery(playerContent),
    };
    return this.exportService.buildExportInventory(
      campaignId,
      user,
      parseProfile(profile),
      options,
      format === 'mdzip' ? 'mdzip' : 'json',
    );
  }

  @Get()
  @ApiOperation({
    summary: 'Export a campaign',
    description:
      "dm role required. `profile` selects what travels (issue #586). 'backup' (default) is the full DM backup — " +
      'campaign, quests, npcs, locations, characters, sessions, notes, comments, members, encounters, attachment ' +
      'metadata, factions, storyArcs, timelineEvents, timelineCalendar, sessionZero, inventory, treasury, revisions, ' +
      'proposals plus audit history with auditMeta disclosure (not a full-server backup — see auditNote). ' +
      "'handoff' keeps the world, DM secrets and play state but drops member identities and operational history. " +
      "'publish' produces a redistributable module: member identities, audit, proposals, private/whisper notes, RSVPs, " +
      'attendance, the dice log and credentials are excluded, and DM secrets / played state / player-authored content ' +
      'are opt-in via dmSecrets, playedState and playerContent. Every response carries a machine-readable `redaction` ' +
      'block; call GET /export/preview first for the pre-export inventory. Use format=mdzip for a markdown zip.',
  })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'mdzip'], description: "'mdzip' for a markdown-per-entity zip; omitted/anything else defaults to a single JSON document." })
  @ApiQuery({ name: 'profile', required: false, enum: EXPORT_PROFILES, description: "Redaction profile; defaults to 'backup' (unredacted)." })
  @ApiQuery({ name: 'dmSecrets', required: false, description: 'publish profile only — include dmSecret prose and the unrevealed staging flag.' })
  @ApiQuery({ name: 'playedState', required: false, description: 'publish profile only — include recaps, played dates and live combat state.' })
  @ApiQuery({ name: 'playerContent', required: false, description: 'publish profile only — include characters, comments, party notes and inventory.' })
  @ApiResponse({ status: 200, description: 'File download (application/json or application/zip, with Content-Disposition attachment).' })
  async export(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Query('format') format: string | undefined,
    @Query('profile') profileQuery: string | undefined,
    @Query('dmSecrets') dmSecrets: string | undefined,
    @Query('playedState') playedState: string | undefined,
    @Query('playerContent') playerContent: string | undefined,
    @CurrentUser() user: RequestUser,
    @Res() res: Response,
  ): Promise<void> {
    // Install cancellation before the authorization/campaign lookups: either can
    // be slow, and a client that leaves during them must never start ZIP work.
    const abortController = format === 'mdzip' ? new AbortController() : null;
    const onClose = () => {
      if (!res.writableEnded) abortController?.abort(new Error('Export client disconnected'));
    };
    if (abortController) {
      res.once('close', onClose);
      if (res.destroyed || res.writableEnded) {
        abortController.abort(new Error('Export client disconnected'));
      }
    }
    try {
      if (abortController?.signal.aborted) return;
      // allowArchived: exporting an archived (read-only) campaign is a primary archive use case.
      await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
      if (abortController?.signal.aborted) return;
      const campaign = await this.campaigns.getOrThrow(campaignId);
      if (abortController?.signal.aborted) return;
      const profile = parseProfile(profileQuery);
      const options: ExportProfileOptions = {
        includeDmSecrets: boolQuery(dmSecrets),
        includePlayedState: boolQuery(playedState),
        includePlayerContent: boolQuery(playerContent),
      };

      if (format === 'mdzip') {
        const filename = this.exportService.exportFilename(campaign.name, 'zip', profile);
        // Deferred until the archive actually produces bytes. buildProfileExport runs a
        // long series of DB reads first, and this endpoint is reached by a plain anchor
        // navigation, not fetch — so committing zip headers up front meant a mid-read
        // failure was serialised as JSON that Express still labelled `application/zip`
        // with an attachment disposition (res.json does not override a set Content-Type).
        // The browser cannot inspect the status on a navigation, so it saved the error
        // body to disk as a corrupt archive. Setting them on first byte makes "these
        // headers exist only if bytes are coming" true by construction.
        const onFirstByte = () => {
          res
            .status(200)
            .set({
              'Content-Type': 'application/zip',
              'Content-Disposition': `attachment; filename="${filename}"`,
              // Issue #730: exports must not enter HTTP or PWA caches.
              'Cache-Control': 'private, no-store',
              // Issue #586: the redaction profile is visible without opening the archive.
              'X-Campfire-Export-Profile': profile,
            });
        };
        // Do not buffer a whole archive in the request path. `close` also fires for
        // a browser cancelling a download, allowing the service to tear down the
        // archiver and its per-export staging directory promptly.
        try {
          await this.exportService.streamMarkdownZip(res, abortController!.signal, campaignId, user, { profile, options, onFirstByte });
        } catch (err) {
          if (abortController!.signal.aborted) return;
          // Once streaming has started, the service has already destroyed the
          // failed response. Do not ask Nest to write a second JSON error response
          // over committed ZIP headers.
          if (res.headersSent || res.destroyed) return;
          // Projection can fail before archiver emits a byte. Restore a normal
          // error-response header state so Nest's exception filter sends JSON
          // instead of a misleading attachment named like a ZIP archive.
          res.removeHeader('Content-Type');
          res.removeHeader('Content-Disposition');
          res.removeHeader('X-Campfire-Export-Profile');
          throw err;
        }
        return;
      }

      const { data } = await this.exportService.buildProfileExport(campaignId, user, profile, options, { format: 'json' });
      const filename = this.exportService.exportFilename(campaign.name, 'json', profile);
      res
        .status(200)
        .set({
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="${filename}"`,
          // Issue #730: exports must not enter HTTP or PWA caches.
          'Cache-Control': 'private, no-store',
          'X-Campfire-Export-Profile': profile,
        })
        .send(JSON.stringify(data));
    } finally {
      if (abortController) res.off('close', onClose);
    }
  }

  @Get('me')
  @ApiOperation({
    summary: 'Export your own data in a campaign',
    description:
      'Member-scoped export (issue #128 player data rights): the characters you own, the notes you authored, and the ' +
      'proposals you submitted in THIS campaign, as a downloadable JSON file. Requires only campaign membership (not dm) ' +
      'and works on an archived campaign. Distinct from GET /export (the DM-only, campaign-wide bundle).',
  })
  @ApiResponse({ status: 200, description: 'File download (application/json, Content-Disposition attachment) with your own data.' })
  @ApiResponse({ status: 403, description: 'Not a member of this campaign.' })
  async exportOwn(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @CurrentUser() user: RequestUser,
    @Res() res: Response,
  ): Promise<void> {
    // requireMember (no writability assertion) — a member may export their own
    // data even from an archived (read-only) campaign.
    const role = await this.access.requireMember(user, campaignId);
    const campaign = await this.campaigns.getOrThrow(campaignId);
    const data = await this.exportService.buildMemberExport(campaignId, user, role);
    const filename = this.exportService.memberExportFilename(campaign.name, user.id);
    res
      .status(200)
      .set({
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${filename}"`,
        // Issue #730: member exports must not enter HTTP or PWA caches.
        'Cache-Control': 'private, no-store',
      })
      .send(JSON.stringify(data));
  }
}
