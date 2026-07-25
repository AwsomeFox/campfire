import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ServerRoles } from '../../common/decorators/server-roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { RosterImportService } from './roster-import.service';
import { RosterImportDto } from './roster-import.dto';

/**
 * Server-admin bulk roster import (issue #589). Dry-run validates CSV/JSON rows,
 * surfaces per-row diagnostics, and returns a batch fingerprint. Commit applies
 * the reviewed batch in one transaction and returns expiring activation codes
 * for newly created accounts (never logged in audit detail).
 */
@ApiTags('admin')
@Controller('admin/roster-import')
@ServerRoles('admin')
export class RosterImportController {
  constructor(private readonly rosterImport: RosterImportService) {}

  @Post()
  @ApiOperation({
    summary: 'Dry-run or commit a bulk roster import',
    description:
      'Server-admin only. `dryRun:true` parses CSV/JSON, maps columns, validates rows, and returns per-row diagnostics plus a `batchId`. ' +
      '`dryRun:false` commits the reviewed `rows` from the preview inside one transaction; new accounts receive expiring activation codes in the response (shown once, never audited).',
  })
  @ApiResponse({ status: 201, description: 'Dry-run preview or commit result.' })
  @ApiResponse({ status: 400, description: 'Invalid content or commit validation failed.' })
  @ApiResponse({ status: 403, description: 'Requires server-admin power.' })
  @ApiResponse({ status: 409, description: 'batchId mismatch.' })
  run(@Body() body: RosterImportDto, @CurrentUser() actor: RequestUser) {
    return this.rosterImport.run(body, actor);
  }
}
