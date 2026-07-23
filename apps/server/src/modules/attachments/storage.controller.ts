import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ServerRoles } from '../../common/decorators/server-roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { auditActor } from '../../common/user.types';
import { AuditService } from '../audit/audit.service';
import { AttachmentsService } from './attachments.service';
import { StorageQuotaDto } from './attachments.dto';

/**
 * Server-admin storage console (issue #24). Gated by @ServerRoles('admin')
 * (enforced by ServerRolesGuard, which also requires a PAT caller's token be
 * adminEnabled). Mounted under /admin/storage alongside the other server-wide
 * admin surfaces (/admin/metrics, /admin/audit). Surfaces upload-size visibility,
 * per-campaign quotas, and orphan cleanup.
 */
@ApiTags('admin')
@Controller('admin/storage')
@ServerRoles('admin')
export class StorageController {
  constructor(
    private readonly attachments: AttachmentsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Storage usage snapshot',
    description:
      'Server-admin only. Committed/public bytes and in-flight quota reservations, a per-campaign breakdown with quotas + over-quota flags, the actual on-disk byte total, and an orphan summary (rows-without-file, files-without-row).',
  })
  @ApiResponse({ status: 200, description: 'Current storage stats.' })
  stats() {
    return this.attachments.storageStats();
  }

  @Put('campaigns/:campaignId/quota')
  @ApiOperation({
    summary: "Set or clear a campaign's upload quota",
    description:
      'Server-admin only. `quotaBytes` caps the campaign\'s total attachment bytes (uploads past it 413); null removes the cap. Idempotent.',
  })
  @ApiResponse({ status: 200, description: 'Quota updated.' })
  @ApiResponse({ status: 404, description: 'Campaign not found.' })
  async setQuota(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: StorageQuotaDto,
    @CurrentUser() actor: RequestUser,
  ) {
    const quotaBytes = await this.attachments.setCampaignQuota(campaignId, body.quotaBytes);
    await this.audit.log({
      actor: auditActor(actor),
      actorRole: 'dm',
      action: 'storage.quota.set',
      entityType: 'campaign',
      entityId: campaignId,
      campaignId,
      detail: quotaBytes === null ? 'cleared' : `${quotaBytes} bytes`,
    });
    return { campaignId, quotaBytes };
  }

  @Post('cleanup')
  @ApiOperation({
    summary: 'Delete storage orphans',
    description:
      'Server-admin only. Removes attachment rows whose file is missing on disk and on-disk upload files with no backing row. Pass `?dryRun=true` to preview counts without deleting.',
  })
  @ApiQuery({ name: 'dryRun', required: false, enum: ['true', 'false'], description: 'When true, report counts but delete nothing.' })
  @ApiResponse({ status: 201, description: 'Cleanup result (or dry-run preview).' })
  async cleanup(@Query('dryRun') dryRun: string | undefined, @CurrentUser() actor: RequestUser) {
    const isDryRun = dryRun === 'true';
    const result = await this.attachments.cleanupOrphans(isDryRun);
    if (!isDryRun) {
      await this.audit.log({
        actor: auditActor(actor),
        actorRole: 'dm',
        action: 'storage.cleanup',
        entityType: 'storage',
        detail: `rows=${result.rowsDeleted} files=${result.filesDeleted} bytes=${result.bytesReclaimed}`,
      });
    }
    return result;
  }
}
