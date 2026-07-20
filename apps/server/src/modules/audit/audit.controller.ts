import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { parsePageParams } from '../../common/pagination';
import { AuditService } from './audit.service';

/**
 * Audit list paging (issue #71). Default page size stays 100 (unchanged for
 * existing callers); `?limit`/`?offset` now let a client page BACK through older
 * history that the hardcoded cap-100 previously made unreachable via the API.
 */
export const AUDIT_DEFAULT_LIMIT = 100;
export const AUDIT_MAX_LIMIT = 500;

@ApiTags('audit')
@Controller('campaigns/:id/audit')
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List recent audit entries for a campaign',
    description: 'dm role required. Most-recent-first. Defaults to 100 entries; page with `?limit` (max 500) and `?offset`.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max entries to return (default 100, max 500).' })
  @ApiQuery({ name: 'offset', required: false, type: Number, description: 'Entries to skip, for paging older history (default 0).' })
  @ApiResponse({ status: 200, description: 'Audit entries, most-recent-first.' })
  async list(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: RequestUser,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    // allowArchived: reading the audit log of an archived (read-only) campaign is fine.
    await this.access.requireRole(user, id, 'dm', { allowArchived: true });
    const page = parsePageParams({ limit, offset }, AUDIT_MAX_LIMIT);
    return this.audit.listForCampaign(id, page.limit ?? AUDIT_DEFAULT_LIMIT, page.offset ?? 0);
  }
}
