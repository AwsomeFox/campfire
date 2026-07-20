import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { ServerRoles } from '../../common/decorators/server-roles.decorator';
import { parsePageParams } from '../../common/pagination';
import { AuditService } from './audit.service';
import { AUDIT_DEFAULT_LIMIT, AUDIT_MAX_LIMIT } from './audit.controller';

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
    description: 'Server-admin only. Server-wide actions (campaign_id null), most-recent-first. Defaults to 100 entries; page with `?limit` (max 500) and `?offset`.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max entries to return (default 100, max 500).' })
  @ApiQuery({ name: 'offset', required: false, type: Number, description: 'Entries to skip, for paging older history (default 0).' })
  @ApiResponse({ status: 200, description: 'Server-admin audit entries, most-recent-first.' })
  list(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    const page = parsePageParams({ limit, offset }, AUDIT_MAX_LIMIT);
    return this.audit.listServerAdmin(page.limit ?? AUDIT_DEFAULT_LIMIT, page.offset ?? 0);
  }
}
