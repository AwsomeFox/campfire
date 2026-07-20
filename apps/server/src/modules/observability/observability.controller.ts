import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ServerRoles } from '../../common/decorators/server-roles.decorator';
import { ObservabilityService } from './observability.service';

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
  constructor(private readonly observability: ObservabilityService) {}

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
}
