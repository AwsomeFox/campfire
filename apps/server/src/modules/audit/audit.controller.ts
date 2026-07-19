import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { AuditService } from './audit.service';

@ApiTags('audit')
@Controller('campaigns/:id/audit')
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List recent audit entries for a campaign', description: 'dm role required. Most-recent-first, capped at 100 entries.' })
  @ApiResponse({ status: 200, description: 'Up to 100 most recent audit entries.' })
  async list(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, id, 'dm');
    return this.audit.listForCampaign(id, 100);
  }
}
