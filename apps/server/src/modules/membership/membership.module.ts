import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { SettingsModule } from '../settings/settings.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RoleAccessModule } from './role-access.module';
import { MembersService } from './members.service';
import { MembersController } from './members.controller';
import { InvitesService } from './invites.service';
import { CampaignInvitesController, JoinController } from './invites.controller';

@Module({
  imports: [AuditModule, AuthModule, UsersModule, SettingsModule, NotificationsModule, RoleAccessModule],
  controllers: [MembersController, CampaignInvitesController, JoinController],
  providers: [MembersService, InvitesService],
  exports: [RoleAccessModule, MembersService],
})
export class MembershipModule {}
