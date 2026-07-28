import { Controller, Get, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ServerRoles } from '../../common/decorators/server-roles.decorator';
import { ObservabilityService } from './observability.service';
import { StorageDiagnosticsService } from '../health/storage-diagnostics.service';

/**
 * Admin observability dashboard (issue #22). Server-admin only — the whole
 * controller is gated by @ServerRoles('admin'), enforced by ServerRolesGuard
 * (which additionally requires a PAT caller's token be adminEnabled). Mounted
 * under /admin/metrics so it sits alongside the other server-wide admin surfaces
 * (users, settings) rather than any per-campaign namespace.
 */
@ApiTags('admin')
@Controller('admin/metrics')
@ServerRoles('admin')
export class ObservabilityController {
  constructor(private readonly observability: ObservabilityService, private readonly diagnostics: StorageDiagnosticsService) {}

  @Get()
  @ApiOperation({
    summary: 'Server observability metrics',
    description:
      'Server-admin only. Cheap operational snapshot: entity counts, on-disk DB size, uptime, version, and recent activity.',
  })
  @ApiResponse({ status: 200, description: 'Current server metrics snapshot.' })
  get() {
    return this.observability.getMetrics();
  }

  @Get('diagnostics')
  @ApiOperation({
    summary: 'Storage and database diagnostics snapshot',
    description:
      'Server-admin only. Bounded, cached diagnostics covering database writeability, schema/migration status, storage identity, disk/WAL usage, and the most recent quick/integrity check results.',
  })
  @ApiResponse({ status: 200, description: 'Current storage diagnostics snapshot.' })
  diagnosticsSnapshot() { return this.diagnostics.snapshot(); }

  @Post('diagnostics/quick-check')
  @ApiOperation({
    summary: 'Run a quick database integrity check',
    description: 'Server-admin only. Triggers a bounded, fast integrity check (PRAGMA quick_check) and returns its result.',
  })
  @ApiResponse({ status: 201, description: 'Result of the quick integrity check.' })
  async quickCheck() { const result = await this.diagnostics.runIntegrity('quick'); this.diagnostics.snapshot(); return result; }

  @Post('diagnostics/integrity-check')
  @ApiOperation({
    summary: 'Run a full database integrity check',
    description: 'Server-admin only. Triggers a full integrity check (PRAGMA integrity_check) and returns its result.',
  })
  @ApiResponse({ status: 201, description: 'Result of the full integrity check.' })
  async integrityCheck() { const result = await this.diagnostics.runIntegrity('full'); this.diagnostics.snapshot(); return result; }
}
