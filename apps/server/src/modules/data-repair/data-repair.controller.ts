import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ServerRoles } from '../../common/decorators/server-roles.decorator';
import { auditActor, auditActorRole, type RequestUser } from '../../common/user.types';
import { RepairApplyDto, RepairPreviewDto } from './data-repair.dto';
import { DataRepairService } from './data-repair.service';

/** Server-wide, metadata-only integrity repair operations (issue #729). */
@ApiTags('admin')
@Controller('admin/data-repair')
@ServerRoles('admin')
export class DataRepairController {
  constructor(private readonly repairs: DataRepairService) {}

  @Get()
  @ApiOperation({ summary: 'Read data repair health and recent scan history' })
  latest() { return this.repairs.latest(); }

  @Post('scan')
  @ApiOperation({ summary: 'Run a persisted, read-only integrity scan' })
  scan(@CurrentUser() actor: RequestUser) { return this.repairs.scan('admin', auditActor(actor), auditActorRole(actor)); }

  @Get('findings')
  @ApiOperation({ summary: 'List persisted integrity findings' })
  findings(@Query('status') status?: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.repairs.findings(status, Number(limit) || 100, Number(offset) || 0);
  }

  @Post('preview')
  @ApiOperation({ summary: 'Preview an integrity repair without changing data' })
  preview(@Body() input: RepairPreviewDto) { return this.repairs.preview(input); }

  @Post('apply')
  @ApiOperation({ summary: 'Apply a previewed repair after creating a private database backup' })
  apply(@Body() input: RepairApplyDto, @CurrentUser() actor: RequestUser) {
    return this.repairs.apply(input, auditActor(actor), auditActorRole(actor));
  }

  @Post('actions/:id/undo')
  @ApiOperation({ summary: 'Undo a single applied repair when doing so remains referentially safe' })
  undo(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: RequestUser) {
    return this.repairs.undo(id, auditActor(actor), auditActorRole(actor));
  }

  @Get('support-bundle')
  @ApiOperation({ summary: 'Download a redacted, secret-free integrity support bundle' })
  supportBundle(@Res() res: Response): void {
    res.setHeader('Cache-Control', 'private, no-store');
    res.type('application/json');
    res.attachment('campfire-data-repair-support.json');
    res.send(JSON.stringify(this.repairs.bundle(), null, 2));
  }
}
