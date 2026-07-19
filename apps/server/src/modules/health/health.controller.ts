import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';

// Single-sourced from package.json so /healthz, Swagger and tags can't drift.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const VERSION: string = require('../../../package.json').version;

@ApiTags('health')
@Controller()
export class HealthController {
  @Public()
  @Get('healthz')
  healthz() {
    return { ok: true, version: VERSION };
  }
}
