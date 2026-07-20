import { Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import type { PasswordResetApproval, PasswordResetRequest } from '@campfire/schema';
import { ServerRoles } from '../../common/decorators/server-roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { PasswordResetService } from './password-reset.service';

/**
 * Admin side of the forgot-password flow — see PasswordResetService for the
 * full design. The user-facing (public, throttled) endpoints live on
 * AuthController (POST /auth/reset-request, POST /auth/reset-confirm).
 *
 * Path is /users/reset-requests — no route clash with UsersController's
 * /users/:id family (different segment counts / literal first segment).
 */
@ApiTags('users')
@Controller('users/reset-requests')
@ServerRoles('admin')
export class PasswordResetAdminController {
  constructor(private readonly passwordReset: PasswordResetService) {}

  @Get()
  @ApiOperation({ summary: 'List open password-reset requests', description: 'Server-admin only. Pending + approved (unexpired) requests; expired approvals revert to pending.' })
  @ApiResponse({ status: 200, description: 'Open reset requests.' })
  list(): Promise<PasswordResetRequest[]> {
    return this.passwordReset.list();
  }

  @Post(':id/approve')
  @ApiOperation({
    summary: 'Approve a password-reset request',
    description:
      'Server-admin only. Mints a ONE-TIME reset code (returned once, stored hashed, 1-hour expiry) for the admin to hand to the user out-of-band. ' +
      'Re-approving regenerates the code and kills the previous one. Unlike POST /users/:id/password, the admin never learns the new password.',
  })
  @ApiResponse({ status: 201, description: 'Code minted — shown once, relay it to the user now.' })
  @ApiResponse({ status: 404, description: 'Request not found.' })
  @ApiResponse({ status: 409, description: 'Account is disabled or SSO-only (no local password).' })
  approve(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser): Promise<PasswordResetApproval> {
    return this.passwordReset.approve(id, user.name);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Dismiss a password-reset request', description: 'Server-admin only. Also revokes an already-issued (approved) code.' })
  @ApiResponse({ status: 204, description: 'Dismissed.' })
  @ApiResponse({ status: 404, description: 'Request not found.' })
  async deny(@Param('id', ParseIntPipe) id: number): Promise<void> {
    await this.passwordReset.deny(id);
  }
}
