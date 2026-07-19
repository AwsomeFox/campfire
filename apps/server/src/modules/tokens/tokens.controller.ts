import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiCookieAuth } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { TokensService } from './tokens.service';
import { ApiTokenCreateDto } from './tokens.dto';

/** dev:* header users have no real users.id row and can't own tokens. */
function requireRealUserId(user: RequestUser): number {
  if (user.id.startsWith('dev:')) {
    throw new ForbiddenException('API tokens are not available for dev-auth users');
  }
  return Number(user.id);
}

@ApiTags('tokens')
@ApiCookieAuth('campfire_session')
@ApiBearerAuth('bearer')
@Controller('tokens')
export class TokensController {
  constructor(private readonly tokens: TokensService) {}

  @Get()
  @ApiOperation({ summary: 'List own tokens', description: "Lists the caller's own personal access tokens (metadata only — raw token values are never retrievable after creation)." })
  @ApiResponse({ status: 200, description: 'Own tokens.' })
  list(@CurrentUser() user: RequestUser) {
    return this.tokens.listOwn(requireRealUserId(user));
  }

  @Post()
  @ApiOperation({ summary: 'Create a personal access token', description: "Self-service PAT minting. scope caps the effective role (min(scope, real membership role)); campaignId optionally binds the token to a single campaign the caller has real access to (403 otherwise)." })
  @ApiResponse({ status: 201, description: 'PAT created. `token` is shown once — store it now.' })
  @ApiResponse({ status: 403, description: 'No access to the requested campaignId.' })
  create(@Body() body: ApiTokenCreateDto, @CurrentUser() user: RequestUser) {
    return this.tokens.create(requireRealUserId(user), body, user);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke a token', description: 'Deletes a token immediately, invalidating it for future requests. Only the owning user may delete it.' })
  @ApiResponse({ status: 204, description: 'Revoked.' })
  @ApiResponse({ status: 404, description: "Token not found, or not owned by the caller (owner mismatch reported as 404, not 403, to avoid confirming the id's existence)." })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser): Promise<void> {
    await this.tokens.remove(requireRealUserId(user), id);
  }
}
