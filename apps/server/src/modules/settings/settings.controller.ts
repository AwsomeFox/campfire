import { Body, Controller, Get, Patch, Put } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ServerRoles } from '../../common/decorators/server-roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { type RequestUser, auditActor, auditActorRole } from '../../common/user.types';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from './settings.service';
import { AiSeatDefaultsDto, SettingsUpdateDto } from './settings.dto';

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
      actorRole: auditActorRole(actor),
      action: 'settings.update',
      entityType: 'settings',
      detail: changed.map((k) => `${k}=${String((updated as Record<string, unknown>)[k])}`).join(', ') || 'no-op',
    });
    return updated;
  }

  /**
   * #1070 — the server-wide AI seat defaults a brand-new campaign inherits.
   *
   * Deliberately separate from PATCH /settings: those are flat booleans/numbers describing the
   * INSTALL, while this is a structured block describing how new campaigns START. Folding it
   * into the same strict DTO would make a partial seat-defaults update indistinguishable from
   * clearing the fields it omitted.
   */
  @Get('ai-seat-defaults')
  @ApiOperation({
    summary: 'Get the server-wide AI seat defaults',
    description:
      'Server-admin only. The mode / steering / token budget / queue depth a campaign inherits until it configures ' +
      'its own AI seat. Inheritance is LIVE while a campaign has no seat row (mirroring how the AI provider already ' +
      'resolves campaign-then-server); the first save detaches that campaign, seeded from these values. Carries no ' +
      'credential — provider keys live on the AI provider config and are never part of a seat.',
  })
  @ApiResponse({ status: 200, description: 'The current AI seat defaults.' })
  getAiSeatDefaults() {
    return this.settings.getAiSeatDefaults();
  }

  @Put('ai-seat-defaults')
  @ApiOperation({
    summary: 'Replace the server-wide AI seat defaults',
    description:
      'Server-admin only. Replaces the whole block — an omitted field resets to its built-in fallback rather than ' +
      'being left alone, so a client must send the full object. Changing these moves every campaign that has not yet ' +
      'configured its own seat, and no campaign that has.',
  })
  @ApiResponse({ status: 200, description: 'The saved AI seat defaults.' })
  async setAiSeatDefaults(@Body() body: AiSeatDefaultsDto, @CurrentUser() actor: RequestUser) {
    const saved = await this.settings.setAiSeatDefaults(body);
    await this.audit.log({
      actor: auditActor(actor),
      actorRole: auditActorRole(actor),
      action: 'settings.ai-seat-defaults.update',
      entityType: 'settings',
      // Steering can be long and is DM-authored prose; record only that it changed.
      detail: `mode=${saved.mode}, tokenBudget=${saved.tokenBudget}, actionQueueDepth=${saved.actionQueueDepth}, instructions=${saved.instructions.length} chars`,
    });
    return saved;
  }
}
