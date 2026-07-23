import { Body, Controller, Delete, Get, HttpCode, Post, Put } from '@nestjs/common';
import { ApiBody, ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ServerRoles } from '../../common/decorators/server-roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { AiProviderConfigService } from './ai-provider-config.service';
import {
  AiProviderConfigUpdateDto,
  AI_PROVIDER_TEST_REQUEST_OPENAPI_SCHEMA,
  AiProviderTestRequestDto,
  AiProviderTestResultDto,
} from './ai-provider-config.dto';

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
    description:
      'Server-admin only. Redacted: the API key is never returned — only `configured`, `keyLast4`, and non-secret credential source/readiness.',
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

  @Delete('key')
  @ApiOperation({
    summary: 'Clear the stored server-default API key',
    description:
      'Server-admin only. Clears only the encrypted key and masked last-four indicator. Provider, model, base URL, ' +
      'parameters, and model allowlist are retained. A matching environment credential may become effective. Audited without key material.',
  })
  @ApiResponse({ status: 200, description: 'The retained config with updated non-secret credential source/readiness.' })
  @ApiResponse({ status: 404, description: 'No server-default provider config exists.' })
  clearKey(@CurrentUser() user: RequestUser) {
    return this.configs.clearServerKey(user);
  }

  @Delete()
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete the server-default AI provider config', description: 'Server-admin only.' })
  @ApiResponse({ status: 204, description: 'Deleted (or already absent).' })
  async remove(@CurrentUser() user: RequestUser) {
    await this.configs.deleteServer(user);
  }

  @Post('test')
  @Throttle({ ai: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: 'Test a server-default AI provider draft',
    description:
      'Server-admin only. Tests the submitted provider/model/base URL and optional write-only key without saving them. ' +
      'A blank or omitted key reuses the stored server key, then the matching environment credential. Returns only ' +
      'non-secret target/scope/credential-source metadata and the redacted result.',
  })
  @ApiBody({ schema: AI_PROVIDER_TEST_REQUEST_OPENAPI_SCHEMA })
  @ApiResponse({ status: 201, description: 'The non-persisting connection test result.', type: AiProviderTestResultDto })
  async test(@Body() body: AiProviderTestRequestDto) {
    return this.configs.testConnection(null, body);
  }

  @Post('models')
  @Throttle({ ai: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: 'Fetch available models from the configured or draft AI provider',
    description:
      'Server-admin only. Queries the provider\'s model list (e.g. GET /v1/models). Accepts an optional draft body ' +
      'so models can be discovered before saving. Returns a string array of model IDs.',
  })
  @ApiBody({ schema: AI_PROVIDER_TEST_REQUEST_OPENAPI_SCHEMA })
  @ApiResponse({ status: 201, description: 'Available model IDs.', type: Object })
  async models(@Body() body: AiProviderTestRequestDto) {
    const models = await this.configs.fetchAvailableModels(null, body);
    return { models };
  }
}
