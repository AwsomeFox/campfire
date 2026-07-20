import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import type { ApiTokenCreated } from '@campfire/schema';
import { ServerRoles } from '../../common/decorators/server-roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { type RequestUser, auditActor } from '../../common/user.types';
import { UsersService } from './users.service';
import { TokensService } from '../tokens/tokens.service';
import { AuditService } from '../audit/audit.service';
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
    private readonly audit: AuditService,
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
  async create(@Body() body: UserCreateDto, @CurrentUser() actor: RequestUser) {
    const created = await this.users.create(body);
    // #23: server-wide admin trail (campaignId null) — account creation.
    await this.audit.log({
      actor: auditActor(actor),
      actorRole: 'dm',
      action: 'user.create',
      entityType: 'user',
      entityId: created.id,
      detail: `${created.username} (role ${created.serverRole})`,
    });
    return created;
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a user', description: 'Server-admin only. Refuses to demote/disable the last enabled admin.' })
  @ApiResponse({ status: 200, description: 'Updated user.' })
  @ApiResponse({ status: 409, description: 'Would demote or disable the last enabled admin.' })
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: UserUpdateDto, @CurrentUser() actor: RequestUser) {
    const updated = await this.users.update(id, body);
    // #23: log the admin-meaningful transitions (role change / disable-enable),
    // naming which one fired so the trail reads at a glance.
    const changes: string[] = [];
    if (body.serverRole !== undefined) changes.push(`role=${updated.serverRole}`);
    if (body.disabled !== undefined) changes.push(updated.disabled ? 'disabled' : 'enabled');
    if (body.displayName !== undefined) changes.push('displayName');
    await this.audit.log({
      actor: auditActor(actor),
      actorRole: 'dm',
      action: 'user.update',
      entityType: 'user',
      entityId: id,
      detail: `${updated.username}: ${changes.join(', ') || 'no-op'}`,
    });
    return updated;
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a user', description: 'Server-admin only. Refuses to delete the last enabled admin, or a user who is the sole DM of any campaign.' })
  @ApiResponse({ status: 204, description: 'Deleted.' })
  @ApiResponse({ status: 409, description: 'Last enabled admin, or sole DM of one or more campaigns.' })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: RequestUser) {
    // Capture the username before the row is gone, so the trail names the target.
    const target = await this.users.getOrThrow(id);
    await this.users.remove(id);
    // #23: server-wide admin trail — account deletion.
    await this.audit.log({
      actor: auditActor(actor),
      actorRole: 'dm',
      action: 'user.delete',
      entityType: 'user',
      entityId: id,
      detail: target.username,
    });
  }

  @Post(':id/password')
  @HttpCode(204)
  @ApiOperation({ summary: "Reset a user's password", description: 'Server-admin only. No currentPassword check (admin reset, not self-service).' })
  @ApiResponse({ status: 204, description: 'Password reset.' })
  async setPassword(@Param('id', ParseIntPipe) id: number, @Body() body: PasswordChangeDto, @CurrentUser() actor: RequestUser) {
    await this.users.setPassword(id, body.newPassword);
    // #23: log that a reset happened — never the password itself.
    await this.audit.log({
      actor: auditActor(actor),
      actorRole: 'dm',
      action: 'user.password_reset',
      entityType: 'user',
      entityId: id,
    });
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
   *
   * `requester` (the REAL calling admin, from the session/PAT that authenticated
   * this request) is passed separately from `owner` (the target) so
   * TokensService.mintFor() can decide `body.adminEnabled` against the actor
   * actually making the call: honored only when `requester` currently holds real
   * server-admin power (this route is already @ServerRoles('admin')-gated, but
   * that alone doesn't prove non-token-capped power post-P1-fix — see
   * hasServerAdminPower()) AND the target is themselves a server admin.
   */
  @Post(':id/tokens')
  @ApiOperation({
    summary: 'Mint a PAT for another user (admin provisioning)',
    description:
      "Server-admin only. Mints a personal access token owned by user `id`, without needing that user's password. " +
      "scope/campaignId are validated against the TARGET user's own campaign access, not the admin's — an admin cannot mint a token scoped to a campaign the target user cannot access. " +
      'adminEnabled:true additionally requires the calling admin to currently hold real (non-token-capped) server-admin power AND the target user to themselves be a server admin.',
  })
  @ApiResponse({ status: 201, description: 'PAT minted for the target user. `token` is shown once — store it now.' })
  @ApiResponse({ status: 403, description: 'Target user has no access to the requested campaignId.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  async mintToken(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: AdminTokenCreateDto,
    @CurrentUser() requester: RequestUser,
  ): Promise<ApiTokenCreated> {
    const target = await this.users.getOrThrow(id);
    const owner: RequestUser = { id: String(target.id), name: target.displayName || target.username, serverRole: target.serverRole };
    const minted = await this.tokens.mintFor(owner, target.id, body, requester);
    // #23: server-wide admin trail — admin minted a PAT on another user's behalf.
    await this.audit.log({
      actor: auditActor(requester),
      actorRole: 'dm',
      action: 'user.token.mint',
      entityType: 'user',
      entityId: target.id,
      detail: `token "${minted.apiToken.name}" for ${target.username}${body.adminEnabled ? ' (admin-enabled)' : ''}`,
    });
    return minted;
  }
}
