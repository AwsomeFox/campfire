import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
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
  async list(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, id, 'dm');
    return this.audit.listForCampaign(id, 100);
  }
}
