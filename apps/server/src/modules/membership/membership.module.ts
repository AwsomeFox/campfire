import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { EventsModule } from '../events/events.module';
import { UsersModule } from '../users/users.module';
import { SettingsModule } from '../settings/settings.module';
import { NotificationsModule } from '../notifications/notifications.module';
// Issue #600: the invite preview shows the published charter and the join gate checks
// acknowledgment. SessionZeroModule depends only on RoleAccessModule (a leaf) and never
// on MembershipModule, so this direction introduces no cycle.
import { SessionZeroModule } from '../session-zero/session-zero.module';
import { RoleAccessModule } from './role-access.module';
import { MembersService } from './members.service';
import { MembersController } from './members.controller';
import { InvitesService } from './invites.service';
import { CampaignInvitesController, JoinController } from './invites.controller';

@Module({
  imports: [
    AuditModule,
    AuthModule,
    EventsModule,
    UsersModule,
    SettingsModule,
    NotificationsModule,
    RoleAccessModule,
    SessionZeroModule,
  ],
  controllers: [MembersController, CampaignInvitesController, JoinController],
  providers: [MembersService, InvitesService],
  exports: [RoleAccessModule, MembersService, InvitesService],
})
export class MembershipModule {}
