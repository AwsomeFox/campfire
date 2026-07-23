import { Controller, Get, Param, ParseIntPipe, Query, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { ExportService } from './export.service';

@ApiTags('export')
@Controller('campaigns/:campaignId/export')
export class ExportController {
  constructor(
    private readonly exportService: ExportService,
    private readonly access: CampaignAccessService,
    private readonly campaigns: CampaignsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Export a campaign', description: 'dm role required. Bundles the full campaign (quests, npcs, locations, characters, sessions, notes, audit history with auditMeta disclosure, proposals) as a downloadable portability file — not a full-server backup (see auditNote in the JSON).' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'mdzip'], description: "'mdzip' for a markdown-per-entity zip; omitted/anything else defaults to a single JSON document." })
  @ApiResponse({ status: 200, description: 'File download (application/json or application/zip, with Content-Disposition attachment).' })
  async export(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Query('format') format: string | undefined,
    @CurrentUser() user: RequestUser,
    @Res() res: Response,
  ): Promise<void> {
    // allowArchived: exporting an archived (read-only) campaign is a primary archive use case.
    await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
    const campaign = await this.campaigns.getOrThrow(campaignId);

    if (format === 'mdzip') {
      // Issue #530: buildMarkdownZip now returns { buffer, warnings }. The HTTP
      // contract is a raw binary stream with no JSON envelope, so the buffer is
      // streamed unchanged and the warnings ride inside the archive as
      // warnings.txt (when non-empty) for a human to read. The returned array is
      // also available to any programmatic caller that wants to surface collisions
      // in a UI; surfacing it in this controller is a documented follow-up.
      const { buffer: zipBuffer } = await this.exportService.buildMarkdownZip(campaignId, user);
      const filename = this.exportService.exportFilename(campaign.name, 'zip');
      res
        .status(200)
        .set({
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${filename}"`,
          // Issue #730: exports must not enter HTTP or PWA caches.
          'Cache-Control': 'private, no-store',
        })
        .end(zipBuffer);
      return;
    }

    const data = await this.exportService.buildExport(campaignId, user);
    const filename = this.exportService.exportFilename(campaign.name, 'json');
    res
      .status(200)
      .set({
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${filename}"`,
        // Issue #730: exports must not enter HTTP or PWA caches.
        'Cache-Control': 'private, no-store',
      })
      .send(JSON.stringify(data));
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
