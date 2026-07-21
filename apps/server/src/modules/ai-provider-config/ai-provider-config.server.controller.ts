import { Body, Controller, Delete, Get, HttpCode, Post, Put } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ServerRoles } from '../../common/decorators/server-roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { AiProviderConfigService } from './ai-provider-config.service';
import { AiProviderConfigUpdateDto } from './ai-provider-config.dto';

/**
 * Server-default AI provider config (issue #310) — ADMIN only (@ServerRoles('admin')).
 *
 * The stored API key is write-only: PUT accepts it, but GET returns only a redacted
 * view (`configured` + `keyLast4`), never the key. This is the fallback config every
 * campaign inherits unless it sets its own override.
 */
@ApiTags('ai-provider')
@Controller('settings/ai-provider')
@ServerRoles('admin')
export class AiProviderServerConfigController {
  constructor(private readonly configs: AiProviderConfigService) {}

  @Get()
  @ApiOperation({
    summary: 'Get the server-default AI provider config',
    description: 'Server-admin only. Redacted: the API key is never returned — only `configured` + `keyLast4`.',
  })
  @ApiResponse({ status: 200, description: 'The redacted server-default config, or null when unset.' })
  get() {
    return this.configs.getServerView();
  }

  @Put()
  @ApiOperation({
    summary: 'Set the server-default AI provider config',
    description:
      'Server-admin only. `apiKey` is write-only (omit to keep, value to set/rotate, "" to clear). `allowedModels`, ' +
      'when non-empty, restricts which models a per-campaign override may select.',
  })
  @ApiResponse({ status: 200, description: 'The updated (redacted) config.' })
  put(@Body() body: AiProviderConfigUpdateDto, @CurrentUser() user: RequestUser) {
    return this.configs.putServer(body, user);
  }

  @Delete()
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete the server-default AI provider config', description: 'Server-admin only.' })
  @ApiResponse({ status: 204, description: 'Deleted (or already absent).' })
  async remove(@CurrentUser() user: RequestUser) {
    await this.configs.deleteServer(user);
  }

  @Post('test')
  @ApiOperation({
    summary: 'Test the server-default AI provider connection',
    description:
      'Server-admin only. Builds the provider from the decrypted server config and runs a minimal probe. ' +
      'Returns ok/error only — never any credential.',
  })
  @ApiResponse({ status: 201, description: 'The connection test result.' })
  async test() {
    const r = await this.configs.testConnection(null);
    return { scope: 'server' as const, ...r };
  }
}
