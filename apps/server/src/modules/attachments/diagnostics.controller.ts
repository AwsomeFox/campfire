import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ServerRoles } from '../../common/decorators/server-roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { auditActor } from '../../common/user.types';
import { AuditService } from '../audit/audit.service';
import { DiagnosticsService } from './diagnostics.service';
import { DiagnosticFixRequestDto } from './diagnostics.dto';

/**
 * Admin-only attachment diagnostics endpoints (issue #733). Validates canonical
 * owner, path, extension, duplicates, and thumbnails. Offers relink/quarantine
 * remediation before deletion.
 */
@ApiTags('admin')
@Controller('admin/attachments/diagnostics')
@ServerRoles('admin')
export class DiagnosticsController {
  constructor(
    private readonly diagnostics: DiagnosticsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Run a full diagnostic scan of attachment storage vs DB rows.
   * Classifies misplaced, wrong-extension, duplicate, malformed,
   * unexpected-thumbnail, orphan, and missing issues.
   */
  @Post()
  @ApiOperation({
    summary: 'Run attachment diagnostics scan',
    description:
      'Server-admin only. Scans attachment storage and validates each file against its DB row. ' +
      'Classifies issues: misplaced, wrong-extension, duplicate, malformed, unexpected-thumbnail, orphan, missing.',
  })
  @ApiResponse({ status: 201, description: 'Diagnostic report with classified issues.' })
  @ApiResponse({ status: 503, description: 'Attachment storage unavailable.' })
  async scan(@CurrentUser() actor: RequestUser) {
    const report = await this.diagnostics.runDiagnostics();

    await this.audit.log({
      actor: auditActor(actor),
      actorRole: 'dm',
      action: 'attachments.diagnostics.scan',
      entityType: 'storage',
      detail: `issues=${report.issues.length} dbRows=${report.totalDbRows} diskFiles=${report.totalDiskFiles}`,
    });

    return report;
  }

  /**
   * Apply a fix action (relink or quarantine) to an identified issue.
   */
  @Post('fix')
  @ApiOperation({
    summary: 'Apply a diagnostics fix (relink or quarantine)',
    description:
      'Server-admin only. Relink updates the DB row to match the actual file location. ' +
      'Quarantine moves the file to a quarantine directory before deletion.',
  })
  @ApiResponse({ status: 201, description: 'Fix result.' })
  @ApiResponse({ status: 400, description: 'Invalid request (missing attachmentId or diskPath).' })
  async fix(@Body() body: DiagnosticFixRequestDto, @CurrentUser() actor: RequestUser) {
    if (!body.attachmentId && !body.diskPath) {
      throw new BadRequestException('Either attachmentId or diskPath must be provided');
    }

    const result = await this.diagnostics.applyFix({
      attachmentId: body.attachmentId,
      diskPath: body.diskPath,
      action: body.action,
    });

    await this.audit.log({
      actor: auditActor(actor),
      actorRole: 'dm',
      action: `attachments.diagnostics.fix.${body.action}`,
      entityType: 'attachment',
      entityId: body.attachmentId,
      detail: result.detail,
    });

    return result;
  }
}
