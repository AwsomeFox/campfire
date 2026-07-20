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
  @ApiOperation({ summary: 'Export a campaign', description: 'dm role required. Bundles the full campaign (quests, npcs, locations, characters, sessions, notes) as a downloadable file.' })
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
      const zipBuffer = await this.exportService.buildMarkdownZip(campaignId, user);
      const filename = this.exportService.exportFilename(campaign.name, 'zip');
      res
        .status(200)
        .set({
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${filename}"`,
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
      })
      .send(JSON.stringify(data));
  }
}
