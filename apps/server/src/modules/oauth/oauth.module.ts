import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { OAuthService } from './oauth.service';
import { OAuthController, OAuthMetadataController } from './oauth.controller';

/**
 * MCP OAuth (issue #37): Campfire as a minimal OAuth 2.1 authorization server so
 * /mcp can be added as a Claude connector. OAuthService is exported because the
 * global SessionAuthGuard consumes it to resolve `Bearer cf_mcp_...` access
 * tokens alongside the existing PAT path.
 *
 * Imports AuthModule (reuse Campfire login for the authorize/consent step) and
 * RoleAccessModule (RoleResolver, to verify a user's access before binding a
 * token to a specific campaign — mirroring PAT minting).
 */
@Module({
  imports: [AuthModule, RoleAccessModule],
  controllers: [OAuthMetadataController, OAuthController],
  providers: [OAuthService],
  exports: [OAuthService],
})
export class OAuthModule {}
