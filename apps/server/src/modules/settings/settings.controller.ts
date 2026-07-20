import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ServerRoles } from '../../common/decorators/server-roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { type RequestUser, auditActor } from '../../common/user.types';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from './settings.service';
import { SettingsUpdateDto } from './settings.dto';

@ApiTags('settings')
@Controller('settings')
@ServerRoles('admin')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get server settings', description: 'Server-admin only.' })
  @ApiResponse({ status: 200, description: 'Current server settings.' })
  get() {
    return this.settings.getAll();
  }

  @Patch()
  @ApiOperation({ summary: 'Update server settings', description: 'Server-admin only. e.g. allowLocalLogin gates non-admin local (password) login; allowSignup gates self-service signup (POST /auth/signup).' })
  @ApiResponse({ status: 200, description: 'Updated server settings.' })
  async update(@Body() body: SettingsUpdateDto, @CurrentUser() actor: RequestUser) {
    const updated = await this.settings.update(body);
    // #23: server-wide admin trail — which settings keys were touched (values in detail).
    const changed = Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined);
    await this.audit.log({
      actor: auditActor(actor),
      actorRole: 'dm',
      action: 'settings.update',
      entityType: 'settings',
      detail: changed.map((k) => `${k}=${String((updated as Record<string, unknown>)[k])}`).join(', ') || 'no-op',
    });
    return updated;
  }
}
