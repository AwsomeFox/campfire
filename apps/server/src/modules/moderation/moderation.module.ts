import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { ModerationService } from './moderation.service';
import { ModerationController } from './moderation.controller';
import { AdminModerationController } from './admin-moderation.controller';

/**
 * Moderation / abuse incidents (issue #601).
 *
 * Exports ModerationService so CommentsModule and NotesModule can inject it for
 * pre-mutation evidence capture and mute enforcement. The dependency runs ONE WAY —
 * content modules depend on moderation, never the reverse — which is why the two
 * visibility rules moderation needs (anchor visibility, note visibility) live in
 * `common/` rather than being reached through CommentsService / NotesService.
 */
@Module({
  imports: [AuditModule, RoleAccessModule],
  controllers: [ModerationController, AdminModerationController],
  providers: [ModerationService],
  exports: [ModerationService],
})
export class ModerationModule {}
