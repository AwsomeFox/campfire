import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { SettingsModule } from '../settings/settings.module';
import { AuthService } from './auth.service';
import { AuthController, MeController } from './auth.controller';

@Module({
  imports: [UsersModule, SettingsModule],
  controllers: [AuthController, MeController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
