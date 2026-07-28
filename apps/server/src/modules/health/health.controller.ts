import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { Public } from '../../common/decorators/public.decorator';
import { APP_VERSION } from '../../common/build-metadata';
import { DB, type DrizzleDb } from '../../db/db.module';
import { DataRepairService } from '../data-repair/data-repair.service';

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(@Inject(DB) private readonly db: DrizzleDb, private readonly repairs: DataRepairService) {}

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
      'Unauthenticated. Runs a real `SELECT 1` against SQLite and includes bounded degraded integrity metadata when a persisted finding remains open. ' +
      'The Docker HEALTHCHECK targets this endpoint so a broken or inconsistent DB marks the container unhealthy (issue #52/#729).',
  })
  @ApiResponse({ status: 200, description: 'Server is up and the database answers queries.' })
  @ApiResponse({ status: 503, description: 'Database is unavailable (locked/corrupted/unmounted volume).' })
  readyz() {
    try {
      // Cheap but real round-trip through the better-sqlite3 driver — throws
      // synchronously if the connection is closed/broken (e.g. locked file,
      // corrupted DB, unmounted /data volume).
      this.db.get(sql`SELECT 1`);
    } catch {
      // Body shape mirrors healthz (`ok`/`version`) so probes can parse both alike.
      throw new ServiceUnavailableException({ ok: false, version: APP_VERSION, error: 'database unavailable' });
    }
    // Public health exposes bounded metadata only; detailed findings are admin-only.
    // Never let optional integrity metadata fail the readiness probe itself.
    let dataRepair: { degraded: boolean; openCount: number | null; latestRunAt: string | null; error?: string };
    try {
      dataRepair = this.repairs.publicHealth();
    } catch {
      dataRepair = { degraded: true, openCount: null, latestRunAt: null, error: 'unavailable' };
    }
    return { ok: true, version: APP_VERSION, dataRepair };
  }
}
