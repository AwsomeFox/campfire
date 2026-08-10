import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import {
  DEFAULT_WEB_PUSH_TRANSPORT,
  PushNotificationsService,
  WEB_PUSH_TRANSPORT,
} from './push-notifications.service';

/**
 * Leaf module (only depends on the global DbModule) so any domain module that
 * emits notifications — sessions, notes, membership — can import it without
 * creating a cycle, mirroring RoleAccessModule.
 */
@Module({
  controllers: [NotificationsController],
  providers: [
    { provide: WEB_PUSH_TRANSPORT, useValue: DEFAULT_WEB_PUSH_TRANSPORT },
    PushNotificationsService,
    NotificationsService,
  ],
  exports: [NotificationsService, PushNotificationsService],
})
export class NotificationsModule {}
