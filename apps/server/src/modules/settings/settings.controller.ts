import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ServerRoles } from '../../common/decorators/server-roles.decorator';
import { SettingsService } from './settings.service';
import { SettingsUpdateDto } from './settings.dto';

@ApiTags('settings')
@Controller('settings')
@ServerRoles('admin')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Get server settings', description: 'Server-admin only.' })
  @ApiResponse({ status: 200, description: 'Current server settings.' })
  get() {
    return this.settings.getAll();
  }

  @Patch()
  @ApiOperation({ summary: 'Update server settings', description: 'Server-admin only. e.g. allowLocalLogin gates non-admin local (password) login; allowSignup gates self-service signup (POST /auth/signup).' })
  @ApiResponse({ status: 200, description: 'Updated server settings.' })
  update(@Body() body: SettingsUpdateDto) {
    return this.settings.update(body);
  }
}
