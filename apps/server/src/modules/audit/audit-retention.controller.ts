import { BadRequestException, Body, Controller, Get, Patch, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ServerRoles } from '../../common/decorators/server-roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { auditActor, auditActorRole, type RequestUser } from '../../common/user.types';
import { AuditService } from './audit.service';
import { AuditLegalHoldDto, AuditPruneRequestDto, AuditRetentionPolicyUpdateDto } from './audit-retention.dto';

@ApiTags('audit')
@Controller('admin/audit')
@ServerRoles('admin')
export class AuditRetentionController {
  constructor(private readonly audit: AuditService) {}

  @Get('retention')
  @ApiOperation({
    summary: 'Read audit retention policy and prune status',
    description:
      'Server-admin only. Discloses the effective audit retention policy, legal hold, archive directory, and last prune job.',
  })
  @ApiResponse({ status: 200, description: 'Audit retention status.' })
  getRetention() {
    return this.audit.getRetentionStatus();
  }

  @Patch('retention')
  @ApiOperation({
    summary: 'Update audit retention policy',
    description:
      'Server-admin only. Updates persisted policy (env vars still take precedence) and records audit.retention.update.',
  })
  @ApiResponse({ status: 200, description: 'Updated effective audit retention policy.' })
  updateRetention(@Body() body: AuditRetentionPolicyUpdateDto, @CurrentUser() user: RequestUser) {
    return this.audit.updateRetentionPolicy(body, { actor: auditActor(user), actorRole: auditActorRole(user) });
  }

  @Post('retention/preview')
  @ApiOperation({
    summary: 'Dry-run audit retention prune',
    description:
      'Server-admin only. Counts rows older than the cutoff, plus rows protected by legal hold, without deleting anything.',
  })
  @ApiResponse({ status: 201, description: 'Dry-run prune job.' })
  preview(@Body() body: AuditPruneRequestDto, @CurrentUser() user: RequestUser) {
    return this.audit.pruneExpiredJob({
      dryRun: true,
      retentionDays: body.retentionDays,
      actor: auditActor(user),
      actorRole: auditActorRole(user),
    });
  }

  @Post('retention/prune')
  @ApiOperation({
    summary: 'Archive and prune expired audit rows',
    description:
      'Server-admin only. Requires `{ confirm: true }`. Archives eligible rows before deleting and records audit.prune.',
  })
  @ApiResponse({ status: 201, description: 'Completed prune job.' })
  prune(@Body() body: AuditPruneRequestDto, @CurrentUser() user: RequestUser) {
    if (body.confirm !== true) {
      throw new BadRequestException('confirm=true is required to prune audit history');
    }
    return this.audit.pruneExpiredJob({
      retentionDays: body.retentionDays,
      force: body.force,
      actor: auditActor(user),
      actorRole: auditActorRole(user),
    });
  }

  @Put('legal-hold')
  @ApiOperation({
    summary: 'Set audit legal hold',
    description:
      'Server-admin only. A global hold blocks all pruning; campaign holds exempt those campaign rows from pruning.',
  })
  @ApiResponse({ status: 200, description: 'Updated legal hold policy.' })
  updateLegalHold(@Body() body: AuditLegalHoldDto, @CurrentUser() user: RequestUser) {
    return this.audit.updateLegalHold(body, { actor: auditActor(user), actorRole: auditActorRole(user) });
  }
}
