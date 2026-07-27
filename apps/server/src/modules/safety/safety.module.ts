import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { SafetyService } from './safety.service';
import { SafetyController } from './safety.controller';

/**
 * Personal safety controls (issue #597).
 *
 * Deliberately a LEAF module: it owns the write side of `member_safety_controls` and
 * nothing else imports it. The read/ENFORCEMENT side lives in `common/safety-controls.ts`
 * as pure functions over a drizzle handle, so NotificationsService (itself a leaf that
 * every domain module imports), NotesService and SearchService can all apply the identical
 * rule without a new module edge and without a service-constructor change — the same
 * pattern #601 used for `note-visibility.ts` / `anchor-visibility.ts`.
 */
@Module({
  imports: [AuditModule, RoleAccessModule],
  controllers: [SafetyController],
  providers: [SafetyService],
  exports: [SafetyService],
})
export class SafetyModule {}
