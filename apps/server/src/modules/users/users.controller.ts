import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import type { ApiTokenCreated } from '@campfire/schema';
import { ServerRoles } from '../../common/decorators/server-roles.decorator';
import type { RequestUser } from '../../common/user.types';
import { UsersService } from './users.service';
import { TokensService } from '../tokens/tokens.service';
import { UserCreateDto, UserUpdateDto, PasswordChangeDto, AdminTokenCreateDto } from './users.dto';

/** Any authenticated user — used by the member-picker. Must be declared before UsersController so /users/lookup doesn't get swallowed by /users/:id-shaped routes in admin controller ordering. */
@ApiTags('users')
@Controller('users')
export class UsersLookupController {
  constructor(private readonly users: UsersService) {}

  @Get('lookup')
  @ApiOperation({ summary: 'Look up users by username/display name', description: 'Any authenticated user. Used by member pickers. Requires query >= 2 chars.' })
  @ApiQuery({ name: 'query', required: true, description: 'Substring match against username or displayName, min length 2.' })
  @ApiResponse({ status: 200, description: 'Up to 10 matching users (id, username, displayName).' })
  @ApiResponse({ status: 400, description: 'query missing or shorter than 2 characters.' })
  lookup(@Query('query') query: string | undefined) {
    if (!query || query.trim().length < 2) {
      throw new BadRequestException('query must be at least 2 characters');
    }
    return this.users.lookup(query.trim());
  }
}

@ApiTags('users')
@Controller('users')
@ServerRoles('admin')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly tokens: TokensService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List all users', description: 'Server-admin only.' })
  @ApiResponse({ status: 200, description: 'All users.' })
  list() {
    return this.users.list();
  }

  @Post()
  @ApiOperation({ summary: 'Create a user', description: 'Server-admin only.' })
  @ApiResponse({ status: 201, description: 'Created user.' })
  @ApiResponse({ status: 409, description: 'Username already taken.' })
  create(@Body() body: UserCreateDto) {
    return this.users.create(body);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a user', description: 'Server-admin only. Refuses to demote/disable the last enabled admin.' })
  @ApiResponse({ status: 200, description: 'Updated user.' })
  @ApiResponse({ status: 409, description: 'Would demote or disable the last enabled admin.' })
  update(@Param('id', ParseIntPipe) id: number, @Body() body: UserUpdateDto) {
    return this.users.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a user', description: 'Server-admin only. Refuses to delete the last enabled admin, or a user who is the sole DM of any campaign.' })
  @ApiResponse({ status: 204, description: 'Deleted.' })
  @ApiResponse({ status: 409, description: 'Last enabled admin, or sole DM of one or more campaigns.' })
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.users.remove(id);
  }

  @Post(':id/password')
  @HttpCode(204)
  @ApiOperation({ summary: "Reset a user's password", description: 'Server-admin only. No currentPassword check (admin reset, not self-service).' })
  @ApiResponse({ status: 204, description: 'Password reset.' })
  async setPassword(@Param('id', ParseIntPipe) id: number, @Body() body: PasswordChangeDto) {
    await this.users.setPassword(id, body.newPassword);
  }

  /**
   * Admin provisioning: mint a PAT on behalf of another user, so a DM/admin agent
   * can provision an entire table's worth of tokens without ever knowing player
   * passwords. Deliberately does NOT reuse the admin's own access: scope/campaignId
   * are checked against the TARGET user (`id`)'s real campaign membership via
   * TokensService.mintFor()'s `caller` param, exactly like the headless bootstrap
   * (POST /auth/token) checks the authenticating user's own access. An admin
   * cannot use this route to mint a token scoped to a campaign the target user
   * has no relationship to (403), even though the admin themself could access it.
   */
  @Post(':id/tokens')
  @ApiOperation({
    summary: 'Mint a PAT for another user (admin provisioning)',
    description:
      "Server-admin only. Mints a personal access token owned by user `id`, without needing that user's password. " +
      "scope/campaignId are validated against the TARGET user's own campaign access, not the admin's — an admin cannot mint a token scoped to a campaign the target user cannot access.",
  })
  @ApiResponse({ status: 201, description: 'PAT minted for the target user. `token` is shown once — store it now.' })
  @ApiResponse({ status: 403, description: 'Target user has no access to the requested campaignId.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  async mintToken(@Param('id', ParseIntPipe) id: number, @Body() body: AdminTokenCreateDto): Promise<ApiTokenCreated> {
    const target = await this.users.getOrThrow(id);
    const owner: RequestUser = { id: String(target.id), name: target.displayName || target.username, serverRole: target.serverRole };
    return this.tokens.mintFor(owner, target.id, body);
  }
}
