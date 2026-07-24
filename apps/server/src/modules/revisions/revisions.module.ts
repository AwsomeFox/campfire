import { Module } from '@nestjs/common';
import { RoleAccessModule } from '../membership/role-access.module';
import { RevisionsService } from './revisions.service';
import { RevisionsController } from './revisions.controller';

/**
 * Prose revision history + optimistic-concurrency guard (issue #157). RevisionsService
 * is exported so the prose entity modules (sessions/quests/npcs/locations) can inject it
 * to snapshot prior content on update and clean up on delete. Importing modules only need
 * to add RevisionsModule to their `imports` — no dependency flows the other way, so there
 * is no cycle. Restore writes its own audit row inside the restore transaction (#513), so
 * this module no longer imports AuditModule.
 */
@Module({
  imports: [RoleAccessModule],
  controllers: [RevisionsController],
  providers: [RevisionsService],
  exports: [RevisionsService],
})
export class RevisionsModule {}
