import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { APP_VERSION } from '../../common/build-metadata';
import { StorageDiagnosticsService } from './storage-diagnostics.service';
import { DataRepairService } from '../data-repair/data-repair.service';

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(
    private readonly diagnostics: StorageDiagnosticsService,
    private readonly repairs: DataRepairService,
  ) {}

  @Public()
  @Get('healthz')
  @ApiOperation({ summary: 'Liveness check', description: 'Unauthenticated. Always 200 while the process is up — no DB/dependency checks. Use /readyz for readiness (DB) checks.' })
  @ApiResponse({ status: 200, description: 'Server is up.' })
  healthz() {
    return { ok: true, version: APP_VERSION };
  }

  @Public()
  @Get('readyz')
  @ApiOperation({
    summary: 'Readiness check',
    description:
      'Unauthenticated. Performs bounded database, rollback-only write, schema, and storage-identity checks — 503 when serving is unsafe. ' +
      'Includes bounded data-repair integrity metadata when a persisted finding remains open. ' +
      'The Docker HEALTHCHECK targets this endpoint so a broken DB marks the container unhealthy (issue #52/#724/#729). ' +
      'Response `checks` values are intentional stable machine codes (never filesystem paths) for operators/orchestrators.',
  })
  @ApiResponse({ status: 200, description: 'Server is up and the database answers queries.' })
  @ApiResponse({ status: 503, description: 'Database is unavailable (locked/corrupted/unmounted volume).' })
  readyz() {
    const result = this.diagnostics.readiness();
    // Stable codes only — never absolute paths or host-specific strings (issue #724).
    const body = {
      ok: result.ready,
      version: APP_VERSION,
      degraded: result.status === 'degraded',
      checks: Object.fromEntries(Object.entries(result.checks).map(([key, value]) => [key, value.code])),
    };
    if (!result.ready) throw new ServiceUnavailableException(body);

    let dataRepair: { degraded: boolean; openCount: number | null; latestRunAt: string | null; error?: string };
    try {
      dataRepair = this.repairs.publicHealth();
    } catch {
      dataRepair = { degraded: true, openCount: null, latestRunAt: null, error: 'unavailable' };
    }
    return { ...body, dataRepair };
  }
}
