import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ServerRoles } from '../../common/decorators/server-roles.decorator';
import { SettingsService } from './settings.service';
import { SettingsUpdateDto } from './settings.dto';

@ApiTags('settings')
@Controller('settings')
@ServerRoles('admin')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  get() {
    return this.settings.getAll();
  }

  @Patch()
  update(@Body() body: SettingsUpdateDto) {
    return this.settings.update(body);
  }
}
