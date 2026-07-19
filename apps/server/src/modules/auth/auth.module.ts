import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { SettingsModule } from '../settings/settings.module';
import { TokensModule } from '../tokens/tokens.module';
import { AuthService } from './auth.service';
import { OidcService } from './oidc.service';
import { AuthController, MeController } from './auth.controller';
import { OidcController } from './oidc.controller';

@Module({
  imports: [UsersModule, SettingsModule, TokensModule],
  controllers: [AuthController, MeController, OidcController],
  providers: [AuthService, OidcService],
  exports: [AuthService, OidcService],
})
export class AuthModule {}
