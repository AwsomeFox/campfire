import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { SettingsModule } from '../settings/settings.module';
import { TokensModule } from '../tokens/tokens.module';
import { AuthService } from './auth.service';
import { OidcService } from './oidc.service';
import { PasswordResetService } from './password-reset.service';
import { AuthController, MeController } from './auth.controller';
import { OidcController } from './oidc.controller';
import { OidcAdminController } from './oidc-admin.controller';
import { PasswordResetAdminController } from './password-reset.controller';

@Module({
  imports: [UsersModule, SettingsModule, TokensModule],
  controllers: [AuthController, MeController, OidcController, OidcAdminController, PasswordResetAdminController],
  providers: [AuthService, OidcService, PasswordResetService],
  exports: [AuthService, OidcService],
})
export class AuthModule {}
