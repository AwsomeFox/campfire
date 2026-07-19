import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuditService } from './audit.service';

@ApiTags('audit')
@Controller('campaigns/:id/audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @Roles('dm')
  list(@Param('id', ParseIntPipe) id: number) {
    return this.audit.listForCampaign(id, 100);
  }
}
