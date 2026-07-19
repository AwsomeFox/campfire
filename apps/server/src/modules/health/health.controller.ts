import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';

const VERSION = '0.1.0';

@ApiTags('health')
@Controller()
export class HealthController {
  @Public()
  @Get('healthz')
  healthz() {
    return { ok: true, version: VERSION };
  }
}
