import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';

// Single-sourced from package.json so /healthz, Swagger and tags can't drift.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const VERSION: string = require('../../../package.json').version;

@ApiTags('health')
@Controller()
export class HealthController {
  @Public()
  @Get('healthz')
  @ApiOperation({ summary: 'Liveness check', description: 'Unauthenticated. Always 200 while the process is up — no DB/dependency checks.' })
  @ApiResponse({ status: 200, description: 'Server is up.' })
  healthz() {
    return { ok: true, version: VERSION };
  }
}
