import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ServerRoles } from '../../common/decorators/server-roles.decorator';
import { AuditService } from './audit.service';

/**
 * #23: server-wide admin audit trail. Lists audit rows not tied to any campaign
 * (campaign_id IS NULL) — account create/disable/delete, settings changes,
 * rule-pack installs, admin token mints. Server-admin only (@ServerRoles gates
 * via ServerRolesGuard + hasServerAdminPower, so a scope-capped PAT can't read it).
 */
@ApiTags('audit')
@Controller('admin/audit')
@ServerRoles('admin')
export class ServerAuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @ApiOperation({
    summary: 'List recent server-admin audit entries',
    description: 'Server-admin only. Server-wide actions (campaign_id null), most-recent-first, capped at 100 entries.',
  })
  @ApiResponse({ status: 200, description: 'Up to 100 most recent server-admin audit entries.' })
  list() {
    return this.audit.listServerAdmin(100);
  }
}
