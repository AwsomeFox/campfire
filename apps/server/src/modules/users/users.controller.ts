import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import type { ApiTokenCreated } from '@campfire/schema';
import { ServerRoles } from '../../common/decorators/server-roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { hasServerAdminPower, auditActorRole, type RequestUser, auditActor } from '../../common/user.types';
import { RoleResolver } from '../membership/role-resolver.service';
import { UsersService } from './users.service';
import { TokensService } from '../tokens/tokens.service';
import { AuditService } from '../audit/audit.service';
import { UserCreateDto, UserUpdateDto, PasswordChangeDto, AdminTokenCreateDto, CampaignDmRepairDto } from './users.dto';

/**
 * Narrow server-operator recovery surface for #849. It exposes only authority
 * metadata and can assign an enabled recovery DM to an already-orphaned campaign;
 * it never reads campaign entities or confers implicit campaign access.
 */
@ApiTags('membership integrity')
@Controller('admin/membership-integrity')
@ServerRoles('admin')
export class MembershipIntegrityController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({
    summary: 'Inspect campaign DM authority integrity',
    description:
      'Server-admin only. Returns campaign ids/names, usable/disabled DM counts, and migration repair history. ' +
      'No campaign content or DM-secret fields are returned; server admin remains distinct from campaign membership.',
  })
  @ApiResponse({ status: 200, description: 'Secret-free authority diagnostics and migration repair metadata.' })
  @ApiResponse({ status: 403, description: 'Requires current server-admin power.' })
  report() {
    return this.users.membershipIntegrity();
  }

  @Post('repair-dm')
  @ApiOperation({
    summary: 'Assign an enabled recovery DM to an orphaned campaign',
    description:
      'Server-admin only and allowed only while the campaign has zero enabled DMs. The target account must exist ' +
      'and be enabled. This does not otherwise expose campaign content or grant the calling admin campaign access.',
  })
  @ApiResponse({ status: 201, description: 'Enabled target assigned/promoted as recovery DM.' })
  @ApiResponse({ status: 400, description: 'Target account is disabled.' })
  @ApiResponse({ status: 404, description: 'Campaign or target account does not exist.' })
  @ApiResponse({ status: 409, description: 'Campaign already has an enabled DM; use normal membership controls.' })
  repair(@Body() body: CampaignDmRepairDto, @CurrentUser() actor: RequestUser) {
    return this.users.repairCampaignDm(body, actor);
  }
}

/**
 * User directory lookup — used by the DM's add-member picker. Declared before
 * UsersController so /users/lookup doesn't get swallowed by /users/:id-shaped
 * routes in admin controller ordering.
 *
 * AUTHZ (issue #88): this is NOT open to every authenticated principal. The
 * server-wide user table is a directory-enumeration oracle (usernames feed the
 * login/timing oracle), so it exposed every account to any player/viewer token.
 * The lookup only exists to serve one legitimate flow — a dm resolving a
 * username to add someone to their campaign (POST /campaigns/:id/members is
 * dm-gated) — so it is now gated to callers who are a dm of at least one
 * campaign, or who hold real server-admin power. A viewer/player (or a token
 * scoped below dm) gets 403.
 */
@ApiTags('users')
@Controller('users')
export class UsersLookupController {
  constructor(
    private readonly users: UsersService,
    private readonly roleResolver: RoleResolver,
  ) {}

  @Get('lookup')
  @ApiOperation({
    summary: 'Look up users by username/display name',
    description:
      'Restricted to a dm of at least one campaign (the add-member picker) or a server admin. Requires query >= 2 chars.',
  })
  @ApiQuery({ name: 'query', required: true, description: 'Substring match against username or displayName, min length 2.' })
  @ApiResponse({ status: 200, description: 'Up to 10 matching users (id, username, displayName).' })
  @ApiResponse({ status: 400, description: 'query missing or shorter than 2 characters.' })
  @ApiResponse({ status: 403, description: 'Caller is neither a dm of any campaign nor a server admin.' })
  async lookup(@Query('query') query: string | undefined, @CurrentUser() user: RequestUser) {
    const allowed = hasServerAdminPower(user) || (await this.roleResolver.isDmOfAnyCampaign(user));
    if (!allowed) {
      throw new ForbiddenException('User lookup is restricted to campaign DMs and server admins');
    }
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
    // #526: attribute the actor's TRUE server role (admin vs dm) so an incident
    // reviewer can tell a privileged operator action from an ordinary DM's.
    await this.audit.log({
      actor: auditActor(actor),
      actorRole: auditActorRole(actor),
      action: 'user.create',
      entityType: 'user',
      entityId: created.id,
      detail: `${created.username} (role ${created.serverRole})`,
    });
    return created;
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a user',
    description: 'Server-admin only. Refuses to demote/disable the last enabled admin or disable a campaign\'s last enabled DM.',
  })
  @ApiResponse({ status: 200, description: 'Updated user.' })
  @ApiResponse({ status: 409, description: 'Would demote/disable the last enabled admin or disable a campaign\'s last enabled DM.' })
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
      actorRole: auditActorRole(actor),
      action: 'user.update',
      entityType: 'user',
      entityId: id,
      detail: `${updated.username}: ${changes.join(', ') || 'no-op'}`,
    });
    return updated;
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a user', description: 'Server-admin only. Refuses to delete the last enabled admin, or the last enabled DM of any campaign.' })
  @ApiResponse({ status: 204, description: 'Deleted.' })
  @ApiResponse({ status: 409, description: 'Last enabled admin, or last enabled DM of one or more campaigns.' })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: RequestUser) {
    // Capture the username before the row is gone, so the trail names the target.
    const target = await this.users.getOrThrow(id);
    await this.users.remove(id);
    // #23: server-wide admin trail — account deletion.
    await this.audit.log({
      actor: auditActor(actor),
      actorRole: auditActorRole(actor),
      action: 'user.delete',
      entityType: 'user',
      entityId: id,
      detail: target.username,
    });
  }

  @Post(':id/password')
  @HttpCode(204)
  @ApiOperation({
    summary: "Reset a user's password",
    description:
      'Server-admin only. No currentPassword check (admin reset, not self-service). ' +
      "Treated as a credential-compromise response: revokes ALL of the user's sessions AND personal access tokens — a leaked cf_pat_… token or stolen cookie does not survive the reset.",
  })
  @ApiResponse({ status: 204, description: 'Password reset; all sessions and personal access tokens revoked.' })
  async setPassword(@Param('id', ParseIntPipe) id: number, @Body() body: PasswordChangeDto, @CurrentUser() actor: RequestUser) {
    await this.users.setPassword(id, body.newPassword);
    // #23: log that a reset happened — never the password itself.
    await this.audit.log({
      actor: auditActor(actor),
      actorRole: auditActorRole(actor),
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
      actorRole: auditActorRole(requester),
      action: 'user.token.mint',
      entityType: 'user',
      entityId: target.id,
      detail: `token "${minted.apiToken.name}" for ${target.username}${body.adminEnabled ? ' (admin-enabled)' : ''}`,
    });
    return minted;
  }

  /**
   * Admin token lifecycle (issue #44): before these routes existed, an admin
   * responding to a leaked `cf_pat_…` token had no way to even SEE another
   * user's tokens, let alone revoke one — the only remedy was disabling or
   * deleting the whole account. List returns the same metadata-only shape as
   * self-service GET /tokens (raw values are never retrievable after mint).
   */
  @Get(':id/tokens')
  @ApiOperation({
    summary: "List a user's personal access tokens",
    description: "Server-admin only. Metadata only (name, scope, campaignId, prefix, lastUsedAt) — raw token values are never retrievable after creation.",
  })
  @ApiResponse({ status: 200, description: "The target user's tokens." })
  @ApiResponse({ status: 404, description: 'User not found.' })
  async listTokens(@Param('id', ParseIntPipe) id: number) {
    await this.users.getOrThrow(id);
    return this.tokens.listOwn(id);
  }

  @Delete(':id/tokens')
  @HttpCode(204)
  @ApiOperation({
    summary: "Revoke ALL of a user's personal access tokens",
    description: 'Server-admin only. Compromise response: immediately invalidates every PAT owned by the user. Idempotent — succeeds even if the user has no tokens.',
  })
  @ApiResponse({ status: 204, description: 'All tokens revoked.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  async revokeAllTokens(@Param('id', ParseIntPipe) id: number): Promise<void> {
    await this.users.getOrThrow(id);
    await this.tokens.removeAllFor(id);
  }

  @Delete(':id/tokens/:tokenId')
  @HttpCode(204)
  @ApiOperation({
    summary: "Revoke one of a user's personal access tokens",
    description: 'Server-admin only. Immediately invalidates the token for future requests.',
  })
  @ApiResponse({ status: 204, description: 'Token revoked.' })
  @ApiResponse({ status: 404, description: 'User not found, or token not found / not owned by that user.' })
  async revokeToken(@Param('id', ParseIntPipe) id: number, @Param('tokenId', ParseIntPipe) tokenId: number): Promise<void> {
    await this.users.getOrThrow(id);
    // Ownership-scoped: 404s (not cross-revokes) when tokenId belongs to a different user.
    await this.tokens.remove(id, tokenId);
  }
}
