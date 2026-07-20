import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';

/**
 * Leaf module (only depends on the global DbModule) so any domain module that
 * emits notifications — sessions, notes, membership — can import it without
 * creating a cycle, mirroring RoleAccessModule.
 */
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
